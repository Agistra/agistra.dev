#!/usr/bin/env node
/**
 * memory-check.js — Stop hook for Claude Code.
 * Called automatically after every agent session.
 *
 * Invoked via exec form (`{"command": "node", "args": ["${CLAUDE_PROJECT_DIR}
 * /tools/memory-check.js"]}`) so no shell — bash or PowerShell — has to
 * resolve or interpret this command. This is the exec-form Node counterpart
 * to memory-check.sh (kept unchanged for the Cursor/Copilot bash-invoked
 * adapters — see memory-check-cursor.sh / memory-check-copilot.sh).
 *
 * Delegates the platform-neutral check to memory-check-core.js, then applies
 * the Claude Code Stop-hook contract: a JSON object with
 * hookSpecificOutput.additionalContext on stdout, exit 0, feeds a reminder
 * back into the model before it closes without the "Stop hook error" label;
 * exit 0 with no output on clean. The reminder text
 * comes from memory-check-message.js (tier-aware memory root). Work evidence
 * comes from memory-check-evidence.js (Stop-hook stdin + transcript).
 */
import { checkMemoryStatus, markReminded } from './memory-check-core.js';
import {
	renderReminderLines,
	neutralizeFirstLine,
} from './memory-check-message.js';
import { readStdin, sessionWorkEvidence } from './memory-check-evidence.js';

// Evidence gating: the Stop hook runs at the end of every turn, so a greeting
// or a quick question must not be nagged. When the hook payload and transcript
// are readable and show no Edit/Write/NotebookEdit/MultiEdit call and no
// shell (Bash/PowerShell) call that is not provably read-only since the
// session-start marker, exit quietly. Otherwise (evidence unknown) fall
// back to marker-only behaviour.
const evidence = sessionWorkEvidence(await readStdin());
if (evidence === false) {
	process.exit(0);
}

const status = await checkMemoryStatus();

if (status !== 'dirty') {
	process.exit(0);
}

const [firstRaw, ...rest] = await renderReminderLines();
// Without transcript evidence we cannot claim files were changed.
const first = evidence === true ? firstRaw : neutralizeFirstLine(firstRaw);
// Once per stop: stamp so the same work is not reminded a second time.
markReminded();
// Reminder delivered as Stop-hook `additionalContext` on stdout with exit 0:
// Claude receives it and the turn continues, but the UI labels it "Stop hook
// feedback" instead of "Stop hook error". Exit 2 / decision:"block" both
// raise the error label. Verified against Claude Code 2.1.293.
const additionalContext = [first, ...rest].join('\n');
process.stdout.write(
	`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext } })}\n`,
);
process.exit(0);
