#!/usr/bin/env node
/**
 * ensure-relay-daemon.js — Claude Code SessionStart hook.
 *
 * When remoteTeam + telegram are enabled in workspace.config.json, ensures the
 * relay daemon is listening on localhost. Spawns detached if not running.
 *
 * Always exits 0 so Claude session start is never blocked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_DAEMON_PORT = 17391;

/**
 * @param {number} port
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<'ok'|'bad'|'unreachable'>}
 */
export async function probeRelayHealth(port, fetchFn = globalThis.fetch) {
	try {
		const res = await fetchFn(`http://127.0.0.1:${port}/health`);
		const data = await res.json();
		return res.ok && data?.ok === true ? 'ok' : 'bad';
	} catch {
		return 'unreachable';
	}
}

/**
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {typeof fs} [options.fsMod]
 */
export function shouldEnsureRelay({ hubRoot, fsMod = fs }) {
	const configPath = path.join(hubRoot, 'workspace.config.json');
	if (!fsMod.existsSync(configPath)) return false;
	try {
		const config = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'));
		if (!config?.remoteTeam?.enabled) return false;
		const telegram = config?.telegram;
		if (!telegram || telegram.enabled === false) return false;
		return Boolean(telegram.bot_token && telegram.relay_group_id);
	} catch {
		return false;
	}
}

/**
 * @param {string} hubRoot
 * @param {typeof fs} [fsMod]
 * @returns {string|null}
 */
export function resolveDaemonScript(hubRoot, fsMod = fs) {
	const script = path.join(
		hubRoot,
		'pipelines',
		'deploy',
		'relay',
		'telegram-relay',
		'daemon.js',
	);
	return fsMod.existsSync(script) ? script : null;
}

function readDaemonPort(hubRoot, fsMod = fs) {
	try {
		const config = JSON.parse(
			fsMod.readFileSync(path.join(hubRoot, 'workspace.config.json'), 'utf-8'),
		);
		return Number(config?.relay?.daemonPort) || DEFAULT_DAEMON_PORT;
	} catch {
		return DEFAULT_DAEMON_PORT;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {typeof fs} [options.fsMod]
 * @param {typeof spawn} [options.spawnFn]
 * @param {typeof fetch} [options.fetchFn]
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{ action: string, port?: number, reason?: string, pid?: number }>}
 */
export async function ensureRelayDaemon({
	hubRoot,
	fsMod = fs,
	spawnFn = spawn,
	fetchFn = globalThis.fetch,
	log = (msg) => process.stderr.write(`${msg}\n`),
}) {
	if (!shouldEnsureRelay({ hubRoot, fsMod })) {
		return { action: 'skip', reason: 'relay not enabled' };
	}

	const port = readDaemonPort(hubRoot, fsMod);
	if ((await probeRelayHealth(port, fetchFn)) === 'ok') {
		return { action: 'already_running', port };
	}

	const daemonScript = resolveDaemonScript(hubRoot, fsMod);
	if (!daemonScript) {
		log(
			'relay autostart: skipped — pipelines/deploy/relay not found (redeploy hub)',
		);
		return { action: 'skip', reason: 'daemon script missing' };
	}

	const child = spawnFn(
		process.execPath,
		[daemonScript, '--hub', path.resolve(hubRoot)],
		{
			cwd: hubRoot,
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
		},
	);
	child.unref();

	for (let attempt = 0; attempt < 10; attempt++) {
		await sleep(200);
		if ((await probeRelayHealth(port, fetchFn)) === 'ok') {
			log(`relay autostart: daemon listening on http://127.0.0.1:${port}`);
			return { action: 'started', port, pid: child.pid };
		}
	}

	log(
		`relay autostart: spawned pid ${child.pid} but /health not ready yet — check manually`,
	);
	return { action: 'spawned', port, pid: child.pid };
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	ensureRelayDaemon({ hubRoot: process.cwd() })
		.catch((err) => {
			process.stderr.write(`relay autostart error: ${err.message}\n`);
		})
		.finally(() => process.exit(0));
}
