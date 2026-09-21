/**
 * ticket-drift.js — ticket-lifecycle state drift detection.
 *
 * Scans local task files for a `github:` frontmatter field, fetches the
 * corresponding GitHub issue's `state:*` label(s) via `gh issue view`, and
 * flags five concrete drift shapes observed in real backlog incidents
 * (see agents/skills/task-automation-flow/SKILL.md "Mandatory dispatch inclusion"
 * section):
 *
 *   1. mismatch            — local `status:` and the GitHub `state:*` label disagree.
 *   2. zero-label          — local `status:` is past the initial pre-dispatch state
 *                            but the GitHub issue carries zero `state:*` labels at all.
 *   3. stale-open          — task filename infix is `qa-passed` or `done` but the
 *                            GitHub issue is still OPEN.
 *   4. stale-todo          — task filename infix is a pre-dispatch state (`todo`,
 *                            `ready-for-implementation`) but the GitHub issue is
 *                            CLOSED with stateReason COMPLETED.
 *   5. missing-tracker-ref — local `status:` is a canonical, currently-dispatched
 *                            state (TRACKED_DISPATCH_STATES below — a positive
 *                            allowlist, not the negative pre-dispatch exclusion the
 *                            other four shapes use), the tracker resolves as
 *                            configured for the project (see detectMissingTrackerRefs
 *                            below), but the task file has no `github:` field at all.
 *                            Shapes 1-4 only ever run on files that already HAVE a
 *                            `github:` field; shape 5 is the inverse — it catches a
 *                            reference that should exist but was never created).
 *
 * Task files with no `github:` field are ignored by shapes 1-4 — no tracker
 * reference to drift-check against for those four (consistent with
 * ticket-lifecycle-mode's Mirror Update Obligation scoping). Shape 5, below, is
 * the dedicated check for exactly those files.
 *
 * The tasks directory is NOT hardcoded to a repo-relative path. In real usage
 * this tool (built and shipped from the setchin-agent-profiles repo) is
 * pointed at task files that live in a separate workspace repo — see the
 * `--tasks-dir` CLI flag / `tasksDir` option below. The default
 * (`projects/setchin-agent-profiles` relative to cwd) only applies when the
 * directory happens to be co-located; the real cross-repo case always
 * requires the explicit override.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, filenameInfix, statusToInfix } from './tasks.js';

/**
 * Local `status:` values that represent the pre-dispatch state — i.e. no
 * lifecycle transition has happened yet, so zero GitHub labels is expected
 * and NOT drift. `state:ready-for-implementation` is the canonical name per
 * ticket-lifecycle-mode; `state:todo` is the token actually used by task
 * files in this backlog today — both are
 * treated as pre-dispatch to avoid false positives against real files.
 */
const PRE_DISPATCH_STATES = ['state:ready-for-implementation', 'state:todo'];

/**
 * Filename infixes that correspond to pre-dispatch states. Used by the
 * stale-todo check: if the infix says the ticket hasn't been dispatched yet
 * but the GitHub issue is already CLOSED/COMPLETED, that's drift.
 */
const PRE_DISPATCH_INFIXES = ['todo', 'ready-for-implementation'];

/**
 * Canonical, currently-dispatched (not pre-dispatch, not closed) `status:` values
 * per ticket-lifecycle-mode's State Vocabulary table. Used as a **positive
 * allowlist** by detectMissingTrackerRefs (shape 5) rather than the negative
 * PRE_DISPATCH_STATES exclusion the other four shapes use — deliberately, because
 * shape 5 is the first shape in this file to ever look at task files with no
 * `github:` field, and this repo's real backlog has ~50 legacy task files
 * predating the tracker-creation rule (ba990dc, 2026-07-11) whose `status:` values
 * are non-canonical or malformed (`undefined` from parse failure, `todo` bare,
 * `superseded`, `discussion-needed`, `active`, `state:done`,
 * `state:closed-superseded`, etc.) — confirmed via a real `--tasks-dir` run against
 * this repo's own backlog during development.
 * A negative exclusion (flag anything not in PRE_DISPATCH_STATES) swept all of
 * those legacy/malformed values in as false positives. This allowlist instead
 * only fires for a status this schema actually recognises as "dispatched, not yet
 * closed" — new tickets past pre-dispatch are covered; ambiguous/legacy/malformed
 * status values are not, consistent with the Tracker Creation Obligation's own
 * going-forward-only caveat.
 */
const TRACKED_DISPATCH_STATES = [
	'state:in-progress',
	'state:ready-for-review',
	'state:ready-for-qa',
	'state:changes-requested',
	'state:qa-passed',
];

