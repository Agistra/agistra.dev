#!/usr/bin/env node
/**
 * tips.js - tip of the day for `doctor`, `setup` and `npm run show:tip`.
 *
 * Tips are printed to the terminal only. They are never delivered inside an
 * agent session (no hook, no subagent), because anything printed there lands
 * in the model's context.
 *
 * Tier model. Tips are tagged with the hub types they apply to:
 *   dev, dev:graph, dev:sub, dev:sub:graph
 * `dev:sub:graph` is not a stored hubType. Following the same shape as
 * dev-graph.doctor-plugin.js and the deploy `--with-graphify` flag, a graph
 * hub is hubType `dev:sub` plus the Graphify add-on, so the tip tier is
 * derived by effectiveTipHubType() from those two inputs. Other hub types
 * (for example `ops`) have no tips: nothing prints and nothing errors.
 *
 * Two guards keep a tip inside its own tier:
 *   1. Deploy time: extras.js writes tips-data.json containing only the
 *      entries tagged for the deployed tier (filterTipsForHubType).
 *   2. Runtime: getTipForHub() filters again against the hub's own tier, so a
 *      file that was copied by hand still cannot leak another tier's tip.
 *
 * Rotation. Each run shows a tip not yet shown in the current cycle, picked at
 * random among the unseen ones. When every eligible tip has been shown a new
 * cycle starts, and its first tip never equals the last one shown. Tips whose
 * ids are not in the saved state count as unseen, so tips added by a redeploy
 * surface before old ones repeat; saved ids that are no longer eligible are
 * dropped. The state lives in `.tips-state.json` at the hub root
 * ({shown: [ids in this cycle], last: id}), is shared by `doctor`, setup and
 * `show:tip`, and is gitignored by the deploy. The tier filter runs first, so
 * state never leaks a tip from another tier. A missing, unreadable, corrupt or
 * unwritable state file falls back to a random pick and never throws. Nothing
 * is written when no tip is printed (JSON mode, CI, tips off).
 *
 * Settings, in workspace.config.json:
 *   tips.enabled  boolean, default true. false silences doctor and setup;
 *                 `show:tip` still prints a tip.
 *   tips.icon     "ascii" forces the plain `Tip:` prefix.
 *
 * CLI (`npm run show:tip`):
 *   node pipelines/deploy/lib/tips.js [--ascii] [--hub-root <path>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TIPS_DATA_FILENAME = 'tips-data.json';
export const DEFAULT_TIPS_DATA_PATH = path.join(__dirname, TIPS_DATA_FILENAME);
export const TIPS_STATE_FILENAME = '.tips-state.json';

/** Hub types that carry tips. Any other hub type prints no tip. */
export const TIP_HUB_TYPES = Object.freeze([
	'dev',
	'dev:graph',
	'dev:sub',
	'dev:sub:graph',
]);

const BULB_PREFIX = '\u{1F4A1} Tip:';
const PLAIN_PREFIX = 'Tip:';

/** Example prompt shown next to the command name. Tells the agent what to run. */
export const ON_REQUEST_PROMPT =
	'Run `npm run show:tip` in the hub root and show me exactly what it prints.';

// ── Tier resolution and filtering ────────────────────────────────────────────

/**
 * Map a stored hubType plus the Graphify add-on flag to the tip tier.
 *
 * @param {string|undefined} hubType
 * @param {boolean} [withGraphify]
 * @returns {string|undefined}
 */
export function effectiveTipHubType(hubType, withGraphify = false) {
	if (hubType === 'dev:sub' && withGraphify) return 'dev:sub:graph';
	return hubType;
}

/**
 * Keep only the tips tagged for exactly this tier. An unknown tier keeps none.
 *
 * @param {Array<{tiers?: string[]}>} tips
 * @param {string|undefined} tipHubType
 * @returns {Array}
 */
export function filterTipsForHubType(tips, tipHubType) {
	if (!TIP_HUB_TYPES.includes(tipHubType)) return [];
	if (!Array.isArray(tips)) return [];
	return tips.filter(
		(tip) => Array.isArray(tip?.tiers) && tip.tiers.includes(tipHubType),
	);
}

