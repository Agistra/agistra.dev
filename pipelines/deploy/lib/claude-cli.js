/**
 * Cross-platform Claude Code CLI helpers.
 *
 * On Windows, npm installs `claude` as a `.cmd` shim. Node's execFileSync/spawn
 * without `shell: true` fails with ENOENT even when `claude --version` works in
 * PowerShell. These helpers centralise the platform workaround for doctor,
 * auto-dispatch, and dispatch.
 */

import { spawn, spawnSync } from 'node:child_process';

/**
 * Whether spawned claude invocations need shell resolution (.cmd shims on Windows).
 *
 * @returns {boolean}
 */
export function claudeSpawnShell() {
	return process.platform === 'win32';
}

/**
 * Probe that the Claude CLI is available. Throws when not found or non-zero exit.
 *
 * @param {object} [options]
 * @param {function(string, string[], object): void} [options.execFn]
 *   Injectable probe for tests — receives (cmd, args, opts).
 */
export function probeClaudeCli({ execFn } = {}) {
	const run = execFn ?? defaultProbeClaude;
	run('claude', ['--version'], { stdio: 'pipe' });
}

function defaultProbeClaude(cmd, args, opts) {
	const result = spawnSync(cmd, args, {
		...opts,
		shell: claudeSpawnShell(),
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`claude --version exited with code ${result.status ?? 'unknown'}`);
	}
}

/**
 * Spawn the Claude CLI with cross-platform PATH resolution.
 *
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [options]
 * @param {typeof spawn} [spawnFn]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnClaude(args, options = {}, spawnFn = spawn) {
	return spawnFn('claude', args, {
		...options,
		shell: options.shell ?? claudeSpawnShell(),
	});
}

/**
 * Synchronous spawn for interactive dispatch flows.
 *
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [options]
 * @param {typeof spawnSync} [spawnFn]
 * @returns {import('node:child_process').SpawnSyncReturns<string | Buffer>}
 */
export function spawnClaudeSync(args, options = {}, spawnFn = spawnSync) {
	return spawnFn('claude', args, {
		...options,
		shell: options.shell ?? claudeSpawnShell(),
	});
}
