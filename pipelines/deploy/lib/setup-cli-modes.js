/**
 * The non-interactive modes of `npm run setup`:
 *
 *   --questions          print every question as JSON (a list), change nothing
 *   --answers <file>     run setup with no prompts, answers read from a JSON file
 *   --secret <id>        read one secret through the masked prompt and store it
 *
 * Machine output is one JSON document on stdout. Everything the setup steps
 * print goes to stderr, so a caller can parse stdout directly.
 *
 * Imported by setup.js only when one of these flags is given. setup.js is the
 * entry point and is still evaluating when it imports this file, so this file
 * must not import setup.js back: the setup functions are passed in (listFn,
 * createRunFn, and `setup` for runSetupCliMode).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input } from 'node:process';
import { createMaskableOutput } from './masked-output.js';
import {
	createAnswerPrompts,
	describeQuestion,
	validateAnswers,
} from './setup-questions.js';

const SKIPPED_DIRS = new Set(['.git']);

// Folders a setup step generates (installed packages, virtual environments,
// caches). Listing every file in them makes the result huge (the Python venv on
// ops is over a thousand files), so the result names each folder once, with a
// trailing slash, and does not look inside.
const GENERATED_DIRS = new Set([
	'node_modules',
	'.venv',
	'venv',
	'__pycache__',
	'.pytest_cache',
	'.cache',
	'.uv-cache',
]);

/**
 * Write all of data to fd. A single fs.writeSync on a pipe can write fewer bytes
 * than asked (a pipe buffer is 64 KB), so loop until every byte is out. A pipe
 * that is momentarily full (EAGAIN) is waited on, not treated as a failure.
 *
 * @param {number} fd
 * @param {string | Buffer} data
 * @param {(fd: number, buf: Buffer, off: number, len: number) => number} [writeSync]
 */
export function writeAllSync(fd, data, writeSync = fs.writeSync) {
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
	let offset = 0;
	while (offset < buf.length) {
		try {
			offset += writeSync(fd, buf, offset, buf.length - offset);
		} catch (err) {
			if (err.code !== 'EAGAIN') throw err;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
}

/**
 * Size and mtime of every file under root, so a run can report which files it
 * created or changed. .git is skipped; a generated folder (node_modules, .venv,
 * caches) is one entry, "<path>/", and is not looked into.
 *
 * @returns {Map<string, string>} hub-relative posix path → "size:mtimeMs"
 */
export function snapshotFiles(root, fsMod = fs) {
	const out = new Map();
	const stack = [''];
	while (stack.length > 0) {
		const rel = stack.pop();
		let entries;
		try {
			entries = fsMod.readdirSync(path.join(root, rel), {
				withFileTypes: true,
			});
		} catch {
			continue;
		}
		for (const entry of entries) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (GENERATED_DIRS.has(entry.name)) out.set(`${childRel}/`, 'dir');
				else if (!SKIPPED_DIRS.has(entry.name)) stack.push(childRel);
			} else if (entry.isFile()) {
				try {
					const st = fsMod.statSync(path.join(root, childRel));
					out.set(childRel, `${st.size}:${st.mtimeMs}`);
				} catch {
					// Vanished between listing and stat: ignore.
				}
			}
		}
	}
	return out;
}

/** Files present after but not before, or whose size or mtime changed. */
export function diffSnapshots(before, after) {
	const changed = [];
	for (const [file, sig] of after) {
		if (before.get(file) !== sig) changed.push(file);
	}
	return changed.sort();
}

/**
 * Run fn with process.stdout.write redirected to stderr. Returns the text that
 * was redirected so the caller can pull warnings out of it.
 */
async function withStdoutOnStderr(fn) {
	const original = process.stdout.write;
	let text = '';
	process.stdout.write = (chunk, ...rest) => {
		text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
		return process.stderr.write(chunk, ...rest);
	};
	try {
		return { value: await fn(), text };
	} catch (error) {
		return { error, text };
	} finally {
		process.stdout.write = original;
	}
}

function warningsFrom(text) {
	return text
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => /\bWARNING\b/.test(l));
}

function readAnswersFile(file, fsMod) {
	let raw;
	try {
		raw = fsMod.readFileSync(file, 'utf-8');
	} catch (err) {
		return { error: `cannot read answers file: ${err.code ?? err.message}` };
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { error: 'answers file is not valid JSON' };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { error: 'answers file must hold one JSON object of id: value' };
	}
	return { answers: parsed };
}

/**
 * `--questions`.
 *
 * @returns {Promise<{exitCode: number, json: unknown}>}
 */
export async function runQuestionsMode({ cliOutputRoot, listFn, ...deps }) {
	const questions = await listFn({ cliOutputRoot, ...deps });
	return { exitCode: 0, json: questions.map(describeQuestion) };
}

/**
 * `--answers <file>`.
 *
 * @returns {Promise<{exitCode: number, json: object, error?: Error, step?: string}>}
 */
