/**
 * error-report.js — the opt-in hub error-report sender.
 *
 * One call, `reportError({ source, code, message, error })`, builds an event
 * ONLY from the field allowlist, appends it to the hub's local
 * log, then posts it to Sentry's envelope endpoint. No Sentry SDK, no
 * dependency. Nothing is read from the caller's input except the fields named
 * here, and every free-text field is scrubbed:
 *
 *   - source, code      : matched against a fixed enum / strict pattern
 *   - message           : the fixed MESSAGES catalogue text for `code`, never
 *                         caller text. Unknown code sends "<no message>".
 *   - stack             : function names + hub-relative path + line numbers
 *   - hub version, tier, adapter, OS family+version, Node version
 *   - report id         : from workspace.config.json errorReports.reportId
 *
 * Gate: send only when errorReports.choice is "yes"
 * and the hub is on a paid tier, or on a free tier inside its 90-day trial.
 * This module only READS workspace.config.json; setup writes it:
 *   errorReports: { choice: "yes"|"no", decidedAt, trialStartedAt, reportId }
 *
 * The caller's own message text is kept ONLY in the local log line, under
 * `local_only_caller_message` (scrubbed), and is never posted.
 *
 * MESSAGES holds the real error codes the error sources report with. A code
 * with no entry sends "<no message>". Tests may inject their own catalogue
 * through the test-only `messages` option.
 *
 * reportError is async: callers MUST await it, or the log and send may not
 * complete before the process exits.
 *
 * A failure never throws and never delays the caller beyond SEND_TIMEOUT_MS.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { effectiveHubType } from './hub-type.js';

/**
 * The Sentry project DSN. Public by design: it can only
 * submit events, so published code carries no secret. Nothing is sent unless
 * the operator has opted in. An empty value would write the local log and skip
 * the send. This is the one place the DSN lives.
 */
export const SENTRY_DSN =
	'https://6cc947deff11ab9efdd5ad6e44399d9e@o4512446597300224.ingest.de.sentry.io/4512446624890960';

/**
 * Highest doctor check id that has a catalogue entry. Doctor check ids are
 * small integers shared by the core checks and the tier plugins.
 */
export const DOCTOR_CHECK_ID_MAX = 36;

/** Setup step codes. Each step is announced by one setup heading. */
export const SETUP_MESSAGES = {
	'setup-failed': 'Setup stopped with an error before its first step.',
	'setup-hub-root-dependencies':
		'Setup stopped with an error. The last step announced was hub-root dependencies.',
	'setup-you':
		'Setup stopped with an error. The last step announced was operator details.',
	'setup-organisation':
		'Setup stopped with an error. The last step announced was organisation.',
	'setup-agent-display-names':
		'Setup stopped with an error. The last step announced was agent display names.',
	'setup-remote-team':
		'Setup stopped with an error. The last step announced was remote team.',
	'setup-github-workflows':
		'Setup stopped with an error. The last step announced was GitHub workflows.',
	'setup-cursor':
		'Setup stopped with an error. The last step announced was Cursor.',
	'setup-github':
		'Setup stopped with an error. The last step announced was GitHub.',
	'setup-github-relay':
		'Setup stopped with an error. The last step announced was GitHub relay.',
	'setup-relay-mcp':
		'Setup stopped with an error. The last step announced was relay MCP.',
	'setup-hub-settings':
		'Setup stopped with an error. The last step announced was hub settings.',
	'setup-hub-mcp-config':
		'Setup stopped with an error. The last step announced was hub MCP config.',
	'setup-vault-plugin-config':
		'Setup stopped with an error. The last step announced was vault plugin config.',
	'setup-vault-plugins':
		'Setup stopped with an error. The last step announced was vault plugins.',
	'setup-projects-folder':
		'Setup stopped with an error. The last step announced was projects folder.',
	'setup-task-cli-permissions':
		'Setup stopped with an error. The last step announced was task CLI permissions.',
	'setup-knowledge-retrieval':
		'Setup stopped with an error. The last step announced was knowledge retrieval.',
	'setup-claude-code-statusline':
		'Setup stopped with an error. The last step announced was Claude Code statusline.',
	'setup-nightly-dreaming':
		'Setup stopped with an error. The last step announced was nightly dreaming.',
	'setup-error-reports':
		'Setup stopped with an error. The last step announced was error reports.',
	'setup-done':
		'Setup stopped with an error. The last step announced was Done.',
	'setup-disable-nightly-dreaming':
		'Setup could not disable the nightly dreaming task.',
};

