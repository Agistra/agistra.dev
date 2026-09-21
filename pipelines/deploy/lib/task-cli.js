/**
 * task-cli.js — the single mechanism agents use for task lifecycle state
 * reads and transitions.
 *
 * Replaces ad-hoc agent-performed file renames and `gh` label edits described
 * in `ticket-lifecycle-mode` / `task-automation-flow` skill text with one
 * compiled Node CLI. Backed by the repo-files task store implementation in
 * `tasks.js` (parseFrontmatter, changeTaskStatus, updateTaskFields,
 * listAllTasks, findTaskByQuery) — the same parser `check:tickets`
 * (`ticket-drift.js`) uses, so there is exactly one frontmatter parser in
 * the codebase, not two.
 *
 * The backend (repo-files) is intentionally kept behind this CLI's own
 * module boundary: every command here calls into `tasks.js` functions
 * rather than doing its own file I/O. This is the seam a future alternate
 * storage backend would sit behind without changing the CLI
 * surface — implementing that backend is explicitly out of scope for this
 * ticket (see Scope boundaries).
 *
 * Commands: read, list, transition, update-field, waves. All output is JSON
 * on stdout; exit code is 0 on success and non-zero on any partial failure
 * (per AC 6).
 *
 * `waves` is read/compute-only: it never mutates task state or
 * dispatches anything. It tells Architect which `todo` tasks in a project
 * CAN safely run in parallel (no `depends_on` edge between them, no
 * overlapping `touches` globs) — Architect still proposes the grouping to
 * the team lead for confirmation per `task-automation-flow`; this command
 * informs that proposal, it does not replace the joint-call gate.
 *
 * `append-section` appends markdown content to a named section
 * (e.g. `## Gap Closure`, `## QA Report`) in a task file's body, without
 * touching frontmatter or filename. Content is read from stdin so callers
 * don't have to escape multi-line markdown as a shell argument.
 *
 * `qa-report` composes and posts a QA report comment to the
 * linked GitHub issue and (if discoverable) PR, re-fetches the comment list
 * to confirm the post actually landed, appends the local `## QA Report`
 * (and, on FAIL/PARTIAL, `## Gap Closure`) section, and performs the
 * matching state transition (`state:qa-passed` on PASS, or
 * `state:changes-requested` + the correct `qa-fail-N` label on FAIL/
 * PARTIAL) — collapsing Tester's multi-step close-out into one call with
 * the same loud-fail/verify-before-success pattern as `transition`.
 *
 * `dispatch-context` assembles the parts of a
 * Builder/Tester dispatch prompt that are mechanically derivable from the
 * ticket file and its `verifier` field — ticket content, issue link,
 * verifier-appropriate terminal state, and the mandatory ticket-state-
 * ownership and worktree-isolation paragraphs, both read live from their
 * source skill files (never duplicated as string literals here). Read-only:
 * it does not invoke the Agent tool or dispatch anything itself.
 *
 * `create` writes a brand-new task file. Tier-aware, using the
 * identical hubType resolution `runCli`'s `--hub-root` branch already uses
 * (`resolveTasksRoot`/`isVaultBackedHubType`, memory-root.js) rather than a
 * second detection mechanism: on a vault-shaped hub the created filename
 * carries no state-token infix and the project hub note + backlink are
 * wired per the active storage plugin's create-task contract; on a free-tier hub
 * (the default when `--hub-root` isn't given, or its `hubType` isn't
 * vault-backed) the existing repo-files filename-infix convention is
 * preserved unchanged, per `storage/repo-files.md`'s create-task contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
	parseFrontmatter,
	changeTaskStatus,
	updateTaskFields,
	appendTaskSection,
	listAllTasks,
	findTaskByQuery,
	computeWaves,
	loadSkillContent,
	stateToToken,
	serializeFrontmatter,
} from './tasks.js';
import { parseGithubIssueRef, fetchIssueState } from './ticket-drift.js';
import { resolveTasksRoot, isVaultBackedHubType } from './memory-root.js';
import { readJsonSafe } from '../wizard.js';

export const DEFAULT_PROJECTS_ROOT = 'projects';

// Skills live in this repo (setchin-agent-profiles), regardless of which
// project repo `--projects-root` points at — so the default is resolved
// relative to this module's own location, not the CLI process cwd.
const __taskCliDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SKILLS_ROOT = path.resolve(__taskCliDir, '..', '..', '..', 'agents', 'skills');

/**
 * Resolve a task file path from an id.
 *
 * Accepted id formats:
 *  - a literal path to an existing `.md` file
 *  - "<project>#<query>" — query is a task number or slug fragment, resolved
 *    via findTaskByQuery against `<projectsRoot>/<project>`
 *  - "<query>" alone — searched across every project directory under
 *    projectsRoot (first match wins)
 *
 * Returns the absolute file path, or null if no match was found.
 */
export function resolveTaskPath(id, { projectsRoot = DEFAULT_PROJECTS_ROOT, fsMod = fs } = {}) {
	if (typeof id !== 'string' || id.length === 0) return null;

	if (id.endsWith('.md') && fsMod.existsSync(id)) {
		return path.resolve(id);
	}

	const hashIdx = id.indexOf('#');
	if (hashIdx !== -1) {
		const project = id.slice(0, hashIdx);
		const query = id.slice(hashIdx + 1);
		return findTaskByQuery(path.join(projectsRoot, project), query);
	}

	if (!fsMod.existsSync(projectsRoot)) return null;
	const projects = fsMod.readdirSync(projectsRoot, { withFileTypes: true })
		.filter(e => e.isDirectory())
		.map(e => e.name);

	for (const project of projects) {
		const found = findTaskByQuery(path.join(projectsRoot, project), id);
		if (found) return found;
	}
	return null;
}

/**
 * `task read <id>` — read a single task file's frontmatter and body.
 */
export function readTask(id, opts = {}) {
	const taskPath = resolveTaskPath(id, opts);
	if (!taskPath || !fs.existsSync(taskPath)) {
		return { ok: false, error: `task not found: ${id}` };
	}
	const raw = fs.readFileSync(taskPath, 'utf-8');
	const { meta, body } = parseFrontmatter(raw);
	return { ok: true, path: taskPath, meta, body };
}

/**
 * `task list <project> [--state S]` — list task files for a project,
 * optionally filtered by filename-infix state token (e.g. "todo",
 * "in-progress", "ready-for-qa").
 */
