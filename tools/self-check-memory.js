/**
 * self-check-memory.js — the memory half of the Bootstrap Self-Check report
 * (tools/self-check.js): what the agent would read, and whether a write would
 * land, for the memory shape the resolver reports.
 *
 *   read        what the first Session Start read returns: the HOT index of a
 *               migrated agent (an empty keyed tree reads as empty, no error),
 *               the single note, or nothing yet for an absent agent.
 *   roundTrip   the write the agent would do, run against a TEMP COPY of its
 *               memory, never the live files:
 *                 migrated   add, resolve-path, get, resolve   (the memory command)
 *                 single     writable, edit, read-back         (copy of the note)
 *                 absent     ensure, resolve-path, read-back   (memory ensure)
 *                 mixed      skipped: the agent must stop, so there is no write
 *   limits      the numbers a keyed write is checked against.
 *
 * A failed round trip, or a mixed shape, blocks the verdict (self-check.js).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePath } from './resolve-path.js';

const ROUND_TRIP_KEY = 'self-check-round-trip';
const ROUND_TRIP_SUMMARY =
	'self-check scratch entry written to a temp copy, never the live memory';

async function importFromHub(hubRoot, rel) {
	try {
		return await import(pathToFileURL(path.join(hubRoot, rel)).href);
	} catch {
		return null;
	}
}

/** Count of `- [[` entry lines in a generated tier index. */
function countIndexEntries(text) {
	return text.split(/\r?\n/).filter((line) => line.startsWith('- [[')).length;
}

function countEntryFiles(dir) {
	try {
		return fs
			.readdirSync(dir)
			.filter((n) => n.endsWith('.md') && !n.startsWith('.')).length;
	} catch {
		return 0;
	}
}

/**
 * @param {{ shape: string, path: string }} resolved
 * @param {string} agent
 */
export function readMemory(resolved, agent) {
	const { shape, path: memPath } = resolved;
	if (shape === 'mixed') {
		return {
			ok: false,
			kind: 'blocked',
			detail: 'mixed: neither the note nor the keyed entries are read',
		};
	}
	if (shape === 'migrated') {
		let text = null;
		try {
			text = fs.readFileSync(memPath, 'utf-8');
		} catch {
			// no generated index yet: an empty keyed tree
		}
		const entries =
			text !== null
				? countIndexEntries(text)
				: countEntryFiles(path.join(path.dirname(memPath), 'hot'));
		return {
			ok: true,
			kind: 'hot-index',
			entries,
			empty: entries === 0,
			bytes: text === null ? 0 : Buffer.byteLength(text, 'utf-8'),
			detail:
				entries === 0
					? `HOT index ${text === null ? 'not generated yet' : 'has no entries'}: reads as empty`
					: `HOT index lists ${entries} entr${entries === 1 ? 'y' : 'ies'}`,
		};
	}
	if (shape === 'single-note') {
		try {
			const text = fs.readFileSync(memPath, 'utf-8');
			return {
				ok: true,
				kind: 'note',
				bytes: Buffer.byteLength(text, 'utf-8'),
				lines: text.split(/\r?\n/).length,
				detail: `single note read (${Buffer.byteLength(text, 'utf-8')} bytes)`,
			};
		} catch (err) {
			return { ok: false, kind: 'note', detail: `cannot read: ${err.message}` };
		}
	}
	return {
		ok: true,
		kind: 'none',
		detail: `no memory for ${agent} yet: run \`memory ensure ${agent}\` before the first write`,
	};
}

/** Copy only what the memory command and the resolver need into a temp hub. */
function mirrorHub(hubRoot, tmp, memoryRoot, agent) {
	const copyIf = (rel) => {
		const from = path.join(hubRoot, rel);
		if (!fs.existsSync(from)) return;
		const to = path.join(tmp, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.cpSync(from, to, { recursive: true });
	};
	copyIf('workspace.config.json');
	copyIf(path.join('skills', 'agent-foundations', 'storage', 'obsidian.md'));
	copyIf(path.join('pipelines', 'deploy', 'wizard.js'));
	copyIf(path.join('pipelines', 'deploy', 'lib', 'memory-root.js'));
	copyIf(path.join('pipelines', 'deploy', 'lib', 'vault-layout.js'));
	copyIf(path.join('pipelines', 'deploy', 'lib', 'memory-scaffold.js'));
	const rel = path.relative(hubRoot, memoryRoot);
	fs.mkdirSync(path.join(tmp, rel), { recursive: true });
	fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });
	copyIf(path.join(rel, `${agent}.md`));
	copyIf(path.join(rel, agent));
}

function step(steps, name, ok, detail) {
	steps.push({ step: name, ok, ...(detail ? { detail } : {}) });
	return ok;
}

