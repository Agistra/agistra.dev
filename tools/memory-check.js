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
 * the Claude Code Stop-hook contract: stderr text + exit 2 feeds a reminder
 * back into the model before it closes; exit 0 on clean. The reminder text
 * comes from memory-check-message.js (tier-aware memory root).
 */
import { checkMemoryStatus } from './memory-check-core.js';
import { renderReminderLines } from './memory-check-message.js';

const status = await checkMemoryStatus();

if (status !== 'dirty') {
	process.exit(0);
}

const [first, ...rest] = await renderReminderLines();
process.stderr.write('\n');
process.stderr.write(`⚠️  ${first}\n`);
for (const line of rest) {
	process.stderr.write(`   ${line}\n`);
}
process.stderr.write('\n');
process.exit(2);