export function listTasks(project, { state, projectsRoot = DEFAULT_PROJECTS_ROOT } = {}) {
	if (!project) return { ok: false, error: 'project is required' };
	const all = listAllTasks(projectsRoot);
	const entry = all.find(e => e.project === project);
	if (!entry) return { ok: false, error: `project not found: ${project}` };

	let tasks = [
		...entry.todos.map(file => ({ file, state: 'todo' })),
		...entry.inFlight,
		...entry.dones.map(file => ({ file, state: 'done' })),
	];
	if (state) tasks = tasks.filter(t => t.state === state);

	return { ok: true, project, tasks };
}

/**
 * `task waves <project>` — compute eligible parallel groups of `todo` tasks
 * for a project. Read/compute-only: never dispatches or
 * transitions state. See module doc comment above for the confirmation-gate
 * contract this command feeds into.
 */
export function wavesCommand(project, { projectsRoot = DEFAULT_PROJECTS_ROOT } = {}) {
	return computeWaves(project, { projectsRoot });
}

/**
 * `task update-field <id> <field> <value>` — edit a single frontmatter
 * field without a state transition (no rename). Use `transition` for
 * state changes.
 */
export function updateField(id, field, value, opts = {}) {
	if (!field) return { ok: false, error: 'field is required' };
	const taskPath = resolveTaskPath(id, opts);
	if (!taskPath) return { ok: false, error: `task not found: ${id}` };

	try {
		updateTaskFields(taskPath, { [field]: value });
	} catch (err) {
		return { ok: false, error: `update-field failed: ${err.message}`, path: taskPath };
	}
	return { ok: true, path: taskPath, field, value };
}

/**
 * Extract the tracker reference from a task file's markdown body when no
 * YAML frontmatter field carries it. Every real task file in this
 * backlog documents its GitHub issue as a `**GitHub:** <url>` line in the
 * body, not frontmatter — `parseFrontmatter()` returns `meta: {}` for these
 * files, so `parseGithubIssueRef(meta.github ?? meta['github-issue'])` was
 * always called with `undefined` and the tracker mirror silently no-op'd on
 * every single transition.
 *
 * Matches the first `**GitHub:** ...` line and returns the raw remainder
 * of that line untouched (including any wrapping backticks, e.g.
 * `` **GitHub:** `https://...` `` as seen in some real task files) —
 * `parseGithubIssueRef()` already extracts the URL out of extra surrounding
 * characters, so no separate stripping step is needed here. Returns null
 * when no such line exists in the body.
 */
export function extractGithubBodyLine(body) {
	if (typeof body !== 'string') return null;
	const match = body.match(/^\*\*GitHub:\*\*\s*(.+)$/m);
	return match ? match[1].trim() : null;
}

/**
 * Resolve a task's tracker (GitHub issue) reference: prefers the canonical
 * YAML frontmatter field(s) (`github:` / `github-issue:`) and falls back to
 * the markdown-body `**GitHub:**` line when frontmatter carries
 * no usable reference — e.g. a placeholder like `**GitHub:** _not created
 * yet_` correctly resolves to null via `parseGithubIssueRef()`, not a thrown
 * error. Every tracker-ref resolution point in this file goes through this
 * one function so the fix applies consistently rather than being duplicated
 * per call site.
 */
export function resolveGithubRef(meta, body) {
	const fromFrontmatter = parseGithubIssueRef(meta.github ?? meta['github-issue']);
	if (fromFrontmatter) return fromFrontmatter;
	return parseGithubIssueRef(extractGithubBodyLine(body));
}

/**
 * Build the mirror-skip message for a task file whose tracker reference
 * resolved to null via `resolveGithubRef`. Distinguishes two shapes:
 *
 *  - the `github`/`github-issue` frontmatter field is present and non-empty
 *    but the value can't be parsed by `parseGithubIssueRef` (e.g. a bare
 *    issue number with no repo, like `github-issue: 784`) — a tracker IS
 *    configured, so the message says so explicitly rather than the
 *    misleading "no tracker configured" wording.
 *  - no such field, or an empty one — "no tracker configured" (unchanged).
 *
 * Deliberately scoped to the frontmatter field only, not the markdown-body
 * `**GitHub:**` fallback: a placeholder body line (e.g. `_not created yet_`)
 * is present and non-empty too, but is an intentional "not linked yet" note,
 * not a broken reference — it keeps the existing "no tracker configured"
 * wording (see `resolveGithubRef`'s doc comment on that placeholder case).
 */
export function describeUnresolvedGithubRef(meta) {
	const frontmatterRaw = meta.github ?? meta['github-issue'];
	if (frontmatterRaw !== undefined && frontmatterRaw !== null && String(frontmatterRaw).trim() !== '') {
		return `skipped (github-issue value could not be parsed: "${frontmatterRaw}")`;
	}
	return 'skipped (no tracker configured)';
}

/**
 * `task transition <id> <new-state> [--github <url>]` — the atomic, ordered
 * lifecycle transition (AC 2). The optional `--github <url>` flag sets the `github:` frontmatter field in the same call.
 *
 *   1. frontmatter `status:` update (via changeTaskStatus)
 *   2. frontmatter `github:` update (if `--github` flag supplied)
 *   3. filename infix rename (via changeTaskStatus, same call)
 *   4. GitHub label sync via `gh` — remove old `state:*` label, add new one
 *      (only when a `github`/`github-issue` tracker reference is present)
 *   5. post-verify: `gh issue view` and confirm the new label actually
 *      landed — explicit failure if not (no silent success)
 *
 * Steps 1-3 are a single atomic local write (already true of
 * `changeTaskStatus` — content write then rename). If the local write
 * succeeds but the tracker mirror (steps 4-5) fails, the result reports
 * `ok: false` with the specific failed step while leaving the local write
 * in place (per ticket-lifecycle-mode's "local write is authoritative and
 * happens first" rule) — the caller/CLI exits non-zero and the failure is
 * not swallowed.
 *
 * Tracker-ref resolution: when this same call supplies a
 * `frontmatterUpdates.github`/`frontmatterUpdates['github-issue']` value
 * (i.e. `--github <url>` was passed), that incoming value is resolved first
 * and used for the mirror sync — not the file's pre-update frontmatter/body.
 * Otherwise resolution falls back to `resolveGithubRef(metaBefore, bodyBefore)`
 * exactly as before. This matters because a task's prior `github:` field can
 * hold a non-issue reference (e.g. a PR URL, before the issue URL was ever
 * written) that `resolveGithubRef` can't parse — without preferring the
 * incoming value, a `--github <valid-issue-url>` call would silently report
 * "no tracker configured" and skip the mirror even though it just supplied a
 * good reference in the same call.
 */
