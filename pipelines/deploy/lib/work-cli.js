/**
 * work-cli.js — one root folder for Builder worktrees and Tester clones.
 *
 * Builder and Tester used to put their working copies wherever the dispatch
 * text said, so they ended up in unrelated folders. This command computes the
 * path instead of anyone typing it:
 *
 *   <root>/<project>/b-<ticket>   Builder worktree (git worktree)
 *   <root>/<project>/q-<ticket>   Tester clone (git clone --local)
 *
 * Commands (`npm run work -- ...`):
 *   new <project> <ticket> builder|tester [--branch <b>] [--base <ref>] [--ref <r>]
 *   list [--json] [--no-pr]
 *   clean --merged [--yes]       dry run unless --yes; --yes is the team lead's approval
 *   root                         print the resolved root
 *
 * Configuration lives in the hub's local workspace.config.json:
 *   workspaces.root          absolute folder; default is `Agistra.dev-worktrees`
 *                            next to the hub's parent folder
 *   workspaces.maxSizeMb     optional; doctor warns when the root is bigger
 *   workspaces.staleDays     optional; doctor warns about entries idle this long (default 14)
 *   projects.<name>.repoPath the source repository (already used by scan and graph)
 *   projects.<name>.defaultBranch  optional; detected from origin/HEAD otherwise
 *
 * One registry file (`work-registry.json`) sits at the root, so two hubs that
 * share a root cannot claim the same path. Agents run `new` and `list`. Only
 * the team lead runs `clean --yes`: agents never remove worktrees.
 *
 * Output is JSON on stdout for `new` and `root`, a table for `list` and
 * `clean`. Exit 0 on success, 1 on a refusal or error.
 */
import { installCrashReporter } from './error-sources.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HUB_ROOT = path.resolve(__dirname, '..', '..', '..');

export const ROOT_FOLDER_NAME = 'Agistra.dev-worktrees';
export const REGISTRY_FILE = 'work-registry.json';
export const ROLE_PREFIX = { builder: 'b', tester: 'q' };
export const DEFAULT_STALE_DAYS = 14;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PATH_LENGTH_WARN = 240;
const LONGEST_RELATIVE_PATH_ALLOWANCE = 120;

// ── small helpers ───────────────────────────────────────────────────────────

function foldCase(p) {
	return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Real path of `p`: links, junctions, `subst` drives and Windows 8.3 short
 * names resolved. A path that is gone from disk (a prunable worktree) keeps
 * its missing tail and has its nearest existing ancestor resolved, so it
 * still compares correctly against paths git reports.
 */
function realPathOf(p) {
	const resolved = path.resolve(p);
	const missing = [];
	let existing = resolved;
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(existing), ...missing);
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return resolved;
			missing.unshift(path.basename(existing));
			existing = parent;
		}
	}
}

/**
 * Normalise a path for equality and containment checks: real path, then
 * case-blind on Windows. Git reports real paths, so a root reached through a
 * short name, junction or symlink must be resolved before comparing.
 */
export function normalisePath(p) {
	return foldCase(realPathOf(p));
}

/** True when `child` is `parent` or sits somewhere below it. */
export function isInside(parent, child) {
	const rel = path.relative(normalisePath(parent), normalisePath(child));
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sameVolume(a, b) {
	if (process.platform === 'win32') {
		return foldCase(path.parse(path.resolve(a)).root) ===
			foldCase(path.parse(path.resolve(b)).root)
			? true
			: false;
	}
	const nearest = (p) => {
		let dir = path.resolve(p);
		while (!fs.existsSync(dir)) dir = path.dirname(dir);
		return fs.statSync(dir).dev;
	};
	return nearest(a) === nearest(b);
}

function validateName(value, label) {
	if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
		throw new WorkError(
			`${label} "${value ?? ''}" is not usable as a folder name: use letters, digits, ".", "_" or "-", starting with a letter or digit`,
		);
	}
}

export class WorkError extends Error {}

// ── git and gh, replaceable in tests ────────────────────────────────────────

function runProcess(cmd, args, cwd) {
	const r = spawnSync(cmd, args, {
		cwd,
		encoding: 'utf-8',
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024,
	});
	return {
		ok: r.status === 0 && !r.error,
		stdout: (r.stdout ?? '').trim(),
		stderr: ((r.stderr ?? '') + (r.error ? String(r.error) : '')).trim(),
	};
}

export const defaultDeps = {
	git: (args, cwd) => runProcess('git', args, cwd),
	gh: (args, cwd) => runProcess('gh', args, cwd),
	now: () => new Date(),
};

