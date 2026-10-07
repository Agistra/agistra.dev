#!/usr/bin/env node
/**
 * memory-work-marker.js — post-tool-use hook shared by every adapter.
 *
 * Reads the hook JSON on stdin (empty or invalid input is tolerated), decides
 * whether the tool just run changed something (file edit/write tools, shell or
 * Bash execution; not reads or searches) and, if so, touches the work marker.
 * A shell call whose command text (tool_input.command, or the top-level
 * command of Cursor afterShellExecution) is made only of allowlisted read-only
 * verbs is not a change; unknown, unparseable or missing command text counts
 * as a change (fail safe). The marker is .claude/.session-work in the hub
 * root; memory-check-core.* compares that
 * marker with the session-start marker and the memory files to decide whether
 * a memory reminder is due. Gitignored runtime state, never inside vault/.
 *
 * Accepted payload shapes (camelCase and snake_case, missing fields tolerated):
 *   Claude Code / Codex / Cursor postToolUse / VS Code Copilot:
 *     { "tool_name": "Edit" | "Bash" | "Shell" | "apply_patch" | ... }
 *   GitHub Copilot CLI postToolUse: { "toolName": "edit" | "bash" | ... }
 *   Cursor afterFileEdit:        { "file_path": "...", "edits": [...] }
 *   Cursor afterShellExecution:  { "command": "..." }
 * With no recognisable field nothing is written; the check then falls back to
 * the marker-only behaviour. Always exits 0 and prints nothing: a failed
 * marker write must never block or alter a tool call.
 *
 * memory-work-marker.sh is the bash twin for the adapters that call bash.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHubRoot, resolveMemoryRootSegment, WORK_MARKER_RELATIVE_PATH } from './memory-check-core.js';
import { readStdin } from './memory-check-evidence.js';

// Tool names are matched on their lowercase alphanumeric form so that
// "Edit", "str_replace_editor", "run_in_terminal" and "apply_patch" all work.
const READ_ONLY = /read|view|grep|glob|search|list|fetch|todo|think|output|^get/;
const CHANGES = /edit|write|create|replace|patch|delete|remove|insert|move|rename|bash|shell|powershell|terminal|exec|command|run|apply/;

/**
 * @param {string} toolName
 * @returns {boolean} true when the tool name looks like a change (edit/write/shell)
 */
export function isChangingTool(toolName) {
	const name = String(toolName).toLowerCase().replace(/[^a-z0-9]/g, '');
	if (!name || READ_ONLY.test(name)) return false;
	return CHANGES.test(name);
}

const SHELL_TOOL = /bash|shell|powershell|terminal|exec|command|run/;

