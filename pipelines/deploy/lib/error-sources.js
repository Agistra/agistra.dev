/**
 * error-sources.js — wires the hub's error sources to the error-report sender.
 *
 * Every function here passes the sender only a source name, an error code from
 * the fixed MESSAGES catalogue and, for crashes, the Error object (the sender
 * keeps only function names, hub-relative paths and line numbers from it).
 * No source passes command arguments, file contents, config values or the
 * caller's own message text.
 *
 * Reporting never changes a command's output, exit code or timing beyond the
 * sender's send timeout: with reporting off every function returns after one
 * small config read, and no function throws.
 *
 * Two call styles:
 *   - async  (reportDoctorChecks, reportMemoryResult, reportSetupFailure,
 *             reportSelfCheckBlocked): await it before the command exits.
 *   - sync   (reportErrorSync, installCrashReporter): for hooks and crash
 *             handlers that cannot wait on a promise. These run the sender in
 *             a short child process only when reporting is on.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	MESSAGES,
	SEND_TIMEOUT_MS,
	SETUP_MESSAGES,
	errorReportStatus,
	reportError,
} from './error-report.js';

const REPORT_MODULE_URL = pathToFileURL(
	path.join(path.dirname(fileURLToPath(import.meta.url)), 'error-report.js'),
).href;

const isActive = (state) => state === 'on' || state === 'trial';

/** Setup headings (trimmed) to the step code that stopped. */
export const SETUP_STEP_CODES = {
	'Hub-root dependencies': 'setup-hub-root-dependencies',
	You: 'setup-you',
	Organisation: 'setup-organisation',
	'Agent display names': 'setup-agent-display-names',
	'Remote team': 'setup-remote-team',
	'GitHub workflows': 'setup-github-workflows',
	Cursor: 'setup-cursor',
	GitHub: 'setup-github',
	'GitHub relay': 'setup-github-relay',
	'Relay MCP': 'setup-relay-mcp',
	'Hub settings': 'setup-hub-settings',
	'Hub MCP config': 'setup-hub-mcp-config',
	'Vault plugin config': 'setup-vault-plugin-config',
	'Vault plugins': 'setup-vault-plugins',
	'Projects folder': 'setup-projects-folder',
	'Task CLI permissions': 'setup-task-cli-permissions',
	'Knowledge retrieval': 'setup-knowledge-retrieval',
	'Claude Code statusline': 'setup-claude-code-statusline',
	'Nightly dreaming (Windows only)': 'setup-nightly-dreaming',
	'Error reports': 'setup-error-reports',
	Done: 'setup-done',
};

/** The step code for a setup heading, or the generic one for an unknown heading. */
export function setupStepCode(heading) {
	const key = typeof heading === 'string' ? heading.trim() : '';
	const code = Object.hasOwn(SETUP_STEP_CODES, key)
		? SETUP_STEP_CODES[key]
		: 'setup-failed';
	return Object.hasOwn(SETUP_MESSAGES, code) ? code : 'setup-failed';
}

/** A doctor check id is our own small integer; anything else is not sent as a code. */
function doctorCode(id) {
	const n = typeof id === 'number' ? id : Number.NaN;
	return Number.isInteger(n) && n >= 1 && n <= 999 ? String(n) : 'unknown';
}

const isEpipe = (e) => e?.code === 'EPIPE';

/**
 * A closed pipe (`... | grep -m1`) means the reader went away; it is not a
 * crash. Swallow the stream error so the command runs to its own exit code and
 * exits quietly. Any other stream error still throws, as before.
 *
 * @param {Array<{on:function, listenerCount?:function}>} [streams]
 * @returns {function} the listener, so a test can remove it
 */
export function ignoreClosedPipe(streams = [process.stdout, process.stderr]) {
	const listener = (error) => {
		if (isEpipe(error) || error?.code === 'ERR_STREAM_DESTROYED') return;
		throw error;
	};
	for (const stream of streams) stream?.on?.('error', listener);
	return listener;
}

/**
 * Report every doctor check that ended fail or warn: one report per check per
 * run, the check id as the code. Reports are sent together, so the added wait
 * is one send timeout however many checks failed.
 *
 * @param {Array<{id:number,status:string}>} checks
 * @param {object} [opts] hubRoot, plus the sender's test seams (dsn, timeoutMs, now, messages)
 * @returns {Promise<number>} how many checks were handed to the sender
 */
export async function reportDoctorChecks(checks, opts = {}) {
	try {
		if (!Array.isArray(checks)) return 0;
		const bad = checks.filter(
			(c) => c?.status === 'fail' || c?.status === 'warn',
		);
		if (bad.length === 0) return 0;
		if (
			!isActive(
				errorReportStatus({ hubRoot: opts.hubRoot, now: opts.now }).state,
			)
		)
			return 0;
		await Promise.all(
			bad.map((c) =>
				reportError({ source: 'doctor', code: doctorCode(c.id) }, opts),
			),
		);
		return bad.length;
	} catch {
		return 0;
	}
}