// ── configuration and paths ─────────────────────────────────────────────────

export function readConfig(hubRoot) {
	const file = path.join(hubRoot, 'workspace.config.json');
	if (!fs.existsSync(file)) return {};
	try {
		return JSON.parse(fs.readFileSync(file, 'utf-8'));
	} catch (err) {
		throw new WorkError(`could not read ${file}: ${err.message}`);
	}
}

/**
 * The root folder. `workspaces.root` wins; otherwise a folder next to the
 * hub's parent folder (a hub at `<dev>/<hub>` gives `<dev>/Agistra.dev-worktrees`).
 * Hubs live in different places, so set `workspaces.root` once per machine
 * when the default is not what you want.
 */
export function resolveRoot(hubRoot, config) {
	const configured = config?.workspaces?.root;
	let root;
	let source;
	if (typeof configured === 'string' && configured.trim() !== '') {
		root = path.resolve(configured);
		source = 'workspaces.root';
	} else {
		root = path.join(path.dirname(path.resolve(hubRoot)), ROOT_FOLDER_NAME);
		source = 'default (next to the hub folder)';
	}
	if (isInside(hubRoot, root)) {
		throw new WorkError(
			`the workspaces root ${root} is inside the hub folder ${hubRoot}; hub tools would scan it. Set workspaces.root to a folder outside the hub`,
		);
	}
	return { root, source };
}

/** `<root>/<project>/<b|q>-<ticket>` */
export function computePath(root, project, ticket, role) {
	validateName(project, 'project');
	validateName(String(ticket), 'ticket');
	const prefix = ROLE_PREFIX[role];
	if (!prefix) {
		throw new WorkError(`role must be builder or tester, got "${role}"`);
	}
	return path.join(root, project, `${prefix}-${ticket}`);
}

export function entryKey(project, role, ticket) {
	return `${project}/${ROLE_PREFIX[role]}-${ticket}`;
}

function projectInfo(config, project, git) {
	const info = config?.projects?.[project];
	if (!info?.repoPath) {
		const known = Object.entries(config?.projects ?? {})
			.filter(([, v]) => v?.repoPath)
			.map(([k]) => k);
		throw new WorkError(
			`unknown project "${project}": projects.${project}.repoPath is not set in workspace.config.json` +
				(known.length ? ` (known: ${known.join(', ')})` : ''),
		);
	}
	const repoPath = path.resolve(info.repoPath);
	if (
		!fs.existsSync(repoPath) ||
		!git(['rev-parse', '--git-dir'], repoPath).ok
	) {
		throw new WorkError(
			`projects.${project}.repoPath is not a git repository: ${repoPath}`,
		);
	}
	return { repoPath, defaultBranch: info.defaultBranch };
}

function detectDefaultBranch(git, repoPath) {
	const head = git(
		['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
		repoPath,
	);
	if (head.ok && head.stdout.startsWith('origin/')) {
		return head.stdout.slice('origin/'.length);
	}
	for (const name of ['develop', 'main', 'master']) {
		if (
			git(
				['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`],
				repoPath,
			).ok ||
			git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], repoPath)
				.ok
		) {
			return name;
		}
	}
	throw new WorkError(
		`could not detect the default branch of ${repoPath}; set projects.<name>.defaultBranch in workspace.config.json`,
	);
}

// ── registry ────────────────────────────────────────────────────────────────

export function readRegistry(root) {
	const file = path.join(root, REGISTRY_FILE);
	if (!fs.existsSync(file)) return { version: 1, entries: [] };
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
		if (!Array.isArray(parsed.entries))
			throw new Error('entries is not a list');
		return parsed;
	} catch (err) {
		throw new WorkError(`could not read the registry ${file}: ${err.message}`);
	}
}

export function writeRegistry(root, registry) {
	fs.mkdirSync(root, { recursive: true });
	const file = path.join(root, REGISTRY_FILE);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
	fs.renameSync(tmp, file);
}

// ── work new ────────────────────────────────────────────────────────────────

function defaultBuilderBranch(ticket) {
	return /^\d+$/.test(String(ticket))
		? `feat/issue-${ticket}`
		: `feat/${ticket}`;
}

/**
 * Create (or find) the working copy for one ticket and role.
 * Idempotent: a second call for the same hub, project, ticket and role reports
 * the existing entry and creates nothing.
 */
