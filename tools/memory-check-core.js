#!/usr/bin/env node
/**
 * memory-check-core.js — platform-neutral WAL memory-check logic.
 *
 * Node reimplementation of memory-check-core.sh, invoked by the Claude Code
 * Stop hook (see memory-check.js) via exec form so no shell — bash or
 * PowerShell — is required to run it. Ports memory-check-core.sh's logic
 * exactly (see that file's own header comment for the original bash
 * version); the WAL-check semantics below (git status + tier-aware memory
 * root + 240-minute mtime fallback) are unchanged.
 *
 * Checks whether files were changed this session (git status --porcelain)
 * without a corresponding update to the hub's live memory directory (git
 * status, falling back to filesystem mtime within the last 240 minutes since
 * that directory may be gitignored in some hubs).
 *
 * The live memory directory is tier-aware: free-tier hubs (dev, dev:graph)
 * store memory at memory/*.md; vault-backed hubs (dev:sub, ops, publish)
 * store it at vault/Memory/*.md instead (see
 * pipelines/deploy/lib/memory-root.js's resolveMemoryRootForHub() — the
 * single source of truth every other tier-aware consumer already uses).
 * This module imports that function directly (no need to shell out to a
 * second process the way the bash version had to) rather than reimplementing
 * the vault-tier list a third time. If the import or resolution fails for
 * any reason, it falls back to the free-tier default ("memory") — the
 * pre-existing behaviour memory-check-core.sh has always had.
 *
 * Contract (consumed by platform adapters — no platform-specific formatting
 * here), mirrors memory-check-core.sh's contract exactly:
 *   checkMemoryStatus() resolves to "clean" or "dirty".
 *   When run as a CLI, prints "clean" or "dirty" to stdout and always exits 0
 *   — the core never fails the calling process; adapters decide how to
 *   surface "dirty" to their platform.
 *
 * Adapters source the shared reminder text from memory-check-message.txt
 * (same directory as this file) rather than duplicating the message.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FOUR_HOURS_MS = 240 * 60 * 1000;

/**
 * Resolve the hub root before any check, regardless of the calling process's
 * cwd. A session that has cd'd into a foreign repo (e.g. another project
 * working dir) must not have its dirty/no-memory state misreported as the
 * hub's.
 *
 *   1. CLAUDE_PROJECT_DIR, when set (Claude Code always sets it) — trust it.
 *   2. Otherwise fall back to this script's own repo root, discovered via
 *      `git rev-parse --show-toplevel` from this file's directory. This
 *      keeps the fallback adapter-agnostic with no hard Claude dependency in
 *      the core.
 *
 * @returns {string}
 */
function resolveHubRoot() {
	if (process.env.CLAUDE_PROJECT_DIR) {
		return process.env.CLAUDE_PROJECT_DIR;
	}
	const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
		cwd: __dirname,
		encoding: 'utf-8',
	});
	const toplevel = result.status === 0 ? result.stdout.trim() : '';
	return toplevel || __dirname;
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
async function resolveMemoryRootSegment(hubRoot) {
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
 * @param {string} memoryDir absolute path to the resolved memory root
 * @returns {boolean} true if any top-level *.md file was modified within the last 240 minutes
 */
function hasRecentlyUpdatedMemoryFile(memoryDir) {
	let entries;
	try {
		entries = fs.readdirSync(memoryDir, { withFileTypes: true });
	} catch {
		return false;
	}
	const cutoff = Date.now() - FOUR_HOURS_MS;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
		try {
			const stat = fs.statSync(path.join(memoryDir, entry.name));
			if (stat.mtimeMs >= cutoff) return true;
		} catch {
			// Ignore files that vanish between readdir and stat.
		}
	}
	return false;
}

/**
 * @param {string} [hubRootOverride] test-only override; production callers omit this
 * @returns {Promise<'clean'|'dirty'>}
 */
export async function checkMemoryStatus(hubRootOverride) {
	const hubRoot = hubRootOverride ?? resolveHubRoot();

	// Nothing to check if this isn't a git repo.
	const gitDirCheck = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: hubRoot });
	if (gitDirCheck.status !== 0) {
		return 'clean';
	}

	// Collect tracked changes relative to HEAD.
	const statusResult = spawnSync('git', ['status', '--porcelain'], {
		cwd: hubRoot,
		encoding: 'utf-8',
	});
	const status = statusResult.status === 0 ? statusResult.stdout : '';
	if (!status || !status.trim()) {
		// No changes — nothing to remember.
		return 'clean';
	}

	const memoryRootSegment = await resolveMemoryRootSegment(hubRoot);
	const memoryDir = path.join(hubRoot, memoryRootSegment);

	// The resolved memory root may be excluded from git tracking — check
	// filesystem mtime instead. Any *.md modified in the last 4 hours counts
	// as updated this session.
	if (hasRecentlyUpdatedMemoryFile(memoryDir)) {
		return 'clean';
	}

	// Work happened but memory was not updated.
	return 'dirty';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	checkMemoryStatus().then(status => {
		process.stdout.write(`${status}\n`);
		process.exit(0);
	});
}
