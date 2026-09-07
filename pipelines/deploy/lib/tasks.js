import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical set of task state tokens (ticket-lifecycle-mode State Vocabulary).
 * Used in filename patterns and state validation across CLI tools.
 */
export const TASK_STATE_TOKENS = [
	'todo',
	'in-progress',
	'ready-for-review',
	'ready-for-qa',
	'changes-requested',
	'qa-passed',
	'done',
];

function taskNum(filename) {
	const m = filename.match(/^task_(\d+)_/);
	return m ? parseInt(m[1], 10) : 0;
}

function listMdFiles(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter(f => f.endsWith('.md'));
}

/** Project root for a task file (handles tasks already under projects/<name>/done/). */
export function projectDirFromTaskPath(taskPath) {
	const dir = path.dirname(taskPath);
	return path.basename(dir) === 'done' ? path.dirname(dir) : dir;
}

export function doneTasksDir(projectDir) {
	return path.join(projectDir, 'done');
}

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Supports scalar string values and simple string arrays (  - item).
 * Returns { meta: object, body: string, hadFrontmatter: boolean }.
 *
 * `hadFrontmatter: false` signals a legacy task file with no `---...---`
 * YAML block — the entire original content came back as `body`. Callers
 * that write a fresh YAML `status:` frontmatter block onto such a file
 * (`changeTaskStatus`, `updateTaskFields`) use this flag to strip the
 * stale `**State:**` bold-text line from `body` so the rewritten file
 * has a single source of truth for state, not a duplicate contradictory field.
 */
export function parseFrontmatter(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return { meta: {}, body: content, hadFrontmatter: false };

	const meta = {};
	const lines = match[1].split(/\r?\n/);
	let currentArrayKey = null;

	for (const line of lines) {
		const arrayItem = line.match(/^\s{2,}- (.+)$/);
		const arrayStart = line.match(/^([\w-]+):\s*$/);
		const keyValue = line.match(/^([\w-]+):\s+(.+)$/);

		if (currentArrayKey && arrayItem) {
			meta[currentArrayKey].push(arrayItem[1].trim());
		} else if (arrayStart) {
			currentArrayKey = arrayStart[1];
			meta[currentArrayKey] = [];
		} else if (keyValue) {
			currentArrayKey = null;
			meta[keyValue[1]] = keyValue[2].trim();
		}
	}

	return { meta, body: match[2], hadFrontmatter: true };
}

/**
 * Strip a legacy `**State:** <value>` bold-text line from a task file body.
 * Only ever called for the no-frontmatter case — i.e. when the body about
 * to be rewritten under a fresh YAML frontmatter block is the *entire*
 * original legacy-format file content. Matches and removes only the first
 * `**State:** ...` line; no other legacy bold-text field (`**Verifier:**`,
 * `**Repo:**`, `**GitHub:**`, etc.) is touched.
 */
function stripLegacyStateLine(body) {
	return body.replace(/^\*\*State:\*\*[ \t]*.*\r?\n?/m, '');
}

/**
 * Find the lowest-numbered _todo task file in a project directory.
 * Returns the absolute file path, or null if none found.
 */
export function findCurrentTask(projectDir) {
	if (!fs.existsSync(projectDir)) return null;
	const files = fs.readdirSync(projectDir)
		.filter(f => f.match(/^task_\d+_todo_/))
		.sort((a, b) => taskNum(a) - taskNum(b));
	return files.length > 0 ? path.join(projectDir, files[0]) : null;
}

/**
 * List all project directories under projectsRoot with their pending/completed task counts.
 * Returns an array of { project, projectDir, todos: string[], inFlight: Array<{file, state}>, dones: string[] }
 *
 * - todos: files in todo state only (auto-dispatchable)
 * - inFlight: files in intermediate states (in-progress, ready-for-review, ready-for-qa, changes-requested, qa-passed) with state token
 * - dones: files in done state (terminal)
 *
 * Shape-agnostic per file: a repo-files-shaped file (state-token
 * filename infix present) is classified from that infix, unchanged from
 * before. A vault-shaped file (no infix -- `task_<id>_<slug>.md`) is
 * classified from its `status:` frontmatter via the same status->bucket
 * mapping `changeTaskStatus`'s `stateToToken` already encodes, so vault-tier
 * projects are never left entirely uncategorized.
 */