/** Memory command result codes: the `code` of an `ok: false` result. */
export const MEMORY_MESSAGES = {
	'agent-not-keyed':
		'The memory command refused an agent that has no keyed memory.',
	'ambiguous-id': 'The memory command found more than one entry for an id.',
	'archive-exists': 'The memory command found an archive that already exists.',
	'duplicate-key': 'The memory command refused a key that already exists.',
	'entry-too-large': 'The memory command refused an entry over the size limit.',
	'entry-unreadable': 'The memory command could not read a memory entry.',
	'hot-over-ceiling': 'The memory command found the hot tier over its ceiling.',
	'index-not-generated':
		'The memory command could not generate a memory index.',
	'invalid-agent': 'The memory command was given an invalid agent.',
	'invalid-config': 'The memory command found an invalid memory configuration.',
	'invalid-entry': 'The memory command found an invalid memory entry.',
	'invalid-field': 'The memory command was given an invalid field.',
	'invalid-key': 'The memory command was given an invalid key.',
	'invalid-promotion-target':
		'The memory command was given an invalid promotion target.',
	'invalid-summary': 'The memory command was given an invalid summary.',
	'invalid-tier': 'The memory command was given an invalid tier.',
	'invalid-usage': 'The memory command was used incorrectly.',
	'key-archived': 'The memory command refused a key that is archived.',
	'mixed-agent': 'The memory command found mixed agent layouts.',
	'mixed-state': 'The memory command found a mixed migration state.',
	'not-adoptable': 'The memory command found a rule that cannot be adopted.',
	'not-found': 'The memory command could not find what it was asked for.',
	'not-vault-tier': 'The memory command needs a vault-backed hub tier.',
	'note-unreadable': 'The memory command could not read a note.',
	'path-outside-memory':
		'The memory command refused a path outside the memory folder.',
	'protected-entry': 'The memory command refused to change a protected entry.',
	'read-failed': 'The memory command could not read a file.',
	'read-only': 'The memory command refused a write in read-only mode.',
	'reserved-agent': 'The memory command refused a reserved agent name.',
	'round-trip-failed': 'The memory command failed its migration round trip.',
	'rule-exists': 'The memory command refused a rule that already exists.',
	'secret-detected':
		'The memory command refused text that looks like a secret.',
	'section-not-found': 'The memory command could not find a section.',
	'single-note-agent':
		'The memory command refused an agent that keeps a single note.',
	'supersedes-not-found':
		'The memory command could not find the entry to supersede.',
	'target-exists': 'The memory command refused to overwrite an existing file.',
	'team-lead-required': 'The memory command needs the team lead to approve.',
	'test-hook-refused': 'The memory command refused a test hook.',
	'unexpected-error': 'The memory command hit an unexpected error.',
	'unsupported-shape': 'The memory command found an unsupported layout.',
	'write-failed': 'The memory command could not write a file.',
	'write-verify-failed': 'The memory command could not verify a written file.',
	unspecified: 'The memory command failed without an error code.',
};

/**
 * Fixed message text per error code. Placeholders only, never real values.
 *
 *   doctor      "1" to "35", the check id (shared by core checks and plugins)
 *   setup       setup-<step>, the setup step that stopped
 *   self-check  blocked
 *   memory      the result code of the failed memory command
 *   hook        hook-<name>, hook-uncaught-exception, hook-unhandled-rejection
 *   npm-run     npm-run-uncaught-exception, npm-run-unhandled-rejection
 */
export const MESSAGES = {
	...Object.fromEntries(
		Array.from({ length: DOCTOR_CHECK_ID_MAX }, (_, i) => [
			String(i + 1),
			`Doctor check ${i + 1} reported a failure or a warning.`,
		]),
	),
	...SETUP_MESSAGES,
	blocked: 'Self-check returned a blocked verdict.',
	...MEMORY_MESSAGES,
	'hook-memory-session-start':
		'The memory session-start hook failed and was skipped.',
	'hook-memory-work-marker':
		'The memory work-marker hook failed and was skipped.',
	'hook-memory-check-codex':
		'The Codex memory reminder hook failed and was skipped.',
	'hook-relay-autostart': 'The relay autostart hook failed.',
	'hook-graph-lens-gate':
		'The graph-lens gate hook failed and allowed the tool call.',
	'hook-secret-scan-gate':
		'The secret-scan gate hook failed and allowed the tool call.',
	'hook-knowledge-start': 'The knowledge start hook failed.',
	'hook-uncaught-exception': 'A hub hook crashed with an uncaught exception.',
	'hook-unhandled-rejection':
		'A hub hook crashed with an unhandled promise rejection.',
	'npm-run-uncaught-exception':
		'An npm run command crashed with an uncaught exception.',
	'npm-run-unhandled-rejection':
		'An npm run command crashed with an unhandled promise rejection.',
};
export const NO_MESSAGE = '<no message>';

