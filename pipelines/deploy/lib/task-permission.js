/**
 * Task-CLI permission rules for Claude Code.
 *
 * The task CLI (`npm run task -- <subcommand>`) drives the ticket flow, and a
 * fresh hub ships no `permissions` block, so every task command prompts (and a
 * close-transition can be blocked outright in auto mode). This module owns the
 * rule set, the merge into `.claude/settings.json`, the decline record in
 * `workspace.config.json`, and the state read shared by setup and doctor.
 *
 * Ships to every hub tier: setup.js and doctor.js import it unconditionally.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	readSettingsForMerge,
	stringifySettings,
	unusableSettingsMessage,
	UnusableSettingsError,
	SETTINGS_SHAPE,
} from '../wizard.js';

export const TASK_CLI_SUBCOMMANDS = Object.freeze([
	'read',
	'list',
	'transition',
	'update-field',
	'waves',
	'append-section',
	'qa-report',
	'post-merge-check',
	'dispatch-context',
	'create',
]);

export const TASK_CLI_ALLOW_RULES = Object.freeze(
	TASK_CLI_SUBCOMMANDS.map((sub) => `Bash(npm run task -- ${sub}:*)`),
);

/** workspace.config.json key recording a declined offer. */
export const TASK_PERMISSION_CONFIG_KEY = 'taskPermission';

export const TASK_PERMISSION_STATES = Object.freeze({
	ENABLED: 'enabled',
	MISSING: 'missing',
	DECLINED: 'declined',
	NOT_APPLICABLE: 'not-applicable',
});

function readJson(filePath, fsMod) {
	if (!fsMod.existsSync(filePath)) return null;
	try {
		return JSON.parse(fsMod.readFileSync(filePath, 'utf-8'));
	} catch {
		return null;
	}
}

function allowList(settings) {
	const allow = settings?.permissions?.allow;
	return Array.isArray(allow) ? allow : [];
}

/** True when every task-CLI rule is present in `settings.permissions.allow`. */
export function hasAllTaskCliRules(settings) {
	const allow = allowList(settings);
	return TASK_CLI_ALLOW_RULES.every((rule) => allow.includes(rule));
}

/**
 * Add any missing task-CLI allow rules. Preserves every other key and every
 * existing rule (order kept, new rules appended). Idempotent.
 *
 * @param {object} settings
 * @returns {object}
 */
export function mergeTaskCliPermissions(settings = {}) {
	const permissions = settings.permissions && typeof settings.permissions === 'object'
		? settings.permissions
		: {};
	const allow = allowList(settings);
	const missing = TASK_CLI_ALLOW_RULES.filter((rule) => !allow.includes(rule));
	return {
		...settings,
		permissions: { ...permissions, allow: [...allow, ...missing] },
	};
}

/**
 * Whether the hub has a Claude Code adapter deployed. Other adapters (Cursor,
 * Codex, Copilot) have their own permission systems and are out of scope.
 */
export function hasClaudeAdapter(hubRoot, fsMod = fs) {
	return fsMod.existsSync(path.join(hubRoot, '.claude', 'agents'))
		|| fsMod.existsSync(path.join(hubRoot, '.claude', 'settings.json'));
}

/**
 * Resolve the task-permission state for a hub.
 *
 * @returns {'enabled'|'missing'|'declined'|'not-applicable'}
 */
export function readTaskPermissionState({ hubRoot, fsMod = fs }) {
	if (!hasClaudeAdapter(hubRoot, fsMod)) return TASK_PERMISSION_STATES.NOT_APPLICABLE;
	const settings = readJson(path.join(hubRoot, '.claude', 'settings.json'), fsMod);
	if (hasAllTaskCliRules(settings)) return TASK_PERMISSION_STATES.ENABLED;
	const config = readJson(path.join(hubRoot, 'workspace.config.json'), fsMod);
	if (config?.[TASK_PERMISSION_CONFIG_KEY]?.declined === true) return TASK_PERMISSION_STATES.DECLINED;
	return TASK_PERMISSION_STATES.MISSING;
}

const UNUSABLE_CONSEQUENCE = 'No task CLI allow rules were added.';

/**
 * Merge the rules into the hub's `.claude/settings.json`.
 *
 * Throws UnusableSettingsError, leaving the file untouched, when the file exists
 * but does not parse or `permissions` / `permissions.allow` has the wrong type.
 */
