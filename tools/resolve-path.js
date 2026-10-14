#!/usr/bin/env node
/**
 * resolve-path.js — absolute-path resolver for the Memory/Task/Document/
 * Learnings stores defined by the Storage Plugin Contract
 * (agents/skills/agent-foundations/SKILL.md).
 *
 * Usage: node tools/resolve-path.js <store> <arg> [--json]
 *   store: memory | task | document | learnings
 *   arg:   agent id (memory) | project id (task) | collection (document) | store name (learnings)
 *
 * Run from the hub root. Detects the active storage plugin by checking for
 * `skills/agent-foundations/storage/obsidian.md` (vault-backed tiers) vs its
 * absence (repo-files default — the free-tier shape), then maps the store +
 * arg to an absolute path using that plugin's documented folder table. This
 * replaces the by-hand path computation the Memory Path Resolution protocol
 * previously asked every agent to perform inline.
 *
 * Output: one JSON object on stdout, always.
 *   success: { ok: true, store, plugin, path }
 *   failure: { ok: false, code, error }
 * Exit code: 0 on success, 1 on any failure (bad usage, invalid arg, or a
 * plugin file present with an unresolvable vault root).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STORES = ['memory', 'task', 'document', 'learnings'];
const HUB_WIDE_DOC_COLLECTIONS = [
	'decisions',
	'architecture',
	'reports',
	'proposals',
];
const LEARNINGS_STORES = ['LEARNINGS', 'ERRORS', 'FEATURE_REQUESTS'];

function fail(code, error) {
	return { ok: false, code, error };
}

/**
 * Reject names that could escape the hub root (path separators, "..",
 * drive prefixes) or are not plain strings. Shared across every store's
 * `<arg>` — none of them are meant to be anything but a single path
 * segment.
 */
function assertSafeName(label, value) {
	if (typeof value !== 'string' || value.length === 0) {
		return fail('invalid-arg', `${label} is required`);
	}
	if (
		value.includes('/') ||
		value.includes('\\') ||
		value.includes('..') ||
		path.isAbsolute(value)
	) {
		return fail(
			'invalid-arg',
			`${label} ${JSON.stringify(value)} must be a plain name, not a path`,
		);
	}
	return { ok: true };
}

/**
 * Detect the active storage plugin by presence of its file under
 * `skills/agent-foundations/storage/`, per the Memory Path Resolution
 * protocol's own step 1. `obsidian.md` present → vault-backed hub;
 * otherwise (no storage directory, or only `repo-files.md`) → repo-files
 * default, matching every free-tier hub shipping no plugin file at all.
 *
 * @param {string} hubRoot
 * @param {object} fsMod
 * @returns {'obsidian' | 'repo-files'}
 */
export function detectPlugin(hubRoot, fsMod = fs) {
	const obsidianPath = path.join(
		hubRoot,
		'skills',
		'agent-foundations',
		'storage',
		'obsidian.md',
	);
	return fsMod.existsSync(obsidianPath) ? 'obsidian' : 'repo-files';
}

/**
 * Resolve the memory/task root segments via the hub's own
 * `pipelines/deploy/lib/memory-root.js` — the single source of truth for
 * those two segments, already shipped to every deployed hub. A synthetic
 * hubType ('dev:sub' for obsidian, 'dev' for repo-files) selects the
 * correct branch without reading workspace.config.json — detection here is
 * plugin-file-presence based, per the ticket's own resolution rule, not
 * hubType-based.
 *
 * @param {string} hubRoot
 * @returns {Promise<{ resolveMemoryRoot: Function, resolveTasksRoot: Function } | null>}
 */
export async function loadMemoryRootModule(hubRoot) {
	const modPath = path.resolve(hubRoot, 'pipelines/deploy/lib/memory-root.js');
	try {
		return await import(pathToFileURL(modPath).href);
	} catch {
		return null;
	}
}

