/**
 * bootstrap.js — workspace.config.json `bootstrap` block read/write helpers.
 *
 * NOT an init command. The CLI at the bottom is the LAST step of the Bootstrap
 * Self-Check protocol (agent-foundations skill): it stamps `bootstrap.completedAt`
 * once the shared bootstrap report exists, and that stamp stops the flow from
 * ever running again. It refuses to stamp until the report is present
 * (`--force` skips that for tests and scratch deploys only); `--reset` clears
 * the stamp so the flow can run again. It does not set up a workspace.
 *
 * The bootstrap block is the durable "has the team run its first-contact
 * self-check" flag: `{ completedAt: ISO string | null, version: string }`.
 *
 * Deliberately NOT tied to memory-file emptiness — memory content is archived
 * or compacted later by the dreaming skill, and that decay must never
 * re-trigger the bootstrap self-check fan-out. workspace.config.json is the
 * one place that persists independently of memory state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHubConfig } from '../setup.js';
import { parseVersion } from './version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Read the hub version. Resolved relative to this file so it works the same
 * whether invoked from the source repo or a deployed hub's copy of
 * pipelines/deploy/. Order: the first whitespace-delimited token of the hub
 * root `VERSION` file when it parses as semver (the same file version-check.js
 * reads; a deployed hub's package.json carries no `version`), then
 * package.json `version`, then '0.0.0'.
 *
 * @param {object} [fsMod] Injectable fs module for testability.
 * @returns {string} Semver string, or '0.0.0' if neither source yields one.
 */