export async function runAnswersMode({
	cliOutputRoot,
	answersFile,
	fsMod = fs,
	listFn,
	createRunFn,
	cliArgs = {},
	listDeps = {},
	runDeps = {},
}) {
	if (typeof answersFile !== 'string') {
		return {
			exitCode: 2,
			json: {
				ok: false,
				error: 'usage',
				message: '--answers needs a file path.',
			},
		};
	}
	const read = readAnswersFile(path.resolve(answersFile), fsMod);
	if (read.error) {
		return {
			exitCode: 2,
			json: { ok: false, error: 'invalid-answers-file', message: read.error },
		};
	}
	const { answers } = read;

	const questions = await listFn({
		cliOutputRoot,
		cliArgs,
		answers,
		...listDeps,
	});
	const check = validateAnswers(questions, answers);
	if (!check.ok) {
		return {
			exitCode: 1,
			json: {
				ok: false,
				error: 'invalid-answers',
				missing: check.missing,
				unknown: check.unknown,
				secrets: check.secrets,
				invalid: check.invalid,
			},
		};
	}

	const prompts = createAnswerPrompts(answers);
	let step = '';
	const line = (label = '') => {
		step = label;
		const dashes = '─'.repeat(Math.max(0, 44 - label.length));
		process.stdout.write(`\n── ${label}${dashes}\n\n`);
	};
	const run = createRunFn({
		ask: prompts.ask,
		askYN: prompts.askYN,
		askSecret: prompts.askSecret,
		line,
		fsMod,
		cliOutputRoot,
		tierPluginPort: cliArgs['tier-plugin-port'],
		cliArgs,
		askPermissions: Boolean(cliArgs['ask-permissions']),
		// The answers file stands in for the person at the keyboard.
		isInteractive: () => true,
		...runDeps,
	});

	const before = snapshotFiles(cliOutputRoot, fsMod);
	const { value: outcome, error, text } = await withStdoutOnStderr(run);
	const filesWritten = diffSnapshots(
		before,
		snapshotFiles(cliOutputRoot, fsMod),
	);
	// Printed WARNING lines, then one entry per advisory step that did not finish.
	const warnings = [
		...warningsFrom(text),
		...(Array.isArray(outcome?.warnings)
			? outcome.warnings.map((w) => ({ step: w.step, message: w.message }))
			: []),
	];
	if (error) {
		return {
			exitCode: 1,
			error,
			step,
			json: {
				ok: false,
				error: 'setup-failed',
				message: error.message,
				filesWritten,
				warnings,
			},
		};
	}
	// A plugin step failed: setup ran to the end but did not finish its job, and
	// left no completed-setup stamp. Name the steps so the caller can act.
	if (outcome && outcome.ok === false) {
		const failedSteps = Array.isArray(outcome.failedSteps)
			? outcome.failedSteps
			: [];
		return {
			exitCode: 1,
			json: {
				ok: false,
				error: 'setup-incomplete',
				message: `Setup did not complete. Failed step(s): ${failedSteps.map((f) => f.step).join(', ')}`,
				failedSteps,
				filesWritten,
				warnings,
			},
		};
	}
	return {
		exitCode: 0,
		json: { ok: true, filesWritten, warnings, ignored: check.ignored },
	};
}

/**
 * `--secret <id>`. The value is read through askSecret and handed to the
 * question's own store; it is never part of the result.
 *
 * @returns {Promise<{exitCode: number, json: object}>}
 */
export async function runSecretMode({
	cliOutputRoot,
	id,
	askSecret,
	fsMod = fs,
	listFn,
	cliArgs = {},
	listDeps = {},
}) {
	if (typeof id !== 'string') {
		return {
			exitCode: 2,
			json: {
				ok: false,
				error: 'usage',
				message: '--secret needs a question id.',
			},
		};
	}
	const questions = await listFn({
		cliOutputRoot,
		cliArgs,
		allSecrets: true,
		...listDeps,
	});
	const question = questions.find((q) => q.id === id);
	if (!question) {
		return { exitCode: 1, json: { ok: false, error: 'unknown-question', id } };
	}
	if (!question.secret || typeof question.store !== 'function') {
		return { exitCode: 1, json: { ok: false, error: 'not-a-secret', id } };
	}
	const value = ((await askSecret(question.prompt, question)) ?? '').trim();
	if (!value) {
		return { exitCode: 1, json: { ok: false, error: 'empty-secret', id } };
	}
	await question.store({ hubRoot: cliOutputRoot, fsMod }, value);
	return { exitCode: 0, json: { ok: true, id, stored: true } };
}

/**
 * Entry used by setup.js: pick the mode from the parsed flags, run it, return
 * the exit code and JSON to print. Prompts for a secret go to stderr.
 */
export async function runSetupCliMode({ cliArgs, cliOutputRoot, setup }) {
	const { createRun, createPromptHelpers, listSetupQuestions } = setup;
	const modes = ['questions', 'answers', 'secret'].filter(
		(m) => cliArgs[m] !== undefined,
	);
	if (modes.length > 1) {
		return {
			exitCode: 2,
			json: {
				ok: false,
				error: 'usage',
				message: 'Use only one of --questions, --answers, --secret.',
			},
		};
	}
	const common = {
		cliOutputRoot,
		cliArgs,
		listFn: listSetupQuestions,
	};
	if (cliArgs.questions !== undefined) {
		return runQuestionsMode({
			...common,
			tierPluginPort: cliArgs['tier-plugin-port'],
		});
	}
	if (cliArgs.answers !== undefined) {
		return runAnswersMode({
			...common,
			createRunFn: createRun,
			answersFile: cliArgs.answers,
		});
	}
	// The gate lets askSecret hide what readline echoes (see masked-output.js).
	const gate = createMaskableOutput(process.stderr);
	const rl = readline.createInterface({ input, output: gate });
	try {
		const { askSecret } = createPromptHelpers({
			rl,
			isTty: Boolean(input.isTTY),
			output: gate,
		});
		return await runSecretMode({ ...common, id: cliArgs.secret, askSecret });
	} finally {
		rl.close();
	}
}
