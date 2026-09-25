import fs from 'node:fs';
import path from 'node:path';
import { scanProject, loadHealth, saveHealth, generateTasks } from './lib/scanner.js';
import { registerProject } from './lib/bootstrap.js';

const SCORE_BAR = (s) => {
	const filled = Math.round(s * 10);
	return '█'.repeat(filled) + '░'.repeat(10 - filled);
};

const TREND = (t) => {
	if (t === null || t === undefined) return '';
	if (t > 0) return ` ▲${t.toFixed(2)}`;
	if (t < 0) return ` ▼${Math.abs(t).toFixed(2)}`;
	return ' →';
};

/**
 * Render the latest scan result as a Markdown snapshot for projects/<projectName>/README.md.
 * Reuses the same Perspective Scores bar-chart format as the terminal output.
 *
 * Returns a Markdown string (caller is responsible for writing it to disk).
 */
export function renderReadme({ projectName, perspectives, overall, allFindings, tasks, prev }) {
	const lines = [`# ${projectName} — Project Scan`, ''];

	lines.push('## Perspective Scores', '', '```', '─'.repeat(50));
	for (const p of perspectives) {
		const prevScore = prev?.perspectives?.[p.id]?.score ?? null;
		const trend = prevScore !== null ? p.score - prevScore : null;
		const flag = p.score === Math.min(...perspectives.map(x => x.score)) ? ' ← lowest' : '';
		lines.push(`  ${p.id.toUpperCase().padEnd(4)} ${p.name.padEnd(12)} ${SCORE_BAR(p.score)}  ${p.score.toFixed(2)}${TREND(trend)}${flag}`);
	}
	lines.push('─'.repeat(50));
	lines.push(`       ${'Overall'.padEnd(12)} ${SCORE_BAR(overall)}  ${overall.toFixed(2)}`);
	lines.push('```', '');

	if (allFindings.length === 0) {
		lines.push('No issues found — project looks healthy.', '');
		return lines.join('\n');
	}

	lines.push('## Issues Found', '', '| Priority | Issue |', '|----------|-------|');
	for (const f of allFindings) {
		lines.push(`| ${f.priority.toUpperCase()} | ${f.title} |`);
	}
	lines.push('');

	lines.push('## Tasks', '', '| Task | Description |', '|------|-------------|');
	if (tasks.length === 0) {
		lines.push('| — | All issues already have task files — nothing new to create. |');
	} else {
		for (const { filename, content } of tasks) {
			const taskId = filename.match(/^(task_\d+)_/)?.[1] ?? filename;
			const title = content.match(/^#\s+(.+)$/m)?.[1] ?? filename;
			lines.push(`| [${taskId}](${filename}) | ${title} |`);
		}
	}
	lines.push('');

	return lines.join('\n');
}

/**
 * Scan a project directory for quality issues and generate task files.
 *
 * Options:
 *   projectRoot   string   absolute path to the project repo to scan
 *   projectName   string   name of the project (used in filenames and content)
 *   projectsDir   string   absolute path to the projects/<name>/ queue directory
 *   hubRoot       string   optional absolute path to the hub root — used to
 *                          resolve Graphify's own graph.json location. Absent
 *                          (e.g. a deploy target with no Graphify integration)
 *                          means the Graphify-preference check is skipped and
 *                          dep-graph.js's own scan is always used.
 *   dryRun        boolean  print what would be written without writing files
 */
export function scan({ projectRoot, projectName, projectsDir, hubRoot, dryRun = false }) {
	if (!projectRoot || !projectName) {
		process.stderr.write('[scan] --project <name> is required\n');
		process.exit(1);
	}

	process.stderr.write(`[scan] scanning ${projectRoot}\n\n`);

	// Prefer Graphify's own graph.json over dep-graph.js's own scan when the
	// project has one. Graphify always writes to
	// .graphify/<project>/graphify-out/graph.json under the hub root
	// (graph-cli.js's resolveGraphifyDir()/resolveGraphifyOutDir() build the
	// identical path — deliberately re-derived here with a plain path.join()
	// rather than imported, since scan.js ships to every hub tier
	// unconditionally while graph-cli.js only ships to Graphify-capable
	// tiers; a static import would break module resolution on tiers that
	// never copy graph-cli.js) — independent of projectsDir, since a
	// project's repoPath can point anywhere (workspace.config.json →
	// projects.<name>.repoPath).
	const graphJsonPath = hubRoot
		? path.join(hubRoot, '.graphify', projectName, 'graphify-out', 'graph.json')
		: undefined;
	const { perspectives, overall, allFindings } = scanProject({ projectDir: projectRoot, graphJsonPath });

	// Register this project in workspace.config.json's projects.<name> map so
	// later consumers (graph-cli.js's resolveRepoPath(), graph-lens-gate.js,
	// ticket-drift.js) can resolve it without hand-editing the config first.
	// Never overwrites an already-registered project (see registerProject()
	// docs) — only fills in repoPath for projects scan doesn't yet know about.
	if (!dryRun && hubRoot) {
		registerProject(hubRoot, projectName, { repoPath: projectRoot });
	}

	// Load previous health for trend comparison
	const prev = loadHealth(projectsDir);

	// Print perspective scores
	if (perspectives.length > 0) {
		console.log('Perspective Scores');
		console.log('─'.repeat(50));
		for (const p of perspectives) {
			const prevScore = prev?.perspectives?.[p.id]?.score ?? null;
			const trend = prevScore !== null ? p.score - prevScore : null;
			const flag = p.score === Math.min(...perspectives.map(x => x.score)) ? ' ← lowest' : '';
			console.log(`  ${p.id.toUpperCase().padEnd(4)} ${p.name.padEnd(12)} ${SCORE_BAR(p.score)}  ${p.score.toFixed(2)}${TREND(trend)}${flag}`);
		}
		const prevOverall = prev?.overall ?? null;
		const overallTrend = prevOverall !== null ? overall - prevOverall : null;
		console.log('─'.repeat(50));
		console.log(`       ${'Overall'.padEnd(12)} ${SCORE_BAR(overall)}  ${overall.toFixed(2)}${TREND(overallTrend)}`);
		console.log();
	}

	if (allFindings.length === 0) {
		console.log('No issues found — project looks healthy.');
		if (!dryRun && perspectives.length > 0) {
			saveHealth(projectsDir, projectName, perspectives, overall);
			fs.mkdirSync(projectsDir, { recursive: true });
			const readme = renderReadme({ projectName, perspectives, overall, allFindings, tasks: [], prev });
			fs.writeFileSync(path.join(projectsDir, 'README.md'), readme, 'utf-8');
		}
		return;
	}

	console.log(`Found ${allFindings.length} issue(s):\n`);
	for (const f of allFindings) {
		console.log(`  [${f.priority.toUpperCase().padEnd(8)}] ${f.title}`);
	}

	const tasks = generateTasks({ allFindings, projectName, projectsDir });

	if (tasks.length === 0) {
		console.log('\nAll issues already have task files — nothing new to create.');
	} else {
		console.log(`\n${dryRun ? 'Would create' : 'Creating'} ${tasks.length} task(s):\n`);
		fs.mkdirSync(projectsDir, { recursive: true });
		for (const { filename, content } of tasks) {
			console.log(`  → ${filename}`);
			if (!dryRun) fs.writeFileSync(path.join(projectsDir, filename), content, 'utf-8');
		}
	}

	if (!dryRun) {
		saveHealth(projectsDir, projectName, perspectives, overall);
		const readme = renderReadme({ projectName, perspectives, overall, allFindings, tasks, prev });
		fs.writeFileSync(path.join(projectsDir, 'README.md'), readme, 'utf-8');
		if (tasks.length > 0) {
			console.log(`\nRun "node pipelines/deploy/index.js dispatch --list" to see the updated queue.`);
		}
	}
}
