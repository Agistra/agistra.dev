/**
 * claude-memory-collect.js — read Claude Code's own memory for this hub so
 * dreaming can bring it into the hub.
 *
 * Claude Code keeps its own notes for a project in
 * `~/.claude/projects/<slug>/memory/`, where `<slug>` is the project's
 * absolute path with every character that is not an ASCII letter or digit
 * replaced by `-` (`/home/me/my.hub` becomes `-home-me-my-hub`). Only Claude Code
 * loads that folder, and it is keyed by the path, so a moved hub starts empty.
 * This module collects what is in it, once:
 *
 *   - each file not yet collected becomes a proposal. A `feedback` note is a
 *     rule candidate for the team lead; `user`, `project` and `reference`
 *     notes are facts for the hub's memory; anything else is shown as
 *     unclassified. This module never writes a rule or a memory entry: the
 *     agent running dreaming does, and rules only with the team lead's OK.
 *   - a ledger in the hub's memory root records every file collected as
 *     file name plus content hash, so a second run proposes nothing new and a
 *     file that changed since is proposed again. A rule candidate is the
 *     exception: it is recorded only once the team lead has answered it
 *     (`--answer <file>`), so one nobody answered is proposed again at the next run.
 *   - the original files are only ever read. They are never edited, moved or
 *     deleted.
 *
 * Nothing is collected unless the folder exists; then the result is one
 * "skipped" line for the end-of-day report. The Claude Code folder is never
 * located by a guess: the caller names the Claude home (`--claude-home`, or
 * `CLAUDE_CONFIG_DIR`, or `~/.claude`).
 *
 * A hub that moved keeps its notes under the old path's folder. `--source-hub-root`
 * names that prior path: the folder is found from it (the path need not exist any
 * more, only its Claude Code folder), while proposals and the ledger belong to
 * `--hub-root`, the hub that is collecting.
 *
 * A file the team lead skipped is not proposed again unless its note changes.
 * To show one again, `--forget <file>` drops that one file from the ledger;
 * `--reset` empties the ledger so every file is proposed again. Either one
 * edits the ledger only, never the original notes, and the same run then
 * proposes what it dropped. With `--dry-run` the ledger is left as it was.
 *
 * Usage:
 *   node pipelines/deploy/lib/claude-memory-collect.js collect
 *     [--hub-root <path>] [--source-hub-root <prior hub path>]
 *     [--claude-home <dir>] [--dry-run] [--forget <file> | --reset] [--answer <file>]
 *
 * Output is one JSON object on stdout. `line` is the sentence for the report.
 * `--dry-run` proposes without recording anything.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMemoryRootForHub } from './memory-root.js';
import { scanForSecrets } from './secret-scan.js';

export const LEDGER_FILE = '.claude-memory-collected.json';
/** Claude Code adds a hash to the slug once the path passes this many characters. */
const SLUG_HASH_AFTER = 200;
const INDEX_FILE = 'MEMORY.md';
/** A proposal's text is cut here so a long note cannot flood the report. */
const TEXT_LIMIT = 1500;

function fail(code, error) {
	return { ok: false, code, error };
}

/**
 * The folder name Claude Code uses under `~/.claude/projects/` for a project
 * path: every character that is not an ASCII letter or digit becomes `-`.
 *
 * @param {string} hubRoot
 * @param {object} [pathMod]  `path`, `path.win32` or `path.posix`; default the running platform's
 * @returns {string}
 */
