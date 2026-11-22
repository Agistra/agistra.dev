/**
 * Setup question model: the single description of every prompt `npm run setup`
 * can ask, shared by the interactive wizard, `--questions`, `--answers` and
 * `--secret`.
 *
 * A question is a plain object:
 *   id        stable machine name (dotted-free snake_case)
 *   prompt    the exact text the interactive prompt shows
 *   type      'text' | 'yes/no' | 'choice'
 *   default   the value used when the question is left unanswered (current value
 *             on a re-run); always null for a secret
 *   secret    true when the value is a credential. Never accepted in an answers
 *             file, never printed; entered with `setup --secret <id>`
 *   required  true when the question has no usable default and so must be
 *             answered in an answers file
 *   when      null, or one condition / an AND-list of conditions
 *             `{ id, equals }` or `{ id, notEquals }` over other questions'
 *             answers
 *   pattern   optional regular expression a non-empty text answer must match
 *   choices   the allowed values for type 'choice'
 *   note      optional human-readable remark (data-dependent prompts)
 * A secret question may carry a `store({ hubRoot, fsMod }, value)` function used
 * by `--secret`; it is never part of the JSON listing.
 *
 * Every prompt call site passes its question as the third argument
 * (`ask(prompt, default, question)`); the interactive helpers ignore it, the
 * answer-backed helpers resolve the answer by `question.id`.
 */

import fs from 'node:fs';
import path from 'node:path';

export const QUESTION_TYPES = Object.freeze(['text', 'yes/no', 'choice']);

/**
 * Build a question descriptor.
 *
 * @param {object} spec
 * @returns {object}
 */
export function defineQuestion({
	id,
	prompt,
	type = 'text',
	default: defaultValue,
	secret = false,
	required = false,
	when = null,
	choices,
	pattern,
	note,
	store,
}) {
	if (!QUESTION_TYPES.includes(type)) {
		throw new Error(`Unknown question type "${type}" for ${id}`);
	}
	const q = {
		id,
		prompt,
		type,
		default: secret ? null : (defaultValue ?? (type === 'yes/no' ? false : '')),
		secret,
		required: required && !secret,
		when,
	};
	if (choices) q.choices = choices;
	if (pattern) q.pattern = pattern;
	if (note) q.note = note;
	if (store) Object.defineProperty(q, 'store', { value: store });
	return q;
}

/** The JSON form of a question (what `--questions` prints). */
export function describeQuestion(q) {
	const out = {
		id: q.id,
		prompt: q.prompt,
		default: q.default,
		type: q.type,
		secret: q.secret,
		required: q.required,
		when: q.when,
	};
	if (q.choices) out.choices = q.choices;
	if (q.pattern) out.pattern = q.pattern;
	if (q.note) out.note = q.note;
	return out;
}

function toConditions(when) {
	if (!when) return [];
	return Array.isArray(when) ? when : [when];
}

/**
 * Does the question's `when` hold, given the effective values so far?
 *
 * @param {object|object[]|null} when
 * @param {Map<string, unknown>} effective  id → answered value, else its default
 */
export function whenHolds(when, effective) {
	return toConditions(when).every((c) =>
		'notEquals' in c
			? effective.get(c.id) !== c.notEquals
			: effective.get(c.id) === c.equals,
	);
}

function hasNoDefault(q) {
	return q.default === '' || q.default === null || q.default === undefined;
}

/**
 * Check an answers object against the question list, before anything runs.
 *
 * @param {object[]} questions  every question, in prompt order
 * @param {Record<string, unknown>} answers
 * @returns {{ok: boolean, unknown: string[], secrets: string[], invalid: {id: string, reason: string}[], missing: string[], ignored: string[], effective: Map<string, unknown>}}
 */
export function validateAnswers(questions, answers) {
	const byId = new Map(questions.map((q) => [q.id, q]));
	const unknown = [];
	const secrets = [];
	const invalid = [];
	for (const id of Object.keys(answers)) {
		const q = byId.get(id);
		if (!q) unknown.push(id);
		else if (q.secret) secrets.push(id);
		else {
			const v = answers[id];
			if (q.type === 'yes/no' && typeof v !== 'boolean') {
				invalid.push({ id, reason: 'expected true or false' });
			} else if (q.type === 'text' && typeof v !== 'string') {
				invalid.push({ id, reason: 'expected a string' });
			} else if (q.pattern && v && !new RegExp(q.pattern).test(v)) {
				invalid.push({ id, reason: `does not match ${q.pattern}` });
			} else if (q.type === 'choice' && !q.choices.includes(v)) {
				invalid.push({
					id,
					reason: `expected one of: ${q.choices.join(', ')}`,
				});
			}
		}
	}

	const effective = new Map();
	const missing = [];
	const ignored = [];
	for (const q of questions) {
		const provided = !q.secret && Object.hasOwn(answers, q.id);
		effective.set(q.id, provided ? answers[q.id] : q.default);
		if (!whenHolds(q.when, effective)) {
			if (provided) ignored.push(q.id);
			continue;
		}
		if (q.required && !provided && hasNoDefault(q)) missing.push(q.id);
	}
	return {
		ok:
			unknown.length === 0 &&
			secrets.length === 0 &&
			invalid.length === 0 &&
			missing.length === 0,
		unknown,
		secrets,
		invalid,
		missing,
		ignored,
		effective,
	};
}

/**
 * Questions whose `when` holds for these answers (what an interactive run with
 * the same answers would ask), in prompt order.
 */
