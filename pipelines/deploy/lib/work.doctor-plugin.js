/**
 * Doctor plugin: agent workspaces (check 35).
 *
 * Discovered generically by doctor.js's checkOptionalTierReadiness() using the
 * "*.doctor-plugin.js" filename convention. Shipped to every tier, next to
 * lib/work-cli.js, which owns the root, registry and path rules.
 *
 * Read-only. Warns (never fails) about:
 *   - a registered project's git worktree that sits outside the workspaces root
 *   - a root bigger than workspaces.maxSizeMb (only checked when that is set)
 *   - a registered entry untouched for workspaces.staleDays (default 14)
 */
import fs from 'node:fs';
import path from 'node:path';
import {
	DEFAULT_STALE_DAYS,
	defaultDeps,
	isInside,
	lastTouched,
	readConfig,
	readRegistry,
	resolveRoot,
} from './work-cli.js';

const CHECK_ID = 35;
const CHECK_LABEL = 'agent workspaces';
const SHOW = 3;

/** Worktree folders of `repoPath`, main checkout first. Empty when git fails. */
function listWorktrees(git, repoPath) {
	const r = git(['worktree', 'list', '--porcelain'], repoPath);
	if (!r.ok) return [];
	return r.stdout
		.split(/\r?\n\r?\n/)
		.map((block) => {
			const wt = /^worktree (.+)$/m.exec(block);
			return wt ? { path: wt[1], prunable: /^prunable/m.test(block) } : null;
		})
		.filter(Boolean);
}

function dirSizeBytes(dir) {
	let total = 0;
	const stack = [dir];
	while (stack.length) {
		const current = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const full = path.join(current, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile()) {
				try {
					total += fs.statSync(full).size;
				} catch {
					// vanished while walking
				}
			}
		}
	}
	return total;
}

function summarise(items) {
	const shown = items.slice(0, SHOW).join('; ');
	return items.length > SHOW
		? `${shown}; and ${items.length - SHOW} more`
		: shown;
}

export async function check({
	hubRoot,
	fsMod,
	readHubConfig,
	pass,
	warn,
	skip,
	workGit,
	workNow,
}) {
	const { skipReason } = readHubConfig(hubRoot, fsMod);
	if (skipReason) return skip(CHECK_ID, CHECK_LABEL, skipReason);

	let config;
	let root;
	try {
		config = readConfig(hubRoot);
		({ root } = resolveRoot(hubRoot, config));
	} catch (err) {
		return warn(
			CHECK_ID,
			CHECK_LABEL,
			err.message,
			'set workspaces.root in workspace.config.json to a folder outside the hub',
		);
	}
	const git = workGit ?? defaultDeps.git;
	const now = (workNow ?? defaultDeps.now)();
	const problems = [];

	for (const [name, info] of Object.entries(config.projects ?? {})) {
		if (!info?.repoPath || !fs.existsSync(info.repoPath)) continue;
		const [, ...others] = listWorktrees(git, path.resolve(info.repoPath));
		const outside = others.filter((w) => !isInside(root, w.path));
		if (outside.length > 0) {
			const stale = outside.filter((w) => w.prunable).length;
			problems.push(
				`${name}: ${outside.length} worktree(s) outside ${root}${stale ? ` (${stale} already gone from disk)` : ''}, e.g. ${summarise(outside.map((w) => w.path))}`,
			);
		}
	}

	let entries = [];
	try {
		entries = readRegistry(root).entries;
	} catch (err) {
		problems.push(err.message);
	}
	const staleDays =
		Number(config.workspaces?.staleDays) > 0
			? Number(config.workspaces.staleDays)
			: DEFAULT_STALE_DAYS;
	const idle = entries
		.map((e) => ({
			e,
			touched: fs.existsSync(e.path) ? lastTouched(e.path) : null,
		}))
		.filter(
			({ touched }) => touched && (now - touched) / 86_400_000 >= staleDays,
		)
		.map(
			({ e, touched }) =>
				`${e.key} (${Math.floor((now - touched) / 86_400_000)} days)`,
		);
	if (idle.length > 0) {
		problems.push(
			`${idle.length} workspace(s) untouched for ${staleDays}+ days: ${summarise(idle)}`,
		);
	}

	const maxMb = Number(config.workspaces?.maxSizeMb);
	if (maxMb > 0 && fs.existsSync(root)) {
		const mb = Math.round(dirSizeBytes(root) / 1_048_576);
		if (mb > maxMb)
			problems.push(
				`${root} is ${mb} MB, over workspaces.maxSizeMb (${maxMb})`,
			);
	}

	if (problems.length > 0) {
		return warn(
			CHECK_ID,
			CHECK_LABEL,
			problems.join('. '),
			'create new working copies with npm run work -- new; npm run work -- list shows them, and the team lead removes merged ones with npm run work -- clean --merged',
		);
	}
	return pass(
		CHECK_ID,
		CHECK_LABEL,
		`root ${root}, ${entries.length} workspace(s), none outside it`,
	);
}