export const SEND_TIMEOUT_MS = 3000;
export const TRIAL_DAYS = 90;
export const LOG_RELATIVE_PATH = path.join('logs', 'error-reports.log');

export const PAID_TIERS = ['dev:sub', 'dev:sub:graph', 'ops', 'ops:graph'];
export const FREE_TIERS = ['dev', 'dev:graph'];
export const SOURCES = [
	'doctor',
	'setup',
	'self-check',
	'memory',
	'hook',
	'npm-run',
];

/** Every key an event may contain, by path. The allowlist test enforces it. */
export const EVENT_KEYS = {
	top: [
		'event_id',
		'timestamp',
		'platform',
		'level',
		'release',
		'message',
		'tags',
		'contexts',
		'exception',
	],
	tags: ['source', 'code', 'tier', 'adapter', 'report_id'],
	contexts: ['os', 'runtime'],
	os: ['name', 'version'],
	runtime: ['name', 'version'],
	exception: ['values'],
	exceptionValue: ['type', 'value', 'stacktrace'],
	stacktrace: ['frames'],
	frame: ['function', 'filename', 'lineno'],
};

const MAX_MESSAGE = 200;
const MAX_FRAMES = 30;

const hubRootDefault = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
);

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * Opt-in state for a hub. Read-only.
 *
 * @param {object} [opts]
 * @param {string} [opts.hubRoot]
 * @param {Date}   [opts.now]
 * @returns {{ state: 'off'|'trial'|'on'|'ended', daysLeft: number|null, tier?: string, reportId?: string }}
 */