/**
 * Report an `ok: false` result of the memory command, using its code. A code
 * the catalogue does not know is sent as `unspecified`, never as free text.
 *
 * @returns {Promise<boolean>} true when a report was handed to the sender
 */
export async function reportMemoryResult(result, opts = {}) {
	try {
		if (!result || result.ok !== false) return false;
		const code =
			typeof result.code === 'string' && Object.hasOwn(MESSAGES, result.code)
				? result.code
				: 'unspecified';
		await reportError({ source: 'memory', code }, opts);
		return true;
	} catch {
		return false;
	}
}

/**
 * Report a setup step that failed. `heading` is the last step setup announced;
 * `code` names a step directly and wins over `heading`.
 *
 * @returns {Promise<void>}
 */
export async function reportSetupFailure(
	{ heading, code, error } = {},
	opts = {},
) {
	try {
		const stepCode =
			typeof code === 'string' && Object.hasOwn(SETUP_MESSAGES, code)
				? code
				: setupStepCode(heading);
		await reportError({ source: 'setup', code: stepCode, error }, opts);
	} catch {
		// swallowed by contract
	}
}

/** Report a self-check `blocked` verdict. */
export async function reportSelfCheckBlocked(report, opts = {}) {
	try {
		if (report?.verdict !== 'blocked') return false;
		await reportError({ source: 'self-check', code: 'blocked' }, opts);
		return true;
	} catch {
		return false;
	}
}

// The child that sends one report. It reads one JSON payload on stdin and
// hands it to the same sender, so the allowlist code path is the one used
// everywhere else.
const CHILD_SCRIPT = `
import { reportError } from ${JSON.stringify(REPORT_MODULE_URL)};
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const { input, opts } = JSON.parse(raw);
await reportError(
	{ source: input.source, code: input.code, error: { stack: input.stack } },
	opts,
);
`;

/**
 * Report from code that cannot wait on a promise (a hook, or a crash handler
 * that runs just before the process dies). Does nothing, and starts no
 * process, unless reporting is on. Blocks for at most the send timeout plus
 * the child's start-up.
 *
 * @param {{source:string, code:string, error?:Error}} input
 * @param {object} [opts] hubRoot, plus the sender's test seams (dsn, timeoutMs, messages)
 * @returns {boolean} true when a report was handed to the sender
 */
export function reportErrorSync(input, opts = {}) {
	try {
		if (!isActive(errorReportStatus({ hubRoot: opts.hubRoot }).state))
			return false;
		const stack =
			typeof input?.error?.stack === 'string' ? input.error.stack : undefined;
		const childOpts = {};
		for (const key of ['hubRoot', 'dsn', 'timeoutMs', 'messages']) {
			if (opts[key] !== undefined) childOpts[key] = opts[key];
		}
		spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
			input: JSON.stringify({
				input: { source: input?.source, code: input?.code, stack },
				opts: childOpts,
			}),
			stdio: ['pipe', 'ignore', 'ignore'],
			timeout: (opts.timeoutMs ?? SEND_TIMEOUT_MS) + 5000,
			windowsHide: true,
		});
		return true;
	} catch {
		return false;
	}
}

/** Report a hook that failed. `name` is the catalogue code, such as hook-memory-session-start. */
export function reportHookFailure(code, error, opts = {}) {
	return reportErrorSync({ source: 'hook', code, error }, opts);
}

/**
 * Report an uncaught exception or unhandled rejection, then let Node carry on
 * exactly as it does today. The listener is a monitor: it runs before Node's
 * own handling, which still prints the error and sets the exit code.
 *
 * Call it from a command's entry point only, never at import time.
 *
 * @param {object} [opts]
 * @param {'npm-run'|'hook'} [opts.source]
 * @param {string} [opts.hubRoot]
 * @param {function} [opts.report] test seam, replaces reportErrorSync
 * @param {Array} [opts.streams] test seam, replaces [process.stdout, process.stderr]
 * @returns {function} the listener, so a test can remove it
 */
export function installCrashReporter({
	source = 'npm-run',
	report = reportErrorSync,
	streams,
	...rest
} = {}) {
	if (source === 'npm-run') ignoreClosedPipe(streams);
	const listener = (error, origin) => {
		try {
			if (isEpipe(error)) return;
			const kind =
				origin === 'unhandledRejection'
					? 'unhandled-rejection'
					: 'uncaught-exception';
			report({ source, code: `${source}-${kind}`, error }, rest);
		} catch {
			// never change how the process dies
		}
	};
	process.on('uncaughtExceptionMonitor', listener);
	return listener;
}