export function transitionTask(id, newState, {
	projectsRoot = DEFAULT_PROJECTS_ROOT,
	execFn = execFileSync,
	frontmatterUpdates = {},
} = {}) {
	const result = { ok: false, steps: [] };

	const taskPath = resolveTaskPath(id, { projectsRoot });
	if (!taskPath) {
		result.error = `task not found: ${id}`;
		return result;
	}

	const rawBefore = fs.readFileSync(taskPath, 'utf-8');
	const { meta: metaBefore, body: bodyBefore } = parseFrontmatter(rawBefore);
	const oldState = metaBefore.status;

	// Step 1 + 2: atomic local write (frontmatter status + filename rename).
	let newPath;
	try {
		newPath = changeTaskStatus(taskPath, newState, frontmatterUpdates);
		result.steps.push({ step: 'local-write', ok: true, path: newPath });
	} catch (err) {
		result.steps.push({ step: 'local-write', ok: false, error: err.message });
		result.error = `local write failed: ${err.message}`;
		return result;
	}
	result.path = newPath;

	// No tracker configured for this task — local-only transition is complete.
	// Prefer this call's own incoming --github value (if supplied) over the
	// file's pre-update frontmatter/body — see doc comment above.
	const incomingGithub = frontmatterUpdates.github ?? frontmatterUpdates['github-issue'];
	const githubRef = incomingGithub !== undefined
		? parseGithubIssueRef(incomingGithub)
		: resolveGithubRef(metaBefore, bodyBefore);
	if (!githubRef) {
		result.ok = true;
		// The incoming --github value's own unparseable-but-present case keeps
		// the existing "no tracker configured" wording (a supplied value that
		// doesn't resolve to a real issue, e.g. a PR URL, is a caller mistake,
		// not evidence a tracker field exists on the file) -- only the file's
		// own frontmatter field gets the more specific message.
		result.mirror = incomingGithub !== undefined
			? 'skipped (no tracker configured)'
			: describeUnresolvedGithubRef(metaBefore);
		return result;
	}

	// Step 3: GitHub label sync. Removing the old label is best-effort — the
	// issue may never have carried it (e.g. it was created without a
	// `state:*` label, or a previous sync already cleared it), and that is
	// not itself a transition failure as long as the new label lands and
	// verifies. Adding the new label is NOT best-effort: any failure there
	// aborts the transition.
	if (oldState && oldState.startsWith('state:') && oldState !== newState) {
		try {
			execFn('gh', [
				'issue', 'edit', String(githubRef.number),
				'--repo', `${githubRef.owner}/${githubRef.repo}`,
				'--remove-label', oldState,
			], { encoding: 'utf-8' });
			result.steps.push({ step: 'label-remove', ok: true });
		} catch (err) {
			// Non-fatal: record and continue to add-label + verify.
			result.steps.push({ step: 'label-remove', ok: true, note: `old label not present or removal failed (non-fatal): ${err.message}` });
		}
	}

	// `closed` is not a real `state:*` label in this repo — GitHub represents
	// "closed" via the issue's `state` field, not a label. Special-case it to
	// close the issue instead of attempting a nonexistent label add.
	if (newState === 'closed') {
		try {
			execFn('gh', [
				'issue', 'close', String(githubRef.number),
				'--repo', `${githubRef.owner}/${githubRef.repo}`,
			], { encoding: 'utf-8' });
			result.steps.push({ step: 'issue-close', ok: true });
		} catch (err) {
			result.steps.push({ step: 'issue-close', ok: false, error: err.message });
			result.error = `issue close failed: ${err.message}`;
			return result;
		}

		// Step 4: post-verify — confirm the issue's live state is CLOSED.
		try {
			const issueState = fetchIssueState(githubRef, execFn);
			if (issueState.state !== 'CLOSED') {
				const msg = `issue state is "${issueState.state}" after close (expected CLOSED)`;
				result.steps.push({ step: 'verify', ok: false, error: msg });
				result.error = `verification failed: ${msg}`;
				return result;
			}
			result.steps.push({ step: 'verify', ok: true });
		} catch (err) {
			result.steps.push({ step: 'verify', ok: false, error: err.message });
			result.error = `verification failed: ${err.message}`;
			return result;
		}

		result.ok = true;
		result.mirror = 'synced';
		return result;
	}

	try {
		execFn('gh', [
			'issue', 'edit', String(githubRef.number),
			'--repo', `${githubRef.owner}/${githubRef.repo}`,
			'--add-label', newState,
		], { encoding: 'utf-8' });
		result.steps.push({ step: 'label-add', ok: true });
	} catch (err) {
		result.steps.push({ step: 'label-add', ok: false, error: err.message });
		result.error = `label sync failed: ${err.message}`;
		return result;
	}

	// Step 4: post-verify — confirm the new label actually landed.
	try {
		const issueState = fetchIssueState(githubRef, execFn);
		if (!issueState.labels.includes(newState)) {
			const msg = `label "${newState}" not found on issue after sync (found: ${issueState.labels.join(', ') || 'none'})`;
			result.steps.push({ step: 'verify', ok: false, error: msg });
			result.error = `verification failed: ${msg}`;
			return result;
		}
		result.steps.push({ step: 'verify', ok: true });
	} catch (err) {
		result.steps.push({ step: 'verify', ok: false, error: err.message });
		result.error = `verification failed: ${err.message}`;
		return result;
	}

	result.ok = true;
	result.mirror = 'synced';
	return result;
}

/**
 * `task append-section <id> <section-name> <content>` — append markdown
 * content under a named `## <section-name>` heading in the task file's
 * body. Creates the heading if it doesn't already exist.
 */
export function appendSection(id, section, content, opts = {}) {
	if (!section) return { ok: false, error: 'section is required' };
	if (typeof content !== 'string' || content.trim() === '') {
		return { ok: false, error: 'content is required' };
	}
	const taskPath = resolveTaskPath(id, opts);
	if (!taskPath) return { ok: false, error: `task not found: ${id}` };

	try {
		appendTaskSection(taskPath, section, content);
	} catch (err) {
		return { ok: false, error: `append-section failed: ${err.message}`, path: taskPath };
	}
	return { ok: true, path: taskPath, section };
}

// ── qa-report ───────────────────────────────────────────────────────────────

const FAIL_VERDICTS = new Set(['FAIL', 'PARTIAL', 'PARTIAL PASS']);

/**
 * Compose the QA report comment/section body. Content/judgment (which ACs
 * pass, what the findings are) is entirely the caller's (Tester's)
 * responsibility — this only assembles the supplied pieces into one report.
 */
export function composeQaReport(id, verdict, { findingsContent, gapsContent } = {}) {
	const lines = [`## QA Report — ${id}`, '', `**Verdict:** ${verdict}`];
	if (findingsContent && findingsContent.trim()) {
		lines.push('', findingsContent.trim());
	}
	if (gapsContent && gapsContent.trim()) {
		lines.push('', '### Gap Closure Reference', '', gapsContent.trim());
	}
	lines.push('');
	return lines.join('\n');
}

