import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
	SOURCE_EXTS,
	MAX_FILE_LINES,
	MAX_DIR_FILES,
	r,
	walkDir,
	countLines,
	collectSourceFiles,
} from './scan-utils.js';
import { analyzeDependencyGraph, analyzeDependencyGraphFromGraphify, MAX_FAN_OUT } from './dep-graph.js';

// ── SYS: System / Architecture ────────────────────────────────────────────────
//
// Complexity and Cohesion each blend the original line/file-count heuristic
// with a real dependency-graph signal, 50/50 weight: a module's fan-out
// feeds Complexity (how much surrounding context you must hold in mind to
// understand a file), and import cycles feed Cohesion (a cycle is a direct,
// hard signal that two modules are not well-separated). The heuristics are
// kept at half-weight rather than fully replaced because file/directory size
// still catches a signal the import graph does not — a single oversized file
// with no imports, or a directory of many small unrelated files, would
// otherwise score perfectly.
//
// Dependency-graph source: when the project has already run Graphify
// (`.graphify/<project>/graphify-out/graph.json` exists under the hub root),
// that real, richer call/import graph is preferred over this module's own
// regex-based scan — Graphify is optional and derived, so its absence is
// never an error, just a fallback to dep-graph.js's own
// buildImportGraph()/detectCycles() engine (dep-graph.js's own doc comment
// has the full engine description).

export function analyzeSys(root, { graphJsonPath } = {}) {
	const allFiles = collectSourceFiles(root);
	const dirCounts = {};
	let largeCount = 0;

	for (const f of allFiles) {
		const dir = path.dirname(f);
		dirCounts[dir] = (dirCounts[dir] || 0) + 1;
		if (countLines(f) > MAX_FILE_LINES) largeCount++;
	}

	const findings = [];

	const resolvedGraphJsonPath = graphJsonPath ?? path.join(root, 'graphify', 'graphify-out', 'graph.json');
	const graphifyResult = fs.existsSync(resolvedGraphJsonPath)
		? analyzeDependencyGraphFromGraphify(resolvedGraphJsonPath)
		: null;
	const { files: graphFiles, cycles, coupling } = graphifyResult ?? analyzeDependencyGraph(root);

	const lineComplexityScore = allFiles.length > 0 ? 1 - largeCount / allFiles.length : 1;
	if (largeCount > 0) {
		findings.push({
			id: 'sys-large-files',
			priority: largeCount > 3 ? 'high' : 'medium',
			title: `Refactor ${largeCount} oversized file(s)`,
			description: `${largeCount} source file(s) exceed ${MAX_FILE_LINES} lines. Large files increase coupling and reduce comprehension.`,
			skill: 'scan-sys', agent: 'architect', mode: 'architecture',
		});
	}

	const highFanOut = [...coupling.entries()].filter(([, c]) => c.fanOut > MAX_FAN_OUT);
	const couplingScore = graphFiles.length > 0 ? 1 - highFanOut.length / graphFiles.length : 1;
	if (highFanOut.length > 0) {
		findings.push({
			id: 'sys-high-coupling',
			priority: 'medium',
			title: `Reduce fan-out in ${highFanOut.length} module(s)`,
			description: `${highFanOut.length} module(s) import more than ${MAX_FAN_OUT} internal dependencies. Top: ${highFanOut.slice(0, 2).map(([m]) => m).join(', ')}`,
			skill: 'scan-sys', agent: 'architect', mode: 'architecture',
		});
	}

	const complexityScore = r((lineComplexityScore + couplingScore) / 2);

	const dirs = Object.values(dirCounts);
	const overloaded = dirs.filter(n => n > MAX_DIR_FILES).length;
	const dirCohesionScore = dirs.length > 0 ? 1 - overloaded / dirs.length : 1;
	if (overloaded > 0) {
		findings.push({
			id: 'sys-overloaded-dirs',
			priority: 'medium',
			title: `Split ${overloaded} overloaded director(ies)`,
			description: `${overloaded} director(ies) hold more than ${MAX_DIR_FILES} source files. Extract into focused sub-modules.`,
			skill: 'scan-sys', agent: 'architect', mode: 'architecture',
		});
	}

	const modulesInCycles = new Set(cycles.flat());
	const cycleScore = graphFiles.length > 0 ? 1 - modulesInCycles.size / graphFiles.length : 1;
	if (cycles.length > 0) {
		findings.push({
			id: 'sys-dependency-cycles',
			priority: cycles.length > 3 ? 'high' : 'medium',
			title: `Break ${cycles.length} dependency cycle(s)`,
			description: `${cycles.length} import cycle(s) found across ${modulesInCycles.size} module(s). Top: ${cycles.slice(0, 2).map(c => c.join(' -> ')).join(' | ')}`,
			skill: 'scan-sys', agent: 'architect', mode: 'architecture',
		});
	}

	const cohesionScore = r((dirCohesionScore + cycleScore) / 2);

	const hasTs = allFiles.some(f => f.endsWith('.ts') || f.endsWith('.tsx'));
	const hasTsConfig = fs.existsSync(path.join(root, 'tsconfig.json'));
	const hasCi = fs.existsSync(path.join(root, '.github', 'workflows'));
	const infraScore = ((hasTs ? (hasTsConfig ? 1 : 0) : 1) + (hasCi ? 1 : 0)) / 2;

	if (hasTs && !hasTsConfig) {
		findings.push({
			id: 'sys-no-tsconfig',
			priority: 'high',
			title: 'Add tsconfig.json',
			description: 'TypeScript files found but no tsconfig.json. Strict type checking prevents whole classes of runtime bugs.',
			skill: 'scan-sys', agent: 'builder', mode: 'engineering',
		});
	}
	if (!hasCi) {
		findings.push({
			id: 'sys-no-ci',
			priority: 'medium',
			title: 'Add CI/CD pipeline',
			description: 'No .github/workflows/ directory found. Automated checks catch regressions before they ship.',
			skill: 'scan-sys', agent: 'architect', mode: 'architecture',
		});
	}

	return { id: 'sys', name: 'System', score: r((complexityScore + cohesionScore + infraScore) / 3), findings };
}