export function listAllTasks(projectsRoot) {
	if (!fs.existsSync(projectsRoot)) return [];
	return fs.readdirSync(projectsRoot, { withFileTypes: true })
		.filter(e => e.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(e => {
			const projectDir = path.join(projectsRoot, e.name);
			const doneDir = doneTasksDir(projectDir);
			const rootFiles = listMdFiles(projectDir).filter(f => f.match(/^task_\d+_.+$/));
			const doneFiles = listMdFiles(doneDir).filter(f => f.match(/^task_\d+_.+$/));

			const todos = [];
			const dones = [];
			const inFlight = [];

			const classify = (file, dir) => {
				let token = hasStateTokenInfix(file) ? filenameInfix(file) : null;
				if (!token) {
					// Vault-shaped (no valid infix): derive the bucket token from the
					// `status:` frontmatter field instead. An unrecognized/malformed
					// status leaves the file uncategorized (consistent with the
					// existing repo-files behavior of ignoring non-matching filenames).
					try {
						const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
						const { meta } = parseFrontmatter(raw);
						token = stateToToken(meta.status);
					} catch {
						return;
					}
				}
				if (token === 'todo') {
					todos.push(file);
				} else if (token === 'done') {
					dones.push(file);
				} else {
					inFlight.push({ file, state: token });
				}
			};

			for (const file of rootFiles) classify(file, projectDir);
			for (const file of doneFiles) classify(file, doneDir);

			todos.sort((a, b) => taskNum(a) - taskNum(b));
			dones.sort((a, b) => taskNum(a) - taskNum(b));
			inFlight.sort((a, b) => taskNum(a.file) - taskNum(b.file));

			return {
				project: e.name,
				projectDir,
				todos,
				inFlight,
				dones,
			};
		});
}

/**
 * Find a specific task by number or slug.
 * Matches both repo-files-shaped filenames (any state-token infix -- todo,
 * in-progress, ready-for-review, ready-for-qa, changes-requested, qa-passed,
 * done) and vault-shaped filenames with no infix at all
 * (`task_<id>_<slug>.md`). e.g. query "6" matches
 * "task_6_in-progress_feature.md" as well as a vault-shaped
 * "task_6_feature.md".
 * Returns the absolute file path, or null if not found.
 */
export function findTaskByQuery(projectDir, query) {
	if (!fs.existsSync(projectDir)) return null;
	const files = fs.readdirSync(projectDir)
		.filter(f => f.match(/^task_\d+_.+\.md$/));

	const num = parseInt(query, 10);
	if (!Number.isNaN(num)) {
		const byNum = files.find(f => taskNum(f) === num);
		if (byNum) return path.join(projectDir, byNum);
	}

	const needle = String(query).toLowerCase();
	const bySlug = files.find(f => f.toLowerCase().includes(needle));
	return bySlug ? path.join(projectDir, bySlug) : null;
}

/**
 * Load a skill's SKILL.md content.
 * Returns the file content string, or null if the skill directory or file doesn't exist.
 */
export function loadSkillContent(skillsRoot, skillName) {
	const skillPath = path.join(skillsRoot, skillName, 'SKILL.md');
	if (!fs.existsSync(skillPath)) return null;
	return fs.readFileSync(skillPath, 'utf-8');
}

/**
 * Map lifecycle state to filename token.
 * Per the ticket-lifecycle-mode state vocabulary.
 * Throws on unknown state to prevent silent bugs.
 */
function stateToToken(state) {
	const map = {
		'state:ready-for-implementation': 'todo',
		'state:in-progress': 'in-progress',
		'state:ready-for-review': 'ready-for-review',
		'state:ready-for-qa': 'ready-for-qa',
		'state:changes-requested': 'changes-requested',
		'state:qa-passed': 'qa-passed',
		'closed': 'done',
	};
	if (!map[state]) {
		throw new Error(`Unknown lifecycle state: ${state}. Valid states: ${Object.keys(map).join(', ')}`);
	}
	return map[state];
}

// ── Per-file shape detection (repo-files vs. vault) ─────────────────────────
//
// A task file either carries a state-token filename infix (repo-files shape,
// e.g. `task_137_todo_slug.md`) or it doesn't (vault shape, e.g.
// `task_521_slug.md` -- see storage/obsidian.md's rename-free `transition-state`
// convention). This is decided per file, not via a global tier flag or a
// plugin-file presence check, so behavior stays correct even if a projects
// root ever mixed both shapes. `ticket-drift.js` proved this exact detection
// pattern first for its own drift-check purposes; these two functions are
// the single shared implementation -- `ticket-drift.js` imports them from
// here rather than keeping its own local copies.

/**
 * Extract the filename state infix (e.g. "todo", "qa-passed", "done") from
 * a task filename like "task_137_todo_slug.md". Returns null when the
 * filename carries no infix at all (vault-shaped, e.g. "task_521_slug.md")
 * or otherwise doesn't match the pattern.
 */
export function filenameInfix(filename) {
	const match = filename.match(/^task_\d+_([a-z-]+)_/);
	return match ? match[1] : null;
}

/**
 * Map a `status:` frontmatter value to the equivalent filename infix used by
 * repo-files-style task files. Used by ticket-drift.js as a fallback when the
 * filename carries no infix (vault-shaped files, where filenames are
 * `task_<id>_<slug>.md` with no embedded state token).
 *
 * Returns null for status values that have no direct infix equivalent (legacy
 * or non-canonical values); those are never flagged by infix-based shapes.
 *
 * @param {string|undefined} status
 * @returns {string|null}
 */
export function statusToInfix(status) {
	const map = {
		'closed': 'done',
		'state:qa-passed': 'qa-passed',
		'state:ready-for-qa': 'ready-for-qa',
		'state:changes-requested': 'changes-requested',
		'state:ready-for-review': 'ready-for-review',
		'state:in-progress': 'in-progress',
		'state:ready-for-implementation': 'ready-for-implementation',
		'state:todo': 'todo',
		'todo': 'todo',
	};
	return map[status] ?? null;
}

/**
 * Whether `filename` carries a valid state-token filename infix (repo-files
 * shape) as opposed to no infix at all (vault shape). Built on `filenameInfix`
 * above, validated against the canonical `TASK_STATE_TOKENS` list so an
 * incidental hyphen segment in a vault slug is never mistaken for a real
 * state token.
 */
function hasStateTokenInfix(filename) {
	const infix = filenameInfix(filename);
	return infix !== null && TASK_STATE_TOKENS.includes(infix);
}

/**
 * Serialize frontmatter object to YAML-like string.
 */
export function serializeFrontmatter(meta) {
	const lines = [];
	for (const [key, value] of Object.entries(meta)) {
		if (Array.isArray(value)) {
			lines.push(`${key}:`);
			for (const item of value) {
				lines.push(`  - ${item}`);
			}
		} else {
			lines.push(`${key}: ${value}`);
		}
	}
	return lines.join('\n');
}

/**
 * Change a task's lifecycle state, updating both frontmatter and filename atomically.
 * 
 * @param {string} taskPath - Current task file path
 * @param {string} [targetState] - New lifecycle state (e.g., 'state:in-progress'). Defaults to 'closed' for backward compatibility.
 * @param {object} [frontmatterUpdates] - Additional frontmatter fields to update (e.g., { 'fail-count': 1 })
 * @returns {string} New task file path
 * 
 * Legacy behavior (backward compatible):
 * - changeTaskStatus(path) → moves _todo_ to done/_done_
 * 
 * New behavior:
 * - changeTaskStatus(path, 'state:in-progress') → renames to _in-progress_ and updates frontmatter status
 * - changeTaskStatus(path, 'state:ready-for-qa', { 'fail-count': 1 }) → updates both status and fail-count
 *
 * Vault-shaped behavior: when `taskPath`'s filename carries no
 * state-token infix (per `hasStateTokenInfix` above), per
 * storage/obsidian.md's `transition-state` contract this performs a single
 * write of the `status:` frontmatter (plus any `frontmatterUpdates`) and does
 * NOT rename the file -- the returned path equals the input path. Repo-files-
 * shaped files (infix present) are unaffected: rename + status write exactly
 * as before.
 */
export function changeTaskStatus(taskPath, targetState = 'closed', frontmatterUpdates = {}) {
	// Validate targetState before touching anything -- on both the vault-shaped
	// and repo-files-shaped paths. An unknown state must throw here, before any
	// frontmatter mutation or disk write, so a typo'd state name fails loud
	// with the file left byte-for-byte untouched, matching the "no silent
	// success" contract this codebase already establishes elsewhere.
	const token = stateToToken(targetState);

	const projectDir = projectDirFromTaskPath(taskPath);
	const raw = fs.readFileSync(taskPath, 'utf-8');
	const { meta, body, hadFrontmatter } = parseFrontmatter(raw);
	const newBody = hadFrontmatter ? body : stripLegacyStateLine(body);

	// Update frontmatter
	meta.status = targetState;
	for (const [key, value] of Object.entries(frontmatterUpdates)) {
		meta[key] = String(value);
	}

	const basename = path.basename(taskPath);

	if (!hasStateTokenInfix(basename)) {
		// Vault-shaped: single write, no rename.
		const newContent = `---\n${serializeFrontmatter(meta)}\n---\n${newBody}`;
		fs.writeFileSync(taskPath, newContent, 'utf-8');
		return taskPath;
	}

	// Determine new filename token
	const match = basename.match(/^(task_\d+)_(todo|in-progress|ready-for-review|ready-for-qa|changes-requested|qa-passed|done)_(.+)$/);
	if (!match) {
		throw new Error(`Task filename does not match expected pattern: ${basename}`);
	}
	const [, prefix, , slug] = match;
	const newBasename = `${prefix}_${token}_${slug}`;

	// Determine target directory (done/ for terminal states, project root otherwise)
	let targetDir = projectDir;
	if (token === 'done') {
		targetDir = doneTasksDir(projectDir);
		fs.mkdirSync(targetDir, { recursive: true });
	}

	const newPath = path.join(targetDir, newBasename);

	// Write atomically: update content, then rename
	const newContent = `---\n${serializeFrontmatter(meta)}\n---\n${newBody}`;
	fs.writeFileSync(taskPath, newContent, 'utf-8');
	if (taskPath !== newPath) {
		fs.renameSync(taskPath, newPath);
	}

	return newPath;
}

/**
 * Edit frontmatter fields on a task file WITHOUT renaming it (no state
 * transition). Use `changeTaskStatus` when a rename is also required.
 *
 * @param {string} taskPath
 * @param {object} fields - map of frontmatter key -> value to set/overwrite
 * @returns {string} the (unchanged) task file path
 */
export function updateTaskFields(taskPath, fields) {
	const raw = fs.readFileSync(taskPath, 'utf-8');
	const { meta, body, hadFrontmatter } = parseFrontmatter(raw);

	// Only strip the legacy `**State:**` body line when this write is about
	// to introduce a `status` frontmatter field on a previously-frontmatter-
	// less file — that's the only case where a duplicate/contradictory-state
	// field would be created (e.g. `task update-field <id> status <value>`
	// on a legacy file). Updating an unrelated field (e.g. `fail-count`) on
	// a legacy file must NOT strip `**State:**` — doing so would delete the
	// file's only source of truth for state instead of de-duplicating it.
	const introducesStatus = hadFrontmatter === false && Object.prototype.hasOwnProperty.call(fields, 'status');
	const newBody = introducesStatus ? stripLegacyStateLine(body) : body;

	for (const [key, value] of Object.entries(fields)) {
		meta[key] = String(value);
	}

	const newContent = `---\n${serializeFrontmatter(meta)}\n---\n${newBody}`;
	fs.writeFileSync(taskPath, newContent, 'utf-8');
	return taskPath;
}

/**
 * Append content to a named section (e.g. `## Gap Closure`, `## QA Report`,
 * `## Log`) in a task file's body. If the section heading already exists,
 * the content is appended underneath it (after a blank line); otherwise a
 * new `## <section>` heading is added at the end of the body.
 *
 * Does not touch frontmatter or filename — use `changeTaskStatus` /
 * `updateTaskFields` for those.
 *
 * @param {string} taskPath
 * @param {string} section - section name without the `##` prefix, e.g. "Gap Closure"
 * @param {string} content - markdown content to append under the section
 * @returns {string} the (unchanged) task file path
 */
export function appendTaskSection(taskPath, section, content) {
	const raw = fs.readFileSync(taskPath, 'utf-8');
	const { meta, body } = parseFrontmatter(raw);

	const heading = `## ${section}`;
	const headingRegex = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');

	let newBody;
	if (headingRegex.test(body)) {
		// Section exists — append content under it, before the next `## ` heading (or EOF).
		const lines = body.split('\n');
		const headingIdx = lines.findIndex(line => headingRegex.test(line));
		let nextHeadingIdx = lines.findIndex((line, i) => i > headingIdx && /^##\s/.test(line));
		if (nextHeadingIdx === -1) nextHeadingIdx = lines.length;

		const before = lines.slice(0, nextHeadingIdx);
		const after = lines.slice(nextHeadingIdx);
		// Trim trailing blank lines from `before` so we control spacing precisely.
		while (before.length && before[before.length - 1].trim() === '') before.pop();

		newBody = [...before, '', content.trim(), '', ...after].join('\n');
	} else {
		const trimmedBody = body.replace(/\s+$/, '');
		newBody = `${trimmedBody}\n\n${heading}\n\n${content.trim()}\n`;
	}

	const newContent = `---\n${serializeFrontmatter(meta)}\n---\n${newBody}`;
	fs.writeFileSync(taskPath, newContent, 'utf-8');
	return taskPath;
}

// ── Wave computation ─────────────────────────────────────────────────────────

/**
 * Extract a numeric task id from a filename or a depends_on/id reference
 * string. Accepts "task_<id>_todo_x.md", "task_<id>", or a bare numeric id.
 * Returns the id as a string (e.g. "170"), or null if no digits found.
 */
function extractTaskId(value) {
	if (typeof value !== 'string') return null;
	const m = value.match(/(\d+)/);
	return m ? m[1] : null;
}

/**
 * Convert a glob pattern (supporting `*` within a segment and `**` as a
 * whole path segment meaning "zero or more segments") into an anchored
 * RegExp.
 */
function globToRegex(glob) {
	const segments = glob.split('/').map(seg => {
		if (seg === '**') return '.*';
		const escaped = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		return escaped.replace(/\*/g, '[^/]*');
	});
	return new RegExp('^' + segments.join('/') + '$');
}

/**
 * Produce a concrete sample path from a glob by replacing wildcard segments
 * with a literal placeholder, preserving literal segments and extensions.
 */
function globSample(glob) {
	return glob.split('/').map(seg => {
		if (seg === '**') return 'x';
		return seg.replace(/\*/g, 'x');
	}).join('/');
}

/**
 * Heuristic overlap check between two glob patterns: true if either
 * pattern's regex matches a sample derived from the other (or they are
 * identical). This is a practical approximation of glob intersection —
 * sufficient for detecting the common "same file" / "same directory tree"
 * conflicts task `touches` frontmatter is meant to flag, without pulling in
 * a full glob-intersection dependency.
 */
export function globsOverlap(a, b) {
	if (a === b) return true;
	const regexA = globToRegex(a);
	const regexB = globToRegex(b);
	return regexA.test(globSample(b)) || regexB.test(globSample(a));
}

/**
 * Compute wave-parallel groups of dispatchable (`todo`) tasks for a project.
 * Read/compute-only — never mutates task state or dispatches
 * anything; the caller (Architect) proposes the result to the team lead for
 * confirmation per `task-automation-flow`.
 *
 * Algorithm:
 *  1. Parse every task file in the project (todo, in-flight, and done) to
 *     build the full `depends_on` graph, keyed by numeric task id.
 *  2. Detect cycles across that full graph — reachable from any todo task —
 *     via DFS. A cycle is a hard error (`ok: false`), not a silently wrong
 *     or empty wave.
 *  3. Restrict candidates to tasks in the `todo` state (dispatchable).
 *  4. Two candidates conflict (cannot share a wave) when either:
 *       - a direct `depends_on` edge exists between them (either direction), or
 *       - any of their `touches` globs overlap (see `globsOverlap`).
 *     Tasks with no `touches` declared impose no glob-based conflict.
 *  5. Greedily assign candidates (in ascending task-id order) to the first
 *     wave with no conflicting member, opening a new wave otherwise.
 *
 * Returns `{ ok: true, project, waves: string[][] }` (array of arrays of
 * task id strings, e.g. `[["170","172"],["175"]]`) or
 * `{ ok: false, error }` on a missing project or a dependency cycle.
 */
export function computeWaves(project, { projectsRoot = 'projects' } = {}) {
	if (!project) return { ok: false, error: 'project is required' };

	const all = listAllTasks(projectsRoot);
	const entry = all.find(e => e.project === project);
	if (!entry) return { ok: false, error: `project not found: ${project}` };

	const fileEntries = [
		...entry.todos.map(file => ({ file, state: 'todo' })),
		...entry.inFlight,
		...entry.dones.map(file => ({ file, state: 'done' })),
	];

	/** @type {Map<string, {id: string, file: string, state: string, dependsOn: string[], touches: string[]}>} */
	const nodes = new Map();

	for (const { file, state } of fileEntries) {
		const id = extractTaskId(file);
		if (!id) continue;

		const rootPath = path.join(entry.projectDir, file);
		const filePath = fs.existsSync(rootPath) ? rootPath : path.join(doneTasksDir(entry.projectDir), file);
		if (!fs.existsSync(filePath)) continue;

		const raw = fs.readFileSync(filePath, 'utf-8');
		const { meta } = parseFrontmatter(raw);

		const dependsOnRaw = Array.isArray(meta.depends_on) ? meta.depends_on : [];
		const dependsOn = dependsOnRaw.map(extractTaskId).filter(Boolean);
		const touches = Array.isArray(meta.touches) ? meta.touches : [];

		nodes.set(id, { id, file, state, dependsOn, touches });
	}

	// Cycle detection over the full depends_on graph (WHITE/GRAY/BLACK DFS).
	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color = new Map();
	for (const id of nodes.keys()) color.set(id, WHITE);

	function dfs(id, stack) {
		color.set(id, GRAY);
		stack.push(id);
		const node = nodes.get(id);
		if (node) {
			for (const depId of node.dependsOn) {
				if (!nodes.has(depId)) continue; // dangling reference: not a cycle risk
				if (color.get(depId) === GRAY) {
					const cycleStart = stack.indexOf(depId);
					return [...stack.slice(cycleStart), depId];
				}
				if (color.get(depId) === WHITE) {
					const found = dfs(depId, stack);
					if (found) return found;
				}
			}
		}
		stack.pop();
		color.set(id, BLACK);
		return null;
	}

	for (const id of nodes.keys()) {
		if (color.get(id) !== WHITE) continue;
		const cycle = dfs(id, []);
		if (cycle) {
			return { ok: false, error: `dependency cycle detected: ${cycle.map(c => `task_${c}`).join(' -> ')}` };
		}
	}

	// Candidates: dispatchable (todo) tasks only.
	const candidates = [...nodes.values()]
		.filter(n => n.state === 'todo')
		.sort((a, b) => Number(a.id) - Number(b.id));

	if (candidates.length === 0) {
		return { ok: true, project, waves: [] };
	}

	function conflicts(a, b) {
		if (a.dependsOn.includes(b.id) || b.dependsOn.includes(a.id)) return true;
		for (const globA of a.touches) {
			for (const globB of b.touches) {
				if (globsOverlap(globA, globB)) return true;
			}
		}
		return false;
	}

	const waves = [];
	for (const candidate of candidates) {
		let placed = false;
		for (const wave of waves) {
			const hasConflict = wave.some(memberId => conflicts(candidate, nodes.get(memberId)));
			if (!hasConflict) {
				wave.push(candidate.id);
				placed = true;
				break;
			}
		}
		if (!placed) waves.push([candidate.id]);
	}

	return { ok: true, project, waves };
}

/**
 * Build a focused dispatch prompt for a task file.
 * Skills declared in the frontmatter are listed by name only — the agent loads
 * them from its profile on demand rather than having content inlined here.
 *
 * Returns { meta, model, taskName, injectedSkills, missingSkills, prompt }
 */
export function buildDispatchPrompt(taskPath, skillsRoot) {
	const raw = fs.readFileSync(taskPath, 'utf-8');
	const { meta, body } = parseFrontmatter(raw);

	const skills = Array.isArray(meta.skills) ? meta.skills : [];
	const knownSkills = [];
	const missingSkills = [];

	for (const skillName of skills) {
		if (loadSkillContent(skillsRoot, skillName)) {
			knownSkills.push(skillName);
		} else {
			missingSkills.push(skillName);
		}
	}

	const agentLabel = [meta.agent, meta.mode].filter(Boolean).join(' / ');
	const model = meta.model ?? 'claude-sonnet-4-6';
	const githubLine = meta.github ? `\n**GitHub:** \`${meta.github}\`` : '';
	const taskName = path.basename(taskPath);
	const skillsSummary = skills.length > 0 ? skills.join(', ') : 'none';
	const missingSummary = missingSkills.length > 0
		? ` | **Unknown skills:** ${missingSkills.join(', ')}`
		: '';

	const header =
		`<!-- DISPATCH -->\n` +
		`**Agent:** ${agentLabel || 'unspecified'} | **Model:** \`${model}\`${githubLine}\n` +
		`**Task:** \`${taskName}\`\n` +
		`**Skills required:** ${skillsSummary}${missingSummary}\n\n` +
		`---\n\n`;

	return {
		meta,
		model,
		taskName,
		injectedSkills: knownSkills,
		missingSkills,
		prompt: header + body,
	};
}