/**
 * Best-effort discovery of an open PR for the current branch on the same
 * repo as the linked issue. Task files have no explicit PR frontmatter
 * field today, so this infers the PR from the current git branch via
 * `gh pr list --head <branch>`. Returns null (not an error) when no branch
 * can be determined or no open PR is found — issue-only posting is a valid
 * outcome, not a failure.
 */
function discoverPrRef(githubRef, execFn) {
	try {
		const branch = execFn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
		if (!branch || branch === 'HEAD') return null;
		const out = execFn('gh', [
			'pr', 'list',
			'--head', branch,
			'--repo', `${githubRef.owner}/${githubRef.repo}`,
			'--state', 'open',
			'--json', 'number',
		], { encoding: 'utf-8' });
		const arr = JSON.parse(out);
		if (Array.isArray(arr) && arr.length > 0) {
			return { owner: githubRef.owner, repo: githubRef.repo, number: arr[0].number };
		}
		return null;
	} catch {
		return null;
	}
}

function fetchComments(kind, ref, execFn) {
	const cmd = kind === 'issue' ? 'issue' : 'pr';
	const out = execFn('gh', [
		cmd, 'view', String(ref.number),
		'--repo', `${ref.owner}/${ref.repo}`,
		'--json', 'comments',
	], { encoding: 'utf-8' });
	const data = JSON.parse(out);
	return (data.comments || []).map(c => c.body);
}

/**
 * Post `body` to a GitHub issue or PR, then re-fetch the comment list to
 * confirm it actually landed (the same label post-verify pattern applied
 * to comments). Pushes `post-<kind>`/`verify-<kind>` steps onto `steps` and
 * returns `{ ok, error }` — never throws.
 */
function postAndVerify(kind, ref, body, execFn, steps) {
	try {
		execFn('gh', [
			kind === 'issue' ? 'issue' : 'pr', 'comment', String(ref.number),
			'--repo', `${ref.owner}/${ref.repo}`,
			'--body', body,
		], { encoding: 'utf-8' });
		steps.push({ step: `post-${kind}`, ok: true });
	} catch (err) {
		steps.push({ step: `post-${kind}`, ok: false, error: err.message });
		return { ok: false, error: `posting to ${kind} failed: ${err.message}` };
	}

	try {
		const comments = fetchComments(kind, ref, execFn);
		if (!comments.some(c => typeof c === 'string' && c.includes(body.trim()))) {
			const msg = `QA report comment not found on ${kind} after posting (post-verify failed)`;
			steps.push({ step: `verify-${kind}`, ok: false, error: msg });
			return { ok: false, error: msg };
		}
		steps.push({ step: `verify-${kind}`, ok: true });
	} catch (err) {
		steps.push({ step: `verify-${kind}`, ok: false, error: err.message });
		return { ok: false, error: `verifying ${kind} post failed: ${err.message}` };
	}

	return { ok: true };
}

/**
 * `task qa-report <id> <verdict> [--gaps <path>] [--findings <path>]`
 * (AC 1-4). Composes the report, posts it to the linked issue and
 * (if discoverable) PR, post-verifies each post landed, appends the local
 * `## QA Report` section (plus `## Gap Closure` on FAIL/PARTIAL when
 * `--gaps` is supplied), and performs the matching state transition.
 *
 * Any post-verify failure aborts before any state transition happens — the
 * local task file's frontmatter/filename are left untouched so a caller can
 * retry without a partial, silently-inconsistent state (mirrors
 * `transitionTask`'s "no silent success" contract).
 */
export function qaReport(id, verdict, {
	gapsPath,
	findingsPath,
	projectsRoot = DEFAULT_PROJECTS_ROOT,
	execFn = execFileSync,
	fsMod = fs,
} = {}) {
	const result = { ok: false, steps: [] };

	if (!verdict) {
		result.error = 'verdict is required';
		return result;
	}
	const verdictUpper = String(verdict).toUpperCase();
	const isPass = verdictUpper === 'PASS';
	const isFail = FAIL_VERDICTS.has(verdictUpper) || verdictUpper.startsWith('PARTIAL');

	const taskPath = resolveTaskPath(id, { projectsRoot, fsMod });
	if (!taskPath) {
		result.error = `task not found: ${id}`;
		return result;
	}
	result.path = taskPath;

	const raw = fsMod.readFileSync(taskPath, 'utf-8');
	const { meta, body } = parseFrontmatter(raw);

	let gapsContent = null;
	if (gapsPath) {
		if (!fsMod.existsSync(gapsPath)) {
			result.error = `gaps file not found: ${gapsPath}`;
			return result;
		}
		gapsContent = fsMod.readFileSync(gapsPath, 'utf-8');
	}

	let findingsContent = null;
	if (findingsPath) {
		if (!fsMod.existsSync(findingsPath)) {
			result.error = `findings file not found: ${findingsPath}`;
			return result;
		}
		findingsContent = fsMod.readFileSync(findingsPath, 'utf-8');
	}

	const reportBody = composeQaReport(id, verdict, { findingsContent, gapsContent });

	const githubRef = resolveGithubRef(meta, body);
	if (githubRef) {
		const issueResult = postAndVerify('issue', githubRef, reportBody, execFn, result.steps);
		if (!issueResult.ok) {
			result.error = issueResult.error;
			return result;
		}

		const prRef = discoverPrRef(githubRef, execFn);
		if (prRef) {
			const prResult = postAndVerify('pr', prRef, reportBody, execFn, result.steps);
			if (!prResult.ok) {
				result.error = prResult.error;
				return result;
			}
			result.pr = prRef;
		} else {
			result.steps.push({ step: 'post-pr', ok: true, note: 'no open PR found for current branch — issue-only posting' });
		}
	} else {
		result.steps.push({ step: 'post', ok: true, note: 'no tracker configured — skipped' });
	}

	try {
		appendTaskSection(taskPath, 'QA Report', reportBody);
		result.steps.push({ step: 'append-qa-report', ok: true });
	} catch (err) {
		result.steps.push({ step: 'append-qa-report', ok: false, error: err.message });
		result.error = `append-qa-report failed: ${err.message}`;
		return result;
	}

	if (isPass) {
		const transitionResult = transitionTask(id, 'state:qa-passed', { projectsRoot, execFn });
		result.steps.push({ step: 'transition', ok: transitionResult.ok, detail: transitionResult });
		if (!transitionResult.ok) {
			result.error = `transition failed: ${transitionResult.error}`;
			return result;
		}
		result.path = transitionResult.path;
	} else if (isFail) {
		if (gapsContent) {
			try {
				appendTaskSection(taskPath, 'Gap Closure', gapsContent);
				result.steps.push({ step: 'append-gap-closure', ok: true });
			} catch (err) {
				result.steps.push({ step: 'append-gap-closure', ok: false, error: err.message });
				result.error = `append-gap-closure failed: ${err.message}`;
				return result;
			}
		}

		const currentFailCount = parseInt(meta['fail-count'] ?? '0', 10) || 0;
		const newFailCount = currentFailCount + 1;
		const frontmatterUpdates = { 'fail-count': newFailCount };
		if (newFailCount >= 3) frontmatterUpdates.parked = true;

		const transitionResult = transitionTask(id, 'state:changes-requested', { projectsRoot, execFn, frontmatterUpdates });
		result.steps.push({ step: 'transition', ok: transitionResult.ok, detail: transitionResult });
		if (!transitionResult.ok) {
			result.error = `transition failed: ${transitionResult.error}`;
			return result;
		}
		result.path = transitionResult.path;

		if (githubRef) {
			const failLabel = `qa-fail-${newFailCount}`;
			if (currentFailCount >= 1) {
				try {
					execFn('gh', [
						'issue', 'edit', String(githubRef.number),
						'--repo', `${githubRef.owner}/${githubRef.repo}`,
						'--remove-label', `qa-fail-${currentFailCount}`,
					], { encoding: 'utf-8' });
				} catch {
					// best-effort: prior fail label may not exist
				}
			}
			try {
				execFn('gh', [
					'issue', 'edit', String(githubRef.number),
					'--repo', `${githubRef.owner}/${githubRef.repo}`,
					'--add-label', failLabel,
				], { encoding: 'utf-8' });
				result.steps.push({ step: 'qa-fail-label', ok: true, label: failLabel });
			} catch (err) {
				result.steps.push({ step: 'qa-fail-label', ok: false, error: err.message });
				result.error = `qa-fail label sync failed: ${err.message}`;
				return result;
			}
		}
	} else {
		result.error = `unrecognized verdict: ${verdict} (expected PASS, FAIL, PARTIAL PASS, or BLOCKED)`;
		return result;
	}

	result.ok = true;
	result.verdict = verdict;
	return result;
}

