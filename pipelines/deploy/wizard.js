/**
 * wizard.js — Relay MCP wiring for Claude Code and Cursor targets.
 *
 * Reads workspace.config.json → telegram block and writes mcpServers.relay
 * into the appropriate platform config files:
 *   - Claude Code: ~/.claude/settings.json
 *   - Cursor:      .cursor/mcp.json  (relative to workspace root)
 *
 * Invoked as a sub-step from setup.js. Never run standalone.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Constants ──────────────────────────────────────────────────────────────────

export const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// ── Pure helpers (exported for testing) ───────────────────────────────────────

/**
 * Read and parse a JSON file safely.
 *
 * @param {string} filePath  Absolute path to the file.
 * @returns {object|null}  Parsed JSON, or null if the file is absent or unparseable.
 */
export function readJsonSafe(filePath, fsMod = fs) {
	if (!fsMod.existsSync(filePath)) return null;
	try {
		return JSON.parse(fsMod.readFileSync(filePath, 'utf-8'));
	} catch {
		return null;
	}
}

// ── Safe read of a settings.json before a merge-and-rewrite ─────────────────────
//
// Every writer of a Claude Code settings.json merges framework entries into
// whatever the user already has. A file that exists but cannot be used (syntax
// error, wrong top-level type, a key the merge would replace holding the wrong
// type) must never be treated as {} and rewritten: that silently drops the
// user's deny/ask rules, hooks, env and every other key. Writers call
// readSettingsForMerge(), and when it reports `unusable` they leave the file
// byte-identical and tell the user which file and why.
//
// Lives here, not in its own module, because this file already ships to every
// tier and the hook scripts that import readJsonSafe from it must keep working
// with nothing else alongside.

/** Shape each writer needs, as dotted paths into the settings object. */
export const SETTINGS_SHAPE = Object.freeze({
	/** task-permission.js: the allow list the rules are appended to. */
	permissions: Object.freeze({
		object: Object.freeze(['permissions']),
		array: Object.freeze(['permissions.allow']),
	}),
	/** wizard.js: the MCP server map the relay entry is added to. */
	mcpServers: Object.freeze({
		object: Object.freeze(['mcpServers']),
		array: Object.freeze([]),
	}),
	/** Writers that append to a single hook event list. */
	sessionStartHook: Object.freeze({
		object: Object.freeze(['hooks']),
		array: Object.freeze(['hooks.SessionStart']),
	}),
	/** The deploy target and the dev:sub knowledge hooks: every event a merge touches. */
	allHookEvents: Object.freeze({
		object: Object.freeze(['hooks']),
		array: Object.freeze([
			'hooks.SessionStart',
			'hooks.PreToolUse',
			'hooks.PostToolUse',
			'hooks.Stop',
		]),
	}),
});

/** Thrown by writers that cannot continue past an unusable settings file. */
export class UnusableSettingsError extends Error {
	constructor(filePath, reason, consequence = '') {
		super(unusableSettingsMessage(filePath, reason, consequence));
		this.name = 'UnusableSettingsError';
		this.filePath = filePath;
		this.reason = reason;
	}
}

/**
 * One user-facing sentence group: which file, why, what did not happen.
 *
 * @param {string} filePath
 * @param {string} reason
 * @param {string} [consequence]  What the caller skipped or stopped.
 */
export function unusableSettingsMessage(filePath, reason, consequence = '') {
	const tail = consequence ? ` ${consequence}` : '';
	return `${filePath} was left untouched: ${reason}.${tail} Fix the file or move it aside, then run this again.`;
}

function valueAt(settings, dottedPath) {
	let node = settings;
	for (const key of dottedPath.split('.')) {
		if (node === undefined || node === null) return undefined;
		// A wrong-typed parent is reported on its own path; nothing to read below it.
		if (typeof node !== 'object' || Array.isArray(node)) return undefined;
		node = node[key];
	}
	return node;
}

function checkShape(settings, shape) {
	if (!shape) return null;
	for (const p of shape.object ?? []) {
		const v = valueAt(settings, p);
		if (v !== undefined && v !== null && (typeof v !== 'object' || Array.isArray(v))) {
			return `"${p}" is not an object`;
		}
	}
	for (const p of shape.array ?? []) {
		const v = valueAt(settings, p);
		if (v !== undefined && v !== null && !Array.isArray(v)) {
			return `"${p}" is not an array`;
		}
	}
	return null;
}

/**
 * Leading whitespace of the first indented line, or null when the file has
 * none (single-line or empty). Used to rewrite with the user's own indent.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function detectIndent(raw) {
	const match = /^([ \t]+)\S/m.exec(raw);
	return match ? match[1] : null;
}

/**
 * Read a settings file for a merge-and-rewrite.
 *
 * - `absent`: the file does not exist; `settings` is null.
 * - `ok`: parsed to a plain object whose merge-relevant keys have the right
 *   types. A whitespace-only file counts as an empty object (nothing to lose).
 *   A leading UTF-8 byte order mark is ignored when parsing.
 * - `unusable`: exists but cannot be merged safely; `reason` says why. The
 *   caller must not write the file.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {object} [opts.fsMod]
 * @param {{object?: string[], array?: string[]}} [opts.expect]  Dotted paths and the
 *   type each must have when present (see SETTINGS_SHAPE).
 * @returns {{status: 'absent'|'ok'|'unusable', existed: boolean, settings: object|null,
 *   raw: string|null, indent: string|null, reason: string|null}}
 */