export function errorReportStatus({ hubRoot = hubRootDefault, now } = {}) {
	const off = { state: 'off', daysLeft: null };
	try {
		const config = readJson(path.join(hubRoot, 'workspace.config.json'));
		const er = config?.errorReports;
		if (!er || er.choice !== 'yes') return off;
		const reportId = er.reportId;
		if (typeof reportId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(reportId))
			return off;
		const tier = effectiveHubType(hubRoot, config);
		if (PAID_TIERS.includes(tier))
			return { state: 'on', daysLeft: null, tier, reportId };
		if (!FREE_TIERS.includes(tier)) return off;
		const started = Date.parse(er.trialStartedAt);
		if (Number.isNaN(started)) return off;
		const t = (now ?? new Date()).getTime();
		const elapsedDays = Math.max(0, Math.floor((t - started) / 86400000));
		if (elapsedDays >= TRIAL_DAYS)
			return { state: 'ended', daysLeft: 0, tier, reportId };
		return {
			state: 'trial',
			daysLeft: TRIAL_DAYS - elapsedDays,
			tier,
			reportId,
		};
	} catch {
		return off;
	}
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeUser() {
	try {
		return os.userInfo().username;
	} catch {
		return '';
	}
}

/** Replace paths, names, values and token-like strings with placeholders. */
export function scrubMessage(message, hubRoot = hubRootDefault) {
	if (typeof message !== 'string') return '';
	let s = message.split(/\r?\n/)[0];
	// Known-sensitive literals first: hub path, home, user and machine names.
	const literals = [hubRoot, os.homedir(), safeUser(), os.hostname()]
		.filter((v) => typeof v === 'string' && v.length >= 3)
		.sort((a, b) => b.length - a.length);
	for (const lit of literals) {
		s = s.replace(
			new RegExp(escapeRe(lit) + String.raw`[^\s'"\x60),;]*`, 'gi'),
			'<path>',
		);
	}
	// Environment variable values.
	for (const v of Object.values(process.env)) {
		if (typeof v === 'string' && v.length >= 6 && !/^[\d.]+$/.test(v)) {
			s = s.split(v).join('<value>');
		}
	}
	s = s
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
		.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
		.replace(/[A-Za-z]:[\\/][^\s'"`),;]*/g, '<path>')
		.replace(/\\\\[^\s'"`),;]+/g, '<path>')
		.replace(/(^|[\s('"=:])~?(\/[^\s'"`),;]+)+/g, '$1<path>')
		.replace(/(^|[\s('"=:])\.{1,2}[\\/][^\s'"`),;]*/g, '$1<path>')
		.replace(/(["'`])(?:(?!\1).)*\1/g, '<value>')
		.replace(/\b([A-Za-z_][\w.-]*)=\S+/g, '$1=<value>')
		.replace(/\b[A-Za-z0-9_-]{20,}\b/g, '<value>')
		.replace(/\b[A-Fa-f0-9]{12,}\b/g, '<value>');
	return s.slice(0, MAX_MESSAGE);
}

function safeFileUrl(u) {
	try {
		return fileURLToPath(u);
	} catch {
		return null;
	}
}

function toHubRelative(file, hubRoot) {
	if (typeof file !== 'string') return null;
	const f = file.startsWith('file://') ? safeFileUrl(file) : file;
	if (!f) return null;
	if (f.startsWith('node:')) return /^node:[\w/.-]{1,40}$/.test(f) ? f : null;
	const rel = path.relative(hubRoot, path.resolve(f));
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
	const norm = rel.split(path.sep).join('/');
	// Dependencies are not our code and their names may reveal choices.
	if (norm.startsWith('node_modules/')) return null;
	return /^[\w@.\-/]{1,120}$/.test(norm) ? norm : null;
}

/** Stack frames: function name + hub-relative file + line. Nothing else. */
export function buildFrames(error, hubRoot = hubRootDefault) {
	const stack = typeof error?.stack === 'string' ? error.stack : '';
	const frames = [];
	for (const line of stack.split('\n')) {
		const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?\s*$/.exec(line);
		if (!m) continue;
		const fn = m[1] && /^[\w$.<>[\] ]{1,80}$/.test(m[1]) ? m[1] : '<anonymous>';
		const filename = toHubRelative(m[2], hubRoot) ?? '<external>';
		frames.push({ function: fn, filename, lineno: Number(m[3]) });
		if (frames.length >= MAX_FRAMES) break;
	}
	// Sentry wants the oldest frame first.
	return frames.reverse();
}

export function detectAdapter(hubRoot) {
	const has = (p) => fs.existsSync(path.join(hubRoot, p));
	if (has('.claude')) return 'claude-code';
	if (has('.codex') || has('.agents')) return 'codex';
	if (has('.cursor')) return 'cursor';
	if (has(path.join('.github', 'agents'))) return 'copilot';
	return 'unknown';
}

export function readHubVersion(hubRoot) {
	try {
		const raw = fs.readFileSync(path.join(hubRoot, 'VERSION'), 'utf-8');
		// The packaged file carries a trailing release-tooling comment after the
		// version on its first line; drop it before the strict check.
		const v = raw.split(/\r?\n/, 1)[0].replace(/#.*$/, '').trim();
		return /^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(v) ? v : 'unknown';
	} catch {
		return 'unknown';
	}
}

/**
 * Build the event. Only allowlisted values reach the result, each validated
 * or scrubbed. Unknown input fields are never read.
 */
export function buildEvent(
	{ source, code, error } = {},
	{
		hubRoot = hubRootDefault,
		tier,
		reportId,
		now = new Date(),
		messages = MESSAGES,
	} = {},
) {
	const src = SOURCES.includes(source) ? source : 'other';
	const cd =
		typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)
			? code
			: 'unknown';
	const text = Object.hasOwn(messages, cd)
		? scrubMessage(messages[cd], hubRoot)
		: NO_MESSAGE;
	return {
		event_id: crypto.randomBytes(16).toString('hex'),
		timestamp: now.toISOString(),
		platform: 'node',
		level: 'error',
		release: readHubVersion(hubRoot),
		message: text,
		tags: {
			source: src,
			code: cd,
			tier: tier ?? 'unknown',
			adapter: detectAdapter(hubRoot),
			report_id: reportId,
		},
		contexts: {
			os: { name: process.platform, version: os.release() },
			runtime: { name: 'node', version: process.versions.node },
		},
		exception: {
			values: [
				{
					type: src,
					value: text,
					stacktrace: { frames: buildFrames(error, hubRoot) },
				},
			],
		},
	};
}

/**
 * Name of the environment variable that redirects reports, for pointing a hub
 * at a local listener or a test Sentry project. It changes only the
 * destination: the opt-in, tier and trial gate is unchanged, and setup never
 * writes it.
 */
export const DSN_ENV_VAR = 'AGISTRA_ERROR_REPORTS_DSN';

/**
 * The DSN a report goes to: opts.dsn, else the environment variable, else
 * SENTRY_DSN. An unset or empty variable falls back to SENTRY_DSN. A non-empty
 * value that does not parse is returned as is, so the send is skipped and a
 * typo never sends to the production project.
 */
export function resolveDsn(opts = {}, env = process.env) {
	if (opts.dsn !== undefined && opts.dsn !== null) return opts.dsn;
	const fromEnv = env?.[DSN_ENV_VAR];
	if (typeof fromEnv === 'string' && fromEnv.trim() !== '')
		return fromEnv.trim();
	return SENTRY_DSN;
}

/** Parse https://KEY@host[:port]/PROJECT. Returns null when empty/invalid. */
export function parseDsn(dsn) {
	if (typeof dsn !== 'string' || !dsn) return null;
	try {
		const u = new URL(dsn);
		const projectId = u.pathname.replace(/^\/+/, '');
		if (!u.username || !projectId || !/^https?:$/.test(u.protocol)) return null;
		return {
			protocol: u.protocol,
			host: u.hostname,
			port: u.port,
			key: u.username,
			projectId,
		};
	} catch {
		return null;
	}
}

export function buildEnvelope(event, dsn) {
	return [
		JSON.stringify({
			event_id: event.event_id,
			sent_at: event.timestamp,
			dsn,
		}),
		JSON.stringify({ type: 'event' }),
		JSON.stringify(event),
	].join('\n');
}

function post(parsed, body, timeoutMs) {
	return new Promise((resolve) => {
		let done = false;
		let req;
		let timer;
		const finish = (ok) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				req?.destroy();
			} catch {
				// ignore
			}
			resolve(ok);
		};
		timer = setTimeout(() => finish(false), timeoutMs);
		try {
			const lib = parsed.protocol === 'https:' ? https : http;
			req = lib.request(
				{
					method: 'POST',
					host: parsed.host,
					port: parsed.port || undefined,
					path: `/api/${parsed.projectId}/envelope/?sentry_version=7&sentry_key=${encodeURIComponent(parsed.key)}`,
					headers: {
						'Content-Type': 'application/x-sentry-envelope',
						'Content-Length': Buffer.byteLength(body),
					},
				},
				(res) => {
					res.resume();
					res.on('end', () => finish(res.statusCode < 300));
					res.on('error', () => finish(false));
				},
			);
			req.on('error', () => finish(false));
			req.end(body);
		} catch {
			finish(false);
		}
	});
}

/**
 * Report an error. Never throws. Resolves within SEND_TIMEOUT_MS.
 *
 * @param {{source:string, code:string, message?:string, error?:Error}} input
 * @param {object} [opts]  test seams: hubRoot, dsn, timeoutMs, now. The
 *   destination is opts.dsn, else AGISTRA_ERROR_REPORTS_DSN, else SENTRY_DSN.
 * @returns {Promise<{state:string, logged:boolean, sent:boolean}>}
 */
export async function reportError(input, opts = {}) {
	const result = { state: 'off', logged: false, sent: false };
	try {
		const hubRoot = opts.hubRoot ?? hubRootDefault;
		const status = errorReportStatus({ hubRoot, now: opts.now });
		result.state = status.state;
		if (status.state !== 'trial' && status.state !== 'on') return result;
		const event = buildEvent(input ?? {}, {
			hubRoot,
			tier: status.tier,
			reportId: status.reportId,
			now: opts.now,
			messages: opts.messages,
		});
		try {
			const logFile = path.join(hubRoot, LOG_RELATIVE_PATH);
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			const logEntry = {
				...event,
				local_only_caller_message: scrubMessage(input?.message, hubRoot),
			};
			fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
			result.logged = true;
		} catch {
			// a log failure must not block the caller
		}
		const dsn = resolveDsn({ ...opts, hubRoot });
		const parsed = parseDsn(dsn);
		if (!parsed) return result;
		result.sent = await post(
			parsed,
			buildEnvelope(event, dsn),
			opts.timeoutMs ?? SEND_TIMEOUT_MS,
		);
	} catch {
		// swallowed by contract
	}
	return result;
}