// ── post-merge-check ──────────────────────────────────────────────────────

function normalizeGhErrorMessage(err) {
	if (!err) return 'unknown error';
	if (typeof err.message === 'string' && err.message.trim()) return err.message.trim();
	return String(err);
}

function readJsonCommand(execFn, cmd, args) {
	const out = execFn(cmd, args, { encoding: 'utf-8' });
	return JSON.parse(out);
}

function readTextCommand(execFn, cmd, args) {
	return execFn(cmd, args, { encoding: 'utf-8' }).trim();
}

function fetchDefaultBranch(execFn) {
	const repo = readJsonCommand(execFn, 'gh', ['repo', 'view', '--json', 'defaultBranchRef']);
	return repo?.defaultBranchRef?.name ?? null;
}

function fetchPrState(prNumber, execFn) {
	try {
		return readJsonCommand(execFn, 'gh', [
			'pr', 'view', String(prNumber),
			'--json', 'number,state,mergedAt,baseRefName,title,url',
		]);
	} catch (err) {
		const message = normalizeGhErrorMessage(err);
		if (/no pull requests found|could not resolve to a pull request|not found/i.test(message)) {
			return { error: `PR not found: ${prNumber}` };
		}
		return { error: `gh pr view failed: ${message}` };
	}
}

export function postMergeCheck(prNumber, { execFn = execFileSync } = {}) {
	if (!prNumber) {
		return { ok: false, error: 'pr-number is required' };
	}

	const pr = fetchPrState(prNumber, execFn);
	if (pr.error) {
		return { ok: false, error: pr.error, prNumber: String(prNumber) };
	}

	const merged = Boolean(pr.mergedAt) || String(pr.state).toUpperCase() === 'MERGED';
	if (!merged) {
		return {
			ok: true,
			prNumber: String(prNumber),
			merged: false,
			state: pr.state,
			baseRefName: pr.baseRefName ?? null,
			message: `PR #${prNumber} is not merged; no git action taken.`,
		};
	}

	const defaultBranch = fetchDefaultBranch(execFn) ?? pr.baseRefName ?? null;
	if (!defaultBranch) {
		return { ok: false, error: 'default branch could not be determined', prNumber: String(prNumber) };
	}

	const currentBranch = readTextCommand(execFn, 'git', ['branch', '--show-current']);
	if (currentBranch !== defaultBranch) {
		return {
			ok: false,
			error: `post-merge-check must run on the default branch (${defaultBranch}); current branch is ${currentBranch || '(detached HEAD)'}`,
			prNumber: String(prNumber),
			defaultBranch,
			currentBranch,
		};
	}

	const dirty = readTextCommand(execFn, 'git', ['status', '--porcelain']);
	if (dirty) {
		return {
			ok: false,
			error: 'dirty working tree; aborting without git fetch or pull',
			prNumber: String(prNumber),
			defaultBranch,
			currentBranch,
		};
	}

	try {
		execFn('git', ['fetch', 'origin'], { encoding: 'utf-8' });
	} catch (err) {
		return {
			ok: false,
			error: `git fetch failed: ${normalizeGhErrorMessage(err)}`,
			prNumber: String(prNumber),
			defaultBranch,
			currentBranch,
		};
	}

	try {
		execFn('git', ['pull', '--ff-only'], { encoding: 'utf-8' });
	} catch (err) {
		return {
			ok: false,
			error: `fast-forward failed: ${normalizeGhErrorMessage(err)}`,
			prNumber: String(prNumber),
			defaultBranch,
			currentBranch,
		};
	}

	const headInfo = readTextCommand(execFn, 'git', ['log', '-1', '--format=%H%n%s']).split(/\r?\n/);
	const [sha = '', subject = ''] = headInfo;

	return {
		ok: true,
		prNumber: String(prNumber),
		merged: true,
		defaultBranch,
		currentBranch,
		pr: {
			number: pr.number,
			state: pr.state,
			mergedAt: pr.mergedAt ?? null,
			baseRefName: pr.baseRefName ?? null,
			title: pr.title ?? null,
			url: pr.url ?? null,
		},
		head: {
			sha,
			subject,
		},
		message: `Default branch ${defaultBranch} fast-forwarded after confirming PR #${prNumber} was merged.`,
	};
}

// ── dispatch-context ────────────────────────────────────────────────────────

/**
 * Verifier field → the terminal state Builder/Tester's dispatch prompt must
 * drive the ticket to, per `task-automation-flow`'s transition table
 * (`verifier: Tester`/`Automated` → `state:ready-for-qa`;
 * `verifier: Architect` → `state:ready-for-review`, no separate QA phase).
 */
