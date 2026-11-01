/**
 * vault-layout.js — single source of truth for the on-disk layout of a hub's
 * vault: which top-level folders exist, and where a project's tasks, docs,
 * decision logs and ADRs live.
 *
 * Vault-backed hubs (VAULT_BACKED_HUB_TYPES) use the per-project layout:
 *
 *   vault/Projects/<project>/<project>.md      hub note
 *   vault/Projects/<project>/Tasks/            task_*.md, done/, dropped/
 *   vault/Projects/<project>/Docs/             docs, reports, drafts
 *   vault/Projects/<project>/Docs/decisions/   working decision logs
 *   vault/Projects/<project>/ADRs/             final ADRs
 *   vault/Workspace/{ADRs,Learnings,reports}   cross-project material
 *   vault/{Memory,Agistra,Templates}
 *
 * Hubs that are not vault-backed have no vault and keep the plain repo
 * `projects/` folder (unrelated to the vault's `Projects/`). There is no
 * config switch: run-time code knows only this layout. The earlier
 * type-split layout (top-level Tasks, Docs, Drafts, Research) is recognised
 * only so that a leftover one can be reported (see legacyVaultFolders).
 *
 * Nothing else should spell out `Tasks`, `Docs`, `Drafts`, `Research` or
 * `Learnings` for the vault: ask this module.
 *
 * Pure: depends only on node:fs and node:path (fs is injectable) so it ships
 * unchanged to every hub tier.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Hub tiers whose canonical memory record lives in the vault, not plain repo files. */
export const VAULT_BACKED_HUB_TYPES = ['dev:sub', 'ops'];

export function isVaultBackedHubType(hubType) {
	return VAULT_BACKED_HUB_TYPES.includes(hubType);
}

export const LAYOUT_PROJECTS = 'projects';
export const LAYOUT_NONE = 'none';

/** Vault folder, relative to the hub root. */
export const VAULT_DIR = 'vault';

/** Plain repo-files tasks folder used by hubs that are not vault-backed. */
export const REPO_PROJECTS_DIR = 'projects';

/** Folder names. Only this module spells these out. */
const PROJECTS_ROOT = 'Projects';
const WORKSPACE_ROOT = 'Workspace';
const PROJECT_TASKS = 'Tasks';
const PROJECT_DOCS = 'Docs';
const PROJECT_DECISIONS = 'decisions';
const PROJECT_ADRS = 'ADRs';
const WORKSPACE_ADRS = 'ADRs';
const WORKSPACE_LEARNINGS = 'Learnings';
const WORKSPACE_REPORTS = 'reports';

/** Vault folders outside Projects and Workspace. */
const COMMON_FOLDERS = ['Agistra', 'Memory', 'Templates'];

/**
 * Folder names of the earlier type-split layout. Only the migration code
 * (which reads them) and legacyVaultFolders (which reports them) use these.
 */
export const LEGACY_TASKS_FOLDER = 'Tasks';
export const LEGACY_DOCS_FOLDER = 'Docs';
export const LEGACY_DRAFTS_FOLDER = 'Drafts';
export const LEGACY_RESEARCH_FOLDER = 'Research';
export const LEGACY_VAULT_FOLDERS = [
	LEGACY_TASKS_FOLDER,
	LEGACY_DOCS_FOLDER,
	LEGACY_DRAFTS_FOLDER,
	LEGACY_RESEARCH_FOLDER,
];

/** Sub-folder names inside the earlier layout's top-level folders. */
export const LEGACY_PROJECT_DOCS_DIR = 'docs';
export const LEGACY_DECISIONS_DIR = 'decisions';
export const LEGACY_REPORTS_DIR = 'reports';
export const LEGACY_LEARNINGS_DIR = 'Learnings';

/** Top-level folder names, exported for callers that must recognise them. */
export const PROJECTS_ROOT_FOLDER = PROJECTS_ROOT;
export const WORKSPACE_ROOT_FOLDER = WORKSPACE_ROOT;
export const PROJECT_TASKS_FOLDER = PROJECT_TASKS;
export const PROJECT_ADRS_FOLDER = PROJECT_ADRS;
export const WORKSPACE_ADRS_FOLDER = WORKSPACE_ADRS;

// ── Layout resolution ────────────────────────────────────────────────────────

/**
 * The layout a hub tier uses: `projects` for a vault-backed tier, `none` for
 * every other (including unset or unrecognised) tier.
 *
 * @param {string|null|undefined} hubType
 * @returns {'projects'|'none'}
 */
export function resolveVaultLayout(hubType) {
	return isVaultBackedHubType(hubType) ? LAYOUT_PROJECTS : LAYOUT_NONE;
}