export function workNew(opts, deps = defaultDeps) {
	const { hubRoot, project, ticket, role } = opts;
	const config = opts.config ?? readConfig(hubRoot);
	const { root } = resolveRoot(hubRoot, config);
	const target = computePath(root, project, ticket, role);
	const key = entryKey(project, role, ticket);
	const hub = path.resolve(hubRoot);
	const warnings = [];

	const registry = readRegistry(root);
	const owned = registry.entries.find((e) => e.key === key);
	if (owned && normalisePath(owned.hub) !== normalisePath(hub)) {
		throw new WorkError(
			`${target} is owned by another hub (${owned.hub}); refusing to touch it. Pick a different ticket id, or ask the team lead to remove the entry from ${path.join(root, REGISTRY_FILE)}`,
		);
	}
	if (owned && fs.existsSync(target)) {
		return { status: 'existing', ...owned, warnings };
	}
	if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
		throw new WorkError(
			`${target} exists but is not in the registry; refusing to use a folder this command did not create`,
		);
	}

	const { repoPath, defaultBranch: configuredDefault } = projectInfo(
		config,
		project,
		deps.git,
	);
	const defaultBranch =
		configuredDefault ?? detectDefaultBranch(deps.git, repoPath);

	if (target.length + LONGEST_RELATIVE_PATH_ALLOWANCE > PATH_LENGTH_WARN) {
		warnings.push(
			`path is long (${target.length} characters); a deep node_modules path could pass the Windows limit. Use a shorter workspaces.root`,
		);
	}

	const hasOrigin = deps.git(['remote', 'get-url', 'origin'], repoPath);
	if (hasOrigin.ok) {
		const fetched = deps.git(['fetch', 'origin', defaultBranch], repoPath);
		if (!fetched.ok) {
			warnings.push(
				`git fetch origin ${defaultBranch} failed (${fetched.stderr.split('\n')[0]}); using the local copy of the branch`,
			);
		}
	}
	const remoteRef = `origin/${defaultBranch}`;
	const startPoint =
		opts.base ??
		(deps.git(['rev-parse', '--verify', '--quiet', remoteRef], repoPath).ok
			? remoteRef
			: defaultBranch);

	fs.mkdirSync(path.dirname(target), { recursive: true });
	let branch;

	if (role === 'builder') {
		branch = opts.branch ?? defaultBuilderBranch(ticket);
		deps.git(['worktree', 'prune'], repoPath);
		const exists = deps.git(
			['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
			repoPath,
		).ok;
		const args = exists
			? ['worktree', 'add', target, branch]
			: ['worktree', 'add', '--no-track', '-b', branch, target, startPoint];
		const added = deps.git(args, repoPath);
		if (!added.ok) {
			throw new WorkError(`git worktree add failed: ${added.stderr}`);
		}
	} else {
		branch = opts.ref ?? defaultBranch;
		const cloneArgs = ['clone', '--local'];
		if (!sameVolume(repoPath, target)) cloneArgs.push('--no-hardlinks');
		cloneArgs.push(repoPath, target);
		const cloned = deps.git(cloneArgs, undefined);
		if (!cloned.ok) {
			throw new WorkError(`git clone failed: ${cloned.stderr}`);
		}
		// Point the clone at the real remote so the PR branch can be fetched.
		if (hasOrigin.ok) {
			deps.git(['remote', 'set-url', 'origin', hasOrigin.stdout], target);
			const f = deps.git(['fetch', 'origin'], target);
			if (!f.ok) {
				warnings.push(
					`git fetch origin in the clone failed (${f.stderr.split('\n')[0]}); the branch may only exist locally`,
				);
			}
		}
		let checked = deps.git(['checkout', branch], target);
		if (!checked.ok) {
			checked = deps.git(
				['checkout', '-B', branch, `origin/${branch}`],
				target,
			);
		}
		if (!checked.ok) {
			throw new WorkError(
				`created ${target} but could not check out ${branch}: ${checked.stderr}`,
			);
		}
	}

	const entry = {
		key,
		project,
		ticket: String(ticket),
		role,
		branch,
		path: target,
		repoPath,
		hub,
		createdAt: deps.now().toISOString(),
	};
	registry.entries = registry.entries.filter((e) => e.key !== key);
	registry.entries.push(entry);
	writeRegistry(root, registry);
	return { status: 'created', ...entry, warnings };
}

// ── work list ───────────────────────────────────────────────────────────────

