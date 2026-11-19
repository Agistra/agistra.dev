/**
 * status-runs.js — agent run records.
 *
 * One small JSON file per agent run, so the hub can say what is running, for
 * how long, and whether it has gone quiet. `npm run task -- run start|touch|end`
 * writes them; `npm run status` reads them.
 *
 * Where the records live (local hub state, never committed):
 *   - vault-backed hubs: `<hub>/vault/Workspace/Runs/<run-id>.json`, inside the
 *     vault's Workspace area, which the hub's .gitignore already excludes.
 *   - every other hub:   `<hub>/.agent-runs/<run-id>.json`, ignored by the
 *     hub's .gitignore.
 *
 * A record: id, agent, instance, ticket (`<project>#task_N`), project,
 * worktree, started_at, updated_at, ended_at, outcome, note. Times are ISO
 * 8601 UTC strings.
 *
 * The ticket must be project-qualified. A bare id is refused, the same rule
 * the other id-taking `task` commands apply to an ambiguous bare id.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { findTaskInProject, taskNumberOf } from './tasks.js';
import {
	projectTaskDir,
	resolveVaultLayout,
	workspacePaths,
} from './vault-layout.js';
import { scanForSecrets, formatSecretScanError } from './secret-scan.js';

/** Folder, relative to the hub root, that holds records on a hub with no vault. */
export const LOCAL_RUNS_DIR = '.agent-runs';

export const RUN_OUTCOMES = ['done', 'failed', 'stopped'];

const RUN_ID_PATTERN = /^run-[A-Za-z0-9][A-Za-z0-9-]*$/;
const AGENT_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Folder that holds a hub's run records.
 *
 * @param {string} hubRoot
 * @param {string|undefined} hubType
 * @returns {string} absolute path (the folder may not exist yet)
 */
export function runsDirFor(hubRoot, hubType) {
	const layout = resolveVaultLayout(hubType);
	const inVault = workspacePaths(hubRoot, layout).runs;
	return inVault ?? path.join(hubRoot, LOCAL_RUNS_DIR);
}

function compactStamp(date) {
	return date
		.toISOString()
		.replace(/\.\d+Z$/, 'Z')
		.replace(/[-:]/g, '');
}

/** `run-<UTC stamp>-<agent>-<4 hex>`; only letters, digits and "-". */
export function newRunId(agent, now, random = () => crypto.randomBytes(2)) {
	return `run-${compactStamp(now)}-${agent}-${random().toString('hex')}`;
}

function recordPath(runsDir, id) {
	return path.join(runsDir, `${id}.json`);
}

function writeRecord(runsDir, record, fsMod) {
	fsMod.mkdirSync(runsDir, { recursive: true });
	const target = recordPath(runsDir, record.id);
	const temp = `${target}.${process.pid}.tmp`;
	fsMod.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
	fsMod.renameSync(temp, target);
}

function readRecord(file, fsMod) {
	try {
		const record = JSON.parse(fsMod.readFileSync(file, 'utf-8'));
		if (
			record &&
			typeof record === 'object' &&
			typeof record.id === 'string' &&
			typeof record.started_at === 'string'
		) {
			return record;
		}
	} catch {
		// unreadable or not JSON: reported by listRuns, never thrown
	}
	return null;
}

/**
 * Every run record in a folder, oldest start first. Files that cannot be read
 * come back in `problems`.
 *
 * @returns {{ runs: object[], problems: string[] }}
 */
export function listRuns(runsDir, { fsMod = fs } = {}) {
	let names;
	try {
		names = fsMod.readdirSync(runsDir).filter((n) => n.endsWith('.json'));
	} catch {
		return { runs: [], problems: [] };
	}
	const runs = [];
	const problems = [];
	for (const name of names.sort()) {
		const record = readRecord(path.join(runsDir, name), fsMod);
		if (record) runs.push(record);
		else problems.push(name);
	}
	runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
	return { runs, problems };
}

function failure(error) {
	return { ok: false, error };
}

/**
 * Resolve a project-qualified ticket to its canonical reference.
 * Refuses a bare id, an unknown project and an unknown ticket.
 */
function resolveQualifiedTicket(ticket, projectsRoot, fsMod) {
	const text = typeof ticket === 'string' ? ticket.trim() : '';
	const hash = text.indexOf('#');
	if (hash <= 0 || hash === text.length - 1) {
		return failure(
			`a run needs a project-qualified ticket as <project>#task_N; got ${JSON.stringify(text)}. A bare id is refused. Nothing was written.`,
		);
	}
	const project = text.slice(0, hash);
	const query = text.slice(hash + 1);
	if (/[\\/]/.test(project)) {
		return failure(`invalid project name ${JSON.stringify(project)}`);
	}
	const projectDir = projectTaskDir(projectsRoot, project);
	if (!fsMod.existsSync(projectDir)) {
		return failure(`unknown project: ${project}`);
	}
	const found = findTaskInProject(projectDir, query);
	if (!found) return failure(`task not found: ${text}`);
	const num = taskNumberOf(found);
	return { ok: true, project, ticket: `${project}#task_${num}` };
}

function checkText(label, value) {
	if (value === undefined || value === null) return null;
	const hit = scanForSecrets(String(value));
	return hit ? `${label}: ${formatSecretScanError(hit)}` : null;
}

/**
 * Start a run record.
 *
 * @param {object} opts
 * @param {string} opts.hubRoot
 * @param {string|undefined} opts.hubType
 * @param {string} opts.projectsRoot  tasks root (the folder whose children are projects)
 * @param {string} opts.ticket        `<project>#task_N`
 * @param {string} opts.agent
 * @param {number|string} [opts.instance]
 * @param {string} [opts.worktree]
 * @param {() => Date} [opts.now]
 */