const STALE_OPEN_INFIXES = ['qa-passed', 'done'];

/**
 * Extract an owner/repo + issue number from a `github:` frontmatter value.
 * Accepts a full issue URL (e.g. https://github.com/owner/repo/issues/123)
 * or the short form `owner/repo#123`. A bare number is deliberately not
 * resolvable: it carries no repository.
 * Returns null if the value matches neither form.
 */
export function parseGithubIssueRef(value) {
	if (!value) return null;
	const text = String(value);
	const urlMatch = text.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
	if (urlMatch) {
		return { owner: urlMatch[1], repo: urlMatch[2], number: parseInt(urlMatch[3], 10) };
	}
	// The leading boundary keeps the tail of a longer URL (`.../repo#5` after a
	// slash) from being read as `owner/repo#5`.
	const shortMatch = text.match(/(?:^|[\s`'"(<])([\w.-]+)\/([\w.-]+)#(\d+)(?![\w])/);
	if (shortMatch) {
		return { owner: shortMatch[1], repo: shortMatch[2], number: parseInt(shortMatch[3], 10) };
	}
	return null;
}

/**
 * Default GitHub issue fetcher — shells out to `gh issue view`.
 * Returns { state: 'OPEN'|'CLOSED', stateReason: string|null, labels: string[] } or throws.
 *
 * @param {{owner:string, repo:string, number:number}} ref
 * @param {function} [execFn] Injectable exec (defaults to execFileSync).
 */
export function fetchIssueState(ref, execFn = execFileSync) {
	const out = execFn('gh', [
		'issue', 'view', String(ref.number),
		'--repo', `${ref.owner}/${ref.repo}`,
		'--json', 'labels,state,stateReason',
	], { encoding: 'utf-8' });
	const data = JSON.parse(out);
	return {
		state: data.state,
		stateReason: data.stateReason ?? null,
		labels: (data.labels || []).map(l => l.name),
	};
}

/**
 * Scan a tasks directory for `*.md` task files with a `github:` frontmatter
 * field. Returns an array of { file, filePath, meta, githubRef }.
 * Files with no `github:` field, or whose `github:` value isn't a
 * recognisable GitHub issue URL, are skipped (not returned).
 */
export function scanTaskFiles(tasksDir, fsMod = fs) {
	if (!fsMod.existsSync(tasksDir)) return [];
	const files = fsMod.readdirSync(tasksDir).filter(f => f.endsWith('.md'));
	const results = [];
	for (const file of files) {
		const filePath = path.join(tasksDir, file);
		const raw = fsMod.readFileSync(filePath, 'utf-8');
		const { meta } = parseFrontmatter(raw);
		if (!meta.github) continue;
		const githubRef = parseGithubIssueRef(meta.github);
		if (!githubRef) continue;
		results.push({ file, filePath, meta, githubRef });
	}
	return results;
}

/**
 * Read `workspace.config.json` from the hub root. Returns null when the file is
 * absent or unreadable/invalid JSON — never throws. Mirrors the equivalent local
 * helper in graph-cli.js/bootstrap.js (no shared util module exists for this yet;
 * each lib file that needs it keeps its own small copy, consistent with existing
 * precedent in this repo).
 */
export function readWorkspaceConfig(hubRoot, fsMod = fs) {
	const configPath = path.join(hubRoot, 'workspace.config.json');
	if (!fsMod.existsSync(configPath)) return null;
	try {
		return JSON.parse(fsMod.readFileSync(configPath, 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * Resolve a known `owner/repo` for a project using detect-configured **path (a)
 * only** — the common, non-interactive case defined in
 * ticket-lifecycle-mode's Tracker Plugin Contract / trackers/github.md:
 *
 *   1. `workspace.config.json` → `projects.<name>.githubRepo`, or
 *   2. an existing `github:` reference already present on any other task file
 *      scanned for this project.
 *
 * Path (b) (the bootstrap fallback — a project's first-ever ticket, resolved via
 * `git remote -v` against the real repo checkout and/or asking a human for the
 * repo path) is intentionally NOT attempted here: this is a batch/CI-style check
 * with no repo checkout path and no human to ask. A project's first-ever ticket is
 * therefore not resolvable by this function and is not flagged as drift — see
 * `detectMissingTrackerRefs` below.
 */
export function resolveKnownGithubRepo({ workspaceConfig, projectName, existingRefs }) {
	const declared = workspaceConfig?.projects?.[projectName]?.githubRepo;
	if (declared) return declared;
	if (existingRefs.length > 0) {
		const ref = existingRefs[0];
		return `${ref.owner}/${ref.repo}`;
	}
	return null;
}

/**
 * Detect task files whose `status:` is one of TRACKED_DISPATCH_STATES (a canonical,
 * currently-dispatched, not-yet-closed state) but carry no tracker reference at all,
 * for a project where the tracker resolves as configured. This is the inverse of
 * scanTaskFiles/detectEntryDrift above, which only ever operate on files that
 * already HAVE a `github:` reference — those four drift shapes are structurally
 * incapable of catching "a reference should exist here but doesn't" (see
 * ticket-lifecycle-mode's Tracker Creation Obligation / task-automation-flow's
 * Ticket Creation: Tracker Mirror section for the rule this enforces mechanically).
 *
 * Deliberately a **positive allowlist** (TRACKED_DISPATCH_STATES), not the negative
 * PRE_DISPATCH_STATES exclusion the other four shapes use — see the comment on
 * TRACKED_DISPATCH_STATES above for why: a negative exclusion swept in ~50 legacy
 * task files with non-canonical/malformed `status:` values as false positives when
 * this was tested against this repo's real backlog during development.
 *
 * "Tracker configured" resolution mirrors the two independent checks defined in
 * task-automation-flow's Ticket Creation: Tracker Mirror section:
 *   1. `workspace.config.json`'s `githubWorkflows.enabled` must be `true` — a
 *      `false`/absent value skips this check entirely, regardless of anything else.
 *   2. An owner/repo must already be knowable via `resolveKnownGithubRepo` (detect-
 *      configured path (a) only — see above). When neither source resolves a repo
 *      (the project's first-ever ticket, not yet bootstrapped), this check returns
 *      no drift rather than guessing.
 *
 * @param {object} options
 * @param {string} options.tasksDir
 * @param {string} options.projectName
 * @param {object|null} options.workspaceConfig  Already-parsed workspace.config.json (or null).
 * @param {object} [options.fsMod]
 * @returns {Array<{file:string, description:string}>}
 */
export function detectMissingTrackerRefs({ tasksDir, projectName, workspaceConfig, fsMod = fs }) {
	if (workspaceConfig?.githubWorkflows?.enabled !== true) return [];
	if (!fsMod.existsSync(tasksDir)) return [];

	const files = fsMod.readdirSync(tasksDir).filter(f => f.endsWith('.md'));
	const parsed = files.map(file => {
		const raw = fsMod.readFileSync(path.join(tasksDir, file), 'utf-8');
		const { meta } = parseFrontmatter(raw);
		return { file, meta };
	});

	const existingRefs = parsed
		.map(({ meta }) => parseGithubIssueRef(meta.github))
		.filter(Boolean);

	const knownRepo = resolveKnownGithubRepo({ workspaceConfig, projectName, existingRefs });
	if (!knownRepo) return [];

	const drifts = [];
	for (const { file, meta } of parsed) {
		if (meta.github) continue;
		if (!TRACKED_DISPATCH_STATES.includes(meta.status)) continue;
		drifts.push({
			file,
			description: `${file}: local status "${meta.status}" but no tracker reference field is set, even though the tracker resolves as configured for this project (missing-tracker-ref)`,
		});
	}
	return drifts;
}

/**
 * Detect drift for a single task entry (as returned by scanTaskFiles) given
 * the already-fetched GitHub issue state. Returns a drift description
 * string, or null if no drift found.
 *
 * Shapes 3 (stale-open) and 4 (stale-todo) rely on a state key derived from
 * the filename infix on repo-files-style directories. On vault-shaped
 * directories (where filenames carry no infix — `task_<id>_<slug>.md`), the
 * infix is absent (`filenameInfix` returns null) and the effective state key
 * is derived from the `status:` frontmatter field instead via `statusToInfix`.
 */
export function detectEntryDrift(entry, issueState) {
	const { file, meta } = entry;
	const localStatus = meta.status;
	const stateLabels = issueState.labels.filter(l => l.startsWith('state:'));

	// Shape 1: status/label mismatch (only meaningful when at least one state:* label present)
	if (stateLabels.length > 0 && !stateLabels.includes(localStatus)) {
		return `${file}: local status "${localStatus}" does not match GitHub label(s) "${stateLabels.join(', ')}" (status/label mismatch)`;
	}

	// Derive the effective state key for infix-based checks (shapes 3 and 4).
	// On repo-files directories the infix is embedded in the filename.
	// On vault-shaped directories (or any filename without an infix), fall back
	// to deriving the effective key from the `status:` frontmatter field.
	const infix = filenameInfix(file) ?? statusToInfix(localStatus);

	// Shape 3: stale-open — checked before the zero-label case so a done/qa-passed
	// ticket left OPEN is reported with the more specific "stale-open" reason,
	// even when it also happens to carry zero state:* labels.
	if (STALE_OPEN_INFIXES.includes(infix) && issueState.state === 'OPEN') {
		return `${file}: filename infix "${infix}" but GitHub issue is still OPEN (stale-open)`;
	}

	// Shape 4: stale-todo — filename infix says pre-dispatch but the GitHub issue
	// is already CLOSED/COMPLETED. Inverse of stale-open.
	if (PRE_DISPATCH_INFIXES.includes(infix) && issueState.state === 'CLOSED' && issueState.stateReason === 'COMPLETED') {
		return `${file}: filename infix "${infix}" but GitHub issue is CLOSED/COMPLETED (stale-todo)`;
	}

	// Shape 2: zero-label-but-dispatched
	if (stateLabels.length === 0 && !PRE_DISPATCH_STATES.includes(localStatus)) {
		return `${file}: local status "${localStatus}" but GitHub issue has zero state:* labels (zero-label-but-dispatched)`;
	}

	return null;
}

/**
 * Run drift detection across every `github:`-tracked task file in tasksDir, plus
 * (when `projectName` is supplied) the missing-tracker-ref check from
 * detectMissingTrackerRefs above.
 *
 * `projectName` is optional and backward compatible: omitting it (as every
 * pre-existing caller/test does) skips the missing-tracker-ref check entirely —
 * only the four existing `github:`-tracked drift shapes run, unchanged.
 *
 * @param {object} options
 * @param {string} options.tasksDir
 * @param {string} [options.projectName]  Enables the missing-tracker-ref check when set.
 * @param {object|null} [options.workspaceConfig]  Already-parsed workspace.config.json (or null).
 * @param {object} [options.fsMod]
 * @param {function} [options.fetchIssue] Injectable (ref) => {state, labels}. Defaults to fetchIssueState.
 * @returns {Array<{file:string, description:string}>}
 */
export function runDriftCheck({ tasksDir, projectName, workspaceConfig = null, fsMod = fs, fetchIssue = (ref) => fetchIssueState(ref) }) {
	const entries = scanTaskFiles(tasksDir, fsMod);
	const drifts = [];
	for (const entry of entries) {
		let issueState;
		try {
			issueState = fetchIssue(entry.githubRef);
		} catch (err) {
			drifts.push({ file: entry.file, description: `${entry.file}: could not fetch GitHub issue state (${err.message})` });
			continue;
		}
		const description = detectEntryDrift(entry, issueState);
		if (description) {
			drifts.push({ file: entry.file, description });
		}
	}

	if (projectName) {
		drifts.push(...detectMissingTrackerRefs({ tasksDir, projectName, workspaceConfig, fsMod }));
	}

	return drifts;
}

export function computeExitCode(drifts) {
	return drifts.length > 0 ? 1 : 0;
}

export function formatReport(drifts) {
	if (drifts.length === 0) {
		return 'No ticket-lifecycle drift found.\n';
	}
	const lines = [`Found ${drifts.length} drifted/stale ticket(s):`, ''];
	for (const d of drifts) {
		lines.push(`  - ${d.description}`);
	}
	return lines.join('\n') + '\n';
}

export const DEFAULT_TASKS_DIR = 'projects/setchin-agent-profiles';

// ── CLI entry point ────────────────────────────────────────────────────────────

const isMain = process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	const flagIdx = process.argv.indexOf('--tasks-dir');
	const tasksDir = flagIdx !== -1
		? path.resolve(process.argv[flagIdx + 1])
		: path.resolve(process.cwd(), DEFAULT_TASKS_DIR);

	// `workspace.config.json` lives at the hub root, which may differ from
	// tasksDir's own location (e.g. tasksDir points cross-repo via --tasks-dir).
	// Defaults to cwd, matching the DEFAULT_TASKS_DIR assumption that the CLI
	// normally runs from the hub root. A hub without workspace.config.json (or
	// without githubWorkflows.enabled) simply skips the missing-tracker-ref
	// check — see detectMissingTrackerRefs above — so no hard error is raised
	// here for a missing/absent file.
	const hubRootIdx = process.argv.indexOf('--hub-root');
	const hubRoot = hubRootIdx !== -1
		? path.resolve(process.argv[hubRootIdx + 1])
		: process.cwd();

	const projectName = path.basename(tasksDir);
	const workspaceConfig = readWorkspaceConfig(hubRoot);

	const drifts = runDriftCheck({ tasksDir, projectName, workspaceConfig });
	process.stdout.write(formatReport(drifts));
	process.exit(computeExitCode(drifts));
}
