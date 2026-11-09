import {
	hookHaystack,
	upsertOwnedHook,
	removeOwnedHook,
} from './claude-hooks.js';

/**
 * Codex hooks for the WAL memory reminder, written to <hub>/.codex/hooks.json.
 *
 * The file uses the same shape as Claude Code settings ({ hooks: { Event:
 * [{ matcher, hooks: [handler] }] } }), so the entries are merged with the same
 * upsertOwnedHook() helper: our own entries (identified by the script they run)
 * are replaced, every other hook in the file is kept.
 *
 * Commands are relative to the hub root, which is where Codex runs repo hooks.
 * The command is identical on Windows (`node tools/x.js` runs in cmd and
 * PowerShell alike), so no `commandWindows` override is written.
 *
 * Events: SessionStart writes the session marker, PostToolUse writes the work
 * marker, Stop surfaces a `systemMessage` reminder (see memory-check-codex.js)
 * throttled to at most once per Codex session_id plus a cooldown.
 *
 * Opt-out: `reminderEnabled: false` (targets/codex.js reads this from the
 * hub's `codexMemoryReminder.enabled` in workspace.config.json — the same
 * `{ enabled }` shape doctor.js's `nightlyDreaming` config already uses)
 * removes the owned Stop hook via removeOwnedHook() instead of upserting it.
 * SessionStart and PostToolUse are never gated by this option — they are
 * cheap and silent, and other features (e.g. the memory-check-core.js dirty
 * check itself) depend on the markers they write.
 */
const MEMORY_SESSION_START = /tools[\\/]memory-session-start\.(sh|js)(?![\w-])/;
const MEMORY_WORK_MARKER = /tools[\\/]memory-work-marker\.(sh|js)(?![\w-])/;
const MEMORY_CHECK_CODEX = /tools[\\/]memory-check-codex\.js(?![\w-])/;

const handler = (script) => ({
	type: 'command',
	command: `node tools/${script}`,
	timeout: 30,
});
const owns = (pattern) => (hook) =>
	hookHaystack(hook).some((s) => pattern.test(s));

/** PostToolUse matcher: Codex shell and file-edit tools (the script filters again). */
export const CODEX_WORK_MATCHER = 'Bash|apply_patch|Edit|Write';

/**
 * @param {object} hooksFile  parsed .codex/hooks.json ({} when absent)
 * @param {object} [opts]
 * @param {boolean} [opts.reminderEnabled]  Default true (today's behaviour).
 *   false removes the owned Stop hook instead of upserting it; SessionStart
 *   and PostToolUse are added either way.
 * @returns {object} new hooks file with exactly one of each owned hook
 */
export function mergeCodexMemoryHooks(
	hooksFile = {},
	{ reminderEnabled = true } = {},
) {
	let next = hooksFile;
	next = upsertOwnedHook(next, 'SessionStart', owns(MEMORY_SESSION_START), {
		hooks: [handler('memory-session-start.js')],
	});
	next = upsertOwnedHook(next, 'PostToolUse', owns(MEMORY_WORK_MARKER), {
		matcher: CODEX_WORK_MATCHER,
		hooks: [handler('memory-work-marker.js')],
	});
	next = reminderEnabled
		? upsertOwnedHook(next, 'Stop', owns(MEMORY_CHECK_CODEX), {
				hooks: [handler('memory-check-codex.js')],
			})
		: removeOwnedHook(next, 'Stop', owns(MEMORY_CHECK_CODEX));
	return next;
}

/**
 * Whether `hooksFile` currently has the owned Codex memory-reminder Stop hook
 * — used by doctor.js (check 25) to cross-check `codexMemoryReminder.enabled`
 * in workspace.config.json against what was actually deployed, the same way
 * check 18 cross-checks `nightlyDreaming.enabled` against the registered
 * Scheduled Task. Exported so doctor.js never duplicates the MEMORY_CHECK_CODEX
 * pattern.
 *
 * @param {object} hooksFile  parsed .codex/hooks.json
 * @returns {boolean}
 */
export function hasCodexMemoryReminderHook(hooksFile = {}) {
	const stopEntries = Array.isArray(hooksFile?.hooks?.Stop)
		? hooksFile.hooks.Stop
		: [];
	return stopEntries.some((entry) =>
		(Array.isArray(entry?.hooks) ? entry.hooks : []).some(
			owns(MEMORY_CHECK_CODEX),
		),
	);
}