export function startRun({
	hubRoot,
	hubType,
	projectsRoot,
	ticket,
	agent,
	instance,
	worktree,
	now = () => new Date(),
	fsMod = fs,
}) {
	if (typeof agent !== 'string' || !AGENT_PATTERN.test(agent)) {
		return failure(
			'run start needs --agent <id> (lowercase letters, digits and "-", starting with a letter)',
		);
	}
	let instanceNumber = null;
	if (instance !== undefined) {
		if (!/^\d+$/.test(String(instance)) || Number(instance) < 1) {
			return failure(
				`--instance must be a whole number, 1 or more; got ${JSON.stringify(instance)}`,
			);
		}
		instanceNumber = Number(instance);
	}
	const resolved = resolveQualifiedTicket(ticket, projectsRoot, fsMod);
	if (!resolved.ok) return resolved;
	const secret = checkText('worktree', worktree);
	if (secret) return failure(secret);

	const at = now();
	const record = {
		id: newRunId(agent, at),
		agent,
		instance: instanceNumber,
		ticket: resolved.ticket,
		project: resolved.project,
		worktree: worktree ?? null,
		started_at: at.toISOString(),
		updated_at: at.toISOString(),
		ended_at: null,
		outcome: null,
		note: null,
	};
	const dir = runsDirFor(hubRoot, hubType);
	writeRecord(dir, record, fsMod);
	return { ok: true, run: record, path: recordPath(dir, record.id) };
}

function loadOpenRun(runsDir, id, fsMod, verb) {
	if (typeof id !== 'string' || !RUN_ID_PATTERN.test(id)) {
		return failure(`unknown run id: ${JSON.stringify(id ?? '')}`);
	}
	const file = recordPath(runsDir, id);
	if (!fsMod.existsSync(file)) return failure(`unknown run id: ${id}`);
	const record = readRecord(file, fsMod);
	if (!record) return failure(`run record is unreadable: ${id}`);
	if (record.ended_at) {
		return failure(
			`run ${id} already ended (${record.outcome}) at ${record.ended_at}; it cannot be ${verb}`,
		);
	}
	return { ok: true, record };
}

/** `run touch <run-id>`: set `updated_at` to now. */
export function touchRun({
	hubRoot,
	hubType,
	id,
	now = () => new Date(),
	fsMod = fs,
}) {
	const dir = runsDirFor(hubRoot, hubType);
	const loaded = loadOpenRun(dir, id, fsMod, 'touched');
	if (!loaded.ok) return loaded;
	const record = { ...loaded.record, updated_at: now().toISOString() };
	writeRecord(dir, record, fsMod);
	return { ok: true, run: record };
}

/** `run end <run-id> --outcome done|failed|stopped [--note "..."]`. */
export function endRun({
	hubRoot,
	hubType,
	id,
	outcome,
	note,
	now = () => new Date(),
	fsMod = fs,
}) {
	if (!RUN_OUTCOMES.includes(outcome)) {
		return failure(
			`--outcome must be one of ${RUN_OUTCOMES.join(', ')}; got ${JSON.stringify(outcome ?? '')}`,
		);
	}
	const secret = checkText('note', note);
	if (secret) return failure(secret);
	const dir = runsDirFor(hubRoot, hubType);
	const loaded = loadOpenRun(dir, id, fsMod, 'ended again');
	if (!loaded.ok) return loaded;
	const at = now().toISOString();
	const record = {
		...loaded.record,
		updated_at: at,
		ended_at: at,
		outcome,
		note: note ?? null,
	};
	writeRecord(dir, record, fsMod);
	return { ok: true, run: record };
}

/** Value of `--flag value` in args, plus the args with the pair removed. */
function takeFlag(args, flag) {
	const idx = args.indexOf(flag);
	if (idx === -1) return { value: undefined, rest: args };
	return {
		value: args[idx + 1],
		rest: [...args.slice(0, idx), ...args.slice(idx + 2)],
	};
}

/**
 * Run the `run` subcommand of `npm run task`.
 *
 * @param {string[]} args  everything after `run`
 * @param {object} ctx     { hubRoot, hubType, projectsRoot, now, fsMod }
 */
export function runSubcommand(args, ctx) {
	const [verb, ...rest] = args;
	const usage =
		'Usage: task run <start <project>#task_N --agent <id> [--instance N] [--worktree <path>] | touch <run-id> | end <run-id> --outcome done|failed|stopped [--note "..."] | list>';
	if (!ctx.hubRoot) {
		return failure(
			'run records need a hub root: run from the hub folder or pass --hub-root <path>',
		);
	}
	const base = {
		hubRoot: ctx.hubRoot,
		hubType: ctx.hubType,
		now: ctx.now,
		fsMod: ctx.fsMod,
	};
	switch (verb) {
		case 'start': {
			const a = takeFlag(rest, '--agent');
			const i = takeFlag(a.rest, '--instance');
			const w = takeFlag(i.rest, '--worktree');
			return startRun({
				...base,
				projectsRoot: ctx.projectsRoot,
				ticket: w.rest[0],
				agent: a.value,
				instance: i.value,
				worktree: w.value,
			});
		}
		case 'touch':
			return touchRun({ ...base, id: rest[0] });
		case 'end': {
			const o = takeFlag(rest, '--outcome');
			const n = takeFlag(o.rest, '--note');
			return endRun({
				...base,
				id: n.rest[0],
				outcome: o.value,
				note: n.value,
			});
		}
		case 'list': {
			const { runs, problems } = listRuns(
				runsDirFor(ctx.hubRoot, ctx.hubType),
				{ fsMod: ctx.fsMod },
			);
			return { ok: true, runs, problems };
		}
		default:
			return failure(`unknown run command: ${verb ?? '(none)'}. ${usage}`);
	}
}