function prState(deps, entry) {
	if (!entry.branch) return { state: 'none' };
	const r = deps.gh(
		[
			'pr',
			'list',
			'--head',
			entry.branch,
			'--state',
			'all',
			'--json',
			'number,state,url',
			'--limit',
			'1',
		],
		entry.path,
	);
	if (!r.ok) return { state: 'unknown' };
	try {
		const [pr] = JSON.parse(r.stdout || '[]');
		return pr
			? { state: pr.state, number: pr.number, url: pr.url }
			: { state: 'none' };
	} catch {
		return { state: 'unknown' };
	}
}

/** Newest of the folder's own mtime and its git bookkeeping files. */
export function lastTouched(entryPath) {
	const times = [];
	for (const p of [
		entryPath,
		path.join(entryPath, '.git'),
		path.join(entryPath, '.git', 'index'),
		path.join(entryPath, '.git', 'HEAD'),
	]) {
		try {
			times.push(fs.statSync(p).mtimeMs);
		} catch {
			// not there
		}
	}
	return times.length ? new Date(Math.max(...times)) : null;
}

export function workList(opts, deps = defaultDeps) {
	const { hubRoot } = opts;
	const config = opts.config ?? readConfig(hubRoot);
	const { root } = resolveRoot(hubRoot, config);
	const registry = readRegistry(root);
	const rows = registry.entries.map((entry) => {
		const present = fs.existsSync(entry.path);
		let currentBranch = entry.branch;
		let dirty = null;
		if (present) {
			const b = deps.git(['rev-parse', '--abbrev-ref', 'HEAD'], entry.path);
			if (b.ok) currentBranch = b.stdout;
			const s = deps.git(['status', '--porcelain'], entry.path);
			dirty = s.ok ? s.stdout !== '' : null;
		}
		const pr =
			present && opts.pr !== false
				? prState(deps, { ...entry, branch: currentBranch })
				: { state: present ? 'not checked' : 'none' };
		return {
			...entry,
			branch: currentBranch,
			present,
			dirty,
			pr,
			lastTouched: present
				? (lastTouched(entry.path)?.toISOString() ?? null)
				: null,
		};
	});
	return { root, rows };
}

function formatRows(rows) {
	if (rows.length === 0) return ['(no entries)'];
	const header = ['PROJECT', 'ROLE', 'TICKET', 'BRANCH', 'PR', 'STATE', 'PATH'];
	const lines = rows.map((r) => [
		r.project,
		r.role,
		r.ticket,
		r.branch ?? '',
		r.pr?.number ? `#${r.pr.number} ${r.pr.state}` : (r.pr?.state ?? ''),
		!r.present ? 'missing' : r.dirty ? 'uncommitted changes' : 'clean',
		r.path,
	]);
	const widths = header.map((h, i) =>
		Math.max(h.length, ...lines.map((l) => String(l[i]).length)),
	);
	const fmt = (cols) =>
		cols
			.map((c, i) => String(c).padEnd(widths[i]))
			.join('  ')
			.trimEnd();
	return [fmt(header), ...lines.map(fmt)];
}

// ── work clean ──────────────────────────────────────────────────────────────

