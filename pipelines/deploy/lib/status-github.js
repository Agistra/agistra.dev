/**
 * status-github.js — the GitHub half of `npm run status`.
 *
 * Reads through the `gh` CLI, with three calls per repository (one GraphQL
 * query for issues and PRs, one list of push runs, one of scheduled runs),
 * never one call per ticket. Every call goes through an injectable
 * `ghFn(args) => Promise<string>` so tests stub GitHub completely.
 *
 * A missing `gh`, or a repository that cannot be reached, never fails the
 * status: the caller gets what could be read plus warnings.
 */
import { execFile } from 'node:child_process';

export const DEFAULT_LONG_LIVED_BRANCHES = ['main', 'master', 'develop'];

/** Run conclusions that count as a red result. */
export const FAILING_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'];

const GH_TIMEOUT_MS = 45_000;
const MAX_PARALLEL = 12;
const RUN_FIELDS =
	'databaseId,workflowName,headBranch,event,status,conclusion,createdAt,url';

/** Default `ghFn`: run `gh` and resolve with its stdout. */
export function defaultGh(args) {
	return new Promise((resolve, reject) => {
		execFile(
			'gh',
			args,
			{
				encoding: 'utf-8',
				timeout: GH_TIMEOUT_MS,
				maxBuffer: 128 * 1024 * 1024,
				windowsHide: true,
			},
			(err, stdout, stderr) => {
				if (err) {
					if (stderr) err.stderr = stderr;
					if (stdout) err.stdout = stdout;
					reject(err);
				} else resolve(stdout);
			},
		);
	});
}

/** First useful line of a gh failure, for a warning. */
function reason(err) {
	const text = String(err?.stderr || err?.message || err || '').trim();
	return text.split(/\r?\n/).find((l) => l.trim()) ?? 'unknown error';
}

/** Run async jobs with at most `limit` in flight. */
async function pool(jobs, limit) {
	const results = new Array(jobs.length);
	let next = 0;
	const worker = async () => {
		while (next < jobs.length) {
			const i = next++;
			results[i] = await jobs[i]();
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, jobs.length) }, worker),
	);
	return results;
}

const ISSUE_FIELDS =
	'fragment I on Issue { number title state stateReason closedAt labels(first: 30) { nodes { name } } }';

/** The one GraphQL document read for a repo. `wanted` are issue numbers to look up by number. */
export function repoQuery({ owner, name, wanted, sinceIso }) {
	const lookups = wanted
		.map((n) => `i${n}: issue(number: ${n}) { ...I }`)
		.join(' ');
	return `query {
  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    openIssues: issues(states: OPEN, first: 100) { nodes { ...I } pageInfo { hasNextPage endCursor } }
    closedIssues: issues(states: CLOSED, first: 100, filterBy: {since: ${JSON.stringify(sinceIso)}}) { nodes { ...I } pageInfo { hasNextPage } }
    openPrs: pullRequests(states: OPEN, first: 50) { nodes { number title url headRefName baseRefName isDraft body closingIssuesReferences(first: 10) { nodes { number } } } }
    mergedPrs: pullRequests(states: MERGED, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title url mergedAt headRefName baseRefName } }
    ${lookups}
  }
}
${ISSUE_FIELDS}`;
}

function moreOpenIssuesQuery({ owner, name, after }) {
	return `query {
  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    openIssues: issues(states: OPEN, first: 100, after: ${JSON.stringify(after)}) { nodes { ...I } pageInfo { hasNextPage endCursor } }
  }
}
${ISSUE_FIELDS}`;
}

const MAX_OPEN_ISSUE_PAGES = 30;

function toIssue(node) {
	return {
		number: node.number,
		title: node.title ?? '',
		state: node.state,
		stateReason: node.stateReason ?? null,
		labels: (node.labels?.nodes ?? []).map((l) => l.name),
		closedAt: node.closedAt ?? null,
	};
}

/**
 * Run a GraphQL query. GitHub answers a lookup of a number that is not an
 * issue with an error next to good data, and `gh` then exits non-zero; the
 * data is still used.
 */
async function graphql(ghFn, query) {
	let text;
	try {
		text = await ghFn(['api', 'graphql', '-f', `query=${query}`]);
	} catch (err) {
		if (err?.stdout) {
			try {
				const body = JSON.parse(err.stdout);
				if (body?.data?.repository) return body.data.repository;
			} catch {
				// not JSON: fall through to the original error
			}
		}
		throw err;
	}
	const repository = JSON.parse(text)?.data?.repository;
	if (!repository) throw new Error('GitHub returned no repository data');
	return repository;
}

/**
 * Read the GitHub data the status needs for each repo: one GraphQL call (open
 * issues, issues closed today, open PRs, recently merged PRs, and the tickets'
 * own issues by number), plus two run lists. Never one call per ticket.
 *
 * @param {object} opts
 * @param {string[]} opts.repos         `owner/repo` names
 * @param {Record<string, number[]>} [opts.wanted]  issue numbers to look up, by repo
 * @param {(args: string[]) => Promise<string>} [opts.ghFn]
 * @param {Date} opts.since             local midnight (start of "today")
 * @returns {Promise<{
 *   available: boolean,
 *   warnings: string[],
 *   repos: Record<string, {
 *     issues: Map<number, object>|null, openPrs: object[]|null,
 *     mergedPrs: object[]|null, pushRuns: object[]|null, scheduleRuns: object[]|null,
 *   }>,
 * }>}
 */
