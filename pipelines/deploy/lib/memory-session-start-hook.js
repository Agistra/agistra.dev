import { hookHaystack, upsertOwnedHook } from './claude-hooks.js';

/**
 * Command run on Claude Code SessionStart to write the WAL session-start
 * marker (.claude/.session-start) that the memory-check Stop hook compares
 * memory writes against. Exec form, same reasoning as the relay hook in
 * claude-hooks.js: no shell interpretation, ${CLAUDE_PROJECT_DIR} anchored.
 */
export const MEMORY_SESSION_START_COMMAND = 'node';
export const MEMORY_SESSION_START_ARGS = [
	'${CLAUDE_PROJECT_DIR}/tools/memory-session-start.js',
];

/**
 * Ensure hub .claude/settings.json includes SessionStart → memory-session-start.
 * Idempotent — skips if a memory-session-start hook is already present.
 *
 * @param {object} settings
 * @returns {object}
 */
export function mergeMemorySessionStartHook(settings = {}) {
	const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
	const sessionStart = [...(next.hooks.SessionStart ?? [])];
	const hasHook = sessionStart.some((entry) =>
		entry.hooks?.some(
			(h) =>
				String(h.command ?? '').includes('memory-session-start') ||
				(Array.isArray(h.args) &&
					h.args.some((a) => String(a).includes('memory-session-start'))),
		),
	);
	if (!hasHook) {
		sessionStart.push({
			matcher: '',
			hooks: [
				{
					type: 'command',
					command: MEMORY_SESSION_START_COMMAND,
					args: MEMORY_SESSION_START_ARGS,
				},
			],
		});
	}
	next.hooks.SessionStart = sessionStart;
	return next;
}

/**
 * PostToolUse work-marker hook: touches .claude/.session-work whenever a tool
 * that changes something ran, so the memory-check Stop hook knows work happened.
 * Same exec form as above; the matcher limits it to the change tools (the
 * script filters again, so a payload with a read tool never writes the marker).
 */
export const MEMORY_WORK_MARKER_COMMAND = 'node';
export const MEMORY_WORK_MARKER_ARGS = [
	'${CLAUDE_PROJECT_DIR}/tools/memory-work-marker.js',
];
export const MEMORY_WORK_MARKER_MATCHER =
	'Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell';

/**
 * Ensure hub .claude/settings.json includes PostToolUse -> memory-work-marker.
 * Upsert via the shared helper: replaces our own entry with the current form,
 * keeps every other PostToolUse hook, and leaves exactly one of ours.
 *
 * @param {object} settings
 * @returns {object}
 */
export function mergeMemoryWorkMarkerHook(settings = {}) {
	return upsertOwnedHook(
		settings,
		'PostToolUse',
		(h) =>
			hookHaystack(h).some((s) =>
				/tools[\\/]memory-work-marker\.(sh|js)(?![\w-])/.test(s),
			),
		{
			matcher: MEMORY_WORK_MARKER_MATCHER,
			hooks: [
				{
					type: 'command',
					command: MEMORY_WORK_MARKER_COMMAND,
					args: MEMORY_WORK_MARKER_ARGS,
				},
			],
		},
	);
}