export function workClean(opts, deps = defaultDeps) {
	const { hubRoot, confirm } = opts;
	const config = opts.config ?? readConfig(hubRoot);
	const { root } = resolveRoot(hubRoot, config);
	const { rows } = workList({ hubRoot, config, pr: true }, deps);
	const mergedTickets = new Set(
		rows
			.filter((r) => r.pr?.state === 'MERGED')
			.map((r) => `${r.project}/${r.ticket}`),
	);
	const plan = [];
	for (const r of rows) {
		const mine = normalisePath(r.hub) === normalisePath(hubRoot);
		if (!mine) {
			plan.push({
				...r,
				action: 'skip',
				reason: `owned by another hub (${r.hub})`,
			});
		} else if (!r.present) {
			plan.push({
				...r,
				action: 'remove',
				reason: 'folder is gone; drop the registry entry and prune git',
			});
		} else if (
			r.pr?.state === 'MERGED' ||
			mergedTickets.has(`${r.project}/${r.ticket}`)
		) {
			if (r.dirty !== false) {
				plan.push({
					...r,
					action: 'skip',
					reason: r.dirty
						? 'merged, but has uncommitted changes'
						: 'merged, but state could not be read',
				});
			} else if (!isInside(path.join(root, r.project), r.path)) {
				plan.push({ ...r, action: 'skip', reason: 'path is outside the root' });
			} else {
				plan.push({ ...r, action: 'remove', reason: 'pull request merged' });
			}
		}
	}

	const removed = [];
	const failed = [];
	if (confirm) {
		const registry = readRegistry(root);
		for (const item of plan.filter((p) => p.action === 'remove')) {
			let ok = true;
			let error = '';
			if (item.present) {
				if (item.role === 'builder') {
					const r = deps.git(['worktree', 'remove', item.path], item.repoPath);
					ok = r.ok;
					error = r.stderr;
				} else {
					try {
						fs.rmSync(item.path, {
							recursive: true,
							force: true,
							maxRetries: 3,
						});
					} catch (err) {
						ok = false;
						error = err.message;
					}
				}
			}
			if (ok) {
				registry.entries = registry.entries.filter((e) => e.key !== item.key);
				removed.push(item);
			} else {
				failed.push({ ...item, error });
			}
		}
		writeRegistry(root, registry);
		for (const repo of new Set(plan.map((p) => p.repoPath))) {
			deps.git(['worktree', 'prune'], repo);
		}
	}
	return { root, plan, removed, failed, confirmed: Boolean(confirm) };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function takeFlag(args, name) {
	const i = args.indexOf(name);
	if (i === -1) return undefined;
	const value = args[i + 1];
	args.splice(i, 2);
	if (value === undefined) throw new WorkError(`${name} needs a value`);
	return value;
}
function takeSwitch(args, name) {
	const i = args.indexOf(name);
	if (i === -1) return false;
	args.splice(i, 1);
	return true;
}

const USAGE = `Usage:
  npm run work -- new <project> <ticket> builder|tester [--branch <b>] [--base <ref>] [--ref <r>]
  npm run work -- list [--json] [--no-pr]
  npm run work -- clean --merged [--yes]
  npm run work -- root
Add --hub <folder> to use another hub's workspace.config.json.`;

export function runCli(
	argv,
	deps = defaultDeps,
	out = (s) => process.stdout.write(s + '\n'),
) {
	const args = [...argv];
	try {
		const hubRoot = takeFlag(args, '--hub') ?? DEFAULT_HUB_ROOT;
		const command = args.shift();
		if (command === 'new') {
			const branch = takeFlag(args, '--branch');
			const base = takeFlag(args, '--base');
			const ref = takeFlag(args, '--ref');
			const [project, ticket, role] = args;
			if (!project || !ticket || !role || args.length > 3)
				throw new WorkError(USAGE);
			if (!ROLE_PREFIX[role])
				throw new WorkError(`role must be builder or tester, got "${role}"`);
			const result = workNew(
				{ hubRoot, project, ticket, role, branch, base, ref },
				deps,
			);
			out(JSON.stringify(result, null, 2));
			return 0;
		}
		if (command === 'root') {
			const config = readConfig(hubRoot);
			out(JSON.stringify(resolveRoot(hubRoot, config), null, 2));
			return 0;
		}
		if (command === 'list') {
			const json = takeSwitch(args, '--json');
			const pr = !takeSwitch(args, '--no-pr');
			const { root, rows } = workList({ hubRoot, pr }, deps);
			if (json) out(JSON.stringify({ root, rows }, null, 2));
			else {
				out(`Root: ${root}`);
				for (const l of formatRows(rows)) out(l);
			}
			return 0;
		}
		if (command === 'clean') {
			const merged = takeSwitch(args, '--merged');
			const confirm = takeSwitch(args, '--yes');
			if (!merged) throw new WorkError(`clean needs --merged\n${USAGE}`);
			const res = workClean({ hubRoot, confirm }, deps);
			out(`Root: ${res.root}`);
			if (res.plan.length === 0) out('Nothing to clean.');
			for (const p of res.plan) {
				const verb =
					p.action === 'remove'
						? res.confirmed
							? 'REMOVE'
							: 'would remove'
						: 'skip';
				out(
					`${verb}  ${p.project}/${p.role === 'builder' ? 'b' : 'q'}-${p.ticket}  ${p.path}  (${p.reason})`,
				);
			}
			for (const f of res.failed) out(`FAILED  ${f.path}: ${f.error}`);
			if (!res.confirmed) {
				out(
					'Dry run: nothing was removed. The team lead re-runs with --yes to remove the entries marked "would remove".',
				);
			} else {
				out(
					`Removed ${res.removed.length}, failed ${res.failed.length}. Branches are kept.`,
				);
			}
			return res.failed.length ? 1 : 0;
		}
		throw new WorkError(USAGE);
	} catch (err) {
		if (err instanceof WorkError) {
			process.stderr.write(err.message + '\n');
			return 1;
		}
		throw err;
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	installCrashReporter({ source: 'npm-run' });
	process.exitCode = runCli(process.argv.slice(2));
}