const VERIFIER_TERMINAL_STATE = {
	Tester: 'state:ready-for-qa',
	Automated: 'state:ready-for-qa',
	Architect: 'state:ready-for-review',
};

/**
 * Extract the mandatory ticket-state-ownership paragraph verbatim from
 * `task-automation-flow`'s SKILL.md content (the blockquote directly under
 * the "## Mandatory dispatch inclusion: ticket-state ownership" heading).
 * Read live from the skill file at call time — never duplicated as a string
 * literal in this CLI — so an edit to the skill text is picked up
 * automatically and never silently drifts out of sync with the CLI (AC 1, 5).
 * Returns null if the heading or its blockquote can't be found (the skill's
 * shape changed) rather than falling back to a stale copy.
 */
export function extractStateOwnershipParagraph(skillText) {
	if (typeof skillText !== 'string') return null;
	const lines = skillText.split(/\r?\n/);
	const headingIdx = lines.findIndex(
		l => l.trim() === '## Mandatory dispatch inclusion: ticket-state ownership'
	);
	if (headingIdx === -1) return null;

	const quoteLines = [];
	for (let i = headingIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('>')) {
			quoteLines.push(line.replace(/^>\s?/, ''));
		} else if (quoteLines.length > 0) {
			break;
		}
	}
	if (quoteLines.length === 0) return null;
	return quoteLines.join('\n').trim();
}

/**
 * Extract the worktree-isolation reminder verbatim from `agent-foundations`'s
 * SKILL.md content (the "Never mutate the team lead's default local
 * checkout..." bullet under "## Security Baseline"). Same live-read-at-
 * call-time sourcing as `extractStateOwnershipParagraph` — never duplicated
 * as a string literal here (AC 3, 5).
 */
export function extractWorktreeIsolationReminder(skillText) {
	if (typeof skillText !== 'string') return null;
	const lines = skillText.split(/\r?\n/);
	const headingIdx = lines.findIndex(l => l.trim() === '## Security Baseline');
	if (headingIdx === -1) return null;

	let bulletStart = -1;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('## ')) break; // left the Security Baseline section
		if (/^-\s+Never mutate the team lead's default local checkout/.test(line)) {
			bulletStart = i;
			break;
		}
	}
	if (bulletStart === -1) return null;

	const bulletLines = [lines[bulletStart].replace(/^-\s+/, '')];
	for (let i = bulletStart + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '' || line.startsWith('- ') || line.startsWith('## ')) break;
		bulletLines.push(line.trim());
	}
	return bulletLines.join(' ').trim();
}

/**
 * `task dispatch-context <id>` — assemble the
 * mechanically-derivable parts of a Builder/Tester dispatch prompt: the
 * ticket file content, its issue link, the verifier-appropriate terminal
 * state, and two mandatory paragraphs (ticket-state ownership,
 * worktree-isolation) read live from their source skill files so a skill-text
 * edit never requires a CLI code change (AC 1, 3, 5).
 *
 * Read-only — no dispatch side effects, no Agent tool invocation (AC 4).
 * Output is meant to be pasted/concatenated into the actual dispatch prompt;
 * Architect still adds task-specific instructions, anchors, and scope notes
 * (AC 2) — this command does not attempt to template the whole prompt.
 */
export function dispatchContext(id, {
	projectsRoot = DEFAULT_PROJECTS_ROOT,
	skillsRoot = DEFAULT_SKILLS_ROOT,
	fsMod = fs,
} = {}) {
	const taskPath = resolveTaskPath(id, { projectsRoot, fsMod });
	if (!taskPath || !fsMod.existsSync(taskPath)) {
		return { ok: false, error: `task not found: ${id}` };
	}

	const raw = fsMod.readFileSync(taskPath, 'utf-8');
	const { meta } = parseFrontmatter(raw);

	const verifier = meta.verifier;
	const terminalState = VERIFIER_TERMINAL_STATE[verifier];
	if (!terminalState) {
		return {
			ok: false,
			error: `unsupported or missing verifier "${verifier ?? '(none)'}" on ${id} — expected "Tester", "Automated", or "Architect"`,
			path: taskPath,
		};
	}

	const automationFlowText = loadSkillContent(skillsRoot, 'task-automation-flow');
	const stateOwnershipParagraph = extractStateOwnershipParagraph(automationFlowText);
	if (!stateOwnershipParagraph) {
		return {
			ok: false,
			error: 'could not extract the ticket-state-ownership paragraph from task-automation-flow\'s SKILL.md — its heading/blockquote shape may have changed',
			path: taskPath,
		};
	}

	const agentFoundationsText = loadSkillContent(skillsRoot, 'agent-foundations');
	const worktreeIsolationReminder = extractWorktreeIsolationReminder(agentFoundationsText);
	if (!worktreeIsolationReminder) {
		return {
			ok: false,
			error: 'could not extract the worktree-isolation reminder from agent-foundations\'s SKILL.md Security Baseline — its shape may have changed',
			path: taskPath,
		};
	}

	return {
		ok: true,
		path: taskPath,
		id,
		verifier,
		terminalState,
		issueLink: meta.github ?? meta['github-issue'] ?? null,
		ticketContent: raw,
		stateOwnershipParagraph,
		worktreeIsolationReminder,
	};
}

// ── create ───────────────────────────────────────────────────────────────

/**
 * Create (if absent) or update the project hub note — vault-shaped hubs
 * only, per the active storage plugin's create-task contract. Creates the note
 * with the documented minimal starter shape (`# <project>` / `## Tasks`) on
 * first use, then appends a `[[task_<id>_<slug>]]` link line under `## Tasks`
 * on every call, first or subsequent. The minimal starter shape has exactly
 * one section, so appending at the end of the note is equivalent to
 * appending under `## Tasks`.
 */
function ensureProjectHubNote(projectsRoot, project, taskFilenameNoExt, fsMod) {
	const hubNotePath = path.join(projectsRoot, project, `${project}.md`);
	const linkLine = `- [[${taskFilenameNoExt}]]`;

	if (!fsMod.existsSync(hubNotePath)) {
		fsMod.mkdirSync(path.dirname(hubNotePath), { recursive: true });
		fsMod.writeFileSync(hubNotePath, `# ${project}\n\n## Tasks\n\n${linkLine}\n`, 'utf-8');
		return;
	}

	const raw = fsMod.readFileSync(hubNotePath, 'utf-8');
	const trimmed = raw.replace(/\s+$/, '');
	fsMod.writeFileSync(hubNotePath, `${trimmed}\n${linkLine}\n`, 'utf-8');
}

