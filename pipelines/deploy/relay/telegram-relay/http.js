import http from 'node:http';
import { validateOutboundPayload, sendTextMessage } from './send.js';
import { formatOutboundToRemote } from '../core/names.js';

/**
 * @param {object} options
 * @param {import('../core/config.js').RelayConfig} options.config
 * @param {import('../core/queue.js').InboundQueue} options.queue
 * @param {() => boolean} options.isPolling
 * @param {typeof fetch} [options.fetchFn]
 * @returns {import('node:http').Server}
 */
export function createHttpServer({ config, queue, isPolling, fetchFn = fetch }) {
	const server = http.createServer(async (req, res) => {
		try {
			const urlPath = req.url?.split('?')[0] ?? '';

			if (req.method === 'GET' && urlPath === '/health') {
				const stats = queue.stats();
				json(res, 200, {
					ok: true,
					channel: 'telegram',
					polling: isPolling(),
					inbox_pending: stats.pending,
					inbox_processing: stats.processing,
				});
				return;
			}

			if (req.method === 'GET' && urlPath === '/inbox/next') {
				const job = queue.peekNext();
				json(res, 200, { ok: true, job: job ?? null });
				return;
			}

			if (req.method === 'GET' && urlPath === '/inbox/stats') {
				json(res, 200, { ok: true, ...queue.stats() });
				return;
			}

			if (req.method === 'POST' && urlPath === '/inbox/ack') {
				const body = await readJsonBody(req);
				if (!body?.job_id) {
					json(res, 400, { ok: false, error: 'job_id is required' });
					return;
				}
				const job = queue.ack(String(body.job_id));
				json(res, 200, { ok: true, job_id: job.id, status: job.status });
				return;
			}

			if (req.method === 'POST' && urlPath === '/outbound') {
				const body = await readJsonBody(req);
				const payload = validateOutboundPayload(body, config.relayGroupId);
				const text = formatOutboundToRemote(payload.text, config.remoteAgentName);
				const result = await sendTextMessage({
					botToken: config.botToken,
					chatId: config.relayGroupId,
					text,
					replyToMessageId: payload.reply_to_message_id,
					fetchFn,
				});
				json(res, 200, { ok: true, message_id: result.result?.message_id });
				return;
			}

			json(res, 404, { ok: false, error: 'not found' });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			json(res, 400, { ok: false, error: message });
		}
	});

	return server;
}

function json(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => {
			try {
				const raw = Buffer.concat(chunks).toString('utf-8');
				resolve(raw ? JSON.parse(raw) : {});
			} catch {
				reject(new Error('invalid JSON body'));
			}
		});
		req.on('error', reject);
	});
}
