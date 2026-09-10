import fs from 'node:fs';
import path from 'node:path';
import { TASK_STATE_TOKENS } from './tasks.js';
import { analyzeSys, analyzeTst, analyzeUsr, analyzeAnl, analyzeDbg, analyzeCtx } from './perspectives.js';

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2 };

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Run all 6 perspectives against a project directory.
 *
 * Options:
 *   projectDir     string  absolute or relative path to the project repo to scan
 *   graphJsonPath  string  optional absolute path to a Graphify graph.json —
 *                          forwarded to analyzeSys() so it can prefer
 *                          Graphify's own graph over dep-graph.js's own scan
 *                          when present. See scan.js's scan() for how this
 *                          is derived from projectsDir.
 *
 * Returns { perspectives, overall, allFindings }
 *   perspectives  — array of { id, name, score, findings[] }
 *   overall       — weighted average score 0–1.0
 *   allFindings   — flat array of all findings across perspectives
 */
export function scanProject({ projectDir, graphJsonPath }) {
	const root = path.resolve(projectDir);

	if (!fs.existsSync(root)) {
		const f = {
			id: 'project-not-found', priority: 'critical',
			title: 'Project directory not found',
			description: `Expected project at ${root}. Verify the workspace layout.`,
			skill: 'scan-sys', agent: 'architect', mode: 'architecture',
		};
		return { perspectives: [], overall: 0, allFindings: [f] };
	}

	const perspectives = [
		analyzeSys(root, { graphJsonPath }),
		analyzeTst(root),
		analyzeUsr(root),
		analyzeAnl(root),
		analyzeDbg(root),
		analyzeCtx(root),
	];

	const overall = round(perspectives.reduce((s, p) => s + p.score, 0) / perspectives.length);
	const allFindings = perspectives.flatMap(p => p.findings);

	return { perspectives, overall, allFindings };
}

/**
 * Load the previous health snapshot for a project.
 * Returns the parsed JSON object or null if none exists.
 */
export function loadHealth(projectsDir) {
	const hp = path.join(projectsDir, 'health.json');
	if (!fs.existsSync(hp)) return null;
	try { return JSON.parse(fs.readFileSync(hp, 'utf-8')); }
	catch { return null; }
}

/**
 * Write an updated health snapshot.
 * Appends the previous overall score to history (kept to last 10 scans).
 * Returns the new health object.
 */
export function saveHealth(projectsDir, projectName, perspectives, overall) {
	const prev = loadHealth(projectsDir);
	const now = new Date().toISOString();

	const scores = {};
	for (const p of perspectives) {
		const prevScore = prev?.perspectives?.[p.id]?.score ?? null;
		scores[p.id] = {
			score: p.score,
			trend: prevScore !== null ? round(p.score - prevScore) : null,
		};
	}

	const prevHistory = prev?.history ?? [];
	const history = [
		...prevHistory.slice(-9),
		...(prev ? [{ scannedAt: prev.scannedAt, overall: prev.overall }] : []),
	];

	const health = { project: projectName, scannedAt: now, perspectives: scores, overall, history };
	fs.mkdirSync(projectsDir, { recursive: true });
	fs.writeFileSync(path.join(projectsDir, 'health.json'), JSON.stringify(health, null, 2), 'utf-8');
	return health;
}

/**
 * Convert scan findings into task file descriptors, skipping any finding
 * that already has a task file (matched by finding-id in frontmatter).
 * Findings are sorted critical → high → medium before numbering.
 *
 * Returns [{ filename, content }]
 */
export function generateTasks({ allFindings, projectName, projectsDir }) {
	const existingFiles = collectExistingTaskFiles(projectsDir);

	const existingIds = new Set(existingFiles.map(({ dir, filename }) => readFindingId(dir, filename)).filter(Boolean));
	const newFindings = allFindings.filter(f => !existingIds.has(f.id));

	if (newFindings.length === 0) return [];

	newFindings.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));

	const maxNum = existingFiles.reduce((max, { filename }) => {
		const m = filename.match(/^task_(\d+)_/);
		return m ? Math.max(max, parseInt(m[1], 10)) : max;
	}, 0);

	return newFindings.map((finding, i) => ({
		filename: `task_${maxNum + i + 1}_todo_${makeSlug(finding.title)}.md`,
		content: buildTaskContent(finding, projectName),
	}));
}

// ── helpers ───────────────────────────────────────────────────────────────────

function round(n) { return Math.round(n * 100) / 100; }

function collectExistingTaskFiles(projectsDir) {
	// Match all task states from the ticket-lifecycle-mode canonical vocabulary
	const tokenPattern = TASK_STATE_TOKENS.join('|');
	const pattern = new RegExp(`^task_\\d+_(?:${tokenPattern})_`);
	const entries = [];
	if (fs.existsSync(projectsDir)) {
		for (const filename of fs.readdirSync(projectsDir)) {
			if (pattern.test(filename)) entries.push({ dir: projectsDir, filename });
		}
	}
	const doneDir = path.join(projectsDir, 'done');
	if (fs.existsSync(doneDir)) {
		for (const filename of fs.readdirSync(doneDir)) {
			if (pattern.test(filename)) entries.push({ dir: doneDir, filename });
		}
	}
	return entries;
}

function makeSlug(title) {
	return title.toLowerCase()
		.replace(/[^a-z0-9\s]/g, '')
		.trim()
		.split(/\s+/)
		.slice(0, 4)
		.join('-');
}

function readFindingId(dir, filename) {
	try {
		const content = fs.readFileSync(path.join(dir, filename), 'utf-8');
		const m = content.match(/^finding-id:\s+(.+)$/m);
		return m ? m[1].trim() : null;
	} catch { return null; }
}

function buildTaskContent(finding, projectName) {
	return `---
agent: ${finding.agent}
mode: ${finding.mode}
model: claude-sonnet-4-6
finding-id: ${finding.id}
skills:
  - ${finding.skill}
---

# ${finding.title}

**Project:** ${projectName}
**Priority:** ${finding.priority}

${finding.description}

## Acceptance Criteria

- [ ] Issue resolved and verified
- [ ] No regressions introduced
`;
}
