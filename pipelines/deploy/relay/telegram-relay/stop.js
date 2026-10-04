#!/usr/bin/env node
/**
 * Stop the relay daemon for a hub.
 *
 * Usage:
 *   node pipelines/deploy/relay/telegram-relay/stop.js --hub <hub-root>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelayConfig, resolveHubRoot, DEFAULT_DAEMON_PORT } from './config.js';
import { lockFilePath } from './lock.js';
import { probeRelayHealth } from '../../../../tools/ensure-relay-daemon.js';

const DISPATCH_LOCK = 'dispatch.lock';
const DEFAULT_WAIT_MS = 5000;
const POLL_MS = 200;

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessAlive(pid, killFn = process.kill.bind(process)) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		killFn(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLockPid(hubRoot, fsMod = fs) {
	const lockPath = lockFilePath({ hubRoot, fsMod });
	if (!fsMod.existsSync(lockPath)) return null;
	const pid = parseInt(fsMod.readFileSync(lockPath, 'utf-8').trim(), 10);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function removeLockIfSafe(hubRoot, pid, fsMod = fs) {
	const lockPath = lockFilePath({ hubRoot, fsMod });
	if (!fsMod.existsSync(lockPath)) return;
	try {
		const current = parseInt(fsMod.readFileSync(lockPath, 'utf-8').trim(), 10);
		if (current === pid || !isProcessAlive(current)) {
			fsMod.unlinkSync(lockPath);
		}
	} catch {
		// best-effort
	}
}

function removeDispatchLock(hubRoot, fsMod = fs) {
	const lockPath = path.join(hubRoot, 'relay', DISPATCH_LOCK);
	if (fsMod.existsSync(lockPath)) {
		try {
			fsMod.unlinkSync(lockPath);
		} catch {
			// best-effort
		}
	}
}

/**
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {typeof fs} [options.fsMod]
 * @param {typeof process.kill} [options.killFn]
 * @param {typeof fetch} [options.fetchFn]
 * @param {number} [options.waitMs]
 * @returns {Promise<{ action: string, pid?: number, port?: number }>}
 */
export async function stopRelayDaemon({
	hubRoot,
	fsMod = fs,
	killFn = process.kill.bind(process),
	fetchFn = globalThis.fetch,
	waitMs = DEFAULT_WAIT_MS,
}) {
	let port = DEFAULT_DAEMON_PORT;
	try {
		port = loadRelayConfig({ hubRoot, fsMod }).daemonPort;
	} catch {
		// still attempt stop via lock file using default port
	}
	const health = await probeRelayHealth(port, fetchFn);
	const pid = readLockPid(hubRoot, fsMod);

	if (health === 'unreachable' && !pid) {
		removeDispatchLock(hubRoot, fsMod);
		return { action: 'not_running', port };
	}

	if (health === 'unreachable' && pid && !isProcessAlive(pid, killFn)) {
		removeLockIfSafe(hubRoot, pid, fsMod);
		removeDispatchLock(hubRoot, fsMod);
		return { action: 'stale_lock_cleared', pid, port };
	}

	const targetPid = pid ?? null;
	if (!targetPid) {
		if (health === 'ok') {
			return { action: 'running_no_lock', port };
		}
		removeDispatchLock(hubRoot, fsMod);
		return { action: 'not_running', port };
	}

	try {
		killFn(targetPid, 'SIGTERM');
	} catch (err) {
		const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
		if (code !== 'ESRCH') {
			throw err;
		}
		removeLockIfSafe(hubRoot, targetPid, fsMod);
		removeDispatchLock(hubRoot, fsMod);
		return { action: 'already_stopped', pid: targetPid, port };
	}

	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		await sleep(POLL_MS);
		if (await probeRelayHealth(port, fetchFn) === 'unreachable') {
			removeLockIfSafe(hubRoot, targetPid, fsMod);
			removeDispatchLock(hubRoot, fsMod);
			return { action: 'stopped', pid: targetPid, port };
		}
	}

	if (!isProcessAlive(targetPid, killFn)) {
		removeLockIfSafe(hubRoot, targetPid, fsMod);
		removeDispatchLock(hubRoot, fsMod);
		return { action: 'stopped', pid: targetPid, port };
	}

	return { action: 'stop_timeout', pid: targetPid, port };
}

const isMain = process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	const hubRoot = resolveHubRoot(process.argv.slice(2));
	try {
		const result = await stopRelayDaemon({ hubRoot });
		switch (result.action) {
			case 'not_running':
				process.stdout.write('relay not running\n');
				process.exit(0);
				break;
			case 'stale_lock_cleared':
				process.stdout.write(`relay not running — cleared stale lock (pid ${result.pid})\n`);
				process.exit(0);
				break;
			case 'already_stopped':
				process.stdout.write(`relay already stopped (pid ${result.pid})\n`);
				process.exit(0);
				break;
			case 'stopped':
				process.stdout.write(`relay stopped (pid ${result.pid})\n`);
				process.exit(0);
				break;
			case 'running_no_lock':
				process.stderr.write(
					`relay responds on port ${result.port} but no lock file — stop the node process manually\n`,
				);
				process.exit(1);
				break;
			case 'stop_timeout':
				process.stderr.write(
					`relay pid ${result.pid} did not exit within ${DEFAULT_WAIT_MS}ms — try again or kill manually\n`,
				);
				process.exit(1);
				break;
			default:
				process.stderr.write(`relay stop: unexpected result ${result.action}\n`);
				process.exit(1);
		}
	} catch (err) {
		process.stderr.write(`relay stop: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}
}