// Verbs that never change anything on their own, matched lowercase.
const READ_ONLY_VERBS = new Set([
	'ls', 'dir', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'date', 'pwd', 'stat', 'wc',
	'get-content', 'get-childitem', 'get-date', 'select-string', 'test-path',
]);
const GIT_READ_ONLY = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'merge-base']);
const GH_AREAS = new Set(['pr', 'issue', 'run']);
const GH_ACTIONS = new Set(['view', 'list', 'checks']);
const FIND_WRITE_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
// Anything here means the command may write, chain or substitute: work.
const UNSAFE_CHARS = /[>;&<`\n\r]|\$\(/;
const WRITE_WORDS = /(^|[^a-z0-9_-])(tee|out-file|set-content|add-content)($|[^a-z0-9_-])/;

/**
 * @param {string} segment one pipeline segment
 * @returns {boolean} true when the segment starts with an allowlisted read-only verb
 */
function isReadOnlySegment(segment) {
	const words = segment.trim().split(/\s+/);
	const verb = words[0].toLowerCase();
	if (!verb) return false;
	if (verb === 'git') {
		if (words.some(w => w.toLowerCase().startsWith('--output'))) return false;
		const sub = (words[1] ?? '').toLowerCase();
		return GIT_READ_ONLY.has(sub) || (sub === 'branch' && words[2] === '--list');
	}
	if (verb === 'gh') {
		const area = (words[1] ?? '').toLowerCase();
		const action = (words[2] ?? '').toLowerCase();
		return (GH_AREAS.has(area) && GH_ACTIONS.has(action)) || (area === 'repo' && action === 'view');
	}
	if (!READ_ONLY_VERBS.has(verb)) return false;
	const args = words.slice(1).map(w => w.toLowerCase());
	if (verb === 'find') return !args.some(a => FIND_WRITE_FLAGS.has(a));
	if (verb === 'date') return !args.some(a => a === '-s' || a.startsWith('--set'));
	if (verb === 'rg') return !args.some(a => a === '--pre' || a.startsWith('--pre='));
	return true;
}

/**
 * Whole-command check for shell tools. Conservative: any doubt means "not read-only".
 * @param {unknown} command shell command text
 * @returns {boolean} true only when every pipeline segment is an allowlisted read-only verb
 */
export function isReadOnlyCommand(command) {
	if (typeof command !== 'string' || !command.trim()) return false;
	if (UNSAFE_CHARS.test(command) || WRITE_WORDS.test(command.toLowerCase())) return false;
	return command.split('|').every(isReadOnlySegment);
}

/**
 * Canonical comparison form of a path: forward slashes, no duplicate slashes,
 * lowercase when it is a Windows drive path. Null when it contains "." or ".."
 * segments (never excused).
 * @param {string} p
 * @returns {string|null}
 */
function canonicalPath(p) {
	let c = p.split(String.fromCharCode(92)).join('/').replace(/\/{2,}/g, '/');
	if (/^[a-z]:\//i.test(c)) c = c.toLowerCase();
	if (c.split('/').some(seg => seg === '.' || seg === '..')) return null;
	return c.replace(/\/$/, '');
}

/**
 * @param {unknown} filePath path an edit tool targeted
 * @param {string|undefined} memoryRoot absolute memory root of the hub
 * @returns {boolean} true when the path is a live memory note (*.md under the root, not archive/)
 */
function isMemoryNote(filePath, memoryRoot) {
	if (typeof filePath !== 'string' || !filePath || !memoryRoot) return false;
	const file = canonicalPath(filePath);
	const root = canonicalPath(memoryRoot);
	if (!file || !root || !file.startsWith(`${root}/`)) return false;
	const rel = file.slice(root.length + 1);
	return rel.endsWith('.md') && !rel.split('/').slice(0, -1).includes('archive');
}

/**
 * @param {string} stdinText raw hook stdin
 * @param {string} [memoryRoot] absolute tier memory root; edits to notes under it are not work
 * @returns {boolean} true when the payload describes a change
 */
export function isWorkPayload(stdinText, memoryRoot) {
	let payload;
	try {
		payload = JSON.parse(stdinText);
	} catch {
		return false;
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
	const toolName = payload.tool_name ?? payload.toolName;
	if (typeof toolName === 'string' && toolName) {
		if (!isChangingTool(toolName)) return false;
		const name = toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
		// A shell call is not work only when its command text is provably read-only.
		if (SHELL_TOOL.test(name) && isReadOnlyCommand(payload.tool_input?.command)) return false;
		const input = payload.tool_input;
		if (!SHELL_TOOL.test(name) && isMemoryNote(input?.file_path ?? input?.filePath ?? input?.path, memoryRoot)) return false;
		return true;
	}
	// Cursor afterFileEdit / afterShellExecution carry no tool name.
	const editedPath = payload.file_path ?? payload.filePath;
	if (typeof editedPath === 'string') return !isMemoryNote(editedPath, memoryRoot);
	return typeof payload.command === 'string' && !isReadOnlyCommand(payload.command);
}

/**
 * @param {string} [hubRootOverride] test-only override
 */
export function touchWorkMarker(hubRootOverride) {
	const markerPath = path.join(hubRootOverride ?? resolveHubRoot(), WORK_MARKER_RELATIVE_PATH);
	fs.mkdirSync(path.dirname(markerPath), { recursive: true });
	fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	try {
		const hubRoot = resolveHubRoot();
		const memoryRoot = path.join(hubRoot, await resolveMemoryRootSegment(hubRoot));
		if (isWorkPayload(await readStdin(), memoryRoot)) touchWorkMarker(hubRoot);
	} catch {
		// Swallow: see header.
	}
	process.exit(0);
}
