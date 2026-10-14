/**
 * memory-check-evidence.js — decides whether real work happened this session,
 * from the Claude Code Stop-hook payload (JSON on stdin) and the transcript it
 * points at (JSONL, `transcript_path`).
 *
 * Work evidence is an assistant `tool_use` block named Edit, Write,
 * NotebookEdit or MultiEdit, or a shell block (Bash, PowerShell) whose
 * command is not provably read-only (the same isReadOnlyCommand() the
 * work-marker hook uses; missing command text counts as work), dated after the session-start marker's
 * mtime (or after the 240-minute window when no marker exists). Lines without
 * a `timestamp` count as in scope. Only the tail of the transcript is read.
 *
 * sessionWorkEvidence() resolves to:
 *   true   work evidence found
 *   false  transcript readable, no work evidence (greeting or Q&A only)
 *   null   unknown (no/invalid stdin, no transcript_path, unreadable or
 *          unparsable transcript): callers fall back to marker-only behaviour
 */
import fs from 'node:fs';
import path from 'node:path';
import {
	resolveHubRoot,
	SESSION_MARKER_RELATIVE_PATH,
} from './memory-check-core.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// ── Shared work classifier ──────────────────────────────────────────────────
// One rule for "is this shell command read-only", used by the work-marker hook
// and by the Stop-hook evidence gate so the two cannot disagree.

// Verbs that never change anything on their own, matched lowercase.
const READ_ONLY_VERBS = new Set([
	'ls',
	'dir',
	'cat',
	'head',
	'tail',
	'grep',
	'rg',
	'find',
	'date',
	'pwd',
	'stat',
	'wc',
	'get-content',
	'get-childitem',
	'get-date',
	'select-string',
	'test-path',
]);
const GIT_READ_ONLY = new Set([
	'status',
	'log',
	'diff',
	'show',
	'rev-parse',
	'merge-base',
]);
const GH_AREAS = new Set(['pr', 'issue', 'run']);
const GH_ACTIONS = new Set(['view', 'list', 'checks']);
// Exact hub commands that are known read-only but are scripts, so they cannot be
// matched by verb. Compared whole (whitespace-collapsed): any extra argument, pipe or
// redirect makes the command differ and it falls back to the normal rules.
const EXACT_READ_ONLY_COMMANDS = new Set([
	'node pipelines/deploy/lib/version-check.js',
	'npm run version:check',
]);
const FIND_WRITE_FLAGS = new Set([
	'-delete',
	'-exec',
	'-execdir',
	'-ok',
	'-okdir',
	'-fprint',
	'-fprint0',
	'-fprintf',
	'-fls',
]);
// Anything here means the command may write, chain or substitute: work.
const UNSAFE_CHARS = /[>;&<`\n\r]|\$\(/;
const WRITE_WORDS =
	/(^|[^a-z0-9_-])(tee|out-file|set-content|add-content)($|[^a-z0-9_-])/;
// A single leading "cd <path> &&": the path is one bare or quoted token with no metacharacters.
const CD_PREFIX =
	/^\s*cd\s+("[^"&;|<>`$\r\n]+"|'[^'&;|<>`$\r\n]+'|[^\s"'&;|<>`$()\r\n]+)\s*&&\s*(.*)$/s;

/**
 * @param {string} segment one pipeline segment
 * @returns {boolean} true when the segment starts with an allowlisted read-only verb
 */
function isReadOnlySegment(segment) {
	const words = segment.trim().split(/\s+/);
	const verb = words[0].toLowerCase();
	if (!verb) return false;
	if (verb === 'git') {
		if (words.some((w) => w.toLowerCase().startsWith('--output'))) return false;
		// "git -C <path> <verb>": one bare path token, then the verb.
		let i = 1;
		if (words[1] === '-C') {
			if (!words[2] || words[2].startsWith('-')) return false;
			i = 3;
		}
		const sub = (words[i] ?? '').toLowerCase();
		return (
			GIT_READ_ONLY.has(sub) || (sub === 'branch' && words[i + 1] === '--list')
		);
	}
	if (verb === 'gh') {
		const area = (words[1] ?? '').toLowerCase();
		const action = (words[2] ?? '').toLowerCase();
		return (
			(GH_AREAS.has(area) && GH_ACTIONS.has(action)) ||
			(area === 'repo' && action === 'view')
		);
	}
	if (!READ_ONLY_VERBS.has(verb)) return false;
	const args = words.slice(1).map((w) => w.toLowerCase());
	if (verb === 'find') return !args.some((a) => FIND_WRITE_FLAGS.has(a));
	if (verb === 'date')
		return !args.some((a) => a === '-s' || a.startsWith('--set'));
	if (verb === 'rg')
		return !args.some((a) => a === '--pre' || a.startsWith('--pre='));
	return true;
}

