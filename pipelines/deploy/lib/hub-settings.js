/**
 * hub-settings.js — the single definition of the hub's `.claude/settings.json`
 * baseline (the `enableAllProjectMcpServers` key plus the tier-independent
 * hooks). Deploy composes the file through composeHubSettings(); setup calls
 * the same function to create or complete the file in a clone, and doctor
 * derives its expected hook set from it, so the three cannot drift.
 *
 * Ships to every hub tier. Tier-specific hooks stay out of this file: deploy
 * passes them in through `tierHooks`, and a tier's own setup step adds its
 * hooks itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	mergeRelaySessionStartHook,
	mergeMemoryCheckStopHook,
} from './claude-hooks.js';
import {
	mergeMemorySessionStartHook,
	mergeMemoryWorkMarkerHook,
} from './memory-session-start-hook.js';
import { mergeSecretScanPreToolUseHook } from './secret-scan.hooks-plugin.js';
import {
	readSettingsForMerge,
	stringifySettings,
	SETTINGS_SHAPE,
} from '../wizard.js';

/** A fresh settings object for a hub that has no settings file yet. */
export function newHubSettings() {
	return { hooks: {}, enableAllProjectMcpServers: true };
}

/**
 * Add the baseline to `settings`. Pure on its input's top level (returns a new
 * object); user-owned hooks and keys are never removed or reordered.
 *
 * @param {object} settings
 * @param {object} [opts]
 * @param {(s: object) => object} [opts.tierHooks]  Merged after the shared
 *   hooks and before the work marker, so deploy's PostToolUse order is unchanged.
 * @param {boolean} [opts.overrideMcpEnable]  true (deploy): force the key on.
 *   false (setup): set it only when the user has no value.
 * @returns {object}
 */
export function composeHubSettings(
	settings,
	{ tierHooks = (s) => s, overrideMcpEnable = true } = {},
) {
	let next = { ...settings };
	if (overrideMcpEnable || next.enableAllProjectMcpServers === undefined) {
		next.enableAllProjectMcpServers = true;
	}
	next = mergeRelaySessionStartHook(next);
	next = mergeMemorySessionStartHook(next);
	next = mergeMemoryCheckStopHook(next);
	next = mergeSecretScanPreToolUseHook(next);
	next = tierHooks(next);
	next = mergeMemoryWorkMarkerHook(next);
	return next;
}

function hookKey(event, entry, hook) {
	return JSON.stringify([
		event,
		entry?.matcher ?? '',
		hook?.command ?? '',
		hook?.args ?? [],
	]);
}

function hookName(hook) {
	const last = Array.isArray(hook?.args) ? hook.args.at(-1) : hook?.command;
	return String(last ?? '').replace(/^.*[\\/]/, '');
}

/**
 * Compare a settings object with the baseline. Names every baseline hook (as
 * `Event: script`) and key that the settings lack.
 *
 * @param {object|null} settings
 * @returns {string[]}
 */
export function missingHubSettings(settings) {
	const expected = composeHubSettings({}, { overrideMcpEnable: true });
	const have = new Set();
	for (const [event, entries] of Object.entries(settings?.hooks ?? {})) {
		for (const entry of Array.isArray(entries) ? entries : []) {
			for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
				have.add(hookKey(event, entry, hook));
			}
		}
	}
	const missing = [];
	for (const [event, entries] of Object.entries(expected.hooks)) {
		for (const entry of entries) {
			for (const hook of entry.hooks) {
				if (!have.has(hookKey(event, entry, hook))) {
					missing.push(`${event}: ${hookName(hook)}`);
				}
			}
		}
	}
	if (settings?.enableAllProjectMcpServers !== true) {
		missing.push('enableAllProjectMcpServers');
	}
	return missing;
}

/**
 * Create or complete the hub's `.claude/settings.json` (setup). A file that
 * does not parse, or has a wrong-typed `hooks` / hook event list, is left
 * untouched. Writes only when the content changes, so a second run is a no-op.
 *
 * @param {object} opts
 * @param {string} opts.hubRoot
 * @param {object} [opts.fsMod]
 * @param {(s: object) => object} [opts.tierHooks]
 * @returns {{status: 'created'|'updated'|'unchanged'|'unusable', settingsPath: string, reason?: string}}
 */
export function ensureHubSettings({
	hubRoot,
	fsMod = fs,
	tierHooks = (s) => s,
}) {
	const settingsPath = path.join(hubRoot, '.claude', 'settings.json');
	const read = readSettingsForMerge(settingsPath, {
		fsMod,
		expect: SETTINGS_SHAPE.allHookEvents,
	});
	if (read.status === 'unusable') {
		return { status: 'unusable', settingsPath, reason: read.reason };
	}
	const base = read.existed ? read.settings : newHubSettings();
	const next = composeHubSettings(base, {
		tierHooks,
		overrideMcpEnable: false,
	});
	const content = stringifySettings(next, read.indent, '\t');
	if (read.existed && content === read.raw) {
		return { status: 'unchanged', settingsPath };
	}
	fsMod.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fsMod.writeFileSync(settingsPath, content, 'utf-8');
	return { status: read.existed ? 'updated' : 'created', settingsPath };
}
