#!/usr/bin/env node
/**
 * memory-check-core.js — platform-neutral WAL memory-check logic.
 *
 * Node reimplementation of memory-check-core.sh, invoked by the Claude Code
 * Stop hook (see memory-check.js) via exec form so no shell — bash or
 * PowerShell — is required to run it. Both implementations share one
 * contract and the same shared test cases.
 *
 * "Work happened this session" is decided by a session marker, not by git:
 * a SessionStart hook (memory-session-start.js / .sh) writes a timestamp
 * file at `.claude/.session-start` (gitignored, outside the memory root).
 * The check reports "dirty" when no *.md file under the tier's memory root
 * (recursive, excluding archive/) has an mtime newer than that marker. When
 * the marker is missing, it falls back to a 240-minute window. No git calls,
 * so it works on hubs that are not git repos and on hubs whose own tree stays
 * clean because agents work in other repos.
 *
 * Work marker: every adapter's post-tool hook runs
 * memory-work-marker.js/.sh, which touches `.claude/.session-work` when a
 * tool changed something (edit/write/shell, not read/search). When that marker
 * exists the check is: dirty only if the work marker is newer than the
 * session-start marker (work happened this session) AND no memory *.md is
 * newer than the work marker, where "newer" allows MEMORY_WRITE_TOLERANCE_MS (30 s) of
 * slack because the post-tool hook touches the work marker just after the
 * memory write itself (a changing tool call within that window of a memory
 * write counts as covered by it: a missed nag is cheaper than a false one).
 * A work marker older than the session marker is
 * leftover from an earlier session: clean. When the work marker is absent the
 * marker-only behaviour above applies unchanged.
 *
 * Once per stop: adapters stamp `.claude/.session-reminded` when they emit a
 * reminder (--stamp on the CLI, markReminded() in code). A stamp not older than
 * the work marker (or, without a work marker, the session marker) means the
 * reminder for this work was already given: clean.
 *
 * The live memory directory is tier-aware: free-tier hubs (dev, dev:graph)
 * store memory under memory/; vault-backed hubs (dev:sub, ops) store it under
 * vault/Memory/ (see pipelines/deploy/lib/memory-root.js's
 * resolveMemoryRootForHub() — the single source of truth every other
 * tier-aware consumer already uses). If the import or resolution fails for
 * any reason, it falls back to the free-tier default ("memory").
 *
 * Contract (consumed by platform adapters — no platform-specific formatting
 * here), mirrors memory-check-core.sh's contract exactly:
 *   checkMemoryStatus() resolves to "clean" or "dirty".
 *   When run as a CLI, prints "clean" or "dirty" to stdout and always exits 0
 *   — the core never fails the calling process; adapters decide how to
 *   surface "dirty" to their platform.
 *
 * Adapters get the shared, tier-aware reminder text from
 * memory-check-message.js (same directory as this file) rather than
 * duplicating the message.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FOUR_HOURS_MS = 240 * 60 * 1000;

/** Session-start marker, relative to the hub root. Gitignored; never inside vault/. */
export const SESSION_MARKER_RELATIVE_PATH = '.claude/.session-start';

/** Work marker, touched by each adapter's post-tool hook. Gitignored; never inside vault/. */
export const WORK_MARKER_RELATIVE_PATH = '.claude/.session-work';

/**
 * Slack for the memory-vs-work-marker comparison. The post-tool hook touches
 * the work marker right after the tool call that wrote memory, so the marker
 * is always slightly newer than that write. Mirrored in memory-check-core.sh.
 */
export const MEMORY_WRITE_TOLERANCE_MS = 30000;

/** Stamp written when a reminder was emitted, so the same work is reminded once. */
export const REMINDED_STAMP_RELATIVE_PATH = '.claude/.session-reminded';

/**
 * Resolve the hub root before any check, regardless of the calling process's
 * cwd. A session that has cd'd into a foreign repo (e.g. another project
 * working dir) must not have its dirty/no-memory state misreported as the
 * hub's.
 *
 *   1. CLAUDE_PROJECT_DIR, when set (Claude Code always sets it) — trust it.
 *   2. Otherwise this script's own location: the parent of the tools/
 *      directory it ships in (or its own directory when not inside tools/).
 *      Adapter-agnostic, no git.
 *
 * @returns {string}
 */
export function resolveHubRoot() {
	if (process.env.CLAUDE_PROJECT_DIR) {
		return process.env.CLAUDE_PROJECT_DIR;
	}
	return path.basename(__dirname) === 'tools' ? path.dirname(__dirname) : __dirname;
}