/**
 * Read a hub's workspace.config.json and resolve its layout. A missing or
 * unreadable config resolves like a hub with no hubType (layout `none`).
 *
 * @param {string} hubRoot
 * @param {object} [opts]
 * @param {object} [opts.fsMod]
 * @returns {'projects'|'none'}
 */
export function resolveVaultLayoutForHub(hubRoot, { fsMod = fs } = {}) {
	let config;
	try {
		config = JSON.parse(
			fsMod.readFileSync(path.join(hubRoot, 'workspace.config.json'), 'utf-8'),
		);
	} catch {
		config = null;
	}
	return resolveVaultLayout(config?.hubType);
}

/**
 * Leftover top-level folders of the earlier layout present under a vault.
 *
 * @param {string} vaultRoot
 * @param {object} [fsMod]
 * @returns {string[]}
 */
export function legacyVaultFolders(vaultRoot, fsMod = fs) {
	return LEGACY_VAULT_FOLDERS.filter((name) => {
		try {
			return fsMod.statSync(path.join(vaultRoot, name)).isDirectory();
		} catch {
			return false;
		}
	});
}

// ── Folder tables ────────────────────────────────────────────────────────────

/**
 * Top-level vault folders the index, search and write guard care about.
 * Empty for a hub with no vault.
 *
 * @param {'projects'|'none'} layout
 * @returns {string[]}
 */
export function vaultTopLevelFolders(layout) {
	return layout === LAYOUT_PROJECTS
		? [PROJECTS_ROOT, WORKSPACE_ROOT, ...COMMON_FOLDERS].sort()
		: [];
}

/**
 * Vault-relative folders to create when scaffolding a fresh vault, deepest
 * form (a parent is implied by its children). Empty for a hub with no vault.
 * `Agistra/` is not listed: deploy writes it separately and agents never
 * write there.
 *
 * @param {'projects'|'none'} layout
 * @returns {string[]}
 */
export function vaultScaffoldFolders(layout) {
	if (layout !== LAYOUT_PROJECTS) return [];
	return [
		PROJECTS_ROOT,
		path.join(WORKSPACE_ROOT, WORKSPACE_ADRS),
		path.join(WORKSPACE_ROOT, WORKSPACE_LEARNINGS),
		path.join(WORKSPACE_ROOT, WORKSPACE_REPORTS),
		'Memory',
		'Templates',
	];
}

/**
 * Top-level vault folders agents may write to (the obsidian write guard's
 * allow-list). `Agistra/` is deliberately absent: it is Agistra-maintained
 * and refreshed on every deploy.
 *
 * @param {'projects'|'none'} layout
 * @returns {string[]}
 */
export function vaultWritePaths(layout) {
	return layout === LAYOUT_PROJECTS
		? [PROJECTS_ROOT, WORKSPACE_ROOT, 'Memory', 'Templates']
		: [];
}

/**
 * Top-level vault folders the default working-knowledge search covers.
 * `Memory/` has its own collection and `Templates/` is not knowledge.
 * Drafts and decision logs live inside these (under each project's `Docs/`),
 * so they are searched too.
 *
 * @param {'projects'|'none'} layout
 * @returns {string[]}
 */
export function vaultSearchRoots(layout) {
	return layout === LAYOUT_PROJECTS ? [PROJECTS_ROOT, WORKSPACE_ROOT] : [];
}

/**
 * Tasks-root path segment relative to the hub root (OS-native separators).
 * This is the folder whose children are projects.
 *
 * @param {'projects'|'none'} layout
 * @returns {string}
 */
export function tasksRootSegment(layout) {
	return layout === LAYOUT_PROJECTS
		? path.join(VAULT_DIR, PROJECTS_ROOT)
		: REPO_PROJECTS_DIR;
}

/**
 * Vault-relative folder for one project's material, or null when the layout
 * has no vault.
 *
 * @param {'projects'|'none'} layout
 * @param {string} project
 * @param {'dir'|'tasks'|'docs'|'decisions'|'adrs'} kind
 * @returns {string|null}  path relative to the vault root
 */
export function projectFolderRel(layout, project, kind) {
	if (layout !== LAYOUT_PROJECTS) return null;
	const dir = path.join(PROJECTS_ROOT, project);
	switch (kind) {
		case 'dir':
			return dir;
		case 'tasks':
			return path.join(dir, PROJECT_TASKS);
		case 'docs':
			return path.join(dir, PROJECT_DOCS);
		case 'decisions':
			return path.join(dir, PROJECT_DOCS, PROJECT_DECISIONS);
		case 'adrs':
			return path.join(dir, PROJECT_ADRS);
		default:
			return null;
	}
}

