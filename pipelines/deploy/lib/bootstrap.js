/**
 * bootstrap.js — workspace.config.json `bootstrap` block read/write helpers.
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Read this repo's own package.json version. Resolved relative to this file
 * so it works the same whether invoked from the source repo or a deployed
 * hub's copy of pipelines/deploy/ (the deployed hub still ships its own package.json next
 * to pipelines/deploy/, mirroring how other lib modules resolve repo-relative paths).
 *
 * @param {object} [fsMod] Injectable fs module for testability.
 * @returns {string} Semver string, or '0.0.0' if package.json is unreadable.
 */
export function readPackageVersion(fsMod = fs) {
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
