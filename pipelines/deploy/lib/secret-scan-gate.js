#!/usr/bin/env node
/**
 * secret-scan-gate.js — PreToolUse gate script enforcing a pre-write secret
 * scan on direct `Edit`/`Write` tool calls. Wired via
 * secret-scan.hooks-plugin.js into .claude/settings.json (see that file's
 * doc comment for why Cursor/Codex/Copilot have no equivalent wiring today).
 *
 * This is the third of three enforcement points using the shared scanner —
 * packages/vault/vault-guard.cjs and pipelines/deploy/lib/task-cli.js cover
 * the other two application-layer write paths. This hook exists specifically
 * to cover (a) free-tier (dev/dev:graph) direct `Edit`/`Write` calls against
 * memory/task/doc files, which have no application-layer guard in front of
 * them at all, and (b) the documented MCP-down fallback on vault tiers
 * (storage/obsidian.md), which uses this same `Edit` tool.
 *
 * Invoked as:
 *   node pipelines/deploy/lib/secret-scan-gate.js
 *
 * Matcher: Edit|Write (see secret-scan.hooks-plugin.js).
 *
 * Reads the Claude Code hook input JSON from stdin (tool_name, tool_input)
 * and writes a hookSpecificOutput JSON decision to stdout — 'deny' (naming
 * the matched category and line, never the matched string — see
 * secret-scan.js's formatSecretScanError) on a match, 'allow' otherwise.
 * Same structured PreToolUse decision shape graph-lens-gate.js already uses
 * in this hub (permissionDecision: 'allow'/'deny'), not a raw exit-code-2
 * block — kept consistent with the one existing PreToolUse precedent here.
 *
 * Path scoping: only file paths under a memory/task/doc/learnings-shaped top-
 * level folder are scanned — free-tier shapes (memory/, projects/, docs/,
 * .learnings/) and vault-tier shapes (Memory/, Tasks/, Docs/, Research/,
 * Drafts/ — see storage/obsidian.md's folder-mapping table). Any other path
 * (source code, config, skills, etc.) is allowed without scanning at all —
 * this hook has no way to know the hub's hubType at hook-invocation time, so
 * it checks both shapes rather than guessing which tier it is running on.
 *
 * Content scanned: `Write`'s tool_input.content (the full new file content);
 * `Edit`'s tool_input.new_string (the text being introduced — old_string is
 * content already on disk before this call, not newly introduced, so it is
 * not scanned).
 *
 * Fail-open: any error anywhere in this script (missing/malformed hook
 * input, an exception thrown while scanning) resolves to 'allow' plus a
 * stderr log line, same fail-open posture as graph-lens-gate.js. This is a
 * crash-resilience decision, not an opt-out — the design explicitly rejects a
 * *deliberate* override/opt-out flag; a hook crashing on malformed input is a
 * different failure mode, and must never deadlock every Edit/Write call
 * hub-wide the way a fail-closed gate would on its first bug.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForSecrets, formatSecretScanError } from './secret-scan.js';

const ALLOW_PRE_TOOL_USE = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };

/**
 * Top-level folder names (case-insensitive) this gate scans under. Free-tier
 * and vault-tier shapes both included — see doc comment above.
 */
const SCOPED_TOP_LEVEL_DIRS = new Set([
	'memory', 'projects', 'docs', '.learnings', // free-tier (repo-files.md)
	'tasks', 'research', 'drafts', // vault-tier additions (storage/obsidian.md) — 'memory'/'docs' already covered above (case-insensitive)
]);

/**
 * Returns true if `filePath`'s first path segment is one of the scoped
 * memory/task/doc/learnings-shaped folders (case-insensitive, `\` and `/`
 * both treated as separators). Absolute or relative paths both work — only
 * the first segment matters, so a hub-root-relative or a fully-resolved
 * absolute path (`<hubRoot>/memory/builder.md`) both correctly report false
 * if `<hubRoot>`'s own name happens not to be one of these — deliberately:
 * this checks position from the END for absolute paths too, since an
 * absolute path's first segment is a drive/root, not `memory`.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isScopedPath(filePath) {
	if (!filePath || typeof filePath !== 'string') return false;
	const segments = filePath.split(/[\\/]/).filter(Boolean);
	return segments.some(segment => SCOPED_TOP_LEVEL_DIRS.has(segment.toLowerCase()));
}

/**
 * Core PreToolUse handler (Edit|Write matcher).
 *
 * @param {object} hookInput  Claude Code PreToolUse hook input (parsed JSON).
 * @returns {object} hookSpecificOutput payload — allow or deny.
 */
export function decidePreToolUse(hookInput) {
	const toolName = hookInput?.tool_name;
	const filePath = hookInput?.tool_input?.file_path;
	if (!filePath || !isScopedPath(filePath)) return ALLOW_PRE_TOOL_USE;

	let content = null;
	if (toolName === 'Write') {
		content = hookInput?.tool_input?.content;
	} else if (toolName === 'Edit') {
		content = hookInput?.tool_input?.new_string;
	}
	if (typeof content !== 'string' || content.length === 0) return ALLOW_PRE_TOOL_USE;

	const match = scanForSecrets(content);
	if (!match) return ALLOW_PRE_TOOL_USE;

	return {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: formatSecretScanError(match),
		},
	};
}

// ── CLI entry point ───────────────────────────────────────────────────────────

/**
 * Read all of stdin synchronously — same rationale as graph-lens-gate.js's
 * readStdinSync: Claude Code pipes the hook input JSON to stdin and waits for
 * the process to exit.
 *
 * @param {object} [fsMod]
 * @returns {string}
 */
export function readStdinSync(fsMod = fs) {
	try {
		return fsMod.readFileSync(0, 'utf-8');
	} catch {
		return '';
	}
}

/**
 * Run one gate invocation end-to-end: parse stdin, dispatch to
 * decidePreToolUse, write the JSON result to stdout. Fail-open at every
 * stage — see the fail-open doc comment above.
 *
 * @param {object} [options]
 * @param {object} [options.fsMod]
 * @param {function(string): void} [options.stdoutWrite]
 * @param {function(string): void} [options.stderrWrite]
 * @returns {number} process exit code (always 0 — fail-open never exits non-zero)
 */
export function runGate({ fsMod = fs, stdoutWrite = (s) => process.stdout.write(s), stderrWrite = (s) => process.stderr.write(s) } = {}) {
	let hookInput;
	try {
		const raw = readStdinSync(fsMod);
		hookInput = raw ? JSON.parse(raw) : {};
	} catch (err) {
		stderrWrite(`secret-scan-gate: failed to parse hook input JSON (failing open): ${err.message}\n`);
		stdoutWrite(JSON.stringify(ALLOW_PRE_TOOL_USE));
		return 0;
	}

	try {
		const result = decidePreToolUse(hookInput);
		stdoutWrite(JSON.stringify(result));
		return 0;
	} catch (err) {
		stderrWrite(`secret-scan-gate: gate error (failing open): ${err.message}\n`);
		stdoutWrite(JSON.stringify(ALLOW_PRE_TOOL_USE));
		return 0;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	process.exitCode = runGate();
}
