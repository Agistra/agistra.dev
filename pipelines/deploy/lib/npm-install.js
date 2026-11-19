import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Bounded, stdin-detached child-process execution for setup-time installs.
 *
 * Before this module, setup's `npm ci` calls used `execFileSync` with
 * `stdio: 'inherit'` and no timeout: one stalled install hung the whole
 * `npm run setup` forever, and the install inherited setup's stdin (a pipe
 * when setup is driven by a script).
 */

/** Generous default for one setup-time install: 10 minutes. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Upper bound for quick presence/version probes (`gh --version`, `schtasks /query`, ...). */
export const PROBE_TIMEOUT_MS = 30 * 1000;

/** Env var that overrides the install timeout (milliseconds). */
export const INSTALL_TIMEOUT_ENV = 'SETUP_INSTALL_TIMEOUT_MS';

/** Exit status the supervisor uses to say "I killed the install on timeout". */
export const SUPERVISOR_TIMEOUT_EXIT = 124;

// Extra time the parent gives the supervisor to kill the tree and exit before
// it gives up on it and kills the supervisor itself.
const SUPERVISOR_GRACE_MS = 20 * 1000;

const SUPERVISOR_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'npm-install-supervisor.js',
);

/**
 * Resolve the install timeout: SETUP_INSTALL_TIMEOUT_MS when it is a positive
 * integer, otherwise the 10-minute default.
 *
 * @param {object} [env]
 * @returns {number}
 */
export function resolveInstallTimeoutMs(env = process.env) {
	const raw = env?.[INSTALL_TIMEOUT_ENV];
	if (raw === undefined || raw === '') return DEFAULT_INSTALL_TIMEOUT_MS;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_INSTALL_TIMEOUT_MS;
}

/**
 * Options every setup-time install passes to its execFn: no stdin (an install
 * never prompts), output still visible, and a hard timeout.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {object} [opts.env]
 */
export function installExecOptions({ cwd, env = process.env }) {
	return {
		cwd,
		stdio: ['ignore', 'inherit', 'inherit'],
		shell: process.platform === 'win32',
		timeout: resolveInstallTimeoutMs(env),
	};
}

/** True when `err` came from an install that exceeded its timeout. */
export function isInstallTimeout(err) {
	return Boolean(err) && (err.code === 'ETIMEDOUT' || err.timedOut === true);
}

/** Seconds, for the one-line warning. */
export function formatTimeout(ms) {
	return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/**
 * Drop-in `execFileSync(cmd, args, options)` replacement for setup-time
 * installs. Runs the command under a small supervisor process that, when
 * `options.timeout` elapses, kills the command's whole process tree
 * (`taskkill /T /F` on Windows, where npm runs through a shell and a plain
 * `child.kill()` would orphan the real npm node process; a process-group
 * SIGKILL elsewhere) and exits with SUPERVISOR_TIMEOUT_EXIT. This function then
 * throws an error with `code: 'ETIMEDOUT'` and `timedOut: true`.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [options]  cwd, stdio, shell, timeout (ms), env
 * @param {function} [execFn]  Injectable execFileSync for the supervisor spawn.
 */
export function execWithTimeout(
	cmd,
	args,
	options = {},
	execFn = execFileSync,
) {
	const timeoutMs = options.timeout ?? DEFAULT_INSTALL_TIMEOUT_MS;
	const payload = JSON.stringify({
		cmd,
		args,
		timeoutMs,
		shell: Boolean(options.shell),
	});
	try {
		return execFn(process.execPath, [SUPERVISOR_PATH, payload], {
			cwd: options.cwd,
			env: options.env,
			stdio: options.stdio ?? ['ignore', 'inherit', 'inherit'],
			// Backstop only: the supervisor enforces `timeoutMs` itself.
			timeout: timeoutMs + SUPERVISOR_GRACE_MS,
		});
	} catch (err) {
		if (err?.status === SUPERVISOR_TIMEOUT_EXIT || err?.code === 'ETIMEDOUT') {
			const timeoutErr = new Error(
				`${cmd} ${args.join(' ')} timed out after ${formatTimeout(timeoutMs)}`,
				{ cause: err },
			);
			timeoutErr.code = 'ETIMEDOUT';
			timeoutErr.timedOut = true;
			throw timeoutErr;
		}
		throw err;
	}
}

/**
 * Remove a directory a timed-out install may have half-written, so a later
 * presence check cannot mistake it for an installed runtime. Never throws;
 * returns whether the directory is gone.
 *
 * @param {string} dir
 * @param {object} [fsMod]
 * @returns {boolean}
 */
export function removePartialInstall(dir, fsMod = fs) {
	try {
		fsMod.rmSync?.(dir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 200,
		});
	} catch {
		// Fall through to the existence check below.
	}
	try {
		return !fsMod.existsSync(dir);
	} catch {
		return false;
	}
}
