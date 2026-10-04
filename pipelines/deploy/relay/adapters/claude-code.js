/**
 * Claude Code auto-dispatch adapter — spawns a headless Router session for each
 * new inbox job when relay.primaryRuntime === 'claude-code' and autoDispatch === true.
 *
 * @typedef {import('../core/adapter-contract.js').InboundJob} InboundJob
 * @typedef {import('../core/config.js').RelayConfig} RelayConfig
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { resolveRouterModel } from '../../lib/models.js';
import { spawnClaude } from '../../lib/claude-cli.js';
import { createDaemonLogger } from '../core/logger.js';

const DISPATCH_LOCK = 'dispatch.lock';

// ── Predicate ────────────────────────────────────────────────────────────────

/**
 * True when this hub should auto-dispatch Router for new inbox jobs.
 *
 * @param {RelayConfig} config
 * @returns {boolean}
 */
export function shouldDispatchClaude(config) {
	return config.primaryRuntime === 'claude-code'
		&& config.autoDispatch === true
		&& config.remoteTeamEnabled === true;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Build the headless Router prompt for a given inbox job.
 *
 * The hub root is the cwd when claude runs, so CLAUDE.md loads automatically,
 * which in turn triggers the startup rule and loads the router profile and memory.
 *
 * @param {InboundJob} job
 * @param {RelayConfig} config
 * @returns {string}
 */
export function buildRouterPrompt(job, config) {
	const routerName = (config.routerDisplayName || 'Router').trim();
	return [
		`@router Process relay inbox job ${job.id}.`,
		'',
		`Use relay_inbox_peek to retrieve the job details. Classify the workflow_state`,
		`and requested_action. If a reply is warranted, compose it and call relay_send.`,
		`When handling is complete, call relay_inbox_ack with job_id "${job.id}".`,
		'',
		`Subagents (Architect, Builder, Tester) run inside this session via the Agent`,
		`tool — do not spawn a second claude process for handoff.`,
		'',
		`Router display name: ${routerName}`,
	].join('\n');
}

// ── Dispatch lock ─────────────────────────────────────────────────────────────

/**
 * Acquire a simple presence lock for dispatch serialisation.
 * Returns { acquired: false } without throwing if another spawn is in progress.
 *
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {typeof fs} [options.fsMod]
 * @returns {{ acquired: boolean, release: () => void }}
 */
export function acquireDispatchLock({ hubRoot, fsMod = fs }) {
	const relayDir = path.join(hubRoot, 'relay');
	fsMod.mkdirSync(relayDir, { recursive: true });
	const lockPath = path.join(relayDir, DISPATCH_LOCK);

	if (fsMod.existsSync(lockPath)) {
		return { acquired: false, release: () => {} };
	}

	fsMod.writeFileSync(lockPath, String(Date.now()), 'utf-8');

	return {
		acquired: true,
		release() {
			try {
				if (fsMod.existsSync(lockPath)) {
					fsMod.unlinkSync(lockPath);
				}
			} catch {
				// best-effort cleanup
			}
		},
	};
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Spawn a detached headless Router session for the given inbox job.
 * Skips silently if the dispatch lock is held (serialise concurrent jobs).
 * Releases the lock when the claude process exits or errors.
 *
 * @param {object} options
 * @param {InboundJob} options.job
 * @param {RelayConfig} options.config
 * @param {string} options.hubRoot       Absolute hub root — cwd for claude invocation.
 * @param {string} options.profilesRoot  Absolute path to setchin-agent-profiles repo root.
 * @param {typeof nodeSpawn} [options.spawnFn]   Injectable for testing.
 * @param {typeof fs} [options.fsMod]             Injectable for testing.
 * @param {() => Date} [options.nowFn]            Injectable clock for logger (testing).
 * @returns {boolean} true when a spawn was started, false when skipped.
 */
export async function dispatchRouter({ job, config, hubRoot, profilesRoot, spawnFn = nodeSpawn, fsMod = fs, nowFn }) {
	const loggerOpts = nowFn ? { fsMod, nowFn } : { fsMod };
	const logger = createDaemonLogger(hubRoot, loggerOpts);

	const lock = acquireDispatchLock({ hubRoot, fsMod });
	if (!lock.acquired) {
		logger.log(`job=${job.id} skipped — lock held`);
		return false;
	}

	let model;
	try {
		model = resolveRouterModel(profilesRoot, fsMod, hubRoot);
	} catch (err) {
		logger.log(`job=${job.id} model resolution failed: ${err.message}`);
		lock.release();
		return false;
	}

	const prompt = buildRouterPrompt(job, config);

	logger.log(`job=${job.id} spawning claude model=${model}`);

	let child;
	try {
		child = spawnClaude(['-p', prompt, '--model', model], {
			cwd: hubRoot,
			detached: true,
			stdio: 'ignore',
		}, spawnFn);
	} catch (err) {
		logger.log(`job=${job.id} spawn error: ${err.message}`);
		lock.release();
		return false;
	}

	child.on('exit', (code) => {
		logger.log(`job=${job.id} claude exited code=${code ?? '?'}`);
		lock.release();
	});

	child.on('error', (err) => {
		logger.log(`job=${job.id} claude process error: ${err.message}`);
		lock.release();
	});

	child.unref();
	return true;
}

// ── Stale job reaper ──────────────────────────────────────────────────────────

/**
 * Reset processing jobs stuck longer than processingTimeoutSec.
 * Also clears a stale dispatch lock whose timestamp is older than the timeout.
 *
 * @param {object} options
 * @param {import('../core/queue.js').InboundQueue} options.queue
 * @param {number} options.processingTimeoutSec
 * @param {string} [options.hubRoot]  If provided, also clears a stale dispatch.lock.
 * @param {typeof fs} [options.fsMod]
 * @returns {number} Number of jobs reset.
 */
export function resetStaleJobs({ queue, processingTimeoutSec, hubRoot, fsMod = fs }) {
	const resetCount = queue.resetStaleProcessing(processingTimeoutSec * 1000);

	if (hubRoot) {
		const lockPath = path.join(hubRoot, 'relay', DISPATCH_LOCK);
		if (fsMod.existsSync(lockPath)) {
			try {
				const written = Number(fsMod.readFileSync(lockPath, 'utf-8').trim());
				if (Date.now() - written > processingTimeoutSec * 1000) {
					fsMod.unlinkSync(lockPath);
				}
			} catch {
				// best-effort
			}
		}
	}

	return resetCount;
}