/**
 * `task create <project> <id> <slug> [--status S] [--verifier V]
 * [--github-issue URL] [--fail-count N] [--parked BOOL] [--agent A]
 * [--model M] [--skills a,b,c] [--token-budget N]` — write a new
 * task file. `fields` carries every optional frontmatter field named by the
 * active storage plugin's create-task contract (the files under
 * `skills/agent-foundations/storage/`): `verifier`, `fail-count`, `parked`,
 * `github-issue`, `agent`, `model`, `skills`, `token-budget`. `fields.status`
 * (if present) is the initial lifecycle state; both contracts list `status`
 * and `verifier` as required.
 *
 * `isVaultShaped` decides the on-disk shape — resolved by the caller
 * (`runCli`) from `--hub-root`'s `workspace.config.json` `hubType` via
 * `isVaultBackedHubType`, the same mechanism `resolveTasksRoot` already uses
 * for `--hub-root` (see `runCli` below), not re-derived here:
 *
 *  - `true` (vault-shaped): filename carries NO state-token infix
 *    (`task_<id>_<slug>.md`). Also creates/updates the project hub note,
 *    whose `[[task_<id>_<slug>]]` forward link is the sole explicit link
 *    between hub and task — the vault viewer's own backlinks panel and graph view
 *    surface the reverse direction automatically, so no `[[<project>]]`
 *    link is written into the task's body.
 *  - `false` (free-tier, the default): preserves the existing repo-files
 *    convention unchanged — filename carries the initial status's
 *    filename-infix token (`task_<id>_<token>_<slug>.md`). No hub note.
 */
export function createTask(project, id, slug, {
	fields = {},
	body = '',
	projectsRoot = DEFAULT_PROJECTS_ROOT,
	isVaultShaped = false,
	fsMod = fs,
} = {}) {
	if (!project) return { ok: false, error: 'project is required' };
	if (!id) return { ok: false, error: 'id is required' };
	if (!slug) return { ok: false, error: 'slug is required' };
	if (!fields.verifier) return { ok: false, error: 'verifier is required' };

	const status = fields.status ?? 'state:ready-for-implementation';
	let token;
	try {
		token = stateToToken(status);
	} catch (err) {
		return { ok: false, error: err.message };
	}

	const projectDir = path.join(projectsRoot, project);
	const filenameNoExt = isVaultShaped ? `task_${id}_${slug}` : `task_${id}_${token}_${slug}`;
	const taskPath = path.join(projectDir, `${filenameNoExt}.md`);

	if (fsMod.existsSync(taskPath)) {
		return { ok: false, error: `task file already exists: ${taskPath}` };
	}

	const { status: _status, ...restFields } = fields;
	const meta = { status, ...restFields };

	const taskBody = body;

	fsMod.mkdirSync(projectDir, { recursive: true });
	fsMod.writeFileSync(taskPath, `---\n${serializeFrontmatter(meta)}\n---\n${taskBody}`, 'utf-8');

	if (isVaultShaped) {
		ensureProjectHubNote(projectsRoot, project, filenameNoExt, fsMod);
	}

	return { ok: true, path: taskPath };
}

// ── CLI entry point ────────────────────────────────────────────────────────

function parseFlags(args) {
	const idx = args.indexOf('--state');
	const state = idx !== -1 ? args[idx + 1] : undefined;
	return { state };
}

function parseQaReportFlags(args) {
	const gapsIdx = args.indexOf('--gaps');
	const findingsIdx = args.indexOf('--findings');
	return {
		gapsPath: gapsIdx !== -1 ? args[gapsIdx + 1] : undefined,
		findingsPath: findingsIdx !== -1 ? args[findingsIdx + 1] : undefined,
	};
}

/**
 * Extract `create` command flags from args. Covers every optional
 * frontmatter field the active storage plugin's create-task contract names
 * (the files under `skills/agent-foundations/storage/`): `--status`,
 * `--verifier`, `--github-issue`, `--fail-count`, `--parked`, `--agent`,
 * `--model`, `--token-budget` map to scalar fields; `--skills` maps to a
 * comma-separated array field (matching `serializeFrontmatter`'s existing
 * array-value handling). Returns `{ fields, rest }` where `rest` is the
 * remaining positional args (`<project> <id> <slug>`) with every recognized
 * flag and its value stripped out.
 */
const CREATE_FLAG_FIELDS = {
	'--status': 'status',
	'--verifier': 'verifier',
	'--github-issue': 'github-issue',
	'--fail-count': 'fail-count',
	'--parked': 'parked',
	'--agent': 'agent',
	'--model': 'model',
	'--token-budget': 'token-budget',
};

function parseCreateFlags(args) {
	const fields = {};
	let rest = [...args];

	for (const [flag, field] of Object.entries(CREATE_FLAG_FIELDS)) {
		const idx = rest.indexOf(flag);
		if (idx !== -1) {
			fields[field] = rest[idx + 1];
			rest = [...rest.slice(0, idx), ...rest.slice(idx + 2)];
		}
	}

	const skillsIdx = rest.indexOf('--skills');
	if (skillsIdx !== -1) {
		fields.skills = rest[skillsIdx + 1].split(',').map(s => s.trim()).filter(Boolean);
		rest = [...rest.slice(0, skillsIdx), ...rest.slice(skillsIdx + 2)];
	}

	return { fields, rest };
}

/**
 * Extract `--github <url>` flag from transition command args.
 * Returns { github: url, rest } where rest is the args with the flag removed,
 * or { github: undefined, rest } if no flag is present.
 */
function parseTransitionFlags(args) {
	const githubIdx = args.indexOf('--github');
	if (githubIdx === -1) {
		return { github: undefined, rest: args };
	}
	const url = args[githubIdx + 1];
	const rest = [...args.slice(0, githubIdx), ...args.slice(githubIdx + 2)];
	return { github: url, rest };
}

/**
 * Extract a global `--projects-root <path>` flag from anywhere in argv and
 * strip it out, returning the remaining positional/flag argv untouched
 * This flag can appear before or after the command name — e.g.
 * `task transition <id> <state> --projects-root <path>` — so it must be
 * pulled out once, up front, before per-command positional parsing runs.
 *
 * Without this step every command silently ignored `--projects-root`
 * (task-cli.js always fell back to the cwd-relative `DEFAULT_PROJECTS_ROOT`,
 * and the literal flag/value tokens leaked into positional args), which is
 * the root cause of the cross-repo resolution failures.
 */
export function extractProjectsRootFlag(argv) {
	const idx = argv.indexOf('--projects-root');
	if (idx === -1) return { present: false, projectsRoot: undefined, rest: argv };
	const value = argv[idx + 1];
	const rest = [...argv.slice(0, idx), ...argv.slice(idx + 2)];
	return { present: true, projectsRoot: value, rest };
}

