/**
 * status-cli.js — `npm run status [--json] [--hub-root .]`.
 *
 * One status document for the hub, built from four sources:
 *   - the tickets (front matter: status, queue, go, waiting_on, ask),
 *   - agent memory (open entries flagged needs_team_lead; vault-backed hubs),
 *   - GitHub, through `gh` (PRs, issues, CI and scheduled runs),
 *   - agent run records (`task run start|touch|end`, see status-runs.js).
 *
 * Sections: active, queue, needs_you, waiting_on_others, done_today, health.
 * Anything that reads the status (a chat relay, a desk page) should call
 * `buildStatus` or run `--json`, so every view shows the same facts.
 *
 * A missing `gh`, or a repo GitHub cannot reach, never fails the command: the
 * local sections are still built and `warnings` says what was skipped.
 *
 * "Today" is the local calendar day of the machine running the command, from
 * local midnight, never the UTC date.
 *
 * Settings, in workspace.config.json:
 *   "status": { "stuckAfterHours": 3, "longLivedBranches": ["main", "develop"] }
 */
import { installCrashReporter } from './error-sources.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	parseFrontmatter,
	hasStateTokenInfix,
	filenameInfix,
	stateToToken,
	doneTasksDir,
	droppedTasksDir,
} from './tasks.js';
import { unquoteValue, routeWaitingOn } from './status-fields.js';
import { listProjectFolders, projectTaskDir } from './vault-layout.js';
import { resolveTasksRoot, isVaultBackedHubType } from './memory-root.js';
import { effectiveHubType, isHubRoot } from './hub-type.js';
import {
	parseGithubIssueRef,
	trackerField,
	listCheckTargets,
	runDriftCheck,
	detectMissingTrackerRefs,
} from './ticket-drift.js';
import { readJsonSafe } from '../wizard.js';
import { listRuns, runsDirFor } from './status-runs.js';
import {
	DEFAULT_LONG_LIVED_BRANCHES,
	readGithub,
	closingIssueNumbers,
	latestBranchRuns,
	latestScheduledRuns,
	defaultGh,
} from './status-github.js';

export const DEFAULT_STUCK_AFTER_HOURS = 3;

const HOUR_MS = 60 * 60 * 1000;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

// ── Settings ──────────────────────────────────────────────────────────────────

/**
 * Effective settings: defaults overlaid with the hub's `status` block.
 *
 * @returns {{ ok: true, settings: { stuckAfterHours: number, longLivedBranches: string[] } }
 *          | { ok: false, error: string }}
 */
export function resolveStatusSettings(config) {
	const block = config?.status ?? {};
	const settings = {
		stuckAfterHours: DEFAULT_STUCK_AFTER_HOURS,
		longLivedBranches: [...DEFAULT_LONG_LIVED_BRANCHES],
	};
	if (block.stuckAfterHours !== undefined) {
		const v = block.stuckAfterHours;
		if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
			return {
				ok: false,
				error: `workspace.config.json status.stuckAfterHours must be a positive number of hours; got ${JSON.stringify(v)}`,
			};
		}
		settings.stuckAfterHours = v;
	}
	if (block.longLivedBranches !== undefined) {
		const v = block.longLivedBranches;
		if (
			!Array.isArray(v) ||
			v.length === 0 ||
			v.some((b) => typeof b !== 'string' || b.trim() === '')
		) {
			return {
				ok: false,
				error:
					'workspace.config.json status.longLivedBranches must be a non-empty list of branch names',
			};
		}
		settings.longLivedBranches = v.map((b) => b.trim());
	}
	return { ok: true, settings };
}

// ── Time ──────────────────────────────────────────────────────────────────────

