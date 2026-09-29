import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
	findCurrentTask,
	findTaskByQuery,
	listAllTasks,
	changeTaskStatus,
	projectDirFromTaskPath,
	buildDispatchPrompt,
} from './lib/tasks.js';

/**
 * Dispatch command — reads the current _todo_ task for a project,
 * lists its required skills, and prints a focused prompt to stdout.
 *
 * Options:
 *   projectsRoot  string   root dir containing project subdirectories
 *   skillsRoot    string   root dir containing skill directories
 *   project       string   target a specific project by name (optional)
 *   advance       boolean  rename current _todo_ → _done_ in done/, then show next
 *   list          boolean  show all projects with todos, in-flight tasks (with state), and dones
 *   launch        boolean  start claude in projectRoot instead of printing prompt
 *   projectRoot   string   absolute path to the sibling project repo (used with launch)
 *   task          string   number or slug fragment to target a specific task in any state
 */
export function dispatch({ projectsRoot, skillsRoot, project, advance, list, launch = false, projectRoot = null, task = null }) {
	// --list: show the full queue across all projects
	if (list) {
		const all = listAllTasks(projectsRoot);
		if (all.length === 0) {
			process.stderr.write(`No projects found in: ${projectsRoot}\n`);
			return;
		}
		console.log('\nProject Queue\n');
		let anyPending = false;
		for (const { project: name, todos, inFlight, dones, unrecognized } of all) {
			const pending = todos.length + inFlight.length;
			const done = dones.length;
			const status = pending === 0 ? 'complete' : `${pending} pending`;
			console.log(`  ${name}  [${status}, ${done} done]`);
			for (const f of todos) {
				console.log(`    → ${f}`);
			}
			for (const { file, state } of inFlight) {
				console.log(`    → ${file.replace(`_${state}_`, ` [${state}] `)}`);
			}
			for (const { file, status: s } of unrecognized) {
				console.log(`    ⚠ ${file} [unrecognized status: ${s}]`);
			}
			if (pending > 0) anyPending = true;
		}
		if (!anyPending) console.log('\n  All projects complete.');
		console.log('');
		return;
	}

	// Resolve which task to act on
	const taskPath = resolveTask(projectsRoot, project, task);
	if (!taskPath) return;

	// --advance: mark current done and show next
	if (advance) {
		const donePath = changeTaskStatus(taskPath);
		process.stderr.write(`\n[dispatch] Done: ${path.basename(donePath)}\n`);

		const next = findCurrentTask(projectDirFromTaskPath(taskPath));
		if (!next) {
			process.stderr.write('[dispatch] All tasks complete for this project.\n\n');
			return;
		}

		process.stderr.write(`[dispatch] Next: ${path.basename(next)}\n\n`);
		if (launch && !projectRoot) {
			process.stderr.write('[dispatch] --launch requires a project name. Use: dispatch --project <name> --launch\n');
			process.exit(1);
		}
		if (launch) {
			launchClaude(next, skillsRoot, projectRoot);
		} else {
			printPrompt(next, skillsRoot);
		}
		return;
	}

	// Default: print prompt or launch Claude
	if (launch && !projectRoot) {
		process.stderr.write('[dispatch] --launch requires a project name. Use: dispatch --project <name> --launch\n');
		process.exit(1);
	}
	if (launch) {
		launchClaude(taskPath, skillsRoot, projectRoot);
	} else {
		printPrompt(taskPath, skillsRoot);
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

function resolveTask(projectsRoot, project, task) {
	if (project) {
		const projectDir = path.join(projectsRoot, project);
		if (task) {
			const found = findTaskByQuery(projectDir, task);
			if (!found) {
				process.stderr.write(`No task matching "${task}" in project: ${project}\n`);
			}
			return found;
		}
		const found = findCurrentTask(projectDir);
		if (!found) {
			process.stderr.write(`No pending tasks for project: ${project}\n`);
		}
		return found;
	}

	// Auto-pick: lowest todo task across all projects (only auto-dispatchable state)
	const all = listAllTasks(projectsRoot);
	const first = all.find(p => p.todos.length > 0);
	if (!first) {
		process.stderr.write('No pending tasks found across any project.\n');
		return null;
	}
	return path.join(first.projectDir, first.todos[0]);
}

function printPrompt(taskPath, skillsRoot) {
	const result = buildDispatchPrompt(taskPath, skillsRoot);

	// Routing summary → stderr so it doesn't pollute the copyable prompt on stdout
	process.stderr.write(
		`[dispatch] agent=${result.meta.agent ?? '?'}  ` +
		`mode=${result.meta.mode ?? '?'}  ` +
		`model=${result.model}\n` +
		`[dispatch] skills=[${result.injectedSkills.join(', ')}]` +
		(result.missingSkills.length > 0 ? `  unknown=[${result.missingSkills.join(', ')}]` : '') +
		`\n\n`
	);

	// Full prompt → stdout (copy-paste into Claude Code, or pipe anywhere)
	process.stdout.write(result.prompt + '\n');
}

function launchClaude(taskPath, skillsRoot, projectRoot) {
	const result = buildDispatchPrompt(taskPath, skillsRoot);

	process.stderr.write(
		`[dispatch] agent=${result.meta.agent ?? '?'}  ` +
		`mode=${result.meta.mode ?? '?'}  ` +
		`model=${result.model}\n` +
		`[dispatch] skills=[${result.injectedSkills.join(', ')}]` +
		(result.missingSkills.length > 0 ? `  unknown=[${result.missingSkills.join(', ')}]` : '') +
		`\n` +
		`[dispatch] launching claude in: ${projectRoot}\n\n`
	);

	// Start Claude non-interactively in the sibling project directory.
	// cwd causes claude to load that project's CLAUDE.md, agents, and settings.
	spawnSync('claude', ['-p', result.prompt, '--model', result.model], {
		cwd: projectRoot,
		stdio: 'inherit',
		shell: false,
	});
}