export function readSettingsForMerge(filePath, { fsMod = fs, expect = null } = {}) {
	const result = { status: 'absent', existed: false, settings: null, raw: null, indent: null, reason: null };
	if (!fsMod.existsSync(filePath)) return result;
	result.existed = true;

	let raw;
	try {
		raw = fsMod.readFileSync(filePath, 'utf-8');
	} catch (err) {
		return { ...result, status: 'unusable', reason: `it could not be read (${err.code ?? err.message})` };
	}
	result.raw = raw;
	result.indent = detectIndent(raw);

	const text = raw.replace(/^﻿/, '');
	if (text.trim() === '') {
		return { ...result, status: 'ok', settings: {} };
	}

	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { ...result, status: 'unusable', reason: `it is not valid JSON (${err.message})` };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ...result, status: 'unusable', reason: 'its top-level value is not a JSON object' };
	}
	const shapeProblem = checkShape(parsed, expect);
	if (shapeProblem) {
		return { ...result, status: 'unusable', reason: shapeProblem };
	}
	return { ...result, status: 'ok', settings: parsed };
}

/**
 * Serialize settings with the file's own indent when it had one.
 *
 * @param {object} settings
 * @param {string|number|null} indent  Detected indent, or null for the default.
 * @param {string|number} defaultIndent
 */
export function stringifySettings(settings, indent, defaultIndent) {
	return JSON.stringify(settings, null, indent ?? defaultIndent) + '\n';
}

/**
 * Merge mcpServers.relay into a config object without duplicating.
 *
 * @param {object} existing
 * @param {object} entry
 * @returns {object}
 */
export function mergeRelayMcpEntry(existing, entry) {
	if (!existing.mcpServers) {
		existing.mcpServers = {};
	}
	existing.mcpServers.relay = entry;
	return existing;
}

/**
 * Build the MCP server entry for the hub relay daemon.
 *
 * @param {string} workspaceRoot Absolute path to the hub root.
 * @returns {object}
 */
export function buildRelayMcpEntry(workspaceRoot) {
	const serverPath = path.join(workspaceRoot, 'pipelines', 'deploy', 'relay', 'mcp', 'server.js');
	return {
		command: process.execPath,
		args: [serverPath, '--hub', path.resolve(workspaceRoot)],
	};
}

/**
 * Write a JSON object to a file atomically (write then rename).
 *
 * @param {string} filePath  Absolute path to write.
 * @param {object} data      Object to serialize.
 * @param {object} [fsMod]   Injectable fs module for testing.
 * @param {string|null} [indent]  Indent to keep from an existing file; default two spaces.
 */
export function writeJsonSafe(filePath, data, fsMod = fs, indent = null) {
	const dir = path.dirname(filePath);
	fsMod.mkdirSync(dir, { recursive: true });
	fsMod.writeFileSync(filePath, JSON.stringify(data, null, indent ?? 2) + '\n', 'utf-8');
}

// ── Main wiring functions ──────────────────────────────────────────────────────

/**
 * Wire relay MCP server config into Claude Code and/or Cursor platform files.
 *
 * @param {object} options
 * @param {object}   options.config
 * @param {string}   options.workspaceRoot
 * @param {string[]} options.targets
 * @param {object}   [options.fsMod]
 * @returns {{ wrote: string[], skipped: Array<{ file: string, message: string }> }}
 *   `skipped` lists a file left untouched because it exists but cannot be merged into.
 */
export function wireRelayMcp({
	config,
	workspaceRoot,
	targets = [],
	fsMod = fs,
}) {
	const wrote = [];
	const skipped = [];

	const telegram = config?.telegram;
	if (!telegram || telegram.enabled === false) {
		return { wrote, skipped };
	}

	const entry = buildRelayMcpEntry(workspaceRoot);

	if (targets.includes('claude-code')) {
		// ~/.claude/settings.json holds the user's own settings; never rewrite a
		// file that does not parse.
		const read = readSettingsForMerge(CLAUDE_SETTINGS_PATH, { fsMod, expect: SETTINGS_SHAPE.mcpServers });
		if (read.status === 'unusable') {
			skipped.push({
				file: CLAUDE_SETTINGS_PATH,
				message: unusableSettingsMessage(CLAUDE_SETTINGS_PATH, read.reason, 'The relay MCP server was not added there.'),
			});
		} else {
			const existing = read.settings ?? {};
			mergeRelayMcpEntry(existing, entry);
			writeJsonSafe(CLAUDE_SETTINGS_PATH, existing, fsMod, read.indent);
			wrote.push(CLAUDE_SETTINGS_PATH);
		}
	}

	if (targets.includes('cursor')) {
		const cursorMcpPath = path.join(workspaceRoot, '.cursor', 'mcp.json');
		const existing = readJsonFileSafe(cursorMcpPath, fsMod) ?? {};
		mergeRelayMcpEntry(existing, entry);
		writeJsonSafe(cursorMcpPath, existing, fsMod);
		wrote.push(cursorMcpPath);
	}

	return { wrote, skipped };
}

// ── Internal helper (uses injectable fs for testability) ─────────────────────

/**
 * Read and parse JSON using an injectable fs module.
 *
 * @param {string} filePath
 * @param {object} fsMod
 * @returns {object|null}
 */
function readJsonFileSafe(filePath, fsMod) {
	if (!fsMod.existsSync(filePath)) return null;
	try {
		return JSON.parse(fsMod.readFileSync(filePath, 'utf-8'));
	} catch {
		return null;
	}
}