/** Vault-relative path of a project's hub note, or null when no vault. */
export function projectHubNoteRel(layout, project) {
	const dir = projectFolderRel(layout, project, 'dir');
	return dir ? path.join(dir, `${project}.md`) : null;
}

/**
 * Vault-relative cross-project folder, or null when the layout has none.
 *
 * @param {'projects'|'none'} layout
 * @param {'root'|'adrs'|'learnings'|'reports'} kind
 */
export function workspaceFolderRel(layout, kind) {
	if (layout !== LAYOUT_PROJECTS) return null;
	switch (kind) {
		case 'root':
			return WORKSPACE_ROOT;
		case 'adrs':
			return path.join(WORKSPACE_ROOT, WORKSPACE_ADRS);
		case 'learnings':
			return path.join(WORKSPACE_ROOT, WORKSPACE_LEARNINGS);
		case 'reports':
			return path.join(WORKSPACE_ROOT, WORKSPACE_REPORTS);
		default:
			return null;
	}
}

// ── Absolute paths ───────────────────────────────────────────────────────────

/** Absolute vault root for a hub. */
export function vaultRootFor(hubRoot) {
	return path.join(hubRoot, VAULT_DIR);
}

/**
 * Absolute paths of one project's folders. A key is null where the layout has
 * no such folder.
 *
 * @param {string} hubRoot
 * @param {'projects'|'none'} layout
 * @param {string} project
 */
export function projectPaths(hubRoot, layout, project) {
	const vault = vaultRootFor(hubRoot);
	const abs = (rel) => (rel ? path.join(vault, rel) : null);
	return {
		dir: abs(projectFolderRel(layout, project, 'dir')),
		tasks: abs(projectFolderRel(layout, project, 'tasks')),
		docs: abs(projectFolderRel(layout, project, 'docs')),
		decisions: abs(projectFolderRel(layout, project, 'decisions')),
		adrs: abs(projectFolderRel(layout, project, 'adrs')),
		hubNote: abs(projectHubNoteRel(layout, project)),
	};
}

/** Absolute paths of the cross-project folders (null keys where absent). */
export function workspacePaths(hubRoot, layout) {
	const vault = vaultRootFor(hubRoot);
	const abs = (rel) => (rel ? path.join(vault, rel) : null);
	return {
		root: abs(workspaceFolderRel(layout, 'root')),
		adrs: abs(workspaceFolderRel(layout, 'adrs')),
		learnings: abs(workspaceFolderRel(layout, 'learnings')),
		reports: abs(workspaceFolderRel(layout, 'reports')),
	};
}

/**
 * Names of the project folders under a tasks root (one directory per
 * project; dot-directories are skipped). Sorted.
 *
 * @param {string} projectsRoot  absolute tasks root
 * @param {object} [fsMod]
 * @returns {string[]}
 */
export function listProjectFolders(projectsRoot, fsMod = fs) {
	let entries;
	try {
		entries = fsMod.readdirSync(projectsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
		.map((e) => e.name)
		.sort();
}

// ── Tasks-root shape detection ───────────────────────────────────────────────
//
// Task code receives a "projects root" (the folder whose children are
// projects) and derives per-project folders from it. In the projects layout a
// project's task files sit one level deeper, so those helpers need to tell the
// two shapes apart. The projects-layout root is always `<hub>/vault/Projects`.

/** True when `root` is the projects-layout tasks root (`.../vault/Projects`). */
export function isProjectsLayoutRoot(root) {
	if (typeof root !== 'string' || root.length === 0) return false;
	const resolved = path.resolve(root);
	return (
		path.basename(resolved) === PROJECTS_ROOT &&
		path.basename(path.dirname(resolved)) === VAULT_DIR
	);
}

/**
 * Folder that holds a project's `task_*.md` files (and its `done/` and
 * `dropped/` subfolders), given the tasks root.
 */
export function projectTaskDir(projectsRoot, project) {
	return isProjectsLayoutRoot(projectsRoot)
		? path.join(projectsRoot, project, PROJECT_TASKS)
		: path.join(projectsRoot, project);
}

/**
 * Describe a task folder (the folder holding `task_*.md`): its project name
 * and the folder that holds the project's hub note.
 *
 * @param {string} taskDir
 * @returns {{ project: string, noteDir: string }}
 */
export function taskDirContext(taskDir) {
	const parent = path.dirname(taskDir);
	if (
		path.basename(taskDir) === PROJECT_TASKS &&
		isProjectsLayoutRoot(path.dirname(parent))
	) {
		return { project: path.basename(parent), noteDir: parent };
	}
	return { project: path.basename(taskDir), noteDir: taskDir };
}
