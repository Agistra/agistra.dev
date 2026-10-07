/**
 * Flatten a hook's command and args into the strings used to identify which
 * script it runs (covers legacy shell-form `command` strings and exec-form
 * `args` arrays).
 *
 * @param {object} hook
 * @returns {string[]}
 */
export function hookHaystack(hook) {
	const args = Array.isArray(hook?.args) ? hook.args : [];
	return [String(hook?.command ?? ''), ...args.map(String)];
}

/**
 * Upsert a pipeline-owned hook into settings.hooks[event]. An existing hook is
 * "ours" when isOwned(hook) is true. Behaviour:
 *  - no owned hook present: append `entry`;
 *  - owned hook present: replace in place with `entry` (current command, args,
 *    matcher). If its entry also holds non-owned hooks, only the owned hook is
 *    removed from that entry (user hooks keep their original matcher) and the
 *    fresh entry is put at the same position;
 *  - duplicate owned hooks are collapsed into the first occurrence.
 * Hooks not owned by the pipeline are never touched. Pure: returns new settings.
 *
 * @param {object} settings
 * @param {string} event  hook event name, e.g. 'PreToolUse'
 * @param {(hook: object) => boolean} isOwned
 * @param {object} entry  full entry: { matcher, hooks: [...] }
 * @returns {object}
 */
export function upsertOwnedHook(settings, event, isOwned, entry) {
	const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
	const out = [];
	let placed = false;
	for (const existing of next.hooks[event] ?? []) {
		const hooks = Array.isArray(existing?.hooks) ? existing.hooks : [];
		if (!hooks.some(h => isOwned(h))) {
			out.push(existing);
			continue;
		}
		const others = hooks.filter(h => !isOwned(h));
		if (!placed) {
			out.push(entry);
			placed = true;
		}
		if (others.length > 0) out.push({ ...existing, hooks: others });
	}
	if (!placed) out.push(entry);
	next.hooks[event] = out;
	return next;
}

/**
 * Command run on Claude Code SessionStart, in exec form — bypasses shell
 * interpretation entirely so it runs identically regardless of which shell
 * Claude Code selects to spawn hooks (PowerShell on Windows does not expand
 * a bare $VAR the way bash does; exec form sidesteps that ambiguity per
 * https://code.claude.com/docs/en/hooks, "Reference scripts by path"/exec
 * form). ${CLAUDE_PROJECT_DIR} is anchored because Claude Code does not
 * guarantee a hook's working directory is the project root.
 */
export const RELAY_SESSION_START_COMMAND = 'node';
export const RELAY_SESSION_START_ARGS = ['${CLAUDE_PROJECT_DIR}/tools/ensure-relay-daemon.js'];

/**
 * Ensure hub .claude/settings.json includes SessionStart -> ensure-relay-daemon.
 * Upsert: replaces an existing relay hook with the current form; idempotent.
 *
 * @param {object} settings
 * @returns {object}
 */
export function mergeRelaySessionStartHook(settings = {}) {
	return upsertOwnedHook(
		settings,
		'SessionStart',
		h => hookHaystack(h).some(s => s.includes('ensure-relay-daemon')),
		{
			matcher: '',
			hooks: [{ type: 'command', command: RELAY_SESSION_START_COMMAND, args: RELAY_SESSION_START_ARGS }],
		},
	);
}

/** Memory-check Stop hook command (exec form, anchored to the project dir). */
export const MEMORY_CHECK_STOP_COMMAND = 'node';
export const MEMORY_CHECK_STOP_ARGS = ['${CLAUDE_PROJECT_DIR}/tools/memory-check.js'];

/**
 * Ensure hub .claude/settings.json includes Stop -> tools/memory-check.js.
 * Upsert: an old `bash .../tools/memory-check.sh` entry becomes the current
 * exec-form entry; idempotent.
 *
 * @param {object} settings
 * @returns {object}
 */
export function mergeMemoryCheckStopHook(settings = {}) {
	return upsertOwnedHook(
		settings,
		'Stop',
		h => hookHaystack(h).some(s => /tools[\\/]memory-check\.(sh|js)(?![\w-])/.test(s)),
		{
			matcher: '',
			hooks: [{ type: 'command', command: MEMORY_CHECK_STOP_COMMAND, args: MEMORY_CHECK_STOP_ARGS }],
		},
	);
}

// Tier-specific runtime hooks live in their own "*.hooks-plugin.js" file
// under lib/, rather than here. This file ships to every hub tier
// unconditionally (it also owns the relay daemon hook above), so it must stay
// generic and free of any tier-specific feature names — the same reasoning
// that moved certain optional-tier readiness checks and setup steps into
// their own "*.doctor-plugin.js" / "*.setup-plugin.js" files. Callers that
// need a tier's runtime hooks import its "*.hooks-plugin.js" file directly;
// those callers are themselves tier-gated or source-repo-only, so a direct
// import never leaks the feature name into a free "dev" hub.