/**
 * Read a tips data file. A missing or unreadable file yields no tips.
 *
 * @param {string} [dataPath]
 * @param {object} [fsMod]
 * @returns {Array}
 */
export function loadTips(dataPath = DEFAULT_TIPS_DATA_PATH, fsMod = fs) {
	try {
		const parsed = JSON.parse(fsMod.readFileSync(dataPath, 'utf-8'));
		return Array.isArray(parsed?.tips) ? parsed.tips : [];
	} catch {
		return [];
	}
}

/**
 * Pick one tip at random.
 *
 * @param {Array} tips
 * @param {() => number} [rng]  Returns a number in [0, 1).
 * @returns {object|null}
 */
export function pickTip(tips, rng = Math.random) {
	if (!Array.isArray(tips) || tips.length === 0) return null;
	const index = Math.min(tips.length - 1, Math.floor(rng() * tips.length));
	return tips[index];
}

// ── Rotation state ───────────────────────────────────────────────────────────

/**
 * Read the rotation state. Missing, unreadable or malformed yields an empty
 * state, which makes the next pick a plain random one.
 *
 * @param {string} hubRoot
 * @param {object} [fsMod]
 * @returns {{shown: string[], last: string|null}}
 */
export function readTipsState(hubRoot, fsMod = fs) {
	try {
		const parsed = JSON.parse(
			fsMod.readFileSync(path.join(hubRoot, TIPS_STATE_FILENAME), 'utf-8'),
		);
		const shown = Array.isArray(parsed?.shown)
			? parsed.shown.filter((id) => typeof id === 'string')
			: [];
		const last = typeof parsed?.last === 'string' ? parsed.last : null;
		return { shown, last };
	} catch {
		return { shown: [], last: null };
	}
}

/** Save the rotation state. Failure is swallowed: tips are optional output. */
export function writeTipsState(hubRoot, state, fsMod = fs) {
	try {
		fsMod.writeFileSync(
			path.join(hubRoot, TIPS_STATE_FILENAME),
			JSON.stringify(state, null, 2) + '\n',
			'utf-8',
		);
	} catch {
		// Read-only hub or missing directory: the next run just picks again.
	}
}

/**
 * Pick the next tip of the rotation and return it with the state to save.
 *
 * @param {Array<{id: string}>} eligible  Tips that passed the tier filter.
 * @param {{shown: string[], last: string|null}} state
 * @param {() => number} [rng]
 * @returns {{tip: object|null, state: {shown: string[], last: string|null}}}
 */
export function pickNextTip(eligible, state, rng = Math.random) {
	if (!Array.isArray(eligible) || eligible.length === 0) {
		return { tip: null, state: { shown: [], last: null } };
	}
	const eligibleIds = new Set(eligible.map((tip) => tip.id));
	let shown = [...new Set(state.shown)].filter((id) => eligibleIds.has(id));
	let candidates = eligible.filter((tip) => !shown.includes(tip.id));
	if (candidates.length === 0) {
		shown = [];
		const fresh = eligible.filter((tip) => tip.id !== state.last);
		candidates = fresh.length > 0 ? fresh : eligible;
	}
	const tip = pickTip(candidates, rng);
	return { tip, state: { shown: [...shown, tip.id], last: tip.id } };
}

// ── Hub config ───────────────────────────────────────────────────────────────

/**
 * Read workspace.config.json. Missing or invalid yields null.
 *
 * @param {string} hubRoot
 * @param {object} [fsMod]
 * @returns {object|null}
 */
