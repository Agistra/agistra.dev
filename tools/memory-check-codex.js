#!/usr/bin/env node
/**
 * memory-check-codex.js — Stop hook for Codex.
 *
 * Codex Stop contract: hook JSON on stdin (session_id, cwd, transcript_path,
 * turn_id, stop_hook_active, last_assistant_message); output JSON on stdout.
 * {"decision":"block","reason":"<text>"} makes Codex continue with the reason
 * as the next prompt; no output (exit 0) lets it stop. Plain text on stdout is
 * invalid for this event.
 *
 * Gating: silent unless memory-check-core reports dirty (work marker newer
 * than the session marker, no memory write after it, not yet reminded).
 * stop_hook_active (camelCase also accepted) means the turn was already
 * forced to continue: never block then. The reminded stamp makes it once per
 * work. Without a work marker (hooks.json PostToolUse missing or the hook
 * feature disabled) the marker-only fallback applies with neutral wording.
 * Always exits 0 so a failure here never blocks the session.
 */
import { checkMemoryStatus, hasSessionWork, markReminded } from './memory-check-core.js';
import { renderReminderLines, neutralizeFirstLine } from './memory-check-message.js';
import { readStdin } from './memory-check-evidence.js';

try {
	let payload = {};
	try {
		const parsed = JSON.parse(await readStdin());
		if (parsed && typeof parsed === 'object') payload = parsed;
	} catch {
		// Missing or invalid stdin: proceed without the loop flag.
	}
	if (payload.stop_hook_active === true || payload.stopHookActive === true) process.exit(0);

	if ((await checkMemoryStatus()) === 'dirty') {
		const [first, ...rest] = await renderReminderLines();
		const lines = [hasSessionWork() ? first : neutralizeFirstLine(first), ...rest];
		markReminded();
		process.stdout.write(`${JSON.stringify({ decision: 'block', reason: lines.join('\n') })}\n`);
	}
} catch {
	// Swallow: see header.
}
process.exit(0);