export function readPackageVersion(fsMod = fs) {
	try {
		const raw = fsMod.readFileSync(path.join(REPO_ROOT, 'VERSION'), 'utf-8');
		const fromFile = parseVersion(String(raw).trim().split(/\s+/)[0]);
		if (fromFile) return fromFile;
	} catch {
		// No readable VERSION file; fall through to package.json.
	}
	try {
		const pkgPath = path.join(REPO_ROOT, 'package.json');
		const pkg = JSON.parse(fsMod.readFileSync(pkgPath, 'utf-8'));
		return pkg.version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

/**
 * Read workspace.config.json from the given workspace root.
 *
 * @param {string} workspaceRoot Absolute path to the workspace root.
 * @param {object} [fsMod] Injectable fs module for testability.
 * @returns {object|null} Parsed config, or null if absent/unparseable.
 */
export function readWorkspaceConfig(workspaceRoot, fsMod = fs) {
	const configPath = path.join(workspaceRoot, 'workspace.config.json');
	if (!fsMod.existsSync(configPath)) return null;
	try {
		return JSON.parse(fsMod.readFileSync(configPath, 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * True when the bootstrap self-check has never run for this workspace:
 * workspace.config.json is absent, OR present but has no
 * bootstrap.completedAt set.
 *
 * @param {string} workspaceRoot Absolute path to the workspace root.
 * @param {object} [fsMod] Injectable fs module for testability.
 * @returns {boolean}
 */
export function isBootstrapPending(workspaceRoot, fsMod = fs) {
	const config = readWorkspaceConfig(workspaceRoot, fsMod);
	if (config === null) return true;
	return !config.bootstrap?.completedAt;
}

/**
 * Mark the bootstrap self-check as completed for this workspace. Writes (or
 * creates) workspace.config.json with `bootstrap.completedAt` set to the
 * current time and `bootstrap.version` set to the running package version.
 *
 * Preserves every other field already present in workspace.config.json —
 * this helper never overwrites unrelated config (user, org, agents, etc.).
 *
 * @param {string} workspaceRoot Absolute path to the workspace root.
 * @param {object} [options]
 * @param {object} [options.fsMod] Injectable fs module for testability.
 * @param {string} [options.completedAt] ISO timestamp override (for tests).
 * @param {string} [options.version] Version override (for tests).
 * @returns {object} The updated config object that was written to disk.
 */
export function markBootstrapCompleted(workspaceRoot, { fsMod = fs, completedAt, version } = {}) {
	const configPath = path.join(workspaceRoot, 'workspace.config.json');
	const existing = readWorkspaceConfig(workspaceRoot, fsMod) ?? {};
	const updated = {
		...existing,
		bootstrap: {
			completedAt: completedAt ?? new Date().toISOString(),
			version: version ?? readPackageVersion(fsMod),
		},
	};
	fsMod.mkdirSync(workspaceRoot, { recursive: true });
	fsMod.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
	return updated;
}

/**
 * Reset the bootstrap block (sets completedAt back to null) so the next
 * agent invocation re-triggers the full self-check fan-out. Used only when a
 * user explicitly asks to re-run bootstrap — never automatically.
 *
 * @param {string} workspaceRoot Absolute path to the workspace root.
 * @param {object} [fsMod] Injectable fs module for testability.
 * @returns {object} The updated config object that was written to disk.
 */
export function resetBootstrap(workspaceRoot, fsMod = fs) {
	const configPath = path.join(workspaceRoot, 'workspace.config.json');
	const existing = readWorkspaceConfig(workspaceRoot, fsMod) ?? {};
	const updated = {
		...existing,
		bootstrap: { completedAt: null, version: readPackageVersion(fsMod) },
	};
	fsMod.mkdirSync(workspaceRoot, { recursive: true });
	fsMod.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
	return updated;
}

/**
 * Record that doctor.js ran for this workspace. Writes (or creates)
 * workspace.config.json with `doctor.lastRanAt` and `doctor.exitCode` set.
 *
 * Called only from the real CLI entry point (the `if (isMain)` block in
 * doctor.js) — not from inside `runChecks()`, which is also called by tests
 * and other callers that must not trigger a file-write side effect.
 *
 * Preserves every other field already present in workspace.config.json —
 * this helper never overwrites unrelated config (bootstrap, hubType, etc.).
 *
 * @param {string} workspaceRoot Absolute path to the workspace root.
 * @param {object} [options]
 * @param {object} [options.fsMod] Injectable fs module for testability.
 * @param {string} [options.ranAt] ISO timestamp override (for tests).
 * @param {number} [options.exitCode] Exit code of the doctor run.
 * @returns {object} The updated config object that was written to disk.
 */
export function markDoctorRun(workspaceRoot, { fsMod = fs, ranAt, exitCode } = {}) {
	const configPath = path.join(workspaceRoot, 'workspace.config.json');
	const existing = readWorkspaceConfig(workspaceRoot, fsMod) ?? {};
	const updated = {
		...existing,
		doctor: {
			lastRanAt: ranAt ?? new Date().toISOString(),
			exitCode: exitCode ?? 0,
		},
	};
	fsMod.mkdirSync(workspaceRoot, { recursive: true });
	fsMod.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
	return updated;
}

/**
 * Set the hubType field in workspace.config.json.
 *
 * Preserves every other field already present in workspace.config.json.
 * Creates the file if it doesn't exist.
 *
 * @param {string} workspaceRoot Absolute path to the workspace root.
 * @param {string} hubType The hub type to set ("dev" or "ops").
 * @param {object} [fsMod] Injectable fs module for testability.
 * @returns {object} The updated config object that was written to disk.
 */
export function setHubType(workspaceRoot, hubType, fsMod = fs) {
	const configPath = path.join(workspaceRoot, 'workspace.config.json');
	const existing = readWorkspaceConfig(workspaceRoot, fsMod) ?? {};
	const updated = {
		...existing,
		hubType,
	};
	fsMod.mkdirSync(workspaceRoot, { recursive: true });
	fsMod.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
	return updated;
}

/**
 * Register a project in workspace.config.json's `projects.<projectName>` map.
 *
 * Never overwrites an already-registered project — it may carry a
 * hand-customized `repoPath`, `githubRepo`, or `notes` that the caller doesn't
 * know about and must not clobber. If `projects.<projectName>` already
 * exists, this is a no-op that returns the existing config unchanged.
 *
 * Preserves every other field already present in workspace.config.json —
 * this helper never overwrites unrelated config (bootstrap, hubType, other
 * projects, etc.).
 *
 * @param {string} workspaceRoot Absolute path to the workspace root.
 * @param {string} projectName Name of the project (the key under `projects`).
 * @param {object} fields Fields to store for this project (e.g. `{ repoPath }`).
 * @param {object} [fsMod] Injectable fs module for testability.
 * @returns {object} The resulting config object (written to disk unless the
 *   project was already registered, in which case the unchanged existing
 *   config is returned without a write).
 */
export function registerProject(workspaceRoot, projectName, fields, fsMod = fs) {
	const configPath = path.join(workspaceRoot, 'workspace.config.json');
	const existing = readWorkspaceConfig(workspaceRoot, fsMod) ?? {};
	if (existing.projects?.[projectName]) {
		return existing;
	}
	const updated = {
		...existing,
		projects: {
			...(existing.projects ?? {}),
			[projectName]: fields,
		},
	};
	fsMod.mkdirSync(workspaceRoot, { recursive: true });
	fsMod.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
	return updated;
}

/**
 * Repo-relative (posix) path(s) where the shared bootstrap report may live.
 * Vault tiers (`dev:sub`, `ops`) keep it under vault/Docs; every other known
 * tier keeps it under projects/. Unknown hubType accepts either.
 *
 * @param {string|undefined} hubType
 * @returns {string[]}
 */
export function bootstrapReportPaths(hubType) {
	const free = 'projects/_bootstrap-report.md';
	const vault = 'vault/Docs/_bootstrap-report.md';
	if (hubType === 'dev:sub' || hubType === 'ops') return [vault];
	if (hubType) return [free];
	return [free, vault];
}

/**
 * True when the text contains exactly one verdict line with a single status value
 * (ready, ready-with-warnings, or blocked), and the status is not negated.
 * Rejects: lines with multiple status values, negations like "not ready", or
 * the template line listing all three statuses.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasValidVerdictLine(text) {
	const lines = text.split('\n');
	// Match status values with hyphen-aware boundaries (not just word boundaries).
	// Longest-first to avoid "ready" matching inside "ready-with-warnings".
	// (?<![\w-]) and (?![\w-]) prevent partial matches within compound words.
	const statusRegex = /(?<![\w-])(ready-with-warnings|ready|blocked)(?![\w-])/gi;

	for (const line of lines) {
		if (!/verdict/i.test(line)) continue;

		// Find all status matches on this line
		const matches = [...line.matchAll(statusRegex)];
		if (matches.length !== 1) continue; // Must have exactly one status

		const statusMatch = matches[0];
		const matchIndex = statusMatch.index;

		// Check if this status is negated (preceded by not/no/isn't/never/etc.)
		const beforeMatch = line.substring(0, matchIndex).trim();
		if (/\b(?:not|no|isn't|never|can't)\s*$/i.test(beforeMatch)) {
			continue; // Status is negated, skip this line
		}

		// Verdict line is valid: contains "verdict" and exactly one non-negated status
		return true;
	}
	return false;
}

/**
 * Gate used by the CLI before stamping: ok only when a report exists at an
 * accepted path and contains a valid verdict line (exactly one of: ready,
 * ready-with-warnings, or blocked, not negated).
 *
 * @param {string} hubRoot
 * @param {string|undefined} hubType
 * @param {object} [fsMod] Injectable fs module for testability.
 * @returns {{ok: boolean, expected: string[]}}
 */
export function checkBootstrapReport(hubRoot, hubType, fsMod = fs) {
	const expected = bootstrapReportPaths(hubType);
	const ok = expected.some(rel => {
		try {
			return hasValidVerdictLine(fsMod.readFileSync(path.join(hubRoot, rel), 'utf-8'));
		} catch {
			return false;
		}
	});
	return { ok, expected };
}

// ── CLI entry point ────────────────────────────────────────────────────────────
//
// The persistence step of the Bootstrap Self-Check protocol (agent-foundations
// skill) previously had no real call site: an agent had to hand-edit
// workspace.config.json at runtime, following prose that never mentioned
// hubType. This entry point is what that protocol now actually runs — it
// backfills hubType from the packaged tier sentinel (pipelines/deploy/.hub-config.json)
// when it isn't already set, then stamps bootstrap.completedAt. It never
// overrides an already-set hubType (see setHubType() docs above and
// resolveHubType()'s matching "never silently apply" precedent in setup.js —
// that reconciliation-with-prompt UX belongs to `npm run setup` only; this
// skip-setup path only ever fills an unset value, it never reconciles a
// disagreement).

const isMain = process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	const outputIdx = process.argv.indexOf('--output');
	const hubRoot = outputIdx !== -1
		? path.resolve(process.argv[outputIdx + 1])
		: process.cwd();

	if (process.argv.includes('--reset')) {
		const reset = resetBootstrap(hubRoot);
		process.stdout.write(JSON.stringify(reset, null, 2) + '\n');
		process.exit(0);
	}

	const existing = readWorkspaceConfig(hubRoot);
	const sentinelHubType = existing?.hubType
		? undefined
		: readHubConfig(path.join(hubRoot, 'pipelines', 'deploy'))?.hubType;

	if (!process.argv.includes('--force')) {
		const gate = checkBootstrapReport(hubRoot, existing?.hubType ?? sentinelHubType);
		if (!gate.ok) {
			process.stderr.write(
				`bootstrap.js refused: no shared bootstrap report containing a verdict line (ready, ready-with-warnings or blocked) at ${gate.expected.join(' or ')}; run the Bootstrap Self-Check protocol (agent-foundations skill) and write the report first.\n`,
			);
			process.exit(1);
		}
	}

	if (sentinelHubType) {
		setHubType(hubRoot, sentinelHubType);
	}

	const updated = markBootstrapCompleted(hubRoot);
	process.stdout.write(JSON.stringify(updated, null, 2) + '\n');
}
