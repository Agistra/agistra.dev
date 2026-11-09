#!/usr/bin/env node
/**
 * memory-check-codex-throttle.js — session+cooldown throttle for the Codex
 * Stop hook's WAL reminder (memory-check-codex.js).
 *
 * Why this is a separate file from memory-check-core.js: that module's
 * REMINDED_STAMP_RELATIVE_PATH ('.claude/.session-reminded') and
 * markReminded()/checkMemoryStatus() are shared with Claude Code's own Stop
 * hook (memory-check.js), which still calls markReminded() exactly as
 * before. Codex's own report (the second one) was that the shared "once per
 * work" rule reminds again on every tool call that touches the work marker
 * (.claude/.session-work), so one long Codex session got reminded on almost
 * every turn. Fixing that for Codex without touching memory-check-core.js
 * keeps Claude Code, Cursor and Copilot (none of which import this file)
 * byte-identical: this module never reads or writes
 * REMINDED_STAMP_RELATIVE_PATH, only its own stamp below.
 *
 * Throttle rule: remind at most once per Codex `session_id` (regardless of
 * how much more work happens in that session), plus a cooldown backstop
 * (default 30 minutes) for a missing/changed session_id — covers a Stop
 * payload with no session_id, and a burst of short-lived sessions.
 *
 * State lives under the same gitignored `.claude/` directory
 * memory-check-core.js already uses for its marker files (see
 * pipelines/deploy/hub.gitignore) — a new file there, never a reuse of an
 * existing marker, so this module's writes never change what those other
 * files' mtimes report to the shared checkMemoryStatus()/markReminded().
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHubRoot } from './memory-check-core.js';

/** Codex-only throttle stamp, relative to the hub root. Gitignored; never inside vault/. */
export const CODEX_REMINDER_STAMP_RELATIVE_PATH =
	'.claude/.codex-reminded.json';

/** Once reminded, no second reminder for this many ms even across a changed/missing session_id. */
export const DEFAULT_CODEX_REMINDER_COOLDOWN_MS = 30 * 60 * 1000;

function stampPath(hubRootOverride) {
	return path.join(
		hubRootOverride ?? resolveHubRoot(),
		CODEX_REMINDER_STAMP_RELATIVE_PATH,
	);
}

/**
 * @param {string} [hubRootOverride] test-only override; production callers omit this
 * @returns {{ sessionId: string|null, remindedAtMs: number } | null}
 */
export function readCodexReminderStamp(hubRootOverride) {
	let raw;
	try {
		raw = fs.readFileSync(stampPath(hubRootOverride), 'utf-8');
	} catch {
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const remindedAtMs = Date.parse(parsed?.remindedAt);
	if (!Number.isFinite(remindedAtMs)) return null;
	return {
		sessionId: typeof parsed?.sessionId === 'string' ? parsed.sessionId : null,
		remindedAtMs,
	};
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.sessionId]  Current Codex `session_id`, or null when absent.
 * @param {string} [opts.hubRootOverride] test-only override; production callers omit this
 * @param {number} [opts.nowMs]           test-only override; production callers omit this
 * @param {number} [opts.cooldownMs]
 * @returns {boolean} true when the Codex Stop-hook reminder must be suppressed this turn
 */
export function isCodexReminderThrottled({
	sessionId = null,
	hubRootOverride,
	nowMs = Date.now(),
	cooldownMs = DEFAULT_CODEX_REMINDER_COOLDOWN_MS,
} = {}) {
	const stamp = readCodexReminderStamp(hubRootOverride);
	if (!stamp) return false;
	// Already reminded for this exact session: never remind again this session,
	// no matter how much more work happens or how much time passes.
	if (sessionId !== null && stamp.sessionId === sessionId) return true;
	// Cooldown backstop: a different or missing session_id shortly after the
	// last reminder is still throttled.
	return nowMs - stamp.remindedAtMs < cooldownMs;
}

/**
 * Record that the Codex reminder was emitted for this session_id. Never throws
 * — a failed stamp only risks one extra reminder, never a blocked session.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.sessionId]
 * @param {string} [opts.hubRootOverride] test-only override; production callers omit this
 * @param {number} [opts.nowMs]           test-only override; production callers omit this
 */
export function markCodexReminded({
	sessionId = null,
	hubRootOverride,
	nowMs = Date.now(),
} = {}) {
	try {
		const stamp = stampPath(hubRootOverride);
		fs.mkdirSync(path.dirname(stamp), { recursive: true });
		fs.writeFileSync(
			stamp,
			`${JSON.stringify({ sessionId, remindedAt: new Date(nowMs).toISOString() })}\n`,
		);
	} catch {
		// A failed stamp only risks a second reminder.
	}
}
