import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {typeof fs} [options.fsMod]
 * @returns {string}
 */
export function lockFilePath({ hubRoot, fsMod = fs }) {
	const relayDir = path.join(hubRoot, 'relay');
	if (!fsMod.existsSync(relayDir)) {
		fsMod.mkdirSync(relayDir, { recursive: true });
	}
	return path.join(relayDir, '.daemon.lock');
}

/**
 * Acquire single-instance lock. Throws if another live holder exists.
 *
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {number} [options.pid]
 * @param {typeof fs} [options.fsMod]
 * @param {(pid: number, signal: number) => boolean} [options.isProcessAlive]
 * @returns {{ lockPath: string, release: () => void }}
 */
export function acquireDaemonLock({
	hubRoot,
	pid = process.pid,
	fsMod = fs,
	isProcessAlive = isAlive,
}) {
	const lockPath = lockFilePath({ hubRoot, fsMod });

	if (fsMod.existsSync(lockPath)) {
		const existing = parseInt(fsMod.readFileSync(lockPath, 'utf-8').trim(), 10);
		if (existing > 0 && existing !== pid && isProcessAlive(existing, 0)) {
			throw new Error(
				`relay daemon already running (pid ${existing}). Stop it before starting another instance.`,
			);
		}
	}

	fsMod.writeFileSync(lockPath, String(pid), 'utf-8');

	return {
		lockPath,
		release() {
			try {
				if (fsMod.existsSync(lockPath)) {
					const current = parseInt(fsMod.readFileSync(lockPath, 'utf-8').trim(), 10);
					if (current === pid) {
						fsMod.unlinkSync(lockPath);
					}
				}
			} catch {
				// best-effort cleanup
			}
		},
	};
}

function isAlive(pid, signal) {
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}
