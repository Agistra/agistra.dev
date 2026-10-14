/**
 * memory-index.js — local keyword index over a hub's own memory/<agent>.md
 * files.
 *
 * A lightweight, zero-infra "find similar decisions" tool: no graph
 * database, no embeddings — a deterministic keyword index built from the
 * existing dated `- **YYYY-MM-DD ... — ...**` bullet format already used
 * throughout every `memory/<agent>.md` file in this codebase. Modeled on
 * `task-cli.js`'s conventions: JSON output on stdout, exit-code discipline
 * (0 = success, 1 = any failure), an explicit `--hub-root` path flag rather
 * than a cwd assumption.
 *
 * Storage Plugin Contract (agent-foundations/SKILL.md): reads go through the
 * `read-memory(agent)` and `list-memory-agents()` operations implemented
 * below for the `repo-files` backend (plain `memory/<agent>.md` files on
 * disk). `list-memory-agents()` extends that contract — `read-memory(agent)`
 * alone takes a single already-known agent id and has no bulk-enumeration
 * form; see the Storage Plugin Contract section of agent-foundations/SKILL.md
 * and both storage plugin files
 * (`agents/skills/agent-foundations/storage/{repo-files,obsidian}.md`) for
 * the documented operation.
 *
 * Commands:
 *   build | index         — parse every agent's memory file, write
 *                            `.memory-index.json` at the hub root
 *                            (gitignored — see hub.gitignore / repo .gitignore).
 *   find <keyword...>      — query the index; auto-rebuilds first if any
 *                            indexed memory file has changed since the last
 *                            build (mtime fast-path, sha256 content hash as
 *                            the authoritative check) unless `--no-rebuild`
 *                            is passed, in which case a stale result is
 *                            still returned but flagged with `stale: true`
 *                            and an explicit `warning` field — never served
 *                            silently as current (AC 5).
 *
 * Flags:
 *   --hub-root <path>  Hub root to operate against. Defaults to cwd. The
 *                       hub's `memory/` directory is resolved relative to
 *                       this path, matching `read-memory(agent)`'s "from the
 *                       hub root" contract.
 *   --no-rebuild        (find only) Do not auto-rebuild a stale index; search
 *                       the existing index and flag the result as stale
 *                       instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const INDEX_FILENAME = '.memory-index.json';
const SCHEMA_VERSION = 1;

// ── tokenizing / keyword extraction ─────────────────────────────────────────

// Common English function words filtered out of the extracted keyword set.
// Deliberately small and generic — this is a lightweight keyword index, not a
// stemmed/stopword-tuned search engine (deliberately out of scope).
const STOPWORDS = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'been',
	'being',
	'but',
	'by',
	'can',
	'did',
	'do',
	'does',
	'down',
	'during',
	'each',
	'few',
	'for',
	'from',
	'further',
	'had',
	'has',
	'have',
	'he',
	'her',
	'here',
	'him',
	'his',
	'how',
	'i',
	'if',
	'in',
	'into',
	'is',
	'it',
	'its',
	'let',
	'may',
	'me',
	'more',
	'most',
	'my',
	'no',
	'nor',
	'not',
	'now',
	'of',
	'off',
	'on',
	'once',
	'only',
	'or',
	'other',
	'our',
	'out',
	'over',
	'own',
	'per',
	'put',
	'said',
	'same',
	'say',
	'she',
	'so',
	'some',
	'such',
	'than',
	'that',
	'the',
	'their',
	'them',
	'then',
	'there',
	'these',
	'they',
	'this',
	'those',
	'through',
	'to',
	'too',
	'under',
	'until',
	'up',
	'use',
	'very',
	'was',
	'we',
	'were',
	'what',
	'when',
	'where',
	'which',
	'while',
	'who',
	'will',
	'with',
	'would',
	'you',
	'your',
]);

/** Lowercase word/id-shaped token scan — keeps compounds like `task_id`, a hash-prefixed number, `2026-08-11` intact. */
export function tokenize(text) {
	if (typeof text !== 'string') return [];
	return text.toLowerCase().match(/[a-z0-9#][a-z0-9_#-]*/g) || [];
}

/** Unique, sorted, stopword-filtered keyword list for one entry's text. */
export function extractKeywords(text) {
	const tokens = tokenize(text).filter(
		(t) => t.length >= 2 && !STOPWORDS.has(t),
	);
	return Array.from(new Set(tokens)).sort();
}

function sha256(content) {
	return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ── Storage Plugin Contract: memory store (repo-files backend) ─────────────

/**
 * `list-memory-agents()` (repo-files backend). Lists the top-level `.md`
 * files directly under `memory/` — excludes `memory/archive/` (a
 * subdirectory) and `memory/working-buffer.md` (not an agent's own memory).
 */
export function listMemoryAgents(hubRoot, { fsMod = fs } = {}) {
	const memoryDir = path.join(hubRoot, 'memory');
	if (!fsMod.existsSync(memoryDir)) return [];
	return fsMod
		.readdirSync(memoryDir, { withFileTypes: true })
		.filter(
			(e) =>
				e.isFile() && e.name.endsWith('.md') && e.name !== 'working-buffer.md',
		)
		.map((e) => e.name.slice(0, -3))
		.sort();
}

/**
 * `read-memory(agent)` (repo-files backend). Reads `memory/<agent>.md` from
 * the hub root. Returns null (not a thrown error) when the file does not
 * exist — callers decide whether a missing agent file is an error.
 */
export function readMemory(agent, hubRoot, { fsMod = fs } = {}) {
	const filePath = path.join(hubRoot, 'memory', `${agent}.md`);
	if (!fsMod.existsSync(filePath)) return null;
	const content = fsMod.readFileSync(filePath, 'utf-8');
	const stat = fsMod.statSync(filePath);
	return { path: filePath, content, mtimeMs: stat.mtimeMs };
}

// ── parsing HOT/WARM/COLD bullet entries ────────────────────────────────────

/**
 * Parses the existing dated `- **YYYY-MM-DD ... — ...**` bullet format (AC 3)
 * out of one agent's memory file content. A new entry starts at any
 * non-indented `- **` bullet line; every following line (including blank
 * lines and indented sub-bullets, e.g. COLD's nested detail lists) belongs to
 * that entry until the next top-level `- **` bullet or the next `## HOT` /
 * `## WARM` / `## COLD` heading. Content outside a recognized tier heading
 * (the file's `# <Agent> — Live Memory` title, stray prose) is ignored.
 * Entries with no leading date (common in WARM/COLD, e.g. `- **task_id
 * (PR reference)** — ...`) get `date: null` rather than being dropped.
 */
export function parseMemoryEntries(content) {
	const lines = content.split(/\r?\n/);
	const entries = [];
	let currentTier = null;
	let currentLines = null;

	function flush() {
		if (currentTier && currentLines && currentLines.length) {
			const text = currentLines.join('\n').trim();
			if (text) {
				const dateMatch = text.match(/^-\s*\*\*\s*(\d{4}-\d{2}-\d{2})/);
				entries.push({
					tier: currentTier,
					date: dateMatch ? dateMatch[1] : null,
					text,
				});
			}
		}
		currentLines = null;
	}

	for (const rawLine of lines) {
		const tierHeadingMatch = rawLine.match(/^##\s+(HOT|WARM|COLD)\s*$/i);
		if (tierHeadingMatch) {
			flush();
			currentTier = tierHeadingMatch[1].toUpperCase();
			continue;
		}
		if (/^#{1,6}\s+/.test(rawLine)) {
			// Any other heading level (title, or an unrecognized ## section) ends
			// the current tier — its content does not belong to HOT/WARM/COLD.
			flush();
			currentTier = null;
			continue;
		}
		if (currentTier === null) continue;

		if (/^-\s+\*\*/.test(rawLine)) {
			flush();
			currentLines = [rawLine];
		} else if (currentLines) {
			currentLines.push(rawLine);
		}
		// else: stray content before the first bullet of a section — ignored.
	}
	flush();

	return entries;
}

// ── build ────────────────────────────────────────────────────────────────

/**
 * `build` / `index` command. Enumerates every agent via `list-memory-agents()`,
 * reads each via `read-memory(agent)`, parses HOT/WARM/COLD entries, and
 * writes `.memory-index.json` at the hub root, keyed by agent, tier, date,
 * and extracted keywords (AC 3).
 */
export function buildIndex(hubRoot, { fsMod = fs } = {}) {
	const memoryDir = path.join(hubRoot, 'memory');
	if (!fsMod.existsSync(memoryDir)) {
		return { ok: false, error: `memory directory not found: ${memoryDir}` };
	}

	const agentIds = listMemoryAgents(hubRoot, { fsMod });
	if (agentIds.length === 0) {
		return {
			ok: false,
			error: `no agent memory files found under ${memoryDir}`,
		};
	}

	const agentsMeta = {};
	const entries = [];
	const byKeyword = {};

	for (const agent of agentIds) {
		const memory = readMemory(agent, hubRoot, { fsMod });
		if (!memory) continue; // race condition guard; listMemoryAgents just confirmed it exists

		agentsMeta[agent] = {
			path: path.relative(hubRoot, memory.path).split(path.sep).join('/'),
			mtimeMs: memory.mtimeMs,
			sha256: sha256(memory.content),
		};

		const parsed = parseMemoryEntries(memory.content);
		parsed.forEach((entry, idx) => {
			const id = `${agent}:${entry.tier}:${idx}`;
			const keywords = extractKeywords(entry.text);
			entries.push({
				id,
				agent,
				tier: entry.tier,
				date: entry.date,
				text: entry.text,
				keywords,
			});
			for (const kw of keywords) {
				if (!byKeyword[kw]) byKeyword[kw] = [];
				byKeyword[kw].push(id);
			}
		});
	}

	const index = {
		schemaVersion: SCHEMA_VERSION,
		builtAt: new Date().toISOString(),
		agents: agentsMeta,
		entries,
		byKeyword,
	};

	const indexPath = path.join(hubRoot, INDEX_FILENAME);
	fsMod.writeFileSync(
		indexPath,
		JSON.stringify(index, null, 2) + '\n',
		'utf-8',
	);

	return {
		ok: true,
		path: indexPath,
		agents: agentIds,
		entryCount: entries.length,
	};
}

function loadIndex(hubRoot, { fsMod = fs } = {}) {
	const indexPath = path.join(hubRoot, INDEX_FILENAME);
	if (!fsMod.existsSync(indexPath)) return null;
	try {
		return JSON.parse(fsMod.readFileSync(indexPath, 'utf-8'));
	} catch (err) {
		throw new Error(`index file is corrupt (${indexPath}): ${err.message}`, {
			cause: err,
		});
	}
}

// ── staleness detection (AC 5) ──────────────────────────────────────────────

/**
 * Detects whether any indexed agent's memory file has changed since the
 * index was built, or whether the live agent set itself has changed (an
 * agent file added or removed). mtime is a fast pre-check; sha256 content
 * hash is the authoritative signal used whenever mtime has moved — this
 * avoids a false "stale" result when a file's mtime changes without its
 * content changing (e.g. touched by an unrelated tool).
 */
export function checkStaleness(hubRoot, index, { fsMod = fs } = {}) {
	const currentAgents = listMemoryAgents(hubRoot, { fsMod });
	const indexedAgents = Object.keys(index.agents || {}).sort();

	if (JSON.stringify(currentAgents) !== JSON.stringify(indexedAgents)) {
		return {
			stale: true,
			reason: 'agent set changed since index was built',
			currentAgents,
			indexedAgents,
		};
	}

	for (const agent of currentAgents) {
		const filePath = path.join(hubRoot, 'memory', `${agent}.md`);
		const stat = fsMod.statSync(filePath);
		const stored = index.agents[agent];
		if (stat.mtimeMs === stored.mtimeMs) continue;

		const content = fsMod.readFileSync(filePath, 'utf-8');
		if (sha256(content) !== stored.sha256) {
			return {
				stale: true,
				reason: `memory file changed since index was built: ${agent}`,
				agent,
			};
		}
	}

	return { stale: false };
}

// ── find ─────────────────────────────────────────────────────────────────

function searchIndex(index, terms) {
	if (!terms.length) return [];
	let candidateIds = null;

	for (const term of terms) {
		const matchingIds = new Set();
		for (const [kw, ids] of Object.entries(index.byKeyword || {})) {
			if (kw === term || kw.includes(term)) {
				for (const id of ids) matchingIds.add(id);
			}
		}
		// Fallback: raw substring match over full entry text, so multi-word
		// phrases and terms shorter than the keyword-extraction floor still work.
		for (const entry of index.entries) {
			if (entry.text.toLowerCase().includes(term)) matchingIds.add(entry.id);
		}

		candidateIds =
			candidateIds === null
				? matchingIds
				: new Set([...candidateIds].filter((id) => matchingIds.has(id)));
		if (candidateIds.size === 0) break;
	}

	const idSet = candidateIds || new Set();
	const matched = index.entries.filter((e) => idSet.has(e.id));
	matched.sort((a, b) => {
		if (a.date && b.date) return b.date.localeCompare(a.date);
		if (a.date) return -1;
		if (b.date) return 1;
		return 0;
	});

	return matched.map((e) => ({
		agent: e.agent,
		tier: e.tier,
		date: e.date,
		snippet:
			e.text.length > 320 ? `${e.text.slice(0, 320).trimEnd()} …` : e.text,
	}));
}

/**
 * `find <keyword...>` command (AC 4). Auto-rebuilds a missing or stale index
 * before searching unless `--no-rebuild` is passed, in which case a stale
 * index is still searched but the result is explicitly flagged (`stale:
 * true` + a `warning` field) — never silently served as current (AC 5).
 */
export function findCommand(
	hubRoot,
	queryStr,
	{ fsMod = fs, noRebuild = false } = {},
) {
	if (!queryStr || !queryStr.trim()) {
		return {
			ok: false,
			error:
				'keyword is required. Usage: npm run memory-index -- find <keyword> [<keyword> ...]',
		};
	}

	let index;
	let rebuilt = false;
	let stale = false;

	try {
		index = loadIndex(hubRoot, { fsMod });
	} catch (err) {
		return { ok: false, error: err.message };
	}

	if (!index) {
		const buildResult = buildIndex(hubRoot, { fsMod });
		if (!buildResult.ok) return buildResult;
		rebuilt = true;
		index = loadIndex(hubRoot, { fsMod });
	} else {
		const staleness = checkStaleness(hubRoot, index, { fsMod });
		stale = staleness.stale;
		if (stale && !noRebuild) {
			const buildResult = buildIndex(hubRoot, { fsMod });
			if (!buildResult.ok) return buildResult;
			rebuilt = true;
			stale = false;
			index = loadIndex(hubRoot, { fsMod });
		}
	}

	const terms = queryStr.trim().toLowerCase().split(/\s+/);
	const results = searchIndex(index, terms);

	const output = {
		ok: true,
		query: queryStr,
		stale,
		rebuilt,
		count: results.length,
		results,
	};
	if (stale) {
		output.warning =
			'index is stale (a memory file changed since the last build); results may not reflect the latest content. Re-run without --no-rebuild, or run `build`, to refresh.';
	}
	return output;
}

// ── CLI entry point ────────────────────────────────────────────────────────

function extractValueFlag(argv, flagName) {
	const idx = argv.indexOf(flagName);
	if (idx === -1) return { present: false, value: undefined, rest: argv };
	const value = argv[idx + 1];
	const rest = [...argv.slice(0, idx), ...argv.slice(idx + 2)];
	return { present: true, value, rest };
}

function extractBooleanFlag(argv, flagName) {
	const idx = argv.indexOf(flagName);
	if (idx === -1) return { present: false, rest: argv };
	const rest = [...argv.slice(0, idx), ...argv.slice(idx + 1)];
	return { present: true, rest };
}

export function runCli(argv, { fsMod = fs } = {}) {
	const hubRootFlag = extractValueFlag(argv, '--hub-root');
	const noRebuildFlag = extractBooleanFlag(hubRootFlag.rest, '--no-rebuild');

	if (
		hubRootFlag.present &&
		(!hubRootFlag.value || !fsMod.existsSync(hubRootFlag.value))
	) {
		return {
			ok: false,
			error: `--hub-root not found: ${hubRootFlag.value ?? '(missing value)'}`,
		};
	}
	const hubRoot = hubRootFlag.present
		? path.resolve(hubRootFlag.value)
		: process.cwd();

	const [cmd, ...positional] = noRebuildFlag.rest;

	switch (cmd) {
		case 'build':
		case 'index':
			return buildIndex(hubRoot, { fsMod });
		case 'find':
			return findCommand(hubRoot, positional.join(' '), {
				fsMod,
				noRebuild: noRebuildFlag.present,
			});
		default:
			return {
				ok: false,
				error: `unknown command: ${cmd ?? '(none)'}. Usage: npm run memory-index -- build  |  npm run memory-index -- find <keyword...>  |  npm run memory-index:build`,
			};
	}
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	let output;
	try {
		const argv = process.argv.slice(2);
		output = runCli(argv);
	} catch (err) {
		output = { ok: false, error: err.message };
	}
	process.stdout.write(JSON.stringify(output, null, 2) + '\n');
	process.exit(output.ok ? 0 : 1);
}
