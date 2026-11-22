/**
 * error-report-optin.js — the setup question, the saved choice, the doctor
 * status row and the trial messages for hub error reports.
 *
 * The sender and the status function live in error-report.js; this module
 * only decides what to ask, what to save and what to print. Everything here
 * prints to the terminal from `npm run setup` and `npm run doctor`. Nothing
 * in it is called from a hook or a session-start path.
 *
 * Saved shape (workspace.config.json):
 *   errorReports: {
 *     choice: "yes"|"no", decidedAt, reportId, trialStartedAt,
 *     endNoticeShownAt
 *   }
 * trialStartedAt is set only on a free tier. endNoticeShownAt records that the
 * trial end notice was shown.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
	FREE_TIERS,
	PAID_TIERS,
	TRIAL_DAYS,
	errorReportStatus,
} from './error-report.js';
import { effectiveHubType } from './hub-type.js';
import { defineQuestion } from './setup-questions.js';

export const UPGRADE_URL = 'https://agistra.ai/pricing';

const DAY_MS = 86400000;

// ── Wording ──────────────────────────────────────────────────────────────────
// Every string is kept to 72 characters per line or less. The wording is
// final: change it only with a new wording decision.

const NEVER_SENT = [
	'Never sent: your code, files, vault notes, memory, tickets, project',
	'names, config values, environment variables, command arguments, folder',
	'paths, usernames or machine name. Sentry, our error service, does not',
	'store your IP address.',
];

export const PAID_PROMPT = [
	'Error reports (optional, off unless you say yes)',
	'',
	'When a hub tool fails (doctor, setup, self-check, memory, a hook or an',
	'npm run command), the hub can send us a short report so we can fix it.',
	'',
	'Sent: the error code, a fixed message for that code, a stack trace',
	'with hub-relative file paths, hub version, tier, adapter, OS, Node',
	'version and a random report id.',
	'',
	...NEVER_SENT,
	'',
	"Every report is written to the hub's logs/ folder before it is sent.",
	'Change this later: npm.cmd run setup -- --error-reports on|off',
	'',
].join('\n');

export const PAID_QUESTION = 'Send error reports?';

export const FREE_PROMPT = [
	'Error reports: 90-day trial (optional, off unless you say yes)',
	'',
	'When a hub tool fails (doctor, setup, self-check, memory, a hook or an',
	'npm run command), the hub can send us a short report. We use reports',
	'to find bugs in the hub.',
	'',
	'Sent: the error code, a fixed message for that code, a stack trace',
	'with hub-relative file paths, hub version, tier, adapter, OS, Node',
	'version and a random report id.',
	'',
	...NEVER_SENT,
	'',
	'The trial lasts 90 days from your yes. After that, reports stop on',
	'their own. The trial covers error reporting only. It does not include',
	'support: we do not reply to reports and cannot see who sent them.',
	'',
	"Every report is written to the hub's logs/ folder before it is sent.",
	'Change this later: npm.cmd run setup -- --error-reports on|off',
	'',
].join('\n');

export const FREE_QUESTION = 'Send error reports for 90 days?';

// The command is `npm.cmd` so it works in PowerShell. That makes the line
// longer than 72 characters, so it wraps after the colon.
export const ANSWER_NO =
	'Error reports off. Turn on any time:\nnpm.cmd run setup -- --error-reports on';

export function answerYesPaid({ reportId }) {
	return `Error reports on. Your report id is ${reportId}; doctor shows it too.`;
}

export function answerYesFree({ endDate, reportId }) {
	return `Error reports on until ${endDate}. Report id: ${reportId}`;
}

export function daysLeftText(daysLeft) {
	return `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`;
}

export function reminderText({ endDate, daysLeft }) {
	return [
		`Error-report trial ends ${endDate} (${daysLeftText(daysLeft)} left). Reports stop`,
		'on their own after that. Nothing for you to do.',
	].join('\n');
}

export function endNoticeText({ endDate, upgradeUrl = UPGRADE_URL }) {
	return [
		`Your 90-day error-report trial ended on ${endDate}.`,
		'Reporting has stopped: this hub no longer sends error reports.',
		'',
		'Paid tiers (dev:sub and ops) include:',
		'  - error reporting with no time limit',
		'  - support: quote your report id and we can find your errors',
		'',
		`Upgrade: ${upgradeUrl}`,
	].join('\n');
}

// ── State helpers ────────────────────────────────────────────────────────────

/** 'paid', 'free', or null when the tier is unknown. */
export function tierKind(tier) {
	if (PAID_TIERS.includes(tier)) return 'paid';
	if (FREE_TIERS.includes(tier)) return 'free';
	return null;
}