/**
 * Resolve the tier-aware memory-root path segment ("memory" or
 * "vault/Memory") by importing resolveMemoryRootForHub() directly — the same
 * function pipelines/deploy/lib/session-cli.js already uses for this exact
 * "hubRoot only, no pre-parsed config" case. Any failure (module missing,
 * workspace.config.json absent/unreadable) falls back to "memory", matching
 * this module's pre-existing free-tier-only behaviour.
 *
 * @param {string} hubRoot
 * @returns {Promise<string>}
 */
export async function resolveMemoryRootSegment(hubRoot) {
	try {
		const modPath = path.resolve(hubRoot, 'pipelines/deploy/lib/memory-root.js');
		const { resolveMemoryRootForHub } = await import(pathToFileURL(modPath).href);
		const absRoot = resolveMemoryRootForHub(hubRoot);
		return path.relative(hubRoot, absRoot).split(path.sep).join('/') || 'memory';
	} catch {
		return 'memory';
	}
}

/**
 * @param {string} dir directory to scan recursively
 * @param {number} cutoffMs mtime threshold in ms
 * @param {boolean} strict true: mtime must be strictly newer than the cutoff
 * @returns {boolean} true if any *.md file (excluding archive/ directories) qualifies
 */
function hasMarkdownNewerThan(dir, cutoffMs, strict) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'archive') continue;
			if (hasMarkdownNewerThan(full, cutoffMs, strict)) return true;
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
		try {
			const { mtimeMs } = fs.statSync(full);
			if (strict ? mtimeMs > cutoffMs : mtimeMs >= cutoffMs) return true;
		} catch {
			// Ignore files that vanish between readdir and stat.
		}
	}
	return false;
}

function mtimeOf(file) {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Whether the hub has a work marker that counts as "work happened this
 * session" (newer than the session marker, or inside the 240-minute window
 * when there is no session marker). Adapters use it to pick the reminder
 * wording: with a work marker the reminder may say files were changed.
 *
 * @param {string} [hubRootOverride] test-only override
 * @returns {boolean}
 */
export function hasSessionWork(hubRootOverride) {
	const hubRoot = hubRootOverride ?? resolveHubRoot();
	const workMs = mtimeOf(path.join(hubRoot, WORK_MARKER_RELATIVE_PATH));
	if (workMs === null) return false;
	const sessionMs = mtimeOf(path.join(hubRoot, SESSION_MARKER_RELATIVE_PATH));
	return sessionMs === null ? workMs >= Date.now() - FOUR_HOURS_MS : workMs > sessionMs;
}

/**
 * Record that a reminder was emitted for the current work. Never throws.
 *
 * @param {string} [hubRootOverride] test-only override
 */
export function markReminded(hubRootOverride) {
	try {
		const stamp = path.join(hubRootOverride ?? resolveHubRoot(), REMINDED_STAMP_RELATIVE_PATH);
		fs.mkdirSync(path.dirname(stamp), { recursive: true });
		fs.writeFileSync(stamp, `${new Date().toISOString()}
`);
	} catch {
		// A failed stamp only risks a second reminder.
	}
}

/**
 * @param {string} [hubRootOverride] test-only override; production callers omit this
 * @returns {Promise<'clean'|'dirty'>}
 */
export async function checkMemoryStatus(hubRootOverride) {
	const hubRoot = hubRootOverride ?? resolveHubRoot();
	const memoryDir = path.join(hubRoot, await resolveMemoryRootSegment(hubRoot));

	const sessionMs = mtimeOf(path.join(hubRoot, SESSION_MARKER_RELATIVE_PATH));
	const workMs = mtimeOf(path.join(hubRoot, WORK_MARKER_RELATIVE_PATH));
	const remindedMs = mtimeOf(path.join(hubRoot, REMINDED_STAMP_RELATIVE_PATH));

	let baselineMs;
	if (workMs !== null) {
		// Work marker present: it only counts when it postdates the session start.
		if (!hasSessionWork(hubRoot)) return 'clean';
		if (hasMarkdownNewerThan(memoryDir, workMs - MEMORY_WRITE_TOLERANCE_MS, false)) return 'clean';
		baselineMs = workMs;
	} else {
		// No work marker: marker-only fallback (240-minute window without a session marker).
		baselineMs = sessionMs ?? Date.now() - FOUR_HOURS_MS;
		if (hasMarkdownNewerThan(memoryDir, baselineMs, sessionMs !== null)) return 'clean';
	}

	// Already reminded for this work (stamp not older than the baseline).
	if (remindedMs !== null && remindedMs >= baselineMs) return 'clean';
	return 'dirty';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	checkMemoryStatus().then(status => {
		if (status === 'dirty' && process.argv.includes('--stamp')) markReminded();
		process.stdout.write(`${status}\n`);
		process.exit(0);
	});
}