/** Local midnight at the start of the day `now` falls on (machine time zone). */
export function startOfLocalDay(now) {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

function minutesBetween(from, to) {
	return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
}

// ── Tickets ───────────────────────────────────────────────────────────────────

const STATE_BY_STATUS = {
	'state:done': 'done',
	done: 'done',
};

/** Lifecycle token of a ticket: filename infix, else its `status:`. */
function ticketState(file, meta, location) {
	if (location === 'done') return 'done';
	if (location === 'dropped') return 'dropped';
	if (hasStateTokenInfix(file)) return filenameInfix(file);
	if (STATE_BY_STATUS[meta.status]) return STATE_BY_STATUS[meta.status];
	try {
		return stateToToken(meta.status);
	} catch {
		return 'unknown';
	}
}

function bodyGithubLine(body) {
	const m = /^\*\*GitHub:\*\*\s*(.+)$/m.exec(body);
	return m ? m[1].trim() : null;
}

function titleOf(body, file) {
	const m = /^#\s+(.+?)\s*$/m.exec(body);
	const raw = m
		? m[1].replace(/^task_\d+\s*[^\w\s]\s*/i, '')
		: file.replace(/^task_\d+_/, '').replace(/\.md$/, '');
	return raw.length > 110 ? `${raw.slice(0, 107)}...` : raw;
}

const READ_PARALLEL = 48;

/**
 * Read many text files with a bounded number in flight. Reading hundreds of
 * small files one by one is slow on some file systems; a missing or unreadable
 * file gives null.
 */
async function readFiles(files, fsMod) {
	const reader = fsMod.promises ?? fs.promises;
	const out = new Array(files.length).fill(null);
	let next = 0;
	const worker = async () => {
		while (next < files.length) {
			const i = next++;
			try {
				out[i] = await reader.readFile(files[i], 'utf-8');
			} catch {
				out[i] = null;
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(READ_PARALLEL, files.length) }, worker),
	);
	return out;
}

/**
 * Read every ticket under a tasks root, once.
 *
 * @returns {Promise<Array<{
 *   project: string, ref: string, number: number, file: string, filePath: string,
 *   title: string, state: string, open: boolean, meta: object,
 *   github: {owner: string, repo: string, number: number}|null,
 *   queue: number|null, go: string|null, waitingOn: string|null, ask: string|null,
 *   parked: boolean,
 * }>>}
 */
export async function scanTickets(tasksRoot, fsMod = fs) {
	const found = [];
	for (const project of listProjectFolders(tasksRoot, fsMod)) {
		const dir = projectTaskDir(tasksRoot, project);
		const places = [
			[dir, 'live'],
			[doneTasksDir(dir), 'done'],
			[droppedTasksDir(dir), 'dropped'],
		];
		for (const [folder, location] of places) {
			let names;
			try {
				names = fsMod.readdirSync(folder);
			} catch {
				continue;
			}
			for (const file of names.sort()) {
				const m = /^task_(\d+)_.+\.md$/.exec(file);
				if (!m) continue;
				found.push({
					project,
					location,
					file,
					number: parseInt(m[1], 10),
					filePath: path.join(folder, file),
				});
			}
		}
	}
	const contents = await readFiles(
		found.map((f) => f.filePath),
		fsMod,
	);
	const tickets = [];
	found.forEach((f, i) => {
		if (contents[i] === null) return;
		const { meta, body } = parseFrontmatter(contents[i]);
		const state = ticketState(f.file, meta, f.location);
		const queueText = unquoteValue(meta.queue);
		const waiting = unquoteValue(meta.waiting_on);
		const ask = unquoteValue(meta.ask);
		tickets.push({
			project: f.project,
			ref: `${f.project}#task_${f.number}`,
			number: f.number,
			file: f.file,
			filePath: f.filePath,
			title: titleOf(body, f.file),
			state,
			open: state !== 'done' && state !== 'dropped',
			meta,
			github:
				parseGithubIssueRef(trackerField(meta)) ??
				parseGithubIssueRef(bodyGithubLine(body)),
			queue: /^\d+$/.test(queueText) ? parseInt(queueText, 10) : null,
			go: /^\d{4}-\d{2}-\d{2}$/.test(unquoteValue(meta.go))
				? unquoteValue(meta.go)
				: null,
			waitingOn: waiting || null,
			ask: ask || null,
			parked: String(meta.parked).toLowerCase() === 'true',
		});
	});
	return tickets;
}

// ── Repos ─────────────────────────────────────────────────────────────────────

/** `owner/repo` from a checkout's `.git/config` origin url, or null. */
export function repoFromGitConfig(repoPath, fsMod = fs) {
	try {
		const text = fsMod.readFileSync(
			path.join(repoPath, '.git', 'config'),
			'utf-8',
		);
		const section = /\[remote "origin"\]([^[]*)/.exec(text);
		const url = section ? /url\s*=\s*(\S+)/.exec(section[1]) : null;
		const m = url
			? /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url[1])
			: null;
		return m ? `${m[1]}/${m[2]}` : null;
	} catch {
		return null;
	}
}

/** Every `owner/repo` the hub tracks: ticket refs, project settings, checkouts. */
export function collectRepos({ hubRoot, config, tickets, fsMod = fs }) {
	const repos = new Set();
	for (const t of tickets) {
		if (t.github) repos.add(`${t.github.owner}/${t.github.repo}`);
	}
	for (const info of Object.values(config?.projects ?? {})) {
		if (typeof info?.githubRepo === 'string') repos.add(info.githubRepo.trim());
		if (typeof info?.repoPath === 'string') {
			const found = repoFromGitConfig(
				path.resolve(hubRoot, info.repoPath),
				fsMod,
			);
			if (found) repos.add(found);
		}
	}
	return [...repos].filter((r) => REPO_NAME.test(r)).sort();
}

// ── Memory ────────────────────────────────────────────────────────────────────

/**
 * Open memory entries flagged needs_team_lead (vault-backed hubs only).
 * Reads each entry file once, in parallel, and parses only the ones whose
 * text carries both flags, so a memory of hundreds of entries stays quick.
 */
async function readNeedsTeamLead(hubRoot, fsMod) {
	let resolveMemoryPaths;
	let entryModule;
	try {
		({ resolveMemoryPaths } = await import('./memory-paths.js'));
		entryModule = await import('./memory-entry.js');
	} catch {
		return { available: false, entries: [] };
	}
	const resolved = resolveMemoryPaths({ hubRoot, fsMod });
	if (!resolved.ok) return { available: false, entries: [] };
	const files = [];
	let agents;
	try {
		agents = fsMod
			.readdirSync(resolved.memoryRoot, { withFileTypes: true })
			.filter((d) => d.isDirectory() && entryModule.validateAgentId(d.name).ok)
			.map((d) => d.name)
			.sort();
	} catch {
		return { available: true, entries: [] };
	}
	for (const agent of agents) {
		for (const tier of entryModule.ENTRY_TIERS) {
			const dir = path.join(resolved.memoryRoot, agent, tier);
			let dirents;
			try {
				dirents = fsMod.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
				if (d.isFile() && /\.md$/i.test(d.name) && !d.name.startsWith('.')) {
					files.push({ agent, tier, file: path.join(dir, d.name) });
				}
			}
		}
	}
	const texts = await readFiles(
		files.map((f) => f.file),
		fsMod,
	);
	const entries = [];
	files.forEach((f, i) => {
		const text = texts[i];
		if (
			text === null ||
			!/^needs_team_lead:\s*true\s*$/m.test(text) ||
			!/^status:\s*open\s*$/m.test(text)
		) {
			return;
		}
		const parsed = entryModule.parseEntry(text, {
			fileName: path.basename(f.file),
		});
		if (
			parsed.ok &&
			parsed.entry.status === 'open' &&
			parsed.entry.needs_team_lead === true
		) {
			entries.push({
				agent: f.agent,
				key: parsed.entry.key,
				tier: f.tier,
				summary: parsed.entry.summary,
			});
		}
	});
	return { available: true, entries };
}

// ── Build ─────────────────────────────────────────────────────────────────────

function byQueueOrder(a, b) {
	if (a.queue !== null && b.queue !== null && a.queue !== b.queue) {
		return a.queue - b.queue;
	}
	if (a.queue !== null && b.queue === null) return -1;
	if (a.queue === null && b.queue !== null) return 1;
	return a.number - b.number;
}

const issueKey = (ref) => `${ref.owner}/${ref.repo}#${ref.number}`;

/** Issue numbers to look up by number, per repo: the issues of unfinished tickets. */
function wantedIssues(tickets) {
	const out = {};
	for (const t of tickets) {
		if (!t.github || !t.open) continue;
		(out[`${t.github.owner}/${t.github.repo}`] ??= []).push(t.github.number);
	}
	return out;
}

/**
 * Find a ticket's issue in what GitHub returned. The status reads open issues,
 * issues closed today and the issues of unfinished tickets, so a finished
 * ticket whose issue is in none of those was closed before today.
 *
 * @returns {{ read: boolean, issue: object|null }}  read is false when the repo could not be read
 */
function lookupIssue(gh, ref, { finished }) {
	const data = gh.repos[`${ref.owner}/${ref.repo}`];
	if (!data?.issues) return { read: false, issue: null };
	const issue = data.issues.get(ref.number);
	if (issue) return { read: true, issue };
	if (!finished) return { read: true, issue: null };
	return {
		read: true,
		issue: {
			number: ref.number,
			state: 'CLOSED',
			stateReason: null,
			labels: [],
			closedAt: null,
			closedEarlier: true,
		},
	};
}

function brief(t) {
	return { ticket: t.ref, project: t.project, title: t.title, state: t.state };
}

/**
 * Build the status document.
 *
 * @param {object} opts
 * @param {string} opts.hubRoot
 * @param {() => Date} [opts.now]
 * @param {(args: string[]) => Promise<string>} [opts.ghFn]
 * @param {object} [opts.fsMod]
 * @returns {Promise<{ ok: true, status: object } | { ok: false, error: string }>}
 */
export async function buildStatus({
	hubRoot,
	now = () => new Date(),
	ghFn = defaultGh,
	fsMod = fs,
}) {
	const started = Date.now();
	if (!hubRoot || !fsMod.existsSync(hubRoot)) {
		return {
			ok: false,
			error: `--hub-root not found: ${hubRoot ?? '(missing)'}`,
		};
	}
	if (!isHubRoot(hubRoot, fsMod)) {
		return {
			ok: false,
			error: `no workspace.config.json under ${hubRoot}: run this from a hub folder or pass --hub-root <path>`,
		};
	}
	const config = readJsonSafe(
		path.join(hubRoot, 'workspace.config.json'),
		fsMod,
	);
	const hubType = effectiveHubType(hubRoot, config, fsMod);
	const resolvedSettings = resolveStatusSettings(config);
	if (!resolvedSettings.ok) return resolvedSettings;
	const { settings } = resolvedSettings;

	const at = now();
	const since = startOfLocalDay(at);
	const warnings = [];

	// Local sources.
	const tasksRoot = resolveTasksRoot(hubRoot, hubType);
	// Memory is read while the tickets are scanned and GitHub is asked.
	const memoryRead = isVaultBackedHubType(hubType)
		? readNeedsTeamLead(hubRoot, fsMod)
		: Promise.resolve({ available: false, entries: [] });
	const tickets = await scanTickets(tasksRoot, fsMod);
	const runs = listRuns(runsDirFor(hubRoot, hubType), { fsMod });
	if (runs.problems.length > 0) {
		warnings.push(`${runs.problems.length} run record(s) could not be read`);
	}

	// GitHub.
	const repos = collectRepos({ hubRoot, config, tickets, fsMod });
	const [memory, gh] = await Promise.all([
		memoryRead,
		readGithub({ repos, wanted: wantedIssues(tickets), ghFn, since }),
	]);
	warnings.push(...gh.warnings);

	// active
	const stuckMs = settings.stuckAfterHours * HOUR_MS;
	const active = runs.runs
		.filter((r) => !r.ended_at)
		.map((r) => {
			const startedAt = new Date(r.started_at);
			const updatedAt = new Date(r.updated_at ?? r.started_at);
			return {
				run: r.id,
				agent: r.agent,
				instance: r.instance ?? null,
				ticket: r.ticket,
				project: r.project,
				worktree: r.worktree ?? null,
				started_at: r.started_at,
				updated_at: r.updated_at ?? r.started_at,
				elapsed_minutes: minutesBetween(startedAt, at),
				idle_minutes: minutesBetween(updatedAt, at),
				stuck: at.getTime() - updatedAt.getTime() > stuckMs,
			};
		});

	// queue
	const queued = tickets
		.filter((t) => t.state === 'todo' && t.go && !t.waitingOn && !t.parked)
		.sort((a, b) => a.project.localeCompare(b.project) || byQueueOrder(a, b));
	const queue = [];
	for (const t of queued) {
		let group = queue[queue.length - 1];
		if (!group || group.project !== t.project) {
			group = { project: t.project, tickets: [] };
			queue.push(group);
		}
		group.tickets.push({ ...brief(t), queue: t.queue, go: t.go });
	}

	// needs_you / waiting_on_others
	const openWaiting = tickets.filter((t) => t.open && t.waitingOn);
	const needsTickets = openWaiting
		.filter((t) => routeWaitingOn(t.waitingOn) === 'needs_you')
		.map((t) => ({ ...brief(t), waiting_on: t.waitingOn, ask: t.ask }));
	const waitingOthers = openWaiting
		.filter((t) => routeWaitingOn(t.waitingOn) === 'external')
		.map((t) => ({
			...brief(t),
			waiting_on: t.waitingOn,
			who: t.waitingOn.slice('external:'.length).trim(),
			ask: t.ask,
		}));

	const qaPassedLocal = new Map();
	for (const t of tickets) {
		if (t.github && t.state === 'qa-passed') {
			qaPassedLocal.set(
				`${t.github.owner}/${t.github.repo}#${t.github.number}`,
				t.ref,
			);
		}
	}
	const prsToMerge = [];
	for (const [repo, data] of Object.entries(gh.repos)) {
		for (const pr of data.openPrs ?? []) {
			for (const n of closingIssueNumbers(pr)) {
				const issue = data.issues?.get(n);
				const ticket = qaPassedLocal.get(`${repo}#${n}`) ?? null;
				if (ticket || issue?.labels.includes('state:qa-passed')) {
					prsToMerge.push({
						repo,
						number: pr.number,
						title: pr.title,
						url: pr.url,
						branch: pr.headRefName,
						draft: Boolean(pr.isDraft),
						issue: n,
						ticket,
					});
					break;
				}
			}
		}
	}
	prsToMerge.sort(
		(a, b) => a.repo.localeCompare(b.repo) || a.number - b.number,
	);

	// done_today
	const doneTickets = [];
	for (const t of tickets) {
		if (t.state !== 'done') continue;
		const found = t.github
			? lookupIssue(gh, t.github, { finished: true })
			: { read: false, issue: null };
		if (found.issue?.closedEarlier) continue; // GitHub closed it before today
		let closedAt;
		let source = 'file';
		if (found.issue?.closedAt) {
			closedAt = new Date(found.issue.closedAt);
			source = 'github';
		} else {
			try {
				closedAt = fsMod.statSync(t.filePath).mtime;
			} catch {
				closedAt = null;
			}
		}
		if (closedAt && closedAt >= since && closedAt <= at) {
			doneTickets.push({
				...brief(t),
				closed_at: closedAt.toISOString(),
				closed_at_source: source,
			});
		}
	}
	doneTickets.sort((a, b) => a.closed_at.localeCompare(b.closed_at));
	const mergedPrs = [];
	for (const [repo, data] of Object.entries(gh.repos)) {
		for (const pr of data.mergedPrs ?? []) {
			const mergedAt = pr.mergedAt ? new Date(pr.mergedAt) : null;
			if (mergedAt && mergedAt >= since && mergedAt <= at) {
				mergedPrs.push({
					repo,
					number: pr.number,
					title: pr.title,
					url: pr.url,
					merged_at: pr.mergedAt,
				});
			}
		}
	}
	mergedPrs.sort((a, b) => a.merged_at.localeCompare(b.merged_at));

	// health
	const ci = [];
	const scheduled = [];
	for (const [repo, data] of Object.entries(gh.repos)) {
		for (const row of latestBranchRuns(
			data.pushRuns ?? [],
			settings.longLivedBranches,
		)) {
			ci.push({ repo, ...row });
		}
		for (const row of latestScheduledRuns(data.scheduleRuns ?? [])) {
			scheduled.push({ repo, ...row });
		}
	}
	const drift = checkDrift({
		tasksRoot,
		tickets,
		config,
		fsMod,
		gh,
		warnings,
	});
	const stuckRuns = active.filter((a) => a.stuck);
	const failingCi = ci.filter((c) => c.failing);
	const failingScheduled = scheduled.filter((s) => s.failing);

	const status = {
		generated_at: at.toISOString(),
		time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		today_since: since.toISOString(),
		hub_type: hubType ?? null,
		settings,
		active,
		queue,
		needs_you: {
			tickets: needsTickets,
			memory: memory.entries,
			memory_available: memory.available,
			prs_to_merge: prsToMerge,
		},
		waiting_on_others: waitingOthers,
		done_today: { tickets: doneTickets, prs: mergedPrs },
		health: {
			ok:
				failingCi.length === 0 &&
				failingScheduled.length === 0 &&
				stuckRuns.length === 0 &&
				drift.length === 0,
			ci,
			scheduled,
			stuck_runs: stuckRuns,
			drift,
		},
		github: { available: gh.available, repos: repos.length },
		counts: {
			tickets: tickets.length,
			projects: new Set(tickets.map((t) => t.project)).size,
		},
		warnings,
		timing_ms: Date.now() - started,
	};
	return { ok: true, status };
}

/** Ticket drift, reusing ticket-drift's checks. Notes anything it could not check. */
function checkDrift({ tasksRoot, tickets, config, fsMod, gh, warnings }) {
	const { targets } = listCheckTargets(
		{ tasksDir: tasksRoot, fromHub: true },
		fsMod,
	);
	const tag = (project, text) => `[${project}] ${text}`;

	if (!gh.available) {
		const drift = [];
		for (const t of targets) {
			for (const d of detectMissingTrackerRefs({
				tasksDir: t.tasksDir,
				projectName: t.project,
				workspaceConfig: config,
				fsMod,
			})) {
				drift.push(tag(t.project, d.description));
			}
		}
		warnings.push(
			'ticket drift: only the missing-tracker check ran (GitHub was not read)',
		);
		return drift;
	}

	const UNREAD = 'repo not read';
	const finishedRefs = new Set(
		tickets.filter((t) => t.github && !t.open).map((t) => issueKey(t.github)),
	);
	const fetchIssue = (ref) => {
		const { read, issue } = lookupIssue(gh, ref, {
			finished: finishedRefs.has(issueKey(ref)),
		});
		if (!read) throw new Error(UNREAD);
		if (!issue) throw new Error('not in the issue list');
		return issue;
	};
	const all = [];
	for (const t of targets) {
		for (const d of runDriftCheck({
			tasksDir: t.tasksDir,
			projectName: t.project,
			workspaceConfig: config,
			fsMod,
			fetchIssue,
		})) {
			all.push({
				unread: d.description.includes(`(${UNREAD})`),
				text: tag(t.project, d.description),
			});
		}
	}
	const unread = all.filter((d) => d.unread);
	if (unread.length > 0) {
		warnings.push(
			`ticket drift: ${unread.length} ticket(s) not checked because their repo could not be read`,
		);
	}
	return all.filter((d) => !d.unread).map((d) => d.text);
}

// ── Text view ─────────────────────────────────────────────────────────────────

function duration(minutes) {
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function list(lines, items, render, max = 8) {
	for (const item of items.slice(0, max)) lines.push(`  ${render(item)}`);
	if (items.length > max) lines.push(`  ... and ${items.length - max} more`);
}

/** Short, readable text version of a status document. */
export function renderStatusText(s) {
	const lines = [];
	const local = new Date(s.generated_at);
	lines.push(
		`Hub status, ${local.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })} (${s.time_zone}), ${s.hub_type ?? 'unknown tier'}, ${s.counts.tickets} tickets in ${s.counts.projects} projects`,
	);

	lines.push('', `ACTIVE (${s.active.length})`);
	if (s.active.length === 0) lines.push('  nothing running');
	list(lines, s.active, (a) => {
		const who = a.instance ? `${a.agent} #${a.instance}` : a.agent;
		return `${who}  ${a.ticket}  running ${duration(a.elapsed_minutes)}, idle ${duration(a.idle_minutes)}${a.stuck ? '  STUCK' : ''}`;
	});

	const queued = s.queue.reduce((n, g) => n + g.tickets.length, 0);
	lines.push('', `QUEUE (${queued})`);
	if (queued === 0) lines.push('  nothing queued');
	for (const g of s.queue) {
		lines.push(`  ${g.project}`);
		list(
			lines,
			g.tickets,
			(t) => `  ${t.queue ?? '-'}. ${t.ticket}  ${t.title}`,
			5,
		);
	}

	const need = s.needs_you;
	const needCount =
		need.tickets.length + need.memory.length + need.prs_to_merge.length;
	lines.push('', `NEEDS YOU (${needCount})`);
	if (needCount === 0) lines.push('  nothing waiting on you');
	list(
		lines,
		need.tickets,
		(t) =>
			`${t.ticket}  waiting on ${t.waiting_on}${t.ask ? `: ${t.ask}` : ''}`,
	);
	list(lines, need.memory, (m) => `memory ${m.agent}/${m.key}: ${m.summary}`);
	list(
		lines,
		need.prs_to_merge,
		(p) => `PR ${p.repo}#${p.number} passed QA, not merged: ${p.title}`,
	);

	lines.push('', `WAITING ON OTHERS (${s.waiting_on_others.length})`);
	list(
		lines,
		s.waiting_on_others,
		(t) => `${t.ticket}  ${t.who}${t.ask ? `: ${t.ask}` : ''}`,
	);

	lines.push(
		'',
		`DONE TODAY: ${s.done_today.tickets.length} ticket(s), ${s.done_today.prs.length} PR(s) merged`,
	);
	list(lines, s.done_today.tickets, (t) => `${t.ticket}  ${t.title}`, 5);

	const h = s.health;
	const issues = [
		...h.ci
			.filter((c) => c.failing)
			.map((c) => `CI red: ${c.repo} ${c.branch} ${c.workflow}`),
		...h.scheduled
			.filter((c) => c.failing)
			.map((c) => `scheduled run red: ${c.repo} ${c.workflow}`),
		...h.stuck_runs.map(
			(r) =>
				`stuck: ${r.agent} on ${r.ticket}, idle ${duration(r.idle_minutes)}`,
		),
		...h.drift.map((d) => `drift: ${d}`),
	];
	lines.push(
		'',
		issues.length === 0
			? `HEALTH: ok (${h.ci.length} branch result(s), ${h.scheduled.length} scheduled workflow(s) checked)`
			: `HEALTH: ${issues.length} problem(s)`,
	);
	list(lines, issues, (i) => i);

	if (s.warnings.length > 0) {
		lines.push('', 'WARNINGS');
		for (const w of s.warnings) lines.push(`  ${w}`);
	}
	lines.push('', `(read in ${(s.timing_ms / 1000).toFixed(1)}s)`);
	return `${lines.join('\n')}\n`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

/**
 * Parse `[--json] [--hub-root <path>]`.
 * @returns {{ json: boolean, hubRoot: string } | { error: string }}
 */
export function parseStatusArgs(argv, cwd = process.cwd()) {
	let json = false;
	let hubRoot = cwd;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--json') json = true;
		else if (argv[i] === '--hub-root') {
			if (!argv[i + 1]) return { error: '--hub-root needs a path' };
			hubRoot = path.resolve(cwd, argv[++i]);
		} else {
			return {
				error: `unknown option: ${argv[i]}. Usage: status [--json] [--hub-root <path>]`,
			};
		}
	}
	return { json, hubRoot };
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	installCrashReporter({ source: 'npm-run' });
	const args = parseStatusArgs(process.argv.slice(2));
	if (args.error) {
		process.stderr.write(`${args.error}\n`);
		process.exit(1);
	}
	const result = await buildStatus({ hubRoot: args.hubRoot });
	if (!result.ok) {
		process.stderr.write(`${result.error}\n`);
		process.exit(1);
	}
	process.stdout.write(
		args.json
			? `${JSON.stringify(result.status, null, 2)}\n`
			: renderStatusText(result.status),
	);
}
