/**
 * dreaming-contradiction-scan.js — mechanical scan-corpus assembly for the
 * `dreaming` skill's nightly contradiction-review pass.
 *
 * Mechanizing contradiction *detection* itself was considered and rejected:
 * genuine contradiction detection is a judgment call, not a deterministic
 * operation. This module
 * deliberately stops one layer short of that: it only assembles the corpus
 * of text an agent's own `dreaming` pass reviews, using the
 * "mechanics vs. judgment" split — gathering files and
 * checking a scan window is mechanical (same steps, same order, verifiable
 * outcome); deciding whether two statements actually conflict is not, and
 * stays entirely in `agents/skills/dreaming/SKILL.md`'s prose, applied live
 * by whichever model runs the nightly pass.
 *
 * Three mechanical guarantees this module exists to make testable (AC5):
 *   1. **Own-agent-only** — never reads another agent's `memory/<agent>.md`
 *      or archive snapshots, matching the existing Cascade isolation rule in
 *      `agents/skills/dreaming/SKILL.md` ("no agent reads or writes another
 *      agent's memory during dreaming").
 *   2. **Scoped scan window** — only archive snapshots within `sinceDays`
 *      (default 7, matching the existing WARM→COLD decay window) are
 *      included, keeping the pass's cost proportional to a normal nightly
 *      consolidation rather than a full-history semantic scan
 *      (context-budget concern).
 *   3. **Graceful index degradation** — `indexAvailable` reflects whether
 *      the memory-index CLI (`.memory-index.json` or
 *      `pipelines/deploy/lib/memory-index.js`) exists in this hub, purely
 *      via a filesystem existence check. This module never imports or
 *      duplicates memory-index.js's own build/search logic (out of scope for
 *      this module — the memory-index CLI ships that separately); the base
 *      corpus (own live memory + own recent archives) is always assembled
 *      identically either way, so a hub without the memory-index CLI never
 *      breaks or behaves differently — the index, when present, is only a
 *      cheaper
 *      *additional* lookup the dreaming pass's prose may use.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMemoryRootForHub } from './memory-root.js';

const DEFAULT_SINCE_DAYS = 7;
const ENTRY_TIERS = ['hot', 'warm', 'cold'];

// memory-paths.js ships to vault-backed tiers only; a free tier has no keyed
// store, so its absence there is expected and not an error.
const memoryPaths = fs.existsSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory-paths.js'),
)
	? await import('./memory-paths.js')
	: null;

/**
 * Resolves the hub's memory root and layout. Vault-backed hubs keep keyed
 * entries under `<memory-root>/<agent>/<tier>/` (`keyed`); every other hub
 * keeps one `memory/<agent>.md` file (`single-file`). Archive snapshots live
 * in `<memory-root>/archive/` in both layouts.
 */
export function resolveScanLayout(hubRoot, { fsMod = fs } = {}) {
	const paths = memoryPaths?.resolveMemoryPaths({ hubRoot, fsMod });
	if (paths?.ok)
		return { layout: 'keyed', paths, memoryRoot: paths.memoryRoot };
	return {
		layout: 'single-file',
		paths: null,
		memoryRoot: resolveMemoryRootForHub(hubRoot, { fsMod }),
	};
}

/**
 * Whether the memory-index CLI has shipped into this hub — either a
 * built index (`.memory-index.json`) or just the CLI script itself
 * (`pipelines/deploy/lib/memory-index.js`, index not yet built). A pure
 * existence check; never throws, never imports the file.
 */
export function memoryIndexAvailable(hubRoot, { fsMod = fs } = {}) {
	const indexFile = path.join(hubRoot, '.memory-index.json');
	const cliFile = path.join(
		hubRoot,
		'pipelines',
		'deploy',
		'lib',
		'memory-index.js',
	);
	return fsMod.existsSync(indexFile) || fsMod.existsSync(cliFile);
}

/**
 * Reads `<memory-root>/<agent>.md` for the given agent only — this agent's
 * own live memory, never another agent's file. Returns null (not a thrown
 * error) when the file does not exist yet, matching the "graceful degrade
 * on absence" convention used throughout this codebase's storage-adjacent
 * lib files. Single-file (free-tier) layout.
 */
export function readOwnLiveMemory(agent, hubRoot, { fsMod = fs } = {}) {
	const { memoryRoot } = resolveScanLayout(hubRoot, { fsMod });
	const filePath = path.join(memoryRoot, `${agent}.md`);
	if (!fsMod.existsSync(filePath)) return null;
	return { path: filePath, content: fsMod.readFileSync(filePath, 'utf-8') };
}

/**
 * Reads this agent's own keyed entries (`<memory-root>/<agent>/<tier>/*.md`,
 * hot, warm and cold) on a vault-backed hub. Returns an empty array for an
 * unknown agent id or a tier folder that does not exist yet. Never reads
 * another agent's folder: the agent id is validated by the path helper.
 */