function readConfig(hubRoot, fsMod = fs) {
	try {
		const parsed = JSON.parse(
			fsMod.readFileSync(path.join(hubRoot, 'workspace.config.json'), 'utf-8'),
		);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

/** `YYYY-MM-DD` of the trial start plus the trial length, in UTC. */
export function trialEndDate(trialStartedAt) {
	const started = Date.parse(trialStartedAt);
	if (Number.isNaN(started)) return null;
	return new Date(started + TRIAL_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/** True when setup has not recorded a yes or no yet. */
export function choiceIsAbsent(config) {
	const choice = config?.errorReports?.choice;
	return choice !== 'yes' && choice !== 'no';
}

/**
 * Save the answer. Reads the config from disk, so other keys are kept.
 * Yes keeps a valid report id already saved with a yes and otherwise makes a
 * random one. On a free tier, yes starts a new trial. No removes the id and
 * the trial.
 *
 * @returns {{ errorReports: object, tier: string|undefined, kind: string|null,
 *   endDate: string|null }}
 */
export function saveErrorReportChoice({
	hubRoot,
	choice,
	tier,
	now = new Date(),
	fsMod = fs,
}) {
	const config = readConfig(hubRoot, fsMod) ?? {};
	const prev = config.errorReports ?? {};
	const kind = tierKind(tier);
	const decidedAt = now.toISOString();
	let errorReports;
	let endDate = null;
	if (choice === 'yes') {
		const keepId =
			prev.choice === 'yes' &&
			typeof prev.reportId === 'string' &&
			/^[A-Za-z0-9-]{8,64}$/.test(prev.reportId);
		const reportId = keepId ? prev.reportId : crypto.randomUUID();
		errorReports = { choice: 'yes', decidedAt, reportId };
		if (kind === 'free') {
			errorReports.trialStartedAt = decidedAt;
			endDate = trialEndDate(decidedAt);
		}
	} else {
		errorReports = { choice: 'no', decidedAt };
	}
	fsMod.mkdirSync(hubRoot, { recursive: true });
	fsMod.writeFileSync(
		path.join(hubRoot, 'workspace.config.json'),
		JSON.stringify({ ...config, errorReports }, null, 2) + '\n',
		'utf-8',
	);
	return { errorReports, tier, kind, endDate };
}

/** The line printed after an answer is saved. */
export function answerLine(saved) {
	if (saved.errorReports.choice !== 'yes') return ANSWER_NO;
	const { reportId } = saved.errorReports;
	return saved.kind === 'free'
		? answerYesFree({ endDate: saved.endDate, reportId })
		: answerYesPaid({ reportId });
}

// ── Setup question ───────────────────────────────────────────────────────────

function buildQuestion(kind) {
	return defineQuestion({
		id: 'error_reports',
		prompt: kind === 'free' ? FREE_QUESTION : PAID_QUESTION,
		type: 'yes/no',
		default: false,
	});
}

/**
 * The opt-in question setup would ask on this hub, or null when it asks
 * nothing (unknown tier, or a yes or no already saved).
 *
 * @returns {object|null}
 */
export function errorReportQuestion({ hubRoot, tier, fsMod = fs }) {
	const kind = tierKind(tier);
	if (!kind) return null;
	if (!choiceIsAbsent(readConfig(hubRoot, fsMod))) return null;
	return buildQuestion(kind);
}

/**
 * Ask the opt-in question once. Asks only in an interactive run, on a hub
 * whose tier is known, when no yes or no is saved yet. An unattended run
 * asks nothing and saves nothing, so reporting stays off.
 *
 * @returns {Promise<{asked: boolean, choice?: string}>}
 */
export async function runErrorReportOptIn({
	hubRoot,
	tier,
	askYN,
	isInteractive,
	announce = () => {},
	write = (s) => process.stdout.write(s),
	now = new Date(),
	fsMod = fs,
}) {
	if (!isInteractive()) return { asked: false };
	const kind = tierKind(tier);
	if (!kind) return { asked: false };
	if (!choiceIsAbsent(readConfig(hubRoot, fsMod))) return { asked: false };
	announce();
	write(`${kind === 'free' ? FREE_PROMPT : PAID_PROMPT}\n`);
	const question = buildQuestion(kind);
	const yes = await askYN(question.prompt, question.default, question);
	const saved = saveErrorReportChoice({
		hubRoot,
		choice: yes ? 'yes' : 'no',
		tier,
		now,
		fsMod,
	});
	write(`\n${answerLine(saved)}\n`);
	return { asked: true, choice: saved.errorReports.choice };
}

/**
 * The `--error-reports on|off` flag of setup. Changes the choice with no other
 * prompt. On a free tier, `on` starts a new trial.
 *
 * @returns {{ok: boolean, message: string}}
 */
export const NOT_INCLUDED_MESSAGE =
	'Error reporting is not included in this hub.';

export function runErrorReportsFlag({
	hubRoot,
	value,
	now = new Date(),
	fsMod = fs,
}) {
	if (value !== 'on' && value !== 'off') {
		return {
			ok: false,
			message: 'Use --error-reports on or --error-reports off.',
		};
	}
	const tier = effectiveHubType(hubRoot, readConfig(hubRoot, fsMod), fsMod);
	if (!tierKind(tier)) {
		return {
			ok: false,
			message:
				'Error reports cannot be set: this hub has no known tier. Run setup first.',
		};
	}
	const saved = saveErrorReportChoice({
		hubRoot,
		choice: value === 'on' ? 'yes' : 'no',
		tier,
		now,
		fsMod,
	});
	return { ok: true, message: answerLine(saved) };
}

// ── Doctor status row ────────────────────────────────────────────────────────

const TURN_OFF = 'Turn off: npm.cmd run setup -- --error-reports off';
const TURN_ON = 'Turn on: npm.cmd run setup -- --error-reports on';

/**
 * The doctor row for the hub's error-report state. It is never a failure or a
 * warning: the operator has done nothing wrong.
 *
 * @returns {{status: 'pass'|'skip', message: string, hint: string|null}|null}
 *   null only from the excluded-build stand-in: doctor shows no row.
 */
export function errorReportRow({ hubRoot, now, fsMod = fs } = {}) {
	const status = errorReportStatus({ hubRoot, now });
	const er = readConfig(hubRoot, fsMod)?.errorReports;
	if (status.state === 'on') {
		return {
			status: 'pass',
			message: `on. Report id: ${status.reportId} (quote it to support)`,
			hint: TURN_OFF,
		};
	}
	if (status.state === 'trial') {
		return {
			status: 'pass',
			message: `trial, ${daysLeftText(status.daysLeft)} left (ends ${trialEndDate(er?.trialStartedAt)}). Report id: ${status.reportId}`,
			hint: TURN_OFF,
		};
	}
	if (status.state === 'ended') {
		return {
			status: 'skip',
			message: `off. Trial ended ${trialEndDate(er?.trialStartedAt)}.`,
			hint: null,
		};
	}
	return { status: 'skip', message: 'off', hint: TURN_ON };
}

// ── Trial messages ───────────────────────────────────────────────────────────

/**
 * The trial message due now, or null.
 *   reminder: days 83-89, every run
 *   end:      day 90 or later, until it has been shown once
 * `tips.enabled` is not consulted: both messages show either way.
 *
 * @returns {{kind: 'reminder'|'end', text: string}|null}
 */
export function dueTrialNotice({ hubRoot, now, fsMod = fs } = {}) {
	const status = errorReportStatus({ hubRoot, now });
	const er = readConfig(hubRoot, fsMod)?.errorReports;
	const endDate = trialEndDate(er?.trialStartedAt);
	if (!endDate) return null;
	if (status.state === 'trial' && status.daysLeft <= 7) {
		return {
			kind: 'reminder',
			text: reminderText({ endDate, daysLeft: status.daysLeft }),
		};
	}
	if (status.state === 'ended' && !er?.endNoticeShownAt) {
		return { kind: 'end', text: endNoticeText({ endDate }) };
	}
	return null;
}

/** Record that the end notice was shown. Failure is swallowed. */
function markEndNoticeShown({ hubRoot, now, fsMod }) {
	try {
		const config = readConfig(hubRoot, fsMod);
		if (!config?.errorReports) return;
		fsMod.writeFileSync(
			path.join(hubRoot, 'workspace.config.json'),
			JSON.stringify(
				{
					...config,
					errorReports: {
						...config.errorReports,
						endNoticeShownAt: now.toISOString(),
					},
				},
				null,
				2,
			) + '\n',
			'utf-8',
		);
	} catch {
		// The notice may show once more on the next run.
	}
}

/**
 * Print the due trial message to the terminal, and record that the end notice
 * was shown. Never throws. Terminal commands only: doctor and setup.
 *
 * @returns {string|null} the kind printed, or null
 */
export function printTrialNotice({
	hubRoot,
	now = new Date(),
	write = (s) => process.stdout.write(s),
	fsMod = fs,
} = {}) {
	try {
		const notice = dueTrialNotice({ hubRoot, now, fsMod });
		if (!notice) return null;
		write(`\n${notice.text}\n`);
		if (notice.kind === 'end') markEndNoticeShown({ hubRoot, now, fsMod });
		return notice.kind;
	} catch {
		return null;
	}
}

/**
 * True when the upgrade tip may be offered: a free-tier hub whose trial has
 * ended. Used by the tip rotation, which also applies `tips.enabled`.
 */
export function upgradeTipEligible({ hubRoot, now } = {}) {
	try {
		const status = errorReportStatus({ hubRoot, now });
		return status.state === 'ended' && tierKind(status.tier) === 'free';
	} catch {
		return false;
	}
}