/**
 * Extract a global `--hub-root <path>` flag from anywhere in argv and strip
 * it out, mirroring `extractProjectsRootFlag`'s extraction pattern exactly.
 * `--hub-root` is an opt-in convenience: when given (and
 * `--projects-root` is not), `runCli` derives the effective `projectsRoot`
 * from the target hub's own `workspace.config.json` `hubType` instead of
 * requiring the caller to know and spell out the hub's tier-specific tasks
 * subpath (e.g. `vault/Tasks` for vault-backed tiers) by hand every time.
 */
export function extractHubRootFlag(argv) {
	const idx = argv.indexOf('--hub-root');
	if (idx === -1) return { present: false, hubRoot: undefined, rest: argv };
	const value = argv[idx + 1];
	const rest = [...argv.slice(0, idx), ...argv.slice(idx + 2)];
	return { present: true, hubRoot: value, rest };
}

export function runCli(argv, { fsMod = fs, execFn = execFileSync, cwd = process.cwd() } = {}) {
	const { present: hubRootPresent, hubRoot: hubRootFlagValue, rest: afterHubRoot } = extractHubRootFlag(argv);
	const { present, projectsRoot, rest: strippedArgv } = extractProjectsRootFlag(afterHubRoot);

	// A `--projects-root` flag with no value, or a value that doesn't resolve
	// to a real directory, is a clean error — not a silent fall-back to the
	// cwd-relative default and not a partial write (AC 6).
	if (present && (!projectsRoot || !fsMod.existsSync(projectsRoot))) {
		return { ok: false, error: `--projects-root not found: ${projectsRoot ?? '(missing value)'}` };
	}

	// Default-root behavior: when neither flag is given AND a
	// `workspace.config.json` exists in the cwd, behave as `--hub-root .` —
	// this is what makes the documented no-flag invocation
	// (`npm run task -- read <id>`) resolve correctly on a vault-backed hub
	// instead of silently falling through to the cwd-relative "projects"
	// default. When no `workspace.config.json` exists in the cwd (the source
	// repo, or any cwd that isn't a hub root), this branch never fires and
	// behavior is unchanged from before. An explicit `--hub-root` or
	// `--projects-root` flag always wins over this default.
	let effectiveHubRootPresent = hubRootPresent;
	let hubRoot = hubRootFlagValue;
	if (!present && !hubRootPresent && fsMod.existsSync(path.join(cwd, 'workspace.config.json'))) {
		effectiveHubRootPresent = true;
		hubRoot = cwd;
	}

	let rootOpts = present ? { projectsRoot } : {};
	// Resolved `hubType` from `--hub-root`'s (or the cwd default's own)
	// `workspace.config.json`, when derivable — undefined when
	// `--projects-root` was given instead (it wins over `--hub-root`), or
	// when neither flag nor the cwd default applies. `create` reuses this
	// exact same resolution to decide vault-vs-free-tier output shape via
	// `isVaultBackedHubType`, rather than a second detection path.
	let hubType;

	// `--projects-root` always wins when both flags are given
	// — only fall back to hub-derived resolution when it was NOT supplied.
	if (!present && effectiveHubRootPresent) {
		if (!hubRoot || !fsMod.existsSync(hubRoot)) {
			return { ok: false, error: `--hub-root not found: ${hubRoot ?? '(missing value)'}` };
		}
		const hubConfigPath = path.join(hubRoot, 'workspace.config.json');
		if (!fsMod.existsSync(hubConfigPath)) {
			return { ok: false, error: `--hub-root given but no workspace.config.json found under it: ${hubConfigPath}` };
		}
		const hubConfig = readJsonSafe(hubConfigPath, fsMod);
		hubType = hubConfig?.hubType;
		rootOpts = { projectsRoot: resolveTasksRoot(hubRoot, hubType) };
	}

	const [cmd, ...rest] = strippedArgv;
	let output;

	switch (cmd) {
		case 'read':
			output = readTask(rest[0], rootOpts);
			break;
		case 'list': {
			const { state } = parseFlags(rest);
			output = listTasks(rest[0], { state, ...rootOpts });
			break;
		}
		case 'transition': {
			const { github, rest: transitionArgs } = parseTransitionFlags(rest);
			const frontmatterUpdates = github ? { github } : {};
			output = transitionTask(transitionArgs[0], transitionArgs[1], { ...rootOpts, frontmatterUpdates });
			break;
		}
		case 'update-field':
			output = updateField(rest[0], rest[1], rest[2], rootOpts);
			break;
		case 'waves':
			output = wavesCommand(rest[0], rootOpts);
			break;
		case 'append-section': {
			// `append-section <id> <section>` with no inline content arg reads
			// content from stdin (pipe or heredoc). Checked here (after
			// `--projects-root` stripping) so the arg-count check reflects the
			// real positional args, not raw process argv.
			let content = rest[2];
			if (rest.length === 2) {
				content = readStdinSync();
			}
			output = appendSection(rest[0], rest[1], content, rootOpts);
			break;
		}
		case 'qa-report': {
			const { gapsPath, findingsPath } = parseQaReportFlags(rest);
			output = qaReport(rest[0], rest[1], { gapsPath, findingsPath, execFn, ...rootOpts });
			break;
		}
		case 'post-merge-check': {
			output = postMergeCheck(rest[0], { execFn });
			break;
		}
		case 'dispatch-context': {
			output = dispatchContext(rest[0], rootOpts);
			break;
		}
		case 'create': {
			const { fields, rest: createArgs } = parseCreateFlags(rest);
			output = createTask(createArgs[0], createArgs[1], createArgs[2], {
				fields,
				...rootOpts,
				isVaultShaped: isVaultBackedHubType(hubType),
				fsMod,
			});
			break;
		}
		default:
			output = {
				ok: false,
				error: `unknown command: ${cmd ?? '(none)'}. Usage: task <read|list|transition|update-field|waves|append-section|qa-report|post-merge-check|dispatch-context|create> ... [--projects-root <path>] [--hub-root <path>]`,
			};
	}

	return output;
}

/**
 * Read all of stdin synchronously (blocks until EOF). Used by
 * `append-section` when content is piped in rather than passed as an
 * argument (avoids shell-escaping multi-line markdown).
 */
function readStdinSync() {
	try {
		return fs.readFileSync(0, 'utf-8');
	} catch {
		return '';
	}
}

const isMain = process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	let output;
	try {
		const argv = process.argv.slice(2);
		output = runCli(argv);
	} catch (err) {
		output = { ok: false, error: err.message };
	}
	process.stdout.write(JSON.stringify(output, null, 2) + '\n');
	process.exit(output.ok ? 0 : 1);
}
