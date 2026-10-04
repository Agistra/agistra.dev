import { parseTelegramUpdate } from './parse.js';
import { isAllowedSender, escalateUnknownSender } from './allowlist.js';
import { isAddressedToRouter } from '../core/names.js';

/**
 * Process one Telegram update: filter relay group, allowlist, Router address, parse, enqueue.
 *
 * @param {object} options
 * @param {object} options.update
 * @param {string} options.relayGroupId
 * @param {string[]} options.allowedSenders
 * @param {string} options.hubRoot
 * @param {string} options.routerDisplayName
 * @param {string} [options.routerTelegramHandle]
 * @param {import('../core/queue.js').InboundQueue} options.queue
 * @param {(job: import('../core/adapter-contract.js').InboundJob) => void | Promise<void>} [options.afterEnqueue]
 * @param {typeof import('node:fs')} [options.fsMod]
 * @returns {'enqueued'|'ignored'|'unknown_sender'|'not_addressed'|null}
 */
export function processTelegramUpdate({
	update,
	relayGroupId,
	allowedSenders,
	hubRoot,
	routerDisplayName,
	routerTelegramHandle,
	queue,
	afterEnqueue,
	fsMod,
}) {
	const msg = update?.message ?? update?.edited_message;
	if (!msg?.chat?.id) return null;
	if (String(msg.chat.id) !== String(relayGroupId)) return 'ignored';

	const messageText = msg.text ?? msg.caption ?? '';
	if (!isAddressedToRouter(messageText, msg, {
		routerDisplayName,
		routerTelegramHandle,
	})) {
		return 'not_addressed';
	}

	if (!isAllowedSender(msg.from?.id, allowedSenders)) {
		escalateUnknownSender({
			hubRoot,
			senderId: msg.from?.id,
			rawText: msg.text ?? msg.caption ?? '',
			fsMod,
		});
		return 'unknown_sender';
	}

	const parsed = parseTelegramUpdate(update, routerDisplayName);
	if (!parsed) return null;

	const job = queue.enqueue(parsed);
	if (afterEnqueue) {
		Promise.resolve(afterEnqueue(job)).catch(() => {});
	}
	return 'enqueued';
}

/**
 * Long-poll Telegram getUpdates, parse inbound, enqueue structured jobs.
 *
 * @param {object} options
 * @param {string} options.botToken
 * @param {string} options.relayGroupId
 * @param {string[]} options.allowedSenders
 * @param {string} options.hubRoot
 * @param {string} options.routerDisplayName
 * @param {string} [options.routerTelegramHandle]
 * @param {import('../core/queue.js').InboundQueue} options.queue
 * @param {(job: import('../core/adapter-contract.js').InboundJob) => void | Promise<void>} [options.afterEnqueue]
 * @param {typeof fetch} [options.fetchFn]
 * @param {typeof import('node:fs')} [options.fsMod]
 * @param {() => boolean} [options.shouldRun]
 * @param {(err: Error) => void} [options.onError]
 * @returns {{ stop: () => void, polling: boolean }}
 */
export function startPoller({
	botToken,
	relayGroupId,
	allowedSenders,
	hubRoot,
	routerDisplayName,
	routerTelegramHandle,
	queue,
	afterEnqueue,
	fetchFn = fetch,
	fsMod,
	shouldRun = () => true,
	onError = () => {},
}) {
	let offset = 0;
	let stopped = false;
	let polling = false;
	let timer = null;

	async function tick() {
		if (stopped || !shouldRun()) return;
		polling = true;
		try {
			const url = new URL(`https://api.telegram.org/bot${botToken}/getUpdates`);
			url.searchParams.set('timeout', '25');
			url.searchParams.set('offset', String(offset));
			const response = await fetchFn(url.toString());
			const data = await response.json();
			if (!data.ok) {
				throw new Error(data.description || 'getUpdates failed');
			}
			for (const update of data.result ?? []) {
				if (update.update_id >= offset) {
					offset = update.update_id + 1;
				}
				processTelegramUpdate({
					update,
					relayGroupId,
					allowedSenders,
					hubRoot,
					routerDisplayName,
					routerTelegramHandle,
					afterEnqueue,
					queue,
					fsMod,
				});
			}
		} catch (err) {
			onError(err instanceof Error ? err : new Error(String(err)));
		} finally {
			polling = false;
			if (!stopped && shouldRun()) {
				timer = setTimeout(tick, 1000);
			}
		}
	}

	tick();

	return {
		get polling() {
			return polling;
		},
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}
