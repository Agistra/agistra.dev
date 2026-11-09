#!/usr/bin/env node
/**
 * memory-check-claude-throttle.js — recent-write and once-per-period gates for
 * the Claude Code Stop hook's WAL reminder (memory-check.js).
 *
 * Why this is a separate file from memory-check-core.js: the core is shared
 * with the Codex hook and mirrored by memory-check-core.sh for the Cursor and
 * Copilot adapters. This module is imported by memory-check.js only, and never
 * reads or writes the shared REMINDED_STAMP_RELATIVE_PATH, so Cursor, Copilot
 * and Codex behave exactly as before.
 *
 * Two gates, both silent-by-default so memory housekeeping stays invisible:
 *
 *   1. Recent write. When any memory *.md (outside archive/) was written within
 *      the window (default 10 minutes), the turn needs no reminder: the agent
 *      is already keeping its memory. The shared core only compares the memory
 *      write with the work marker, so a long session with a memory write ten
 *      minutes ago and a few edits since still looked "dirty".
 *   2. Once per session per work period. After a reminder, no second one for
 *      the same Claude Code `session_id` until the work period has passed
 *      (default 60 minutes). A different session_id is a new session and gets
 *      its own reminder; a missing session_id is held to the same period.
 *
 * Stamp state lives in `.claude/.claude-reminded.json` (gitignored, outside
 * the memory root), a new file separate from the shared markers and the
 * Codex stamp.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
	resolveHubRoot,
	resolveMemoryRootSegment,
} from './memory-check-core.js';

/** Claude Code throttle stamp, relative to the hub root. Gitignored; never inside vault/. */
export const CLAUDE_REMINDER_STAMP_RELATIVE_PATH =
	'.claude/.claude-reminded.json';

/** A memory write this recent means no reminder is needed. */
export const DEFAULT_RECENT_MEMORY_WRITE_WINDOW_MS = 10 * 60 * 1000;

/** Once reminded, the same session is not reminded again for this long (one work period). */
export const DEFAULT_CLAUDE_REMINDER_PERIOD_MS = 60 * 60 * 1000;

/**
 * @param {string} dir directory to scan recursively
 * @param {number} cutoffMs mtime threshold in ms
 * @returns {boolean} true if any *.md file (excluding archive/ directories) is at or after the cutoff
 */
function hasMarkdownSince(dir, cutoffMs) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'archive') continue;
			if (hasMarkdownSince(full, cutoffMs)) return true;
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
		try {
			if (fs.statSync(full).mtimeMs >= cutoffMs) return true;
		} catch {
			// Ignore files that vanish between readdir and stat.
		}
	}
	return false;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.hubRootOverride] test-only override; production callers omit this
 * @param {number} [opts.nowMs]           test-only override; production callers omit this
 * @param {number} [opts.windowMs]
 * @returns {Promise<boolean>} true when a memory *.md was written inside the window
 */
export async function hasRecentMemoryWrite({
	hubRootOverride,
	nowMs = Date.now(),
	windowMs = DEFAULT_RECENT_MEMORY_WRITE_WINDOW_MS,
} = {}) {
	const hubRoot = hubRootOverride ?? resolveHubRoot();
	const memoryDir = path.join(hubRoot, await resolveMemoryRootSegment(hubRoot));
	return hasMarkdownSince(memoryDir, nowMs - windowMs);
}

/**
 * The `session_id` of a Claude Code Stop-hook payload, or null when the stdin
 * text is empty, not JSON, or carries no string session_id.
 *
 * @param {string} stdinText
 * @returns {string|null}
 */
export function sessionIdFromStdin(stdinText) {
	try {
		const payload = JSON.parse(stdinText);
		return typeof payload?.session_id === 'string' && payload.session_id !== ''
			? payload.session_id
			: null;
	} catch {
		return null;
	}
}

function stampPath(hubRootOverride) {
	return path.join(
		hubRootOverride ?? resolveHubRoot(),
		CLAUDE_REMINDER_STAMP_RELATIVE_PATH,
	);
}

/**
 * @param {string} [hubRootOverride] test-only override; production callers omit this
 * @returns {{ sessionId: string|null, remindedAtMs: number } | null}
 */
export function readClaudeReminderStamp(hubRootOverride) {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(stampPath(hubRootOverride), 'utf-8'));
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
 * @param {string|null} [opts.sessionId]  Current Claude Code `session_id`, or null when absent.
 * @param {string} [opts.hubRootOverride] test-only override; production callers omit this
 * @param {number} [opts.nowMs]           test-only override; production callers omit this
 * @param {number} [opts.periodMs]
 * @returns {boolean} true when the Stop-hook reminder must be suppressed this turn
 */
export function isClaudeReminderThrottled({
	sessionId = null,
	hubRootOverride,
	nowMs = Date.now(),
	periodMs = DEFAULT_CLAUDE_REMINDER_PERIOD_MS,
} = {}) {
	const stamp = readClaudeReminderStamp(hubRootOverride);
	if (!stamp) return false;
	const withinPeriod = nowMs - stamp.remindedAtMs < periodMs;
	// A known, different session is a new session: it gets its own reminder.
	if (sessionId !== null && stamp.sessionId !== null) {
		return sessionId === stamp.sessionId && withinPeriod;
	}
	// A missing session_id on either side is held to the period alone.
	return withinPeriod;
}

/**
 * Record that a reminder was emitted. Never throws: a failed stamp only risks
 * one extra reminder.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.sessionId]
 * @param {string} [opts.hubRootOverride] test-only override; production callers omit this
 * @param {number} [opts.nowMs]           test-only override; production callers omit this
 */
export function markClaudeReminded({
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
