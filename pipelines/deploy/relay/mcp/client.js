import fs from 'node:fs';
import { loadRelayConfig } from '../core/config.js';

/**
 * HTTP client for the local relay daemon.
 *
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {typeof fetch} [options.fetchFn]
 * @param {typeof fs} [options.fsMod]
 */
export function createRelayClient({ hubRoot, fetchFn = fetch, fsMod = fs }) {
	const config = loadRelayConfig({ hubRoot, fsMod });
	const baseUrl = `http://127.0.0.1:${config.daemonPort}`;

	async function request(method, urlPath, body) {
		let response;
		try {
			response = await fetchFn(`${baseUrl}${urlPath}`, {
				method,
				headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
				body: body !== undefined ? JSON.stringify(body) : undefined,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`relay daemon not reachable at ${baseUrl} — start with: npm run relay -- --hub ${hubRoot} (${msg})`,
			);
		}

		let data;
		try {
			data = await response.json();
		} catch {
			throw new Error(`relay daemon returned non-JSON response (${response.status})`);
		}

		if (!response.ok || data.ok === false) {
			throw new Error(data.error || `relay daemon error (${response.status})`);
		}
		return data;
	}

	return {
		status: () => request('GET', '/health'),
		send: ({ text, reply_to_message_id }) =>
			request('POST', '/outbound', { text, reply_to_message_id }),
		inboxPeek: () => request('GET', '/inbox/next'),
		inboxAck: job_id => request('POST', '/inbox/ack', { job_id }),
	};
}
