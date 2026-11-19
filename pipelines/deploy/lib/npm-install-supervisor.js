#!/usr/bin/env node
/**
 * Runs one command with a hard timeout and kills its whole process tree when
 * the timeout fires. Spawned by lib/npm-install.js's execWithTimeout().
 *
 * argv[2] is a JSON payload: { cmd, args, timeoutMs, shell }. stdin is not
 * forwarded to the command; stdout/stderr are inherited.
 *
 * Exit status: the command's own status; 124 when the timeout fired.
 */
import { spawn, spawnSync } from 'node:child_process';

const TIMEOUT_EXIT = 124;

function killTree(child) {
	if (!child.pid) return;
	if (process.platform === 'win32') {
		// npm runs through cmd.exe here: child.kill() would only end the shell
		// and orphan the real npm/node processes underneath it.
		spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
			stdio: 'ignore',
			timeout: 15000,
			windowsHide: true,
		});
	} else {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch {
			child.kill('SIGKILL');
		}
	}
}

const { cmd, args, timeoutMs, shell } = JSON.parse(process.argv[2]);

const child = spawn(cmd, args, {
	stdio: ['ignore', 'inherit', 'inherit'],
	shell,
	detached: process.platform !== 'win32',
	windowsHide: true,
});

let timedOut = false;
const timer = setTimeout(() => {
	timedOut = true;
	killTree(child);
	// Do not wait on events from a tree we just killed.
	setTimeout(() => process.exit(TIMEOUT_EXIT), 500);
}, timeoutMs);

child.on('error', (err) => {
	clearTimeout(timer);
	process.stderr.write(`${err.message}\n`);
	process.exit(1);
});

child.on('close', (code, signal) => {
	clearTimeout(timer);
	if (timedOut) process.exit(TIMEOUT_EXIT);
	process.exit(code ?? (signal ? 1 : 0));
});