// ── TST: Test ─────────────────────────────────────────────────────────────────

export function analyzeTst(root) {
	const TEST_PATTERNS = [/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /^test_.*\.py$/, /.*_test\.py$/];
	const allFiles = collectSourceFiles(root);
	const testFiles = allFiles.filter(f => TEST_PATTERNS.some(p => p.test(path.basename(f))));
	const sourceFiles = allFiles.filter(f => !TEST_PATTERNS.some(p => p.test(path.basename(f))));

	let hasTestScript = false;
	const pkgPath = path.join(root, 'package.json');
	if (fs.existsSync(pkgPath)) {
		try { hasTestScript = !!JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).scripts?.test; } catch {}
	}

	const findings = [];

	if (testFiles.length === 0) {
		findings.push({
			id: 'tst-no-tests',
			priority: 'critical',
			title: 'Create test suite',
			description: 'No test files found. Tests are the primary regression safety net.',
			skill: 'scan-tst', agent: 'tester', mode: 'qa',
		});
		return { id: 'tst', name: 'Test', score: 0.0, findings };
	}

	const ratio = sourceFiles.length > 0 ? testFiles.length / sourceFiles.length : 1;
	const ratioScore = Math.min(ratio / 0.5, 1.0);
	if (ratio < 0.5) {
		findings.push({
			id: 'tst-low-coverage',
			priority: 'high',
			title: 'Increase test coverage',
			description: `${testFiles.length} test files for ${sourceFiles.length} source files (${Math.round(ratio * 100)}%). Target: ≥50% file coverage.`,
			skill: 'scan-tst', agent: 'tester', mode: 'qa',
		});
	}

	if (!hasTestScript) {
		findings.push({
			id: 'tst-no-script',
			priority: 'high',
			title: 'Add test script to package.json',
			description: 'No scripts.test defined. CI and contributors cannot verify the build.',
			skill: 'scan-tst', agent: 'tester', mode: 'qa',
		});
	}

	return { id: 'tst', name: 'Test', score: r((ratioScore + (hasTestScript ? 1 : 0)) / 2), findings };
}

// ── USR: User / Product ───────────────────────────────────────────────────────

