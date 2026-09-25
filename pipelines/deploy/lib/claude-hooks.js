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
 * Ensure hub .claude/settings.json includes SessionStart → ensure-relay-daemon.
 * Idempotent — skips if hook already present.
 *
 * @param {object} settings
 * @returns {object}
 */
export function mergeRelaySessionStartHook(settings = {}) {
	const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
	const sessionStart = [...(next.hooks.SessionStart ?? [])];
	const hasRelayHook = sessionStart.some(entry =>
		entry.hooks?.some(h =>
			String(h.command ?? '').includes('ensure-relay-daemon') ||
			(Array.isArray(h.args) && h.args.some(a => String(a).includes('ensure-relay-daemon'))),
		),
	);
	if (!hasRelayHook) {
		sessionStart.push({
			matcher: '',
			hooks: [{ type: 'command', command: RELAY_SESSION_START_COMMAND, args: RELAY_SESSION_START_ARGS }],
		});
	}
	next.hooks.SessionStart = sessionStart;
	return next;
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