export function readWorkspaceConfig(hubRoot, fsMod = fs) {
	try {
		const parsed = JSON.parse(
			fsMod.readFileSync(path.join(hubRoot, 'workspace.config.json'), 'utf-8'),
		);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

/** Tips are on unless the config says `tips.enabled: false`. */
export function tipsEnabled(config) {
	return config?.tips?.enabled !== false;
}

/**
 * Resolve the tip tier of a deployed hub from its config.
 *
 * A dev:sub hub counts as the graph tier when its config carries a `graphify`
 * block or when the Graphify installer plugin is present next to this file
 * (a hub built with the add-on ships it before setup has run).
 *
 * @param {object|null} config
 * @param {object} [options]
 * @param {() => boolean} [options.hasGraphifyInstaller]
 * @returns {string|undefined}
 */
export function resolveHubTipHubType(
	config,
	{
		hasGraphifyInstaller = () =>
			fs.existsSync(path.join(__dirname, 'dev-graph.setup-plugin.js')),
	} = {},
) {
	const hubType = config?.hubType;
	if (hubType !== 'dev:sub') return hubType;
	const withGraphify = Boolean(config?.graphify) || hasGraphifyInstaller();
	return effectiveTipHubType(hubType, withGraphify);
}

// ── Icon ─────────────────────────────────────────────────────────────────────

/**
 * Decide whether the console can render the light bulb.
 *
 * Plain `Tip:` is used when the user asks for it (`--ascii` or
 * `tips.icon: "ascii"`), on a dumb terminal, on a non-UTF-8 locale, and on
 * Windows consoles that are not a known Unicode-capable host.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {boolean} [options.ascii]       `--ascii` flag.
 * @param {string} [options.configIcon]   `tips.icon` from workspace.config.json.
 * @returns {boolean}
 */
export function supportsEmoji({
	env = process.env,
	platform = process.platform,
	ascii = false,
	configIcon,
} = {}) {
	if (ascii || configIcon === 'ascii') return false;
	if (env.TERM === 'dumb') return false;
	if (platform === 'win32') {
		return Boolean(
			env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || env.TERM,
		);
	}
	const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
	if (locale && !/utf-?8/i.test(locale)) return false;
	return true;
}

/**
 * Format one tip as a single line. The word "Tip" always stays next to the
 * icon.
 *
 * @param {{text: string}} tip
 * @param {{emoji?: boolean}} [options]
 * @returns {string}
 */
export function formatTip(tip, { emoji = true } = {}) {
	return `${emoji ? BULB_PREFIX : PLAIN_PREFIX} ${tip.text}`;
}

/** Lines naming the on-request command and the example prompt. */
export function formatOnRequestLines() {
	return [
		'Want a tip on request? Run `npm run show:tip`, or give any agent this prompt:',
		`  "${ON_REQUEST_PROMPT}"`,
	];
}

// ── Selection for a hub ──────────────────────────────────────────────────────

/**
 * Pick the tip for a hub, applying the runtime tier guard.
 *
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {object} [options.fsMod]            Used for the config read.
 * @param {string} [options.dataPath]
 * @param {() => number} [options.rng]
 * @param {() => boolean} [options.hasGraphifyInstaller]
 * @returns {{tip: object|null, tipHubType: string|undefined, config: object|null, remember: () => void}}
 *   `remember()` saves the rotation state; callers invoke it only when the tip
 *   is actually printed.
 */
export function getTipForHub({
	hubRoot,
	fsMod = fs,
	dataPath = DEFAULT_TIPS_DATA_PATH,
	rng = Math.random,
	hasGraphifyInstaller,
}) {
	const config = readWorkspaceConfig(hubRoot, fsMod);
	const tipHubType = resolveHubTipHubType(config, { hasGraphifyInstaller });
	const eligible = filterTipsForHubType(loadTips(dataPath), tipHubType);
	const next = pickNextTip(eligible, readTipsState(hubRoot, fsMod), rng);
	const remember = () => {
		if (next.tip) writeTipsState(hubRoot, next.state, fsMod);
	};
	return { tip: next.tip, tipHubType, config, remember };
}

/** True when the process runs under CI. */
export function isCi(env = process.env) {
	const value = env.CI;
	return Boolean(value) && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Build the text block printed at the end of `doctor`: the on-request lines,
 * then the tip as the last line. Returns '' when nothing should print
 * (JSON mode, CI, tips disabled, or a hub type without tips).
 *
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {boolean} [options.json]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {object} [options.fsMod]
 * @param {string} [options.dataPath]
 * @param {() => number} [options.rng]
 * @param {() => boolean} [options.hasGraphifyInstaller]
 * @returns {string}
 */
export function buildTipFooter({
	hubRoot,
	json = false,
	env = process.env,
	platform = process.platform,
	fsMod = fs,
	dataPath,
	rng,
	hasGraphifyInstaller,
}) {
	if (json || isCi(env)) return '';
	const { tip, config, remember } = getTipForHub({
		hubRoot,
		fsMod,
		dataPath,
		rng,
		hasGraphifyInstaller,
	});
	if (!tip || !tipsEnabled(config)) return '';
	remember();
	const emoji = supportsEmoji({
		env,
		platform,
		configIcon: config?.tips?.icon,
	});
	const lines = [
		'',
		...formatOnRequestLines().map((l) => `  ${l}`),
		'',
		`  ${formatTip(tip, { emoji })}`,
	];
	return lines.join('\n') + '\n';
}

/**
 * Setup ending: print one tip, then ask whether to keep tips on and save the
 * answer as `tips.enabled`. Prints and asks nothing for a hub type without
 * tips, in CI, or when tips are already off and the user keeps them off.
 *
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {function(string, boolean=): Promise<boolean>} options.askYN
 * @param {object} [options.fsMod]
 * @param {function(string): void} [options.write]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.dataPath]
 * @param {() => number} [options.rng]
 * @param {() => boolean} [options.hasGraphifyInstaller]
 * @returns {Promise<{shown: boolean, enabled: boolean|null}>}
 */
export async function runSetupTipStep({
	hubRoot,
	askYN,
	fsMod = fs,
	write = (s) => process.stdout.write(s),
	env = process.env,
	platform = process.platform,
	dataPath,
	rng,
	hasGraphifyInstaller,
}) {
	if (isCi(env)) return { shown: false, enabled: null };
	const { tip, config, remember } = getTipForHub({
		hubRoot,
		fsMod,
		dataPath,
		rng,
		hasGraphifyInstaller,
	});
	if (!tip) return { shown: false, enabled: null };

	const wasEnabled = tipsEnabled(config);
	let shown = false;
	if (wasEnabled) {
		const emoji = supportsEmoji({
			env,
			platform,
			configIcon: config?.tips?.icon,
		});
		write(`\n  ${formatTip(tip, { emoji })}\n\n`);
		remember();
		for (const l of formatOnRequestLines()) write(`  ${l}\n`);
		write('\n');
		shown = true;
	}

	const keep = await askYN(
		wasEnabled
			? 'Keep the tip of the day on in doctor and setup? (`npm run show:tip` keeps working either way)'
			: 'Tips are off in doctor and setup. Turn them back on?',
		wasEnabled,
	);
	if (keep !== wasEnabled || config?.tips?.enabled === undefined) {
		const onDisk = readWorkspaceConfig(hubRoot, fsMod) ?? {};
		const next = {
			...onDisk,
			tips: { ...(onDisk.tips ?? {}), enabled: keep },
		};
		fsMod.writeFileSync(
			path.join(hubRoot, 'workspace.config.json'),
			JSON.stringify(next, null, 2) + '\n',
			'utf-8',
		);
	}
	return { shown, enabled: keep };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * `npm run show:tip`. Prints one tip regardless of `tips.enabled`. A hub type
 * without tips prints a short neutral line and still exits 0.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {number} exit code
 */
export function runShowTip(
	argv,
	{
		env = process.env,
		platform = process.platform,
		fsMod = fs,
		write = (s) => process.stdout.write(s),
		cwd = process.cwd(),
		dataPath,
		rng,
		hasGraphifyInstaller,
	} = {},
) {
	const ascii = argv.includes('--ascii');
	const rootIdx = argv.indexOf('--hub-root');
	const hubRoot =
		rootIdx !== -1 && argv[rootIdx + 1] ? path.resolve(argv[rootIdx + 1]) : cwd;
	const { tip, config, remember } = getTipForHub({
		hubRoot,
		fsMod,
		dataPath,
		rng,
		hasGraphifyInstaller,
	});
	if (!tip) {
		write('No tips are available for this hub type.\n');
		return 0;
	}
	const emoji = supportsEmoji({
		env,
		platform,
		ascii,
		configIcon: config?.tips?.icon,
	});
	write(`${formatTip(tip, { emoji })}\n`);
	remember();
	return 0;
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	process.exitCode = runShowTip(process.argv.slice(2));
}
