#!/usr/bin/env node
/**
 * memory-session-start.js — SessionStart hook for Claude Code.
 *
 * Writes the session-start marker (an ISO timestamp, mtime = now) that the
 * WAL memory-check Stop hook compares memory writes against. The marker lives
 * at .claude/.session-start in the hub root: gitignored runtime state, never
 * inside the memory root. Always exits 0 — a failed marker write must never
 * block a session (the Stop hook falls back to a 240-minute window).
 *
 * Invoked via exec form (command "node", args ["${CLAUDE_PROJECT_DIR}/tools/
 * memory-session-start.js"]); memory-session-start.sh is the bash twin for
 * the Cursor/Copilot adapters.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHubRoot, SESSION_MARKER_RELATIVE_PATH, WORK_MARKER_RELATIVE_PATH } from './memory-check-core.js';

try {
	const markerPath = path.join(resolveHubRoot(), SESSION_MARKER_RELATIVE_PATH);
	fs.mkdirSync(path.dirname(markerPath), { recursive: true });
	fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`);
	// Initialise the work marker at the Unix epoch when absent: "present but older
	// than the session marker" means no work yet (silent), whereas an absent
	// marker means the adapter has no post-tool hook (marker-only fallback).
	const workPath = path.join(path.dirname(markerPath), path.basename(WORK_MARKER_RELATIVE_PATH));
	if (!fs.existsSync(workPath)) {
		fs.writeFileSync(workPath, '');
		fs.utimesSync(workPath, 0, 0);
	}
} catch {
	// Swallow: see header.
}
process.exit(0);