async function migratedRoundTrip({ hubRoot, tmp, agent }) {
	const steps = [];
	const mod = await importFromHub(
		hubRoot,
		path.join('pipelines', 'deploy', 'lib', 'memory-command.js'),
	);
	if (!mod?.runCli) {
		step(steps, 'add', false, 'the memory command is not shipped on this hub');
		return {
			ok: false,
			steps,
			error:
				'the memory command (pipelines/deploy/lib/memory-command.js) is missing',
		};
	}
	const opts = { hubRoot: tmp, markDirty: () => {} };
	const added = mod.runCli(
		[
			'add',
			agent,
			ROUND_TRIP_KEY,
			'--summary',
			ROUND_TRIP_SUMMARY,
			'--body',
			'scratch',
		],
		opts,
	);
	if (!step(steps, 'add', added.ok, added.ok ? undefined : added.error))
		return {
			ok: false,
			steps,
			error: `${added.code ?? 'add-failed'}: ${added.error}`,
		};

	const resolved = await resolvePath({
		hubRoot: tmp,
		store: 'memory',
		arg: agent,
	});
	const inTmp =
		resolved.ok &&
		resolved.shape === 'migrated' &&
		path.resolve(resolved.path).startsWith(path.resolve(tmp));
	if (
		!step(
			steps,
			'resolve-path',
			inTmp,
			resolved.ok ? resolved.path : resolved.error,
		)
	)
		return {
			ok: false,
			steps,
			error: 'resolve-path did not return the HOT index',
		};

	const got = mod.runCli(['get', agent, ROUND_TRIP_KEY], opts);
	let indexHasKey = false;
	try {
		indexHasKey = fs
			.readFileSync(resolved.path, 'utf-8')
			.includes(`${agent}/hot/${ROUND_TRIP_KEY}`);
	} catch {
		// reported below
	}
	if (
		!step(
			steps,
			'get',
			got.ok && got.entry?.summary === ROUND_TRIP_SUMMARY && indexHasKey,
			got.ok ? undefined : got.error,
		)
	)
		return { ok: false, steps, error: 'the entry did not read back' };

	const done = mod.runCli(['resolve', agent, ROUND_TRIP_KEY], opts);
	if (!step(steps, 'resolve', done.ok, done.ok ? undefined : done.error))
		return {
			ok: false,
			steps,
			error: `${done.code ?? 'resolve-failed'}: ${done.error}`,
		};
	return { ok: true, steps };
}

async function singleRoundTrip({ resolved, tmp, hubRoot }) {
	const steps = [];
	try {
		fs.accessSync(resolved.path, fs.constants.W_OK);
		step(steps, 'writable', true);
	} catch (err) {
		step(steps, 'writable', false, err.message);
		return {
			ok: false,
			steps,
			error: `the note is not writable: ${err.message}`,
		};
	}
	const copy = path.join(tmp, path.relative(hubRoot, resolved.path));
	const marker = `- self-check round trip ${Date.now()}`;
	fs.appendFileSync(copy, `\n${marker}\n`);
	step(steps, 'edit', true, 'appended a line to the temp copy');
	const back = fs.readFileSync(copy, 'utf-8').includes(marker);
	step(steps, 'read-back', back);
	return back
		? { ok: true, steps }
		: { ok: false, steps, error: 'the edit did not read back' };
}

async function absentRoundTrip({ hubRoot, tmp, agent }) {
	const steps = [];
	const mod = await importFromHub(
		hubRoot,
		path.join('pipelines', 'deploy', 'lib', 'memory-cli.js'),
	);
	if (!mod?.ensureMemoryFile) {
		step(steps, 'ensure', false, 'memory-cli.js is missing');
		return { ok: false, steps, error: 'memory-cli.js is missing' };
	}
	const ensured = mod.ensureMemoryFile(agent, { repoRoot: tmp });
	if (!step(steps, 'ensure', ensured.ok && ensured.memoryFileCreated === true))
		return {
			ok: false,
			steps,
			error: ensured.error ?? 'ensure created nothing',
		};
	const resolved = await resolvePath({
		hubRoot: tmp,
		store: 'memory',
		arg: agent,
	});
	if (
		!step(
			steps,
			'resolve-path',
			resolved.ok && resolved.shape === 'single-note',
		)
	)
		return { ok: false, steps, error: 'resolve-path did not see the new note' };
	const back = fs.existsSync(resolved.path);
	step(steps, 'read-back', back);
	return back
		? { ok: true, steps }
		: { ok: false, steps, error: 'the new note did not read back' };
}

/**
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {string} options.agent
 * @param {{ ok: boolean, shape: string, path: string }} options.resolved
 * @returns {Promise<{ ok: boolean, skipped?: boolean, steps: object[], error?: string }>}
 */
export async function writeRoundTrip({ hubRoot, agent, resolved }) {
	if (resolved.shape === 'mixed') {
		return {
			ok: false,
			skipped: true,
			steps: [],
			error: 'skipped: a mixed memory is never written',
		};
	}
	const memoryRoot =
		resolved.shape === 'migrated'
			? path.dirname(path.dirname(resolved.path))
			: path.dirname(resolved.path);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-check-memory-'));
	try {
		mirrorHub(hubRoot, tmp, memoryRoot, agent);
		const ctx = { hubRoot, tmp, agent, resolved, memoryRoot };
		if (resolved.shape === 'migrated') return await migratedRoundTrip(ctx);
		if (resolved.shape === 'single-note') return await singleRoundTrip(ctx);
		return await absentRoundTrip(ctx);
	} catch (err) {
		return {
			ok: false,
			steps: [],
			error: `round trip crashed: ${err.message}`,
		};
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/** The limits a keyed write is checked against, or null when the hub has no memory command. */
export async function memoryLimits(hubRoot) {
	const config = await importFromHub(
		hubRoot,
		path.join('pipelines', 'deploy', 'lib', 'memory-config.js'),
	);
	const entry = await importFromHub(
		hubRoot,
		path.join('pipelines', 'deploy', 'lib', 'memory-entry.js'),
	);
	if (!config?.resolveMemoryLimits || !entry?.SUMMARY_MAX_LENGTH) return null;
	const resolved = config.resolveMemoryLimits({ hubRoot });
	if (!resolved.ok) return null;
	return {
		summaryMaxChars: entry.SUMMARY_MAX_LENGTH,
		hotIndexMaxLines: resolved.limits.hotIndexMaxLines,
		hotIndexMaxBytes: resolved.limits.hotIndexMaxBytes,
		entryMaxBytes: resolved.limits.entryMaxBytes,
	};
}
