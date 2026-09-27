/**
 * memory-root.js — single source of truth for where agent memory files and
 * the projects/tasks root live on disk for a given hubType.
 *
 * Free/customer-archive tiers (dev, dev:graph) store memory as plain repo
 * files at <hubRoot>/memory/<agent>.md (the repo-files.md storage plugin)
 * and tasks as plain repo files at <hubRoot>/projects/<project>/task_*.md.
 * Vault-backed paid tiers (dev:sub, ops) store memory as an
 * Obsidian vault note at <hubRoot>/vault/Memory/<agent>.md and tasks as
 * vault notes at <hubRoot>/vault/Tasks/<project>/task_*.md (the obsidian.md
 * storage plugin — see the Storage Plugin Contract in
 * agents/skills/agent-foundations/SKILL.md, and the vault-canonical record
 * convention it documents for vault-backed tiers).
 *
 * VAULT_BACKED_HUB_TYPES mirrors OBSIDIAN_HUB_TYPES in
 * lib/obsidian.doctor-plugin.js exactly — both lists gate on the same set of
 * paid, vault-shaped tiers. If that list ever changes, update both.
 *
 * This module is the single "resolve memory/tasks root for this hubType"
 * helper referenced by every call site that must never drift independently:
 *   - lib/extras.js         (deploy-time memory + projects/tasks scaffold —
 *                            hubType is a param)
 *   - doctor.js             (checkMemoryFiles, checkProjectsDir — hubType
 *                            read from workspace.config.json)
 *   - lib/session-cli.js    (sessionInit's hotSummary default — hubType read
 *                            from workspace.config.json, same as doctor.js)
 *   - targets/claude-code.js (deployClaudeCode's own memory-template copy —
 *                            source-repo-only tooling, never shipped into a
 *                            deployed hub, so it can import this freely)
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe } from '../wizard.js';

/** Hub tiers whose canonical memory record lives in the Obsidian vault, not plain repo files. */
export const VAULT_BACKED_HUB_TYPES = ['dev:sub', 'ops'];

export function isVaultBackedHubType(hubType) {
	return VAULT_BACKED_HUB_TYPES.includes(hubType);
}

/**
 * Resolve the memory-root path segment for a given hubType, relative to
 * hubRoot. Vault-backed tiers resolve to "vault/Memory"; every other
 * (including unset/unrecognised) hubType resolves to "memory", matching the
 * pre-existing free-tier default.
 *
 * @param {string|undefined|null} hubType
 * @returns {string} OS-native relative path segment
 */
export function resolveMemoryRootSegment(hubType) {
	return isVaultBackedHubType(hubType) ? path.join('vault', 'Memory') : 'memory';
}

/**
 * Resolve the absolute memory root for a hub, given its hubRoot and hubType.
 *
 * @param {string} hubRoot
 * @param {string|undefined|null} hubType
 * @returns {string} absolute path
 */
export function resolveMemoryRoot(hubRoot, hubType) {
	return path.join(hubRoot, resolveMemoryRootSegment(hubType));
}

/**
 * Resolve the absolute memory root for an already-deployed-and-set-up hub by
 * reading its own workspace.config.json for hubType. Used by call sites
 * (session-cli.js) that only have a hubRoot to work with, not an
 * already-parsed config — doctor.js parses workspace.config.json itself via
 * readHubConfig() and calls resolveMemoryRoot() directly to avoid a second
 * read of the same file.
 *
 * @param {string} hubRoot
 * @param {object} [opts]
 * @param {object} [opts.fsMod]
 * @returns {string} absolute path
 */
export function resolveMemoryRootForHub(hubRoot, { fsMod = fs } = {}) {
	const config = readJsonSafe(path.join(hubRoot, 'workspace.config.json'), fsMod);
	return resolveMemoryRoot(hubRoot, config?.hubType);
}

/**
 * Resolve the projects/tasks-root path segment for a given hubType, relative
 * to hubRoot. Vault-backed tiers resolve to "vault/Tasks"; every other
 * (including unset/unrecognised) hubType resolves to "projects", matching
 * the pre-existing free-tier default. Mirrors resolveMemoryRootSegment()
 * exactly — same VAULT_BACKED_HUB_TYPES gate, same fallback shape.
 *
 * @param {string|undefined|null} hubType
 * @returns {string} OS-native relative path segment
 */
export function resolveTasksRootSegment(hubType) {
	return isVaultBackedHubType(hubType) ? path.join('vault', 'Tasks') : 'projects';
}

/**
 * Resolve the absolute projects/tasks root for a hub, given its hubRoot and
 * hubType.
 *
 * @param {string} hubRoot
 * @param {string|undefined|null} hubType
 * @returns {string} absolute path
 */
export function resolveTasksRoot(hubRoot, hubType) {
	return path.join(hubRoot, resolveTasksRootSegment(hubType));
}