export function readOwnKeyedEntries(agent, hubRoot, { fsMod = fs } = {}) {
	const { paths } = resolveScanLayout(hubRoot, { fsMod });
	if (!paths) return [];
	const entries = [];
	for (const tier of ENTRY_TIERS) {
		const dir = memoryPaths.tierDirPath(paths, agent, tier);
		if (!dir.ok) return [];
		let files;
		try {
			files = fsMod.readdirSync(dir.path).filter((f) => f.endsWith('.md'));
		} catch {
			continue;
		}
		for (const file of files.sort()) {
			const filePath = path.join(dir.path, file);
			entries.push({
				tier,
				key: file.slice(0, -'.md'.length),
				path: filePath,
				content: fsMod.readFileSync(filePath, 'utf-8'),
			});
		}
	}
	return entries;
}

/**
 * Lists this agent's own archive snapshots (`<memory-root>/archive/<agent>-YYYY-MM-DD.md`)
 * dated within the last `sinceDays` days (inclusive), sorted most-recent-first.
 * Uses the filename's own date component (not file mtime) — matching the
 * same convention `findMostRecentArchiveDate` in nightly-dreaming.js already
 * uses — so a snapshot's scan-window membership only ever depends on the
 * date it was actually written for, not incidental filesystem metadata.
 * Returns an empty array (not an error) when the archive directory does not
 * exist yet.
 */
export function listRecentArchiveSnapshots(
	agent,
	hubRoot,
	{ fsMod = fs, sinceDays = DEFAULT_SINCE_DAYS, now = () => new Date() } = {},
) {
	const archiveDir = path.join(
		resolveScanLayout(hubRoot, { fsMod }).memoryRoot,
		'archive',
	);
	let files;
	try {
		files = fsMod.readdirSync(archiveDir);
	} catch {
		return [];
	}

	const pattern = new RegExp(`^${agent}-(\\d{4}-\\d{2}-\\d{2})\\.md$`);
	const cutoff = new Date(now());
	cutoff.setHours(0, 0, 0, 0);
	cutoff.setDate(cutoff.getDate() - sinceDays);

	const snapshots = [];
	for (const file of files) {
		const match = pattern.exec(file);
		if (!match) continue; // not this agent's snapshot (own-agent-only) or not a dated archive file
		const date = match[1];
		const snapshotDate = new Date(`${date}T00:00:00`);
		if (snapshotDate < cutoff) continue; // outside the scan window
		snapshots.push({
			date,
			path: path.join(archiveDir, file),
			content: fsMod.readFileSync(path.join(archiveDir, file), 'utf-8'),
		});
	}

	return snapshots.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Assembles the full contradiction-review scan corpus for one agent's own
 * `dreaming` pass: this agent's live memory (a single file, or the keyed hot/warm/cold entries
 * on a vault-backed hub), its recent archive snapshots
 * (within `sinceDays`), and whether the memory-index CLI is
 * available as a cheaper *additional* lookup. Never throws — an agent with
 * no memory file yet, or no archive directory yet, gets an empty-but-valid
 * corpus rather than an error.
 */
export function buildContradictionScanCorpus(
	agent,
	hubRoot,
	{ fsMod = fs, sinceDays = DEFAULT_SINCE_DAYS, now = () => new Date() } = {},
) {
	const keyed = resolveScanLayout(hubRoot, { fsMod }).layout === 'keyed';
	return {
		agent,
		scanWindowDays: sinceDays,
		indexAvailable: memoryIndexAvailable(hubRoot, { fsMod }),
		// Vault-backed hubs: the agent's keyed entries replace the single file.
		...(keyed
			? { entries: readOwnKeyedEntries(agent, hubRoot, { fsMod }) }
			: { liveMemory: readOwnLiveMemory(agent, hubRoot, { fsMod }) }),
		recentArchives: listRecentArchiveSnapshots(agent, hubRoot, {
			fsMod,
			sinceDays,
			now,
		}),
	};
}

// ── CLI entry point ──────────────────────────────────────────────────────
// Usage: node dreaming-contradiction-scan.js scan <agent> [--hub-root <path>] [--since-days <n>]
// Prints the assembled corpus as JSON — the `dreaming` skill's own prose
// (agents/skills/dreaming/SKILL.md) directs the agent running a nightly
// pass to invoke this before applying judgment to what it returns.

function extractValueFlag(argv, flagName) {
	const idx = argv.indexOf(flagName);
	if (idx === -1) return { present: false, value: undefined, rest: argv };
	const value = argv[idx + 1];
	const rest = [...argv.slice(0, idx), ...argv.slice(idx + 2)];
	return { present: true, value, rest };
}

export function runCli(argv, { fsMod = fs } = {}) {
	const hubRootFlag = extractValueFlag(argv, '--hub-root');
	const sinceDaysFlag = extractValueFlag(hubRootFlag.rest, '--since-days');

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
	const sinceDays = sinceDaysFlag.present
		? Number(sinceDaysFlag.value)
		: DEFAULT_SINCE_DAYS;

	const [cmd, agent] = sinceDaysFlag.rest;

	if (cmd !== 'scan') {
		return {
			ok: false,
			error: `unknown command: ${cmd ?? '(none)'}. Usage: dreaming-contradiction-scan <scan> <agent> [--hub-root <path>] [--since-days <n>]`,
		};
	}
	if (!agent) {
		return {
			ok: false,
			error:
				'agent id is required. Usage: dreaming-contradiction-scan scan <agent> [--hub-root <path>] [--since-days <n>]',
		};
	}

	const corpus = buildContradictionScanCorpus(agent, hubRoot, {
		fsMod,
		sinceDays,
	});
	return { ok: true, ...corpus };
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