export function claudeProjectSlug(hubRoot, pathMod = path) {
	return pathMod.resolve(hubRoot).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The narrower rule older notes describe (only `:`, `\`, `/` and `.` change).
 * Used only when the folder the current rule names does not exist.
 */
export function legacySlug(hubRoot, pathMod = path) {
	return pathMod.resolve(hubRoot).replace(/[:\\/.]/g, '-');
}

/** The Claude home: the explicit value, else `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function defaultClaudeHome(env = process.env) {
	return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Find the memory folder Claude Code keeps for this hub.
 *
 * @returns {{ ok: true, slug: string, folder: string|null, reason?: string }}
 */
export function resolveClaudeMemoryFolder({ hubRoot, claudeHome, fsMod = fs }) {
	const slug = claudeProjectSlug(hubRoot);
	const projectsDir = path.join(claudeHome, 'projects');
	const has = (dir) => {
		try {
			return fsMod
				.statSync(path.join(projectsDir, dir, 'memory'))
				.isDirectory();
		} catch {
			return false;
		}
	};
	if (slug.length > SLUG_HASH_AFTER) {
		let candidates;
		try {
			candidates = fsMod
				.readdirSync(projectsDir)
				.filter((d) => d.startsWith(slug.slice(0, SLUG_HASH_AFTER)) && has(d));
		} catch {
			candidates = [];
		}
		if (candidates.length === 1)
			return {
				ok: true,
				slug: candidates[0],
				folder: path.join(projectsDir, candidates[0], 'memory'),
			};
		return {
			ok: true,
			slug,
			folder: null,
			reason:
				candidates.length > 1
					? 'more than one project folder matches this long path'
					: 'the hub path is long enough that Claude Code adds a hash to the folder name',
		};
	}
	for (const name of [slug, legacySlug(hubRoot)]) {
		if (has(name))
			return {
				ok: true,
				slug: name,
				folder: path.join(projectsDir, name, 'memory'),
			};
	}
	return {
		ok: true,
		slug,
		folder: null,
		reason: 'no Claude Code memory folder found for this hub',
	};
}

/**
 * Read the frontmatter fields of a Claude memory file. Claude Code writes
 * `name`, `description` and a `type` (`user`, `feedback`, `project` or
 * `reference`), the type either at the top level or under `metadata:`.
 *
 * @param {string} text
 * @returns {{ name: string|null, description: string|null, type: string|null, body: string }}
 */
export function parseClaudeMemoryFile(text) {
	const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
	const match = clean.match(
		/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/,
	);
	const front = match ? match[1] : '';
	const body = (match ? match[2] : clean).trim();
	const field = (name) => {
		const m = front.match(new RegExp(`^[ \\t]*${name}:[ \\t]*(.*)$`, 'm'));
		if (!m) return null;
		const value = m[1].trim().replace(/^["']|["']$/g, '');
		return value === '' ? null : value;
	};
	return {
		name: field('name'),
		description: field('description'),
		type: field('type')?.toLowerCase() ?? null,
		body,
	};
}

/** What the agent should do with a note of this type. */
export function classifyClaudeMemoryType(type) {
	if (type === 'feedback') return 'rule-candidate';
	if (['user', 'project', 'reference'].includes(type)) return 'fact';
	return 'unclassified';
}

function toKey(text) {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 70)
		.replace(/-+$/, '');
	return `claude-${slug || 'note'}`;
}

function oneLine(text, max) {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function readLedger(ledgerPath, fsMod) {
	try {
		const parsed = JSON.parse(fsMod.readFileSync(ledgerPath, 'utf-8'));
		if (parsed && Array.isArray(parsed.collected)) return parsed;
	} catch {
		// absent or unreadable: start a new ledger
	}
	return { version: 1, collected: [] };
}

function writeLedger(ledgerPath, ledger, fsMod) {
	fsMod.mkdirSync(path.dirname(ledgerPath), { recursive: true });
	const tmp = `${ledgerPath}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
	fsMod.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8');
	fsMod.renameSync(tmp, ledgerPath);
}

/**
 * Collect Claude Code's memory for a hub.
 *
 * @param {object} options
 * @param {string} options.hubRoot  the hub that collects: its memory root holds the ledger
 * @param {string} [options.sourceHubRoot]  a prior path of the hub, whose Claude Code
 *   folder is read instead of `hubRoot`'s own; it need not exist on disk
 * @param {string} options.claudeHome  the Claude home (`~/.claude`); required, never guessed here
 * @param {string} [options.memoryRoot]  where the ledger lives; default the hub's memory root
 * @param {boolean} [options.dryRun]  propose without recording
 * @param {string} [options.forget]  a note's file name: drop it from the ledger so it is proposed again
 * @param {boolean} [options.reset]  empty the ledger so every note is proposed again
 * @param {string} [options.answer]  a rule candidate's file name the team lead has answered (accepted or declined): record it so it is not proposed again
 * @param {function} [options.clock]  returns a Date
 * @returns {{ ok: true, skipped: boolean, line: string, slug: string, folder: string|null,
 *   proposals: object[], alreadyCollected: number, recorded: boolean }
 *   | { ok: false, code: string, error: string }}
 */
export function collectClaudeMemory({
	hubRoot,
	sourceHubRoot,
	claudeHome,
	memoryRoot,
	dryRun = false,
	forget,
	reset = false,
	answer,
	clock = () => new Date(),
	fsMod = fs,
}) {
	if (!hubRoot) return fail('invalid-usage', 'hubRoot is required');
	if (!claudeHome) return fail('invalid-usage', 'claudeHome is required');
	if (forget !== undefined && reset)
		return fail(
			'invalid-usage',
			'--forget and --reset cannot be used together',
		);
	if (
		forget !== undefined &&
		(typeof forget !== 'string' ||
			forget === '' ||
			forget !== path.basename(forget) ||
			/[\\/]/.test(forget))
	)
		return fail(
			'invalid-usage',
			'--forget takes a file name from the Claude memory folder, not a path',
		);
	if (
		answer !== undefined &&
		(typeof answer !== 'string' ||
			answer === '' ||
			answer !== path.basename(answer) ||
			/[\\/]/.test(answer))
	)
		return fail(
			'invalid-usage',
			'--answer takes a file name from the Claude memory folder, not a path',
		);
	const root = path.resolve(hubRoot);
	const memRoot = memoryRoot ?? resolveMemoryRootForHub(root, { fsMod });
	const ledgerPath = path.join(memRoot, LEDGER_FILE);
	const ledger = readLedger(ledgerPath, fsMod);
	// Edit the ledger first, so a forgotten file is proposed again by this very
	// run. Only the ledger changes: the original notes are never opened for writing.
	const before = ledger.collected.length;
	if (reset) ledger.collected = [];
	else if (forget !== undefined)
		ledger.collected = ledger.collected.filter((c) => c.file !== forget);
	const dropped = before - ledger.collected.length;
	const ledgerEdited = dropped > 0 && !dryRun;
	const forgotNote =
		reset || forget !== undefined
			? ` ${dropped === 0 ? 'Nothing to forget' : `Forgot ${dropped} ledger ${dropped === 1 ? 'entry' : 'entries'}`}${dryRun ? ' (dry run, ledger unchanged)' : ''}; the original notes were not touched.`
			: '';
	const located = resolveClaudeMemoryFolder({
		hubRoot: sourceHubRoot ? path.resolve(sourceHubRoot) : root,
		claudeHome,
		fsMod,
	});
	if (!located.folder) {
		if (ledgerEdited) {
			try {
				writeLedger(ledgerPath, ledger, fsMod);
			} catch (err) {
				return fail(
					'ledger-write-failed',
					`could not update ${ledgerPath}: ${err.message}`,
				);
			}
		}
		return {
			ok: true,
			skipped: true,
			line: `Claude memory collection: skipped (${located.reason}).${forgotNote}`,
			slug: located.slug,
			folder: null,
			proposals: [],
			alreadyCollected: 0,
			recorded: false,
			ledgerEntriesDropped: dropped,
		};
	}

	let names;
	try {
		names = fsMod
			.readdirSync(located.folder, { withFileTypes: true })
			.filter(
				(d) =>
					d.isFile() &&
					/\.md$/i.test(d.name) &&
					d.name !== INDEX_FILE &&
					!d.name.startsWith('.'),
			)
			.map((d) => d.name)
			.sort();
	} catch (err) {
		return fail(
			'read-failed',
			`could not read ${located.folder}: ${err.message}`,
		);
	}

	const now = clock()
		.toISOString()
		.replace(/\.\d{3}Z$/, 'Z');

	// A rule candidate the team lead answered: record its current content, so it
	// stops being proposed.
	let answered = false;
	if (answer !== undefined) {
		let raw;
		try {
			raw = fsMod.readFileSync(path.join(located.folder, answer));
		} catch {
			return fail(
				'invalid-usage',
				`--answer: ${answer} is not in ${located.folder}`,
			);
		}
		const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
		if (
			!ledger.collected.some((c) => c.file === answer && c.sha256 === sha256)
		) {
			ledger.collected.push({
				file: answer,
				sha256,
				kind: 'rule-candidate',
				collectedAt: now,
			});
			answered = !dryRun;
		}
	}

	const seen = new Set(ledger.collected.map((c) => `${c.file}\0${c.sha256}`));
	const proposals = [];
	let alreadyCollected = 0;

	for (const file of names) {
		let raw;
		try {
			raw = fsMod.readFileSync(path.join(located.folder, file));
		} catch {
			continue;
		}
		const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
		if (seen.has(`${file}\0${sha256}`)) {
			alreadyCollected += 1;
			continue;
		}
		const text = raw.toString('utf-8');
		const parsed = parseClaudeMemoryFile(text);
		const kind = classifyClaudeMemoryType(parsed.type);
		const changed = ledger.collected.some((c) => c.file === file);
		const secret = scanForSecrets(text);
		const title = parsed.name ?? file.replace(/\.md$/i, '');
		proposals.push({
			file,
			sha256,
			kind,
			changedSinceCollected: changed,
			type: parsed.type,
			name: parsed.name,
			description: secret ? null : parsed.description,
			suggestedKey: toKey(title),
			suggestedSummary: oneLine(
				secret ? title : (parsed.description ?? parsed.body ?? title),
				160,
			),
			source: `Claude Code memory file ${file} (sha256 ${sha256.slice(0, 12)})`,
			...(secret
				? {
						secretDetected: true,
						text: null,
						note: 'the note matches a secret pattern, so its text is not shown or copied; review the original by hand',
					}
				: { text: parsed.body.slice(0, TEXT_LIMIT) }),
			truncated: !secret && parsed.body.length > TEXT_LIMIT,
		});
	}

	let recorded = false;
	// A rule candidate is not recorded when proposed, only when answered.
	const recordable = proposals.filter((p) => p.kind !== 'rule-candidate');
	if (!dryRun && (recordable.length > 0 || ledgerEdited || answered)) {
		try {
			for (const p of recordable)
				ledger.collected.push({
					file: p.file,
					sha256: p.sha256,
					kind: p.kind,
					collectedAt: now,
				});
			writeLedger(ledgerPath, ledger, fsMod);
			recorded = true;
		} catch (err) {
			return fail(
				'ledger-write-failed',
				`could not record what was collected in ${ledgerPath}: ${err.message}. Nothing was proposed, so nothing will be lost.`,
			);
		}
	}

	const count = (kind) => proposals.filter((p) => p.kind === kind).length;
	const line =
		proposals.length === 0
			? `Claude memory collection: nothing new (${alreadyCollected} already collected from ${located.slug}).`
			: `Claude memory collection: ${proposals.length} new from ${located.slug} (${count('rule-candidate')} rule candidates for the team lead, ${count('fact')} facts, ${count('unclassified')} unclassified); ${alreadyCollected} already collected${dryRun ? ' (dry run, nothing recorded)' : ''}.`;
	const fullLine = `${line}${forgotNote}`;
	return {
		ok: true,
		skipped: false,
		line: fullLine,
		slug: located.slug,
		folder: located.folder,
		proposals,
		alreadyCollected,
		recorded,
		ledgerEntriesDropped: dropped,
	};
}

function parseArgs(argv) {
	const out = { command: argv[0], hubRoot: process.cwd(), dryRun: false };
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--dry-run') out.dryRun = true;
		else if (arg === '--reset') out.reset = true;
		else if (
			arg === '--hub-root' ||
			arg === '--claude-home' ||
			arg === '--source-hub-root' ||
			arg === '--forget' ||
			arg === '--answer'
		) {
			const value = argv[i + 1];
			if (!value || value.startsWith('--'))
				return fail('invalid-usage', `${arg} needs a value`);
			if (arg === '--hub-root') out.hubRoot = value;
			else if (arg === '--source-hub-root') out.sourceHubRoot = value;
			else if (arg === '--forget') out.forget = value;
			else if (arg === '--answer') out.answer = value;
			else out.claudeHome = value;
			i += 1;
		} else return fail('invalid-usage', `unknown option ${arg}`);
	}
	return { ok: true, ...out };
}

/** Run one command and return its result object. */
export function runCli(argv, { env = process.env, fsMod = fs, clock } = {}) {
	const parsed = parseArgs(argv);
	if (!parsed.ok) return parsed;
	if (parsed.command !== 'collect')
		return fail(
			'invalid-usage',
			'Usage: claude-memory-collect.js collect [--hub-root <path>] [--source-hub-root <prior hub path>] [--claude-home <dir>] [--dry-run] [--forget <file> | --reset] [--answer <file>]',
		);
	return collectClaudeMemory({
		hubRoot: parsed.hubRoot,
		sourceHubRoot: parsed.sourceHubRoot,
		claudeHome: parsed.claudeHome ?? defaultClaudeHome(env),
		dryRun: parsed.dryRun,
		forget: parsed.forget,
		reset: parsed.reset === true,
		answer: parsed.answer,
		clock,
		fsMod,
	});
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	const output = runCli(process.argv.slice(2));
	process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
	process.exitCode = output.ok ? 0 : 1;
}