export function applyTaskCliPermissions({ hubRoot, fsMod = fs }) {
	const settingsPath = path.join(hubRoot, '.claude', 'settings.json');
	const read = readSettingsForMerge(settingsPath, { fsMod, expect: SETTINGS_SHAPE.permissions });
	if (read.status === 'unusable') {
		throw new UnusableSettingsError(settingsPath, read.reason, UNUSABLE_CONSEQUENCE);
	}
	fsMod.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fsMod.writeFileSync(
		settingsPath,
		stringifySettings(mergeTaskCliPermissions(read.settings ?? {}), read.indent, '\t'),
		'utf-8',
	);
	return settingsPath;
}

function writeDeclineRecord({ hubRoot, fsMod, declined }) {
	const configPath = path.join(hubRoot, 'workspace.config.json');
	const config = readJson(configPath, fsMod) ?? {};
	if (declined) {
		config[TASK_PERMISSION_CONFIG_KEY] = { declined: true };
	} else {
		delete config[TASK_PERMISSION_CONFIG_KEY];
	}
	fsMod.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Setup step: offer the task-CLI allow rules once.
 *
 * - Rules already present: one summary line, no question.
 * - Previously declined (and not `reAsk`): no question.
 * - `.claude/settings.json` exists but cannot be merged into (does not parse, or
 *   `permissions` / `permissions.allow` has the wrong type): file left untouched,
 *   warning names the file and the reason, no question asked, nothing recorded.
 * - Non-interactive: nothing added, nothing recorded.
 * - Otherwise asks once; yes merges the rules, no records the decline.
 *
 * @returns {Promise<{outcome: 'not-applicable'|'enabled'|'already-enabled'|'declined'|'previously-declined'|'unusable-settings'|'non-interactive', reason?: string}>}
 */
export async function offerTaskCliPermissions({
	hubRoot,
	fsMod = fs,
	askYN,
	isInteractive,
	reAsk = false,
	log = (s) => process.stdout.write(s),
}) {
	const state = readTaskPermissionState({ hubRoot, fsMod });
	if (state === TASK_PERMISSION_STATES.NOT_APPLICABLE) return { outcome: 'not-applicable' };
	if (state === TASK_PERMISSION_STATES.ENABLED) {
		log('  task permission: enabled\n');
		return { outcome: 'already-enabled' };
	}
	if (state === TASK_PERMISSION_STATES.DECLINED && !reAsk) {
		log('  task permission: declined by choice (re-ask with: npm run setup -- --ask-permissions)\n');
		return { outcome: 'previously-declined' };
	}
	// A settings file we cannot merge into safely is never rewritten, and asking a
	// question we cannot honour would only mislead.
	const settingsPath = path.join(hubRoot, '.claude', 'settings.json');
	const read = readSettingsForMerge(settingsPath, { fsMod, expect: SETTINGS_SHAPE.permissions });
	if (read.status === 'unusable') {
		log(`  WARNING: ${unusableSettingsMessage(settingsPath, read.reason, UNUSABLE_CONSEQUENCE)}\n`);
		return { outcome: 'unusable-settings', reason: read.reason };
	}
	if (!isInteractive()) {
		log('  task permission: not configured (non-interactive run, nothing changed)\n');
		return { outcome: 'non-interactive' };
	}

	log(
		'  Agents run the task CLI (npm run task -- <subcommand>) for every ticket step.\n' +
		'  Without allow rules, Claude Code prompts on each call and auto mode may block\n' +
		'  writes such as transitions. This adds one allow rule per task subcommand to\n' +
		'  .claude/settings.json (read, list, transition, update-field, waves,\n' +
		'  append-section, qa-report, post-merge-check, dispatch-context, create).\n' +
		'  Nothing broader than "npm run task --" is allowed; no gh rules are added.\n',
	);
	const yes = await askYN('Allow the task CLI commands in .claude/settings.json?', true);
	if (yes) {
		applyTaskCliPermissions({ hubRoot, fsMod });
		if (state === TASK_PERMISSION_STATES.DECLINED) writeDeclineRecord({ hubRoot, fsMod, declined: false });
		log(`  Task CLI allow rules added → ${settingsPath}\n`);
		return { outcome: 'enabled' };
	}
	writeDeclineRecord({ hubRoot, fsMod, declined: true });
	log('  Declined — recorded in workspace.config.json; setup will not ask again.\n');
	return { outcome: 'declined' };
}