/**
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {string} options.store
 * @param {string} options.arg
 * @param {object} [options.fsMod]
 * @returns {Promise<{ ok: true, store: string, plugin: string, path: string } | { ok: false, code: string, error: string }>}
 */
export async function resolvePath({ hubRoot, store, arg, fsMod = fs }) {
	if (!STORES.includes(store)) {
		return fail(
			'invalid-store',
			`store must be one of ${STORES.join(', ')}; got ${JSON.stringify(store)}`,
		);
	}

	const plugin = detectPlugin(hubRoot, fsMod);
	const vaultRoot = path.join(hubRoot, 'vault');
	if (plugin === 'obsidian' && !fsMod.existsSync(vaultRoot)) {
		return fail(
			'vault-root-missing',
			`storage plugin "obsidian" is active but ${vaultRoot} does not exist`,
		);
	}

	if (store === 'memory') {
		const safe = assertSafeName('agent id', arg);
		if (!safe.ok) return safe;
		const mod = await loadMemoryRootModule(hubRoot);
		if (!mod)
			return fail(
				'memory-root-unavailable',
				'could not load pipelines/deploy/lib/memory-root.js',
			);
		const root = mod.resolveMemoryRoot(
			hubRoot,
			plugin === 'obsidian' ? 'dev:sub' : 'dev',
		);
		return { ok: true, store, plugin, path: path.join(root, `${arg}.md`) };
	}

	if (store === 'task') {
		const safe = assertSafeName('project id', arg);
		if (!safe.ok) return safe;
		const mod = await loadMemoryRootModule(hubRoot);
		if (!mod)
			return fail(
				'memory-root-unavailable',
				'could not load pipelines/deploy/lib/memory-root.js',
			);
		const root = mod.resolveTasksRoot(
			hubRoot,
			plugin === 'obsidian' ? 'dev:sub' : 'dev',
		);
		return { ok: true, store, plugin, path: path.join(root, arg) };
	}

	if (store === 'document') {
		const safe = assertSafeName('collection', arg);
		if (!safe.ok) return safe;
		if (plugin === 'obsidian') {
			// obsidian.md's Document store section documents only the
			// hub-wide Docs/<collection>/ shape; it carries no
			// project-scoped exception, unlike repo-files.md below.
			return {
				ok: true,
				store,
				plugin,
				path: path.join(hubRoot, 'vault', 'Docs', arg),
			};
		}
		if (HUB_WIDE_DOC_COLLECTIONS.includes(arg)) {
			return { ok: true, store, plugin, path: path.join(hubRoot, 'docs', arg) };
		}
		return {
			ok: true,
			store,
			plugin,
			path: path.join(hubRoot, 'projects', arg, 'docs'),
		};
	}

	// store === 'learnings'
	if (
		typeof arg !== 'string' ||
		!LEARNINGS_STORES.includes(arg.toUpperCase())
	) {
		return fail(
			'invalid-arg',
			`learnings store must be one of ${LEARNINGS_STORES.join(', ')}; got ${JSON.stringify(arg)}`,
		);
	}
	const storeName = arg.toUpperCase();
	if (plugin === 'obsidian') {
		return {
			ok: true,
			store,
			plugin,
			path: path.join(
				hubRoot,
				'vault',
				'Research',
				'Learnings',
				`${storeName}.md`,
			),
		};
	}
	return {
		ok: true,
		store,
		plugin,
		path: path.join(hubRoot, '.learnings', `${storeName}.md`),
	};
}

async function main() {
	const args = process.argv.slice(2);
	const [store, arg] = args;
	if (!store || !arg) {
		process.stderr.write(
			'Usage: node tools/resolve-path.js <memory|task|document|learnings> <arg> [--json]\n',
		);
		process.exit(1);
		return;
	}

	const result = await resolvePath({ hubRoot: process.cwd(), store, arg });
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exit(result.ok ? 0 : 1);
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	main();
}
