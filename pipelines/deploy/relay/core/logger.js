/**
 * Daemon trace logger — per-day rotating log files under relay/logs/.
 *
 * Log path: <hubRoot>/relay/logs/dispatch-YYYY-MM-DD.log (UTC date)
 * The date is resolved on each log() call — midnight UTC auto-rotates
 * with no timer required.
 */

import fs from 'node:fs';
import path from 'node:path';

const LOG_FILENAME_RE = /^dispatch-(\d{4}-\d{2}-\d{2})\.log$/;

/**
 * Format a Date as a UTC date string: YYYY-MM-DD
 *
 * @param {Date} d
 * @returns {string}
 */
function toUtcDateStr(d) {
	const yyyy = d.getUTCFullYear();
	const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
	const dd   = String(d.getUTCDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
}

/**
 * Create a daemon logger scoped to a hub root.
 *
 * @param {string} hubRoot  Absolute path to the hub workspace directory.
 * @param {object} [opts]
 * @param {() => Date} [opts.nowFn]   Injectable clock; defaults to `() => new Date()`.
 * @param {typeof fs}  [opts.fsMod]   Injectable fs module; defaults to `node:fs`.
 * @returns {{ log: (message: string) => void, pruneOldLogs: (olderThanMs: number) => number }}
 */
export function createDaemonLogger(hubRoot, { nowFn = () => new Date(), fsMod = fs } = {}) {
	const logsDir = path.join(hubRoot, 'relay', 'logs');

	/**
	 * Append a timestamped message to today's UTC log file.
	 * Creates relay/logs/ if absent. Non-fatal on write error.
	 *
	 * @param {string} message
	 */
	function log(message) {
		try {
			fsMod.mkdirSync(logsDir, { recursive: true });
			const now = nowFn();
			const dateStr = toUtcDateStr(now);
			const logPath = path.join(logsDir, `dispatch-${dateStr}.log`);
			fsMod.appendFileSync(logPath, `[${now.toISOString()}] ${message}\n`);
		} catch {
			// non-fatal — don't let logging errors break the daemon
		}
	}

	/**
	 * Delete log files older than `olderThanMs` milliseconds.
	 * Skips files whose parsed date is today (UTC). Non-fatal on individual delete error.
	 *
	 * @param {number} olderThanMs
	 * @returns {number} Count of files deleted.
	 */
	function pruneOldLogs(olderThanMs) {
		let deleted = 0;
		const todayStr = toUtcDateStr(nowFn());
		const cutoff = nowFn().getTime() - olderThanMs;

		let files;
		try {
			files = fsMod.readdirSync(logsDir);
		} catch {
			// Directory absent or unreadable — nothing to prune
			return 0;
		}

		for (const file of files) {
			const match = LOG_FILENAME_RE.exec(file);
			if (!match) continue;

			const dateStr = match[1];
			if (dateStr === todayStr) continue;

			// Parse the file date as UTC midnight
			const fileTime = Date.parse(`${dateStr}T00:00:00.000Z`);
			if (isNaN(fileTime) || fileTime >= cutoff) continue;

			try {
				fsMod.unlinkSync(path.join(logsDir, file));
				deleted++;
			} catch {
				// non-fatal — skip files that cannot be deleted
			}
		}

		return deleted;
	}

	return { log, pruneOldLogs };
}
