#!/usr/bin/env node
/**
 * memory-check-message.js — the single source of the WAL reminder text every
 * memory-check adapter shows (Claude Code, Cursor, Copilot).
 *
 * The wording lives in memory-check-message.txt with a {{MEMORY_ROOT}}
 * placeholder. This module fills the placeholder with the tier-resolved
 * memory root from memory-check-core.js (which imports
 * resolveMemoryRootForHub()), so free-tier hubs are told "memory/<agent>.md"
 * and vault-backed hubs are told "vault/Memory/<agent>.md".
 *
 * Hubs that ship the keyed memory command (pipelines/deploy/lib/memory-command.js,
 * vault-backed tiers only) and have at least one migrated agent get keyed
 * wording in place of the middle lines: `npm run memory -- add` with the
 * 160-character summary limit and a warning that the tier files are generated,
 * then one line each, by agent name, for unmigrated agents (their single note,
 * never `memory add`) and mixed ones (stop). Every other hub gets the template
 * unchanged. The bash fallback in memory-check-message.sh renders the
 * free-tier template without it.
 *
 * As a CLI it prints the rendered text to stdout; the bash adapters call it
 * through memory-check-message.sh. With --neutral the first line drops the
 * claim that files were changed (used when only the marker-only fallback
 * applies, so no work evidence exists).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	resolveHubRoot,
	resolveMemoryRootSegment,
} from './memory-check-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, 'memory-check-message.txt');

/** Top-level memory notes that are not agents. */
const NON_AGENT_NAMES = new Set(['memory-index', 'working-buffer']);

/**
 * Group the agents under the memory root by memory shape with the shared
 * definition in the hub's memory-scaffold.js (memoryShape). An agent id is a
 * folder (not archive/) or a top-level note, minus the non-agent notes. Null
 * when the shared definition cannot be loaded: the caller then keeps the
 * single-note template.
 *
 * @param {string} hubRoot
 * @param {string} memoryRootAbs
 * @returns {Promise<{ migrated: string[], single: string[], mixed: string[] } | null>}
 */
async function groupAgentsByShape(hubRoot, memoryRootAbs) {
	let scaffold;
	try {
		scaffold = await import(
			pathToFileURL(
				path.resolve(hubRoot, 'pipelines/deploy/lib/memory-scaffold.js'),
			).href
		);
	} catch {
		return null;
	}
	if (typeof scaffold.memoryShape !== 'function') return null;
	let dirents;
	try {
		dirents = fs.readdirSync(memoryRootAbs, { withFileTypes: true });
	} catch {
		return { migrated: [], single: [], mixed: [] };
	}
	const ids = new Set();
	for (const e of dirents) {
		if (e.isDirectory() && e.name !== 'archive' && !e.name.startsWith('.'))
			ids.add(e.name);
		if (e.isFile() && e.name.endsWith('.md')) {
			const id = e.name.slice(0, -3);
			if (!NON_AGENT_NAMES.has(id) && !id.startsWith('_')) ids.add(id);
		}
	}
	const groups = { migrated: [], single: [], mixed: [] };
	for (const agentId of [...ids].sort()) {
		const shape = scaffold.memoryShape({ memoryRoot: memoryRootAbs, agentId });
		if (shape === 'migrated') groups.migrated.push(agentId);
		else if (shape === 'single-note') groups.single.push(agentId);
		else if (shape === 'mixed') groups.mixed.push(agentId);
	}
	return groups;
}

/**
 * The lines between the first line and the WAL line when at least one agent is
 * migrated.
 *
 * @param {{ migrated: string[], single: string[], mixed: string[] }} groups
 * @returns {string[]}
 */
function keyedLines(groups) {
	const lines = [
		'Before closing, record decisions, corrections, or new context from this session with',
		`\`npm run memory -- add <agent> <key> --summary "<up to 160 characters>"\` for a migrated agent (${groups.migrated.join(', ')}).`,
		'The tier files under {{MEMORY_ROOT}}/<agent>/ are generated: never edit them by hand.',
	];
	if (groups.single.length > 0)
		lines.push(
			`An unmigrated agent (${groups.single.join(', ')}) keeps one note: update the HOT section in {{MEMORY_ROOT}}/<agent>.md; never use memory add for it.`,
		);
	if (groups.mixed.length > 0)
		lines.push(
			`Mixed memory (${groups.mixed.join(', ')}): stop and tell the team lead; read and write nothing for it.`,
		);
	return lines;
}

/**
 * Neutral wording for the first reminder line, for callers without work
 * evidence: we cannot claim files were changed.
 *
 * @param {string} line
 * @returns {string}
 */
export function neutralizeFirstLine(line) {
	return line.replace(
		/files were changed this session but (.*) was not updated\./,
		'no update to $1 was found this session.',
	);
}

/**
 * @param {string} [hubRootOverride] test-only override; production callers omit this
 * @returns {Promise<string[]>} reminder lines with the memory root filled in
 */
export async function renderReminderLines(hubRootOverride) {
	const hubRoot = hubRootOverride ?? resolveHubRoot();
	const memoryRoot = await resolveMemoryRootSegment(hubRoot);
	let lines = fs
		.readFileSync(TEMPLATE_PATH, 'utf-8')
		.replace(/\r/g, '')
		.trimEnd()
		.split('\n');
	// Only a hub that ships the keyed memory command can have migrated agents.
	if (
		fs.existsSync(
			path.join(hubRoot, 'pipelines', 'deploy', 'lib', 'memory-command.js'),
		)
	) {
		const groups = await groupAgentsByShape(
			hubRoot,
			path.join(hubRoot, memoryRoot),
		);
		if (groups && groups.migrated.length > 0)
			lines = [lines[0], ...keyedLines(groups), lines[lines.length - 1]];
	}
	return lines.map((line) => line.replaceAll('{{MEMORY_ROOT}}', memoryRoot));
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const lines = await renderReminderLines();
	if (process.argv.includes('--neutral'))
		lines[0] = neutralizeFirstLine(lines[0]);
	process.stdout.write(`${lines.join('\n')}\n`);
}