export function analyzeUsr(root) {
	const findings = [];

	const readmePath = path.join(root, 'README.md');
	let readmeScore = 0;
	if (fs.existsSync(readmePath)) {
		const len = fs.readFileSync(readmePath, 'utf-8').length;
		readmeScore = Math.min(len / 2000, 1.0);
		if (len < 500) {
			findings.push({
				id: 'usr-readme-thin',
				priority: 'high',
				title: 'Expand README',
				description: `README is only ${len} chars. Add installation, usage examples, and feature descriptions (target: 2000+ chars).`,
				skill: 'scan-usr', agent: 'builder', mode: 'engineering',
			});
		}
	} else {
		findings.push({
			id: 'usr-no-readme',
			priority: 'critical',
			title: 'Create README.md',
			description: 'No README found. Users cannot discover what this project does or how to use it.',
			skill: 'scan-usr', agent: 'builder', mode: 'engineering',
		});
	}

	let descScore = 1.0;
	const pkgPath = path.join(root, 'package.json');
	if (fs.existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
			if (!pkg.description) {
				descScore = 0.0;
				findings.push({
					id: 'usr-no-description',
					priority: 'medium',
					title: 'Add package.json description',
					description: 'The description field is missing. npm search and registries rely on it.',
					skill: 'scan-usr', agent: 'builder', mode: 'engineering',
				});
			}
		} catch {}
	}

	const hasChangelog = fs.existsSync(path.join(root, 'CHANGELOG.md')) || fs.existsSync(path.join(root, 'CHANGELOG'));
	const changelogScore = hasChangelog ? 1.0 : 0.5;

	return { id: 'usr', name: 'User', score: r((readmeScore + descScore + changelogScore) / 3), findings };
}

// ── ANL: Analytics / Observability ───────────────────────────────────────────

