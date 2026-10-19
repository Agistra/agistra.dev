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
 * vault-backed tiers only) get one extra sentence before the last line,
 * telling a migrated agent how to record entries. Other hubs get the template
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
import { fileURLToPath } from 'node:url';
import {
	resolveHubRoot,
	resolveMemoryRootSegment,
} from './memory-check-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, 'memory-check-message.txt');

const MIGRATED_NOTE = [
	'A migrated agent keeps entries under {{MEMORY_ROOT}}/<agent>/: record them with `npm run memory -- add`.',
];

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
	const lines = fs
		.readFileSync(TEMPLATE_PATH, 'utf-8')
		.replace(/\r/g, '')
		.trimEnd()
		.split('\n');
	if (
		fs.existsSync(
			path.join(hubRoot, 'pipelines', 'deploy', 'lib', 'memory-command.js'),
		)
	)
		lines.splice(lines.length - 1, 0, ...MIGRATED_NOTE);
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