export function applicableQuestions(questions, answers) {
	const effective = new Map();
	const out = [];
	for (const q of questions) {
		const provided = !q.secret && Object.hasOwn(answers, q.id);
		effective.set(q.id, provided ? answers[q.id] : q.default);
		if (whenHolds(q.when, effective)) out.push(q);
	}
	return out;
}

/**
 * Prompt helpers backed by an answers object instead of a terminal. A prompt
 * without a question id is a programming error and throws, so an unannotated
 * prompt cannot silently take a default in an unattended run.
 *
 * @param {Record<string, unknown>} answers
 * @returns {{ask: Function, askYN: Function, askSecret: Function, used: string[]}}
 */
export function createAnswerPrompts(answers) {
	const used = [];
	function resolve(prompt, fallback, meta) {
		if (!meta?.id) {
			throw new Error(`Setup prompt has no question id: "${prompt}"`);
		}
		used.push(meta.id);
		if (meta.secret || !Object.hasOwn(answers, meta.id)) return fallback;
		return answers[meta.id];
	}
	return {
		used,
		ask: async (prompt, defaultValue = '', meta) =>
			String(resolve(prompt, defaultValue, meta)),
		askYN: async (prompt, defaultYes = false, meta) =>
			Boolean(resolve(prompt, defaultYes, meta)),
		// A secret never comes from the answers file. Empty means "none given".
		askSecret: async (prompt, meta) => {
			resolve(prompt, '', meta);
			return '';
		},
	};
}

/**
 * Read a hub's version: the first token of its VERSION file, else the
 * package.json version, else '0.0.0'.
 */
export function readSetupVersion(hubRoot, fsMod = fs) {
	try {
		const raw = String(
			fsMod.readFileSync(path.join(hubRoot, 'VERSION'), 'utf-8'),
		)
			.trim()
			.split(/\s+/)[0];
		if (/^\d+\.\d+\.\d+/.test(raw)) return raw;
	} catch {
		// fall through
	}
	try {
		const pkg = JSON.parse(
			fsMod.readFileSync(path.join(hubRoot, 'package.json'), 'utf-8'),
		);
		if (pkg.version) return pkg.version;
	} catch {
		// fall through
	}
	return '0.0.0';
}

/**
 * Record a successful setup run in workspace.config.json
 * (`bootstrap.setupCompletedAt`, `bootstrap.setupVersion`). Other bootstrap
 * keys, such as `completedAt`, are kept.
 */
export function stampSetupCompleted({
	hubRoot,
	fsMod = fs,
	now = new Date(),
	version = readSetupVersion(hubRoot, fsMod),
}) {
	const configPath = path.join(hubRoot, 'workspace.config.json');
	let config = {};
	try {
		config = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'));
	} catch {
		// No readable config: stamp a fresh one.
	}
	const next = {
		...config,
		bootstrap: {
			...(config.bootstrap ?? {}),
			setupCompletedAt: now.toISOString(),
			setupVersion: version,
		},
	};
	fsMod.writeFileSync(
		configPath,
		JSON.stringify(next, null, 2) + '\n',
		'utf-8',
	);
	return next.bootstrap;
}

// ── Shared question builders ──────────────────────────────────────────────────

/**
 * The prior-hub migration questions. Identical across the tiers that offer
 * migration; only the wording of the first prompt differs.
 *
 * @param {object} o
 * @param {string} o.promptMessage  Full text of the first yes/no prompt.
 */
export function migrationQuestions({ promptMessage }) {
	const yes = { id: 'migrate_prior_hub', equals: true };
	return [
		defineQuestion({
			id: 'migrate_prior_hub',
			prompt: promptMessage,
			type: 'yes/no',
			default: false,
		}),
		defineQuestion({
			id: 'prior_hub_path',
			prompt: 'Path to your existing agistra.dev hub',
			type: 'text',
			default: '',
			required: true,
			when: yes,
		}),
		defineQuestion({
			id: 'migrate_confirm_source_tier',
			prompt:
				"Correct the old hub's tier to its packaged value? (names both tiers)",
			type: 'yes/no',
			default: true,
			when: yes,
			note: 'Asked only when the old hub records a tier that differs from its packaged tier. The prompt names both tiers.',
		}),
		defineQuestion({
			id: 'migrate_overwrite_existing',
			prompt:
				'A file already exists here with real content. Overwrite it? (asked per file)',
			type: 'yes/no',
			default: false,
			when: yes,
			note: 'Asked once per file that already exists here with real content. One answer applies to every such file.',
		}),
	];
}

/**
 * Render a recorded timestamp (ISO string) as a plain date (YYYY-MM-DD) for a
 * re-run prompt. Falls back to the raw value when it is not a parseable date.
 */
export function formatMigrationDate(timestamp) {
	const parsed = new Date(timestamp);
	return Number.isNaN(parsed.getTime())
		? String(timestamp)
		: parsed.toISOString().slice(0, 10);
}

/** Meta for the migration prompts whose wording a call site builds itself. */
export const MIGRATION_ASK_META = Object.freeze({ id: 'migrate_prior_hub' });
export const MIGRATION_PATH_META = Object.freeze({ id: 'prior_hub_path' });
export const MIGRATION_SOURCE_TIER_META = Object.freeze({
	id: 'migrate_confirm_source_tier',
});
export const MIGRATION_OVERWRITE_META = Object.freeze({
	id: 'migrate_overwrite_existing',
});