export async function readGithub({
	repos,
	wanted = {},
	ghFn = defaultGh,
	since,
}) {
	const out = { available: true, warnings: [], repos: {} };
	if (repos.length === 0) return out;

	let missing = false;
	const failedRepos = [];

	const jobs = repos.map((repo) => async () => {
		const [owner, name] = repo.split('/');
		const failures = [];
		const note = (label, err) => {
			if (err?.code === 'ENOENT') missing = true;
			failures.push(`${label} (${reason(err)})`);
			return null;
		};
		const data = {
			issues: null,
			openPrs: null,
			mergedPrs: null,
			pushRuns: null,
			scheduleRuns: null,
		};
		const warnTruncated = [];

		const readRepo = async () => {
			try {
				const repository = await graphql(
					ghFn,
					repoQuery({
						owner,
						name,
						wanted: [...new Set(wanted[repo] ?? [])].sort((a, b) => a - b),
						sinceIso: since.toISOString(),
					}),
				);
				const issues = new Map();
				const add = (node) => node && issues.set(node.number, toIssue(node));
				for (const node of repository.openIssues.nodes) add(node);
				for (const node of repository.closedIssues.nodes) add(node);
				for (const [key, node] of Object.entries(repository)) {
					if (/^i\d+$/.test(key)) add(node);
				}
				let page = repository.openIssues.pageInfo;
				for (let n = 1; page?.hasNextPage && n < MAX_OPEN_ISSUE_PAGES; n++) {
					const more = await graphql(
						ghFn,
						moreOpenIssuesQuery({ owner, name, after: page.endCursor }),
					);
					for (const node of more.openIssues.nodes) add(node);
					page = more.openIssues.pageInfo;
				}
				if (repository.closedIssues.pageInfo?.hasNextPage) {
					warnTruncated.push('issues closed today');
				}
				data.issues = issues;
				data.openPrs = repository.openPrs.nodes.map((pr) => ({
					...pr,
					closingIssuesReferences: (
						pr.closingIssuesReferences?.nodes ?? []
					).map((r) => ({ number: r.number })),
				}));
				data.mergedPrs = repository.mergedPrs.nodes;
			} catch (err) {
				note('issues and PRs', err);
			}
		};
		const readRuns = async (event, limit, key, label) => {
			try {
				data[key] = JSON.parse(
					await ghFn([
						'run',
						'list',
						'--repo',
						repo,
						'--event',
						event,
						'--limit',
						String(limit),
						'--json',
						RUN_FIELDS,
					]),
				);
			} catch (err) {
				note(label, err);
			}
		};
		await Promise.all([
			readRepo(),
			readRuns('push', 40, 'pushRuns', 'push runs'),
			readRuns('schedule', 20, 'scheduleRuns', 'scheduled runs'),
		]);
		out.repos[repo] = data;
		for (const what of warnTruncated) {
			out.warnings.push(
				`GitHub ${repo}: more ${what} than one page; some may be missing`,
			);
		}
		if (failures.length > 0) failedRepos.push({ repo, failures });
	});

	await pool(jobs, MAX_PARALLEL);

	if (missing) {
		out.available = false;
		out.repos = {};
		out.warnings = ['GitHub sections skipped: the gh command was not found'];
		return out;
	}
	if (failedRepos.length === repos.length) {
		out.warnings.push(
			`GitHub could not be read for any repo (offline or not signed in?): ${reason(failedRepos[0].failures[0])}`,
		);
	} else {
		for (const { repo, failures } of failedRepos.sort((x, y) =>
			x.repo.localeCompare(y.repo),
		)) {
			out.warnings.push(`GitHub ${repo}: not read: ${failures.join('; ')}`);
		}
	}
	return out;
}

/**
 * Issue numbers a PR will close: GitHub's own link list plus the usual
 * closing words in the description (a PR into a non-default branch has no link
 * list).
 */
export function closingIssueNumbers(pr) {
	const numbers = new Set();
	for (const ref of pr.closingIssuesReferences ?? []) {
		if (Number.isInteger(ref?.number)) numbers.add(ref.number);
	}
	const body = String(pr.body ?? '');
	for (const m of body.matchAll(
		/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi,
	)) {
		numbers.add(parseInt(m[1], 10));
	}
	return [...numbers].sort((a, b) => a - b);
}

/**
 * Latest finished run per workflow on each long-lived branch.
 *
 * @param {object[]} runs      `gh run list` rows, newest first
 * @param {string[]} branches
 */
export function latestBranchRuns(runs, branches) {
	const seen = new Set();
	const rows = [];
	for (const run of [...runs].sort((a, b) =>
		String(b.createdAt).localeCompare(String(a.createdAt)),
	)) {
		if (run.status !== 'completed') continue;
		if (!branches.includes(run.headBranch)) continue;
		const key = `${run.headBranch}\u0000${run.workflowName}`;
		if (seen.has(key)) continue;
		seen.add(key);
		rows.push({
			branch: run.headBranch,
			workflow: run.workflowName,
			conclusion: run.conclusion,
			failing: FAILING_CONCLUSIONS.includes(run.conclusion),
			at: run.createdAt,
			url: run.url,
		});
	}
	return rows.sort(
		(a, b) =>
			a.branch.localeCompare(b.branch) || a.workflow.localeCompare(b.workflow),
	);
}

/** Latest finished run of each scheduled workflow. */
export function latestScheduledRuns(runs) {
	const seen = new Set();
	const rows = [];
	for (const run of [...runs].sort((a, b) =>
		String(b.createdAt).localeCompare(String(a.createdAt)),
	)) {
		if (run.status !== 'completed') continue;
		if (seen.has(run.workflowName)) continue;
		seen.add(run.workflowName);
		rows.push({
			workflow: run.workflowName,
			conclusion: run.conclusion,
			failing: FAILING_CONCLUSIONS.includes(run.conclusion),
			at: run.createdAt,
			url: run.url,
		});
	}
	return rows.sort((a, b) => a.workflow.localeCompare(b.workflow));
}
