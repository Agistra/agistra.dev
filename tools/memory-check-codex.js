#!/usr/bin/env node
/**
 * memory-check-codex.js — Stop hook for Codex.
 *
 * Codex Stop contract: hook JSON on stdin (session_id, cwd, transcript_path,
 * turn_id, stop_hook_active, last_assistant_message); output JSON on stdout.
 * Per the Codex hooks doc, "Common output fields"
 * (https://learn.chatgpt.com/docs/hooks#common-output-fields): Stop supports
 * `systemMessage` ("Surfaced as a warning in the UI or event stream"), and
 * per the Stop-specific section
 * (https://learn.chatgpt.com/docs/hooks#stop): "JSON on stdout supports
 * Common output fields. To keep Codex going, return: {"decision": "block",
 * "reason": ...}" — i.e. only `decision: "block"` forces a continuation;
 * `systemMessage` alone (exit 0, no `decision`) surfaces a user-visible
 * warning without costing an extra model turn. This hook uses `systemMessage`
 * instead of `decision: "block"` for exactly that reason.
 *
 * Gating: silent unless memory-check-core reports dirty (work marker newer
 * than the session marker, no memory write after it) AND the Codex-only
 * throttle (memory-check-codex-throttle.js) is not active. stop_hook_active
 * (camelCase also accepted) means the turn was already forced to continue:
 * never remind then.
 *
 * Throttle: reminds at most once per Codex session_id, with a cooldown
 * backstop (default 30 minutes) for a missing/changed session_id — see
 * memory-check-codex-throttle.js's header for why this is a Codex-only stamp,
 * never the shared REMINDED_STAMP_RELATIVE_PATH memory-check-core.js's
 * markReminded() writes for Claude Code's own Stop hook (memory-check.js).
 * Cursor/Copilot (the bash adapters) are untouched by this file either way.
 *
 * Without a work marker (hooks.json PostToolUse missing or the hook feature
 * disabled) the marker-only fallback applies with neutral wording. Always
 * exits 0 so a failure here never blocks the session.
 */
import { checkMemoryStatus, hasSessionWork } from './memory-check-core.js';
import {
	renderReminderLines,
	neutralizeFirstLine,
} from './memory-check-message.js';
import { readStdin } from './memory-check-evidence.js';
import {
	isCodexReminderThrottled,
	markCodexReminded,
} from './memory-check-codex-throttle.js';

try {
	let payload = {};
	try {
		const parsed = JSON.parse(await readStdin());
		if (parsed && typeof parsed === 'object') payload = parsed;
	} catch {
		// Missing or invalid stdin: proceed without the loop flag.
	}
	if (payload.stop_hook_active === true || payload.stopHookActive === true)
		process.exit(0);

	const sessionId =
		typeof payload.session_id === 'string' ? payload.session_id : null;

	if (
		(await checkMemoryStatus()) === 'dirty' &&
		!isCodexReminderThrottled({ sessionId })
	) {
		const [first, ...rest] = await renderReminderLines();
		const lines = [
			hasSessionWork() ? first : neutralizeFirstLine(first),
			...rest,
		];
		markCodexReminded({ sessionId });
		process.stdout.write(
			`${JSON.stringify({ systemMessage: lines.join('\n') })}\n`,
		);
	}
} catch {
	// Swallow: see header.
}
process.exit(0);