export function analyzeAnl(root) {
	const findings = [];

	// CI/CD — improved: check for test step presence
	const workflowsDir = path.join(root, '.github', 'workflows');
	const hasCi = fs.existsSync(workflowsDir);
	let ciScore = 0;
	if (!hasCi) {
		findings.push({
			id: 'anl-no-ci',
			priority: 'medium',
			title: 'Add CI/CD pipeline',
			description: 'No .github/workflows/ found. Automated checks catch regressions before they reach production.',
			skill: 'scan-anl', agent: 'architect', mode: 'architecture',
		});
	} else {
		// Check if any workflow file includes a test-run step
		let hasTestStep = false;
		try {
			for (const f of fs.readdirSync(workflowsDir)) {
				if (!/\.(yml|yaml)$/.test(f)) continue;
				const content = fs.readFileSync(path.join(workflowsDir, f), 'utf-8');
				if (/\btest\b/i.test(content)) { hasTestStep = true; break; }
			}
		} catch {}
		if (hasTestStep) {
			ciScore = 1.0;
		} else {
			ciScore = 0.5;
			findings.push({
				id: 'anl-ci-no-test-step',
				priority: 'medium',
				title: 'CI pipeline is missing a test-run step',
				description: 'A CI workflow exists but no test step was detected. Add a test step to catch regressions automatically.',
				skill: 'scan-anl', agent: 'architect', mode: 'architecture',
			});
		}
	}

	// Commit quality — fix rate
	let commitScore = 1.0;
	let recentMsgs = [];
	try {
		const out = execSync('git log -20 --pretty=format:%s', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
		recentMsgs = out.trim().split('\n').filter(Boolean);
		if (recentMsgs.length >= 3) {
			const fixes = recentMsgs.filter(m => /\bfix\b/i.test(m)).length;
			const fixRate = fixes / recentMsgs.length;
			if (fixRate > 0.5) {
				commitScore = r(1 - fixRate);
				findings.push({
					id: 'anl-high-fix-rate',
					priority: 'medium',
					title: 'High bug-fix rate in recent commits',
					description: `${fixes} of ${recentMsgs.length} recent commits are fixes (${Math.round(fixRate * 100)}%). Signals weak test coverage or recurring design debt.`,
					skill: 'scan-anl', agent: 'architect', mode: 'architecture',
				});
			}
		}
	} catch {}

	// Working tree cleanliness
	let cleanScore = 1.0;
	try {
		const out = execSync('git status --porcelain', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
		const lines = out.trim().split('\n').filter(Boolean);
		if (lines.length > 0) {
			cleanScore = 0.5;
			findings.push({
				id: 'anl-uncommitted',
				priority: 'medium',
				title: `Commit ${lines.length} uncommitted change(s)`,
				description: 'Working tree has uncommitted changes. Commit or stash before starting new work.',
				skill: 'scan-anl', agent: 'builder', mode: 'engineering',
			});
		}
	} catch {}

	// Commit message quality — vague message fraction
	const VAGUE_PATTERN = /^\s*(fix|wip|update|changes|stuff|misc|minor|patch|tweak|typo|cleanup|temp|todo|test)\s*\.?\s*$/i;
	let msgQualityScore = 1.0;
	if (recentMsgs.length >= 3) {
		const vagueCount = recentMsgs.filter(m => VAGUE_PATTERN.test(m)).length;
		const vagueRate = vagueCount / recentMsgs.length;
		if (vagueRate > 0.4) {
			msgQualityScore = 0.0;
			findings.push({
				id: 'anl-vague-commits',
				priority: 'low',
				title: 'High proportion of vague commit messages',
				description: `${vagueCount} of ${recentMsgs.length} recent commits have vague messages (${Math.round(vagueRate * 100)}%). Use descriptive messages to aid future triage.`,
				skill: 'scan-anl', agent: 'builder', mode: 'engineering',
			});
		} else if (vagueRate >= 0.1) {
			msgQualityScore = 0.5;
		}
	}

	// Test automation — tests exist and run in CI
	let testAutomationScore = 0.0;
	let hasTestScript = false;
	const pkgPath = path.join(root, 'package.json');
	if (fs.existsSync(pkgPath)) {
		try { hasTestScript = !!JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).scripts?.test; } catch {}
	}
	const hasMakefile = fs.existsSync(path.join(root, 'Makefile'));
	const hasTests = hasTestScript || hasMakefile;

	if (hasCi && ciScore === 1.0) {
		// CI present and has a test step
		testAutomationScore = 1.0;
	} else if (hasTests) {
		testAutomationScore = 0.5;
		findings.push({
			id: 'anl-tests-not-in-ci',
			priority: 'medium',
			title: 'Tests exist but are not run in CI',
			description: 'A test script was found but the CI pipeline does not appear to run tests. Wire tests into CI to catch regressions automatically.',
			skill: 'scan-anl', agent: 'architect', mode: 'architecture',
		});
	} else {
		findings.push({
			id: 'anl-no-tests',
			priority: 'medium',
			title: 'No test suite found',
			description: 'No test script in package.json or Makefile detected. Add a test suite to validate behaviour automatically.',
			skill: 'scan-anl', agent: 'tester', mode: 'qa',
		});
	}

	return { id: 'anl', name: 'Analytics', score: r((ciScore + commitScore + cleanScore + msgQualityScore + testAutomationScore) / 5), findings };
}

// ── DBG: Debug / Reliability ──────────────────────────────────────────────────

export function analyzeDbg(root) {
	const TODO_PATTERN = /\/\/\s*(TODO|FIXME|HACK|BUG|XXX)[\s:]*(.*)/i;
	const CONSOLE_PATTERN = /\bconsole\.(log|warn|error|debug)\b/;
	// Silent catch: catch blocks with empty body or no logging call inside
	const SILENT_CATCH_PATTERN = /\.catch\s*\(\s*(?:\(\s*\)|[a-zA-Z_$][\w$]*\s*)?\s*=>\s*\{\s*\}|\bcatch\s*(?:\(\s*[^)]*\))?\s*\{\s*\}/;
	const TYPE_ESCAPE_PATTERN = /\bas\s+any\b|\/\/\s*@ts-ignore|\/\/\s*@ts-nocheck|\/\/\s*eslint-disable/;
	// Observable output: structured logger, error events, or health endpoints
	const OBSERVABLE_PATTERN = /logger\.|log\.|emit\s*\(\s*['"]error['"]|\/health|healthCheck|structuredLog/i;

	const todos = [];
	const consoleLogs = [];
	let silentCatchCount = 0;
	let typeEscapeCount = 0;
	const moduleObservable = new Map(); // dir -> boolean

	walkDir(root, filePath => {
		if (!SOURCE_EXTS.has(path.extname(filePath))) return;
		const rel = path.relative(root, filePath);
		const isTest = /test|spec|__tests__/.test(rel);
		const dir = path.dirname(filePath);
		try {
			const content = fs.readFileSync(filePath, 'utf-8');
			const lines = content.split('\n');

			// Track module-level observability (per directory boundary)
			if (!isTest) {
				if (OBSERVABLE_PATTERN.test(content)) {
					moduleObservable.set(dir, true);
				} else if (!moduleObservable.has(dir)) {
					moduleObservable.set(dir, false);
				}
			}

			lines.forEach((line, i) => {
				const m = line.match(TODO_PATTERN);
				if (m && !isTest) todos.push({ file: rel, line: i + 1, type: m[1].toUpperCase() });
				if (CONSOLE_PATTERN.test(line) && !isTest) consoleLogs.push({ file: rel, line: i + 1 });
				if (!isTest && SILENT_CATCH_PATTERN.test(line)) silentCatchCount++;
				if (!isTest && TYPE_ESCAPE_PATTERN.test(line)) typeEscapeCount++;
			});
		} catch {}
	});

	const findings = [];

	if (todos.length > 0) {
		const fixmes = todos.filter(t => ['FIXME', 'BUG'].includes(t.type));
		findings.push({
			id: 'dbg-todos',
			priority: fixmes.length > 0 ? 'high' : 'medium',
			title: `Resolve ${todos.length} TODO/FIXME comment(s)`,
			description: `${todos.length} inline markers (${fixmes.length} FIXME/BUG). Top: ${todos.slice(0, 2).map(t => `${t.file}:${t.line}`).join(', ')}`,
			skill: 'scan-dbg', agent: 'builder', mode: 'engineering',
		});
	}

	if (consoleLogs.length > 5) {
		findings.push({
			id: 'dbg-console-logs',
			priority: 'medium',
			title: `Remove ${consoleLogs.length} console.log statement(s)`,
			description: `${consoleLogs.length} console.log/warn/error calls in production source. Use a structured logger instead.`,
			skill: 'scan-dbg', agent: 'builder', mode: 'engineering',
		});
	}

	if (silentCatchCount > 0) {
		findings.push({
			id: 'dbg-silent-catch',
			priority: 'high',
			title: `Fix ${silentCatchCount} silent error swallow(s)`,
			description: `${silentCatchCount} catch block(s) swallow errors silently. Silent swallows hide production failures — add logging or re-throw.`,
			skill: 'scan-dbg', agent: 'builder', mode: 'engineering',
		});
	}

	if (typeEscapeCount > 0) {
		findings.push({
			id: 'dbg-type-escapes',
			priority: 'medium',
			title: `Remove ${typeEscapeCount} type-safety escape(s)`,
			description: `${typeEscapeCount} use(s) of \`as any\`, \`@ts-ignore\`, \`@ts-nocheck\`, or \`eslint-disable\` found. Each one hides a potential bug.`,
			skill: 'scan-dbg', agent: 'builder', mode: 'engineering',
		});
	}

	const unobservableDirs = [...moduleObservable.values()].filter(v => !v).length;
	const totalDirs = moduleObservable.size;
	if (totalDirs > 0 && unobservableDirs > 0) {
		findings.push({
			id: 'dbg-no-observable-output',
			priority: 'medium',
			title: `Add observable failure output to ${unobservableDirs} module(s)`,
			description: `${unobservableDirs} of ${totalDirs} module(s) have no structured logging, error event emission, or health-check endpoint. Operators cannot detect failures from outside.`,
			skill: 'scan-dbg', agent: 'builder', mode: 'engineering',
		});
	}

	const todoScore = r(Math.max(0, 1 - todos.length / 10));
	const logScore = r(Math.max(0, 1 - consoleLogs.length / 10));
	const errorScore = silentCatchCount === 0 ? 1.0 : silentCatchCount <= 3 ? 0.5 : 0.0;
	const typesafeScore = r(Math.max(0, 1 - typeEscapeCount / 5));
	const observableScore = totalDirs === 0 ? 1.0
		: r(1 - unobservableDirs / totalDirs);

	return { id: 'dbg', name: 'Debug', score: r((todoScore + logScore + errorScore + typesafeScore + observableScore) / 5), findings };
}

// ── CTX: Context Budget ──────────────────────────────────────────────────────
//
// Measures how much context a deployed agent consumes before real work
// starts. Scoped to this repo's own agent-profile authoring layout
// (`agents/profiles/<id>-workspace/`) — every agent's composed profile is
// assembled at deploy time from a fixed set of Markdown source files
// (AGENTS.md, IDENTITY.md, ROUTING.md, SOUL.md, TOOLS.md; MEMORY.md is
// deliberately excluded — memory is per-session state, not fixed startup
// cost) plus the skills declared in that workspace's agent.manifest.json.
// Measuring the pre-composition Markdown source is a deliberate scope
// boundary, not an oversight: composed/deployed profiles are adapter-specific
// (Claude Code and Cursor emit Markdown, Codex emits TOML via
// compose-codex.js) and this perspective does not parse or score any of
// those composed formats. A project with no `agents/profiles/` directory
// (i.e. not this repo's own layout) has no ctx signal to measure and scores
// a neutral 1.0 rather than being penalized for a structure it was never
// expected to have.

const CTX_PROFILE_FILES = ['AGENTS.md', 'IDENTITY.md', 'ROUTING.md', 'SOUL.md', 'TOOLS.md'];
const CTX_FILE_SIZE_BASE = 300;
const CTX_FILE_SIZE_RANGE = 1500;
const CTX_FILE_SIZE_HIGH_THRESHOLD = 800;
const CTX_SKILL_COUNT_BASE = 5;
const CTX_SKILL_COUNT_RANGE = 10;
const CTX_SKILL_COUNT_MEDIUM_THRESHOLD = 8;

function ctxFileSizeScore(lines) {
	return Math.min(1, Math.max(0, 1 - (lines - CTX_FILE_SIZE_BASE) / CTX_FILE_SIZE_RANGE));
}

function ctxSkillCountScore(skillCount) {
	return Math.min(1, Math.max(0, 1 - (skillCount - CTX_SKILL_COUNT_BASE) / CTX_SKILL_COUNT_RANGE));
}

export function analyzeCtx(root) {
	const findings = [];
	const profilesDir = path.join(root, 'agents', 'profiles');

	if (!fs.existsSync(profilesDir)) {
		return { id: 'ctx', name: 'Context', score: 1.0, findings };
	}

	const workspaceDirs = fs.readdirSync(profilesDir, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => d.name);

	if (workspaceDirs.length === 0) {
		return { id: 'ctx', name: 'Context', score: 1.0, findings };
	}

	const fileSizeScores = [];
	const skillCountScores = [];

	for (const workspace of workspaceDirs) {
		const workspaceDir = path.join(profilesDir, workspace);
		const agentId = workspace.replace(/-workspace$/, '');

		let totalLines = 0;
		for (const file of CTX_PROFILE_FILES) {
			const filePath = path.join(workspaceDir, file);
			if (fs.existsSync(filePath)) totalLines += countLines(filePath);
		}
		fileSizeScores.push(ctxFileSizeScore(totalLines));

		if (totalLines > CTX_FILE_SIZE_BASE) {
			findings.push({
				id: `ctx-large-profile-${agentId}`,
				priority: totalLines > CTX_FILE_SIZE_HIGH_THRESHOLD ? 'high' : 'medium',
				title: `Reduce ${agentId}'s profile size (${totalLines} lines)`,
				description: `${agentId}'s composed profile (${CTX_PROFILE_FILES.join(', ')}) totals ${totalLines} lines. Every session pays this as a fixed context cost before real work starts — move incident history and conditional protocols behind explicit references, keep the always-loaded contract short.`,
				skill: 'scan-ctx', agent: 'architect', mode: 'architecture',
			});
		}

		let skillCount = 0;
		const manifestPath = path.join(workspaceDir, 'agent.manifest.json');
		if (fs.existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
				skillCount = Array.isArray(manifest.skills) ? manifest.skills.length : 0;
			} catch {}
		}
		skillCountScores.push(ctxSkillCountScore(skillCount));

		if (skillCount > CTX_SKILL_COUNT_MEDIUM_THRESHOLD) {
			findings.push({
				id: `ctx-high-skill-count-${agentId}`,
				priority: 'medium',
				title: `Reduce ${agentId}'s merged skill count (${skillCount})`,
				description: `${agentId}'s manifest declares ${skillCount} skills. Each merged skill adds to the context an agent must read or route through — consolidate overlapping skills or narrow routing for rarely-used ones.`,
				skill: 'scan-ctx', agent: 'architect', mode: 'architecture',
			});
		}
	}

	const avg = arr => arr.reduce((s, n) => s + n, 0) / arr.length;
	const fileSizeScore = r(avg(fileSizeScores));
	const skillCountScore = r(avg(skillCountScores));

	return { id: 'ctx', name: 'Context', score: r((fileSizeScore + skillCountScore) / 2), findings };
}
