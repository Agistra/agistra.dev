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
 * back into the model before it closes; exit 0 on clean.
 */
import { checkMemoryStatus } from './memory-check-core.js';

const status = await checkMemoryStatus();

if (status !== 'dirty') {
	process.exit(0);
}

process.stderr.write('\n');
process.stderr.write('⚠️  Memory check: files were changed this session but memory/ was not updated.\n');
process.stderr.write('   Before closing, update the HOT section in memory/<agent>.md with any\n');
process.stderr.write('   decisions, corrections, or new context from this session.\n');
process.stderr.write('   (WAL protocol — write first, respond second.)\n');
process.stderr.write('\n');
process.exit(2);