/**
 * Whole-command check for shell tools. Conservative: any doubt means "not read-only".
 * @param {unknown} command shell command text
 * @returns {boolean} true only when every pipeline segment is an allowlisted read-only verb
 */
export function isReadOnlyCommand(command) {
	if (typeof command !== 'string' || !command.trim()) return false;
	const cd = CD_PREFIX.exec(command);
	const body = cd ? cd[2] : command;
	if (
		!body.trim() ||
		UNSAFE_CHARS.test(body) ||
		WRITE_WORDS.test(body.toLowerCase())
	)
		return false;
	if (EXACT_READ_ONLY_COMMANDS.has(body.trim().replace(/\s+/g, ' ')))
		return true;
	return body.split('|').every(isReadOnlySegment);
}

const TAIL_BYTES = 4 * 1024 * 1024;
const FOUR_HOURS_MS = 240 * 60 * 1000;

/**
 * Read all of stdin without ever blocking the hook: resolves '' for a TTY and
 * after timeoutMs if the stream never closes.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
export function readStdin(timeoutMs = 1000) {
	const stream = process.stdin;
	if (stream.isTTY) return Promise.resolve('');
	return new Promise((resolve) => {
		const chunks = [];
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			stream.removeAllListeners('data');
			stream.removeAllListeners('end');
			stream.removeAllListeners('error');
			stream.pause();
			resolve(Buffer.concat(chunks).toString('utf-8'));
		};
		const timer = setTimeout(finish, timeoutMs);
		stream.on('data', (c) => chunks.push(Buffer.from(c)));
		stream.on('end', finish);
		stream.on('error', finish);
	});
}

function readTail(file) {
	const fd = fs.openSync(file, 'r');
	try {
		const { size } = fs.fstatSync(fd);
		const start = Math.max(0, size - TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		let text = buf.toString('utf-8');
		if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
		return text;
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * @param {unknown} b transcript content block
 * @returns {boolean} true when the block is a tool_use that changed (or may have changed) something
 */
function isWorkBlock(b) {
	if (!b || b.type !== 'tool_use') return false;
	if (EDIT_TOOLS.has(b.name)) return true;
	if (SHELL_TOOLS.has(b.name)) return !isReadOnlyCommand(b.input?.command);
	return false;
}

/**
 * @param {string} stdinText raw Stop-hook stdin
 * @param {string} [hubRootOverride] test-only override
 * @returns {boolean|null}
 */
export function sessionWorkEvidence(stdinText, hubRootOverride) {
	let payload;
	try {
		payload = JSON.parse(stdinText);
	} catch {
		return null;
	}
	const transcriptPath =
		payload && typeof payload === 'object'
			? payload.transcript_path
			: undefined;
	if (typeof transcriptPath !== 'string' || !transcriptPath) return null;

	let text;
	try {
		text = readTail(path.resolve(transcriptPath));
	} catch {
		return null;
	}

	let cutoffMs = Date.now() - FOUR_HOURS_MS;
	try {
		cutoffMs = fs.statSync(
			path.join(
				hubRootOverride ?? resolveHubRoot(),
				SESSION_MARKER_RELATIVE_PATH,
			),
		).mtimeMs;
	} catch {
		// No marker: 240-minute window.
	}

	let parsedLines = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		parsedLines++;
		const blocks = entry?.message?.content;
		if (!Array.isArray(blocks)) continue;
		if (entry.timestamp !== undefined) {
			const ts = Date.parse(entry.timestamp);
			if (!Number.isNaN(ts) && ts < cutoffMs) continue;
		}
		if (blocks.some(isWorkBlock)) return true;
	}
	if (parsedLines === 0 && text.trim()) return null;
	return false;
}
