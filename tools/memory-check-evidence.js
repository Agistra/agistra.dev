/**
 * memory-check-evidence.js — decides whether real work happened this session,
 * from the Claude Code Stop-hook payload (JSON on stdin) and the transcript it
 * points at (JSONL, `transcript_path`).
 *
 * Work evidence is an assistant `tool_use` block named Edit, Write,
 * NotebookEdit, MultiEdit or Bash, dated after the session-start marker's
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
import { resolveHubRoot, SESSION_MARKER_RELATIVE_PATH } from './memory-check-core.js';

const WORK_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash']);
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
	return new Promise(resolve => {
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
		stream.on('data', c => chunks.push(Buffer.from(c)));
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
	const transcriptPath = payload && typeof payload === 'object' ? payload.transcript_path : undefined;
	if (typeof transcriptPath !== 'string' || !transcriptPath) return null;

	let text;
	try {
		text = readTail(path.resolve(transcriptPath));
	} catch {
		return null;
	}

	let cutoffMs = Date.now() - FOUR_HOURS_MS;
	try {
		cutoffMs = fs.statSync(path.join(hubRootOverride ?? resolveHubRoot(), SESSION_MARKER_RELATIVE_PATH)).mtimeMs;
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
		if (blocks.some(b => b && b.type === 'tool_use' && WORK_TOOLS.has(b.name))) return true;
	}
	if (parsedLines === 0 && text.trim()) return null;
	return false;
}
