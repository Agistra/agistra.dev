#!/usr/bin/env node
/**
 * Workspace setup wizard.
 *
 * Collects user / org / agent configuration and writes a gitignored
 * workspace.config.json to the target output directory. Then generates
 * platform-specific personalisation overlays for each detected platform.
 *
 * Run from the source repo:   npm run setup "D:/path/to/hub"
 * Run from a deployed hub:    npm run setup
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { wireRelayMcp, readJsonSafe, writeJsonSafe } from './wizard.js';
import { mergeRelaySessionStartHook } from './lib/claude-hooks.js';
import {
	NIGHTLY_DREAMING_TASK_NAME,
	computeNightlyDreamingTaskName,
	registerNightlyDreamingTask as registerNightlyDreamingTaskDefault,
	removeNightlyDreamingTask as removeNightlyDreamingTaskDefault,
	isNightlyDreamingTaskRegistered as isNightlyDreamingTaskRegisteredDefault,
} from './lib/nightly-dreaming.js';
import { ensureHubRootDepsInstalled as ensureHubRootDepsInstalledDefault } from './lib/hub-root-install.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Manifest-driven, not hardcoded: some hub tiers ship one or more additional
 * setup steps as self-contained plugin modules under lib/ (filename
 * convention: "*.setup-plugin.js"). deployExtras() only copies plugin files
 * into non-free hub tiers (see pipelines/deploy/lib/extras.js); a free "dev"
 * hub never receives any of them, and its own setup wizard always writes
 * hubType: 'dev', so it can never reach the branch below that would call this
 * loader. This keeps setup.js itself generic and free of any tier-specific
 * feature names.
 *
 * Discovers every plugin file present on disk (sorted, so run order is
 * stable) and runs each one in turn with the same opts, awaiting each before
 * starting the next — mirrors doctor.js's checkOptionalTierReadiness(),
 * which already runs every "*.doctor-plugin.js" file rather than just one.
 * Previously exactly one "*.setup-plugin.js" file was ever present per hub,
 * so this was equivalent to running only the first; a hub built with
 * --with-graphify now ships a tier's own plugin (dev-sub.setup-plugin.js /
 * ops.setup-plugin.js) alongside dev-graph.setup-plugin.js, and both must
 * run — the tier's own base setup responsibilities are not optional just
 * because Graphify was added on.
 *
 * @param {object} opts  Forwarded unchanged to every discovered plugin's run(opts) —
 *   each plugin destructures only the properties it needs, so passing the
 *   union of every tier's opts to every plugin is safe (unused properties on
 *   a destructured parameter object are simply ignored).
 * @param {object} [deps]
 * @param {string} [deps.libDir]  Directory to scan for "*.setup-plugin.js" files.
 *   Defaults to this file's own lib/ dir (production). Overridable for testing.
 * @returns {Promise<void>}
 */
export async function defaultSetupTierPlugin(opts, { libDir = path.join(__dirname, 'lib') } = {}) {
	let pluginFiles = [];
	try {
		pluginFiles = fs.readdirSync(libDir)
			.filter(f => f.endsWith('.setup-plugin.js'))
			.sort();
	} catch {
		pluginFiles = [];
	}
	for (const file of pluginFiles) {
		const mod = await import(pathToFileURL(path.join(libDir, file)).href);
		await mod.run(opts);
	}
}
// Source-repo agents/profiles/ dir, relative to this script's own location (not cliOutputRoot).
// Present when running `npm run setup` from inside the setchin-agent-profiles repo itself.
// Absent in a deployed hub (agents/profiles/ is a source-repo-only concept there).
const SOURCE_PROFILES_ROOT = path.resolve(__dirname, '..', '..', 'agents', 'profiles');

// ── Claude Code statusline (exported for testing) ──────────────────────────────

/**
 * Filenames this feature copies to $HOME/.claude/, one per platform family.
 * Windows gets a native PowerShell port (statusline-command.ps1) rather than
 * the bash script: Claude Code's statusLine setting has no exec form (unlike
 * hooks), so the configured command always runs through a shell, and on
 * Windows that shell cannot resolve `bash` on its own child-process PATH even
 * when Git Bash is installed. This hub's own documented constraint
 * (skills/agent-foundations/SKILL.md, "Windows + PowerShell") requires
 * status-line scripts to be .ps1 on Windows, never .sh invoked through a
 * shell that may not have bash resolvable.
 */
export const STATUSLINE_SCRIPT_FILENAME_UNIX = 'statusline-command.sh';
export const STATUSLINE_SCRIPT_FILENAME_WINDOWS = 'statusline-command.ps1';

/**
 * statusLine command value for non-Windows platforms — unchanged from the
 * pre-existing behaviour. `~` is bash/zsh shell-expansion syntax, resolved
 * correctly by the shell Claude Code spawns to run shell-form statusLine
 * commands on Mac/Linux.
 */
export const STATUSLINE_COMMAND_UNIX = `bash ~/.claude/${STATUSLINE_SCRIPT_FILENAME_UNIX}`;

/**
 * Resolve the filename this feature copies to $HOME/.claude/ for a given
 * platform.
 *
 * @param {NodeJS.Platform} [platform] Defaults to the real process.platform.
 * @returns {string}
 */
export function resolveStatuslineScriptFilename(platform = process.platform) {
	return platform === 'win32' ? STATUSLINE_SCRIPT_FILENAME_WINDOWS : STATUSLINE_SCRIPT_FILENAME_UNIX;
}

/**
 * Absolute path to the canonical shipped statusline script, resolved
 * relative to this file's own location (not cliOutputRoot/hubRoot) — same
 * convention other tier-gated setup plugin files use for their own
 * script-path resolution, so this works identically whether setup.js is
 * running from the source repo or from a deployed hub's own copy of
 * pipelines/deploy/setup.js.
 *
 * @param {NodeJS.Platform} [platform] Defaults to the real process.platform.
 * @returns {string}
 */
export function resolveStatuslineScriptSourcePath(platform = process.platform) {
	return path.join(__dirname, 'lib', resolveStatuslineScriptFilename(platform));
}

/**
 * Build the exact statusLine command string for a given $HOME and platform.
 * Non-Windows: unchanged bash-form command (`~` shell-expansion). Windows:
 * `~` does not reliably expand outside bash, so the absolute installed script
 * path is baked in and invoked directly via `powershell -NoProfile -File`
 * (the pattern Claude Code's own docs use for a Windows statusLine script:
 * https://code.claude.com/docs/en/statusline).
 *
 * @param {string} homeDir
 * @param {NodeJS.Platform} [platform] Defaults to the real process.platform.
 * @returns {string}
 */
export function buildStatuslineCommand(homeDir, platform = process.platform) {
	if (platform === 'win32') {
		const scriptPath = path.join(homeDir, '.claude', STATUSLINE_SCRIPT_FILENAME_WINDOWS);
		return `powershell -NoProfile -File "${scriptPath}"`;
	}
	return STATUSLINE_COMMAND_UNIX;
}

/**
 * Build the exact statusLine settings.json entry this feature installs.
 *
 * @param {string} homeDir
 * @param {NodeJS.Platform} [platform] Defaults to the real process.platform.
 * @returns {{type: 'command', command: string}}
 */
export function buildStatuslineSettingsEntry(homeDir, platform = process.platform) {
	return { type: 'command', command: buildStatuslineCommand(homeDir, platform) };
}

/**
 * Is the given settings.json `statusLine` value the one this feature
 * installs? Distinguishes "already installed by this exact mechanism"
 * (silently safe to refresh, never re-asks) from a foreign pre-existing
 * statusLine command that must never be silently clobbered.
 *
 * @param {object|string|undefined|null} statusLineEntry
 * @param {string} homeDir
 * @param {NodeJS.Platform} [platform] Defaults to the real process.platform.
 * @returns {boolean}
 */
export function isAgistraStatusline(statusLineEntry, homeDir, platform = process.platform) {
	return !!statusLineEntry
		&& typeof statusLineEntry === 'object'
		&& statusLineEntry.type === 'command'
		&& statusLineEntry.command === buildStatuslineCommand(homeDir, platform);
}

/**
 * Interactive install/refresh step for the Claude Code statusline feature —
 * tier-agnostic, called unconditionally for every hubType (same "applies
 * uniformly across hub tiers, not gated by hubType" precedent as the
 * nightly-dreaming block below). Platform-conditional on script *shape*
 * (bash .sh vs native PowerShell .ps1 — see resolveStatuslineScriptFilename),
 * but not platform-gated as a whole feature: it still installs on every
 * platform, just with the platform-appropriate script and command.
 *
 * All filesystem access goes through the same injectable fsMod the rest of
 * createRun() already uses — this keeps the step fully mockable in tests and
 * ensures a mocked fsMod can never leak a write onto the real machine's
 * $HOME, regardless of what homeDir string is used to build paths.
 *
 * A missing/unreadable script source (e.g. a broken deploy) warns and skips
 * rather than throwing — this step must never crash the rest of the wizard,
 * same non-fatal posture as the nightly Scheduled Task registration failure
 * warning below.
 *
 * @param {object} opts
 * @param {function(string, boolean=): Promise<boolean>} opts.askYN
 * @param {object} opts.fsMod  Injectable fs module.
 * @param {string} opts.homeDir  Absolute path to $HOME.
 * @param {string} opts.scriptSourcePath  Absolute path to the canonical shipped script.
 * @param {NodeJS.Platform} [opts.platform]  Defaults to the real process.platform.
 * @param {function(string): void} [opts.log]
 * @returns {Promise<{installed: boolean, skippedExisting?: boolean, refreshed?: boolean, error?: string}>}
 */
export async function maybeInstallStatusline({ askYN, fsMod, homeDir, scriptSourcePath, platform = process.platform, log = (s) => process.stdout.write(s) }) {
	const claudeDir = path.join(homeDir, '.claude');
	const settingsPath = path.join(claudeDir, 'settings.json');
	const scriptTargetPath = path.join(claudeDir, resolveStatuslineScriptFilename(platform));

	let existingSettings = null;
	if (fsMod.existsSync(settingsPath)) {
		try {
			existingSettings = JSON.parse(fsMod.readFileSync(settingsPath, 'utf-8'));
		} catch {
			existingSettings = null;
		}
	}
	const existingStatusLine = existingSettings?.statusLine;
	const alreadyInstalledByThisMechanism = isAgistraStatusline(existingStatusLine, homeDir, platform);

	// Already installed by this exact mechanism on a prior `npm run setup` run —
	// skip the initial install prompt entirely and go straight to a silent
	// refresh below (script content + settings.json), rather than re-asking
	// the same yes/no question on every rerun.
	if (!alreadyInstalledByThisMechanism) {
		const wantsInstall = await askYN(
			'Install the Claude Code statusline (context/rate-limit/cost visibility in your terminal)?',
			true,
		);
		if (!wantsInstall) return { installed: false };

		if (existingStatusLine) {
			const overwrite = await askYN(
				`  An existing statusLine command is already configured (${JSON.stringify(existingStatusLine)}). Overwrite it with the Agistra statusline?`,
				false,
			);
			if (!overwrite) {
				log('  Skipping statusline install — existing statusLine command left untouched.\n');
				return { installed: false, skippedExisting: true };
			}
		}
	}

	let scriptSource;
	try {
		scriptSource = fsMod.readFileSync(scriptSourcePath, 'utf-8');
	} catch (err) {
		log(`  WARNING: could not read the statusline script (${err.message}) — skipping install.\n`);
		return { installed: false, error: err.message };
	}

	fsMod.mkdirSync(claudeDir, { recursive: true });
	// Always refresh the script content, even when settings.json already has
	// the right statusLine entry — this is what lets future script
	// improvements reach the customer on a later `npm run setup` re-run.
	fsMod.writeFileSync(scriptTargetPath, scriptSource, 'utf-8');

	const updatedSettings = { ...(existingSettings ?? {}), statusLine: buildStatuslineSettingsEntry(homeDir, platform) };
	fsMod.writeFileSync(settingsPath, JSON.stringify(updatedSettings, null, 2) + '\n', 'utf-8');

	log(`  Statusline ${alreadyInstalledByThisMechanism ? 'refreshed' : 'installed'} → ${scriptTargetPath}\n`);
	return { installed: true, refreshed: alreadyInstalledByThisMechanism };
}

/**
 * Read the static hub-type config file injected into the archive by the packaging
 * profile (e.g. package-dev-graph.js → pipelines/deploy/.hub-config.json).
 * Returns the parsed object, or null if absent or unparseable.
 *
 * Used by setup.js to determine the hub tier on first run (before
 * workspace.config.json exists and prev.hubType is set).
 *
 * @param {string} [deployDir]  Directory containing .hub-config.json (defaults to __dirname).
 * @returns {{ hubType?: string }|null}
 */
export function readHubConfig(deployDir = __dirname) {
	const p = path.join(deployDir, '.hub-config.json');
	if (!fs.existsSync(p)) return null;
	try {
		return JSON.parse(fs.readFileSync(p, 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * Resolve the hubType to write into workspace.config.json, reconciling a
 * previously-stored hubType (from an existing workspace.config.json) against
 * the packaged tier sentinel (.hub-config.json, read via readHubConfig()).
 *
 * A stored hubType is trusted as-is when there is nothing to compare it
 * against (no packaged sentinel — e.g. a "dev" hub) or when it agrees with
 * the packaged value (the common no-op rerun case — no prompt, no output).
 * When the two disagree, the customer is warned and asked whether to correct
 * hubType to the packaged value. Neither value is ever silently applied over
 * the other: a stored hubType is never overridden without asking, and a
 * disagreeing packaged value is never ignored without saying so.
 *
 * This reconciliation closes the gap where a stale
 * workspace.config.json — e.g. left over from an earlier "dev" setup run in
 * the same target directory, which a fresh archive's unzip-merge never
 * removes because the archive itself never ships workspace.config.json —
 * silently locked in the wrong tier forever with no way to recover except
 * hand-editing the file.
 *
 * @param {object} deps
 * @param {string|undefined} deps.prevHubType      hubType from an existing workspace.config.json, if any.
 * @param {string|undefined} deps.packagedHubType  hubType from readHubConfig(), if any.
 * @param {function(string, boolean=): Promise<boolean>} deps.askYN
 * @param {function(string): void} deps.warn        Writer for warning lines (e.g. process.stdout.write).
 * @returns {Promise<string>} the resolved hubType to store.
 */
export async function resolveHubType({ prevHubType, packagedHubType, askYN, warn }) {
	if (!prevHubType) {
		// First run (or an unparsable/absent previous config) — trust the
		// packaged sentinel if present, else fall back to the free "dev" tier.
		return packagedHubType ?? 'dev';
	}
	if (!packagedHubType || packagedHubType === prevHubType) {
		// No packaged sentinel to compare against, or it agrees with the
		// stored value — nothing to reconcile, no prompt.
		return prevHubType;
	}
	// Mismatch: a stored hubType exists and disagrees with this package's own
	// tier. Never silently let either value win — warn and ask.
	warn(
		`\n  WARNING: stored hub type "${prevHubType}" does not match this package's hub type "${packagedHubType}".\n` +
		'  This can happen if an old workspace.config.json survived from a previous setup in this same directory.\n',
	);
	const acceptPackaged = await askYN(
		`Correct hubType to the packaged value ("${packagedHubType}")?`,
		true,
	);
	if (acceptPackaged) return packagedHubType;
	warn(`  Keeping stored hubType "${prevHubType}". Re-run setup later if this was unintentional.\n`);
	return prevHubType;
}

// ── Pure helpers (exported for testing) ───────────────────────────────────────

/**
 * Detect which platform agent directories are present in the given root.
 *
 * @param {string} root  Absolute path to the workspace root.
 * @returns {{ claude: boolean, cursor: boolean, github: boolean }}
 */
export function detectPlatforms(root) {
	return {
		claude: fs.existsSync(path.join(root, '.claude', 'agents')),
		cursor: fs.existsSync(path.join(root, '.cursor', 'agents')),
		github: fs.existsSync(path.join(root, '.github', 'agents')),
	};
}

/**
 * Discover known agent IDs at runtime, without hardcoding the list.
 *
 * Tries, in order:
 *   1. agents/profiles/*-workspace directories next to this script (source-repo run) —
 *      e.g. agents/profiles/architect-workspace → id "architect".
 *   2. Deployed-hub agent directories under cliOutputRoot — .claude/agents/*.md,
 *      .cursor/agents/*.md, .github/agents/*.agent.md — whichever is present.
 *
 * Returns a sorted, de-duplicated array of lowercase agent IDs. Empty array if
 * neither source is available (never throws).
 *
 * @param {string} cliOutputRoot  Absolute path to the workspace root being configured.
 * @param {object} fsMod          Injectable fs module (real fs or an in-memory mock).
 * @returns {string[]}
 */
export function discoverAgentIds(cliOutputRoot, fsMod) {
	const ids = new Set();

	// 1. Source-repo profiles/*-workspace dirs
	if (fsMod.existsSync(SOURCE_PROFILES_ROOT)) {
		try {
			for (const name of fsMod.readdirSync(SOURCE_PROFILES_ROOT)) {
				const match = /^(.+)-workspace$/i.exec(name);
				if (match) ids.add(match[1].trim().toLowerCase());
			}
		} catch {
			// Unreadable profiles/ dir — fall through to deployed-hub discovery
		}
	}

	// 2. Deployed-hub agent directories
	const deployedDirs = [
		{ dir: path.join(cliOutputRoot, '.claude', 'agents'), suffix: '.md' },
		{ dir: path.join(cliOutputRoot, '.cursor', 'agents'), suffix: '.md' },
		{ dir: path.join(cliOutputRoot, '.github', 'agents'), suffix: '.agent.md' },
	];
	for (const { dir, suffix } of deployedDirs) {
		if (!fsMod.existsSync(dir)) continue;
		try {
			for (const name of fsMod.readdirSync(dir)) {
				if (name.endsWith(suffix)) {
					ids.add(name.slice(0, -suffix.length).trim().toLowerCase());
				}
			}
		} catch {
			// Unreadable agents dir — skip this source
		}
	}

	return [...ids].sort();
}

/**
 * Check whether the `gh` CLI is installed and authenticated.
 *
 * Used by the GitHub-workflow opt-in question during setup. Never blocks
 * setup from completing — callers decide how to surface the result (warn,
 * not exit).
 *
 * @param {function(string, string[], object): void} [execFn]
 *   Injectable exec function for testing. Defaults to execFileSync.
 * @returns {{ installed: boolean, authenticated: boolean }}
 */
export function checkGhCli(execFn = execFileSync) {
	let installed = false;
	let authenticated = false;
	try {
		execFn('gh', ['--version'], { stdio: 'pipe' });
		installed = true;
	} catch {
		// gh not on PATH — installed stays false
	}
	if (installed) {
		try {
			execFn('gh', ['auth', 'status'], { stdio: 'pipe' });
			authenticated = true;
		} catch {
			// gh installed but not authenticated — authenticated stays false
		}
	}
	return { installed, authenticated };
}

/**
 * Build the shared personalisation body text from a workspace config object.
 * Used by both the Cursor and GitHub generators.
 *
 * @param {object} config  Parsed workspace.config.json object.
 * @returns {string}
 */
export function buildPersonalisationContent(config) {
	const lines = [];

	// User identity
	lines.push('## Workspace Identity');
	lines.push('');
	lines.push(`- **Name:** ${config.user?.name ?? ''}`);
	lines.push(`- **Role:** ${config.user?.role ?? ''}`);
	lines.push(`- **Organisation:** ${config.org ?? ''}`);

	// Agent display names
	const agents = config.agents ?? {};
	const agentEntries = Object.entries(agents);
	if (agentEntries.length > 0) {
		lines.push('');
		lines.push('## Agent Display Names');
		lines.push('');
		for (const [id, { displayName }] of agentEntries) {
			lines.push(`- **${id}:** ${displayName}`);
		}
	}

	// Remote team
	const rt = config.remoteTeam;
	if (rt?.enabled) {
		lines.push('');
		lines.push('## Remote Team');
		lines.push('');
		lines.push(`- **Remote team name:** ${rt.name ?? ''}`);
		lines.push(`- **Remote agent name:** ${rt.agentName ?? ''}`);

		const handle = rt.telegram?.handle;
		if (handle) {
			lines.push(`- **Telegram handle:** ${handle}`);
		}

		if (rt.telegram) {
			lines.push('- **Telegram bot token:** see workspace.config.json → remoteTeam.telegram.botToken');
		}
	}

	return lines.join('\n');
}

const GENERATED_HEADER = '<!-- Generated by setup.js — do not edit manually -->';

/**
 * Generate .cursor/rules/workspace-identity.mdc for the given workspace root.
 *
 * @param {string} root    Absolute path to the workspace root.
 * @param {object} config  Parsed workspace.config.json object.
 */
export function generateCursorIdentity(root, config) {
	const rulesDir = path.join(root, '.cursor', 'rules');
	fs.mkdirSync(rulesDir, { recursive: true });

	const frontmatter = [
		'---',
		'description: Workspace identity and personalisation for Cursor agents',
		'alwaysApply: true',
		'---',
	].join('\n');

	const body = buildPersonalisationContent(config);
	const content = `${GENERATED_HEADER}\n${frontmatter}\n\n${body}\n`;

	fs.writeFileSync(path.join(rulesDir, 'workspace-identity.mdc'), content, 'utf-8');
}

/**
 * Generate .github/copilot-instructions.md for the given workspace root.
 *
 * @param {string} root    Absolute path to the workspace root.
 * @param {object} config  Parsed workspace.config.json object.
 */
export function generateGithubCopilotInstructions(root, config) {
	const githubDir = path.join(root, '.github');
	fs.mkdirSync(githubDir, { recursive: true });

	const body = buildPersonalisationContent(config);
	const content = `${GENERATED_HEADER}\n\n${body}\n`;

	fs.writeFileSync(path.join(githubDir, 'copilot-instructions.md'), content, 'utf-8');
}

// ── Token sentinel (exported for testing) ─────────────────────────────────────

/**
 * Sentinel value shown in the bot-token prompt when a token is already stored.
 * If the user presses Enter without typing, ask() returns this string.
 * setup.run() checks for equality: if the returned value matches, the existing
 * token is preserved silently. If the user types anything else, that replaces it.
 */
export const TOKEN_SENTINEL = '[token set — press Enter to keep]';

// ── Testable run factory (exported for unit tests) ─────────────────────────────

/**
 * Create a run() function with injectable I/O and filesystem.
 * Separating the run logic from the real readline/fs lets unit tests drive the
 * wizard without spawning a subprocess or touching real files.
 *
 * @param {object} deps
 * @param {function(string, string=): Promise<string>} deps.ask
 *   Prompt for a string value. Should honour a defaultValue parameter.
 * @param {function(string, boolean=): Promise<boolean>} deps.askYN
 *   Prompt for a yes/no value. Should honour a defaultYes parameter.
 * @param {function(string=): void} deps.line
 *   Print a visual section separator.
 * @param {object} deps.fsMod
 *   Injectable fs module (real fs or an in-memory mock).
 * @param {string} deps.cliOutputRoot
 *   Absolute path to the workspace root being configured.
 * @param {function(): {installed: boolean, authenticated: boolean}} [deps.checkGh]
 *   Injectable `gh` CLI probe (see checkGhCli). Defaults to the real probe.
 * @param {function(string=): ({hubType?: string}|null)} [deps.readHubConfig]
 *   Injectable packaged-tier sentinel reader (see readHubConfig). Defaults to the real
 *   reader, which reads .hub-config.json from disk (not via fsMod — see readHubConfig's
 *   own doc comment for why it is a separate, always-real-fs read).
 * @param {string} [deps.platform]
 *   Injectable process.platform, used only to pick the right `gh` CLI install
 *   instructions to print when it's missing. Defaults to the real process.platform.
 * @param {function} [deps.registerNightlyDreamingTask]
 *   Injectable nightly dreaming Scheduled Task registration (see lib/nightly-dreaming.js).
 * @param {function} [deps.removeNightlyDreamingTask]
 *   Injectable nightly dreaming Scheduled Task removal (see lib/nightly-dreaming.js).
 * @param {function} [deps.isNightlyDreamingTaskRegistered]
 *   Injectable live Scheduled Task presence check (see lib/nightly-dreaming.js). Used to
 *   skip the interactive re-prompt on a true no-op re-run (config already says enabled
 *   AND the live task is still registered).
 * @param {string} [deps.homeDir]
 *   Injectable absolute path to $HOME, used only by the statusline install step below.
 *   Defaults to the real os.homedir() — tests point this at a scratch fixture directory.
 * @param {function} [deps.installStatusline]
 *   Injectable statusline install/refresh step (see maybeInstallStatusline above).
 * @param {function} [deps.ensureHubRootDepsInstalled]
 *   Injectable hub-root npm dependency install step (see lib/hub-root-install.js).
 *   Defaults to the real implementation (runs a real `npm ci`/`npm install` when
 *   node_modules/ is missing or stale). Overridable so unit tests can verify this
 *   step's own wiring (runs early, every hubType) without spawning a real npm install.
 * @returns {function(): Promise<void>}
 */
export function createRun({
	ask,
	askYN,
	askSecret,
	line,
	fsMod,
	cliOutputRoot,
	checkGh = checkGhCli,
	readHubConfig: readHubConfigFn = readHubConfig,
	setupTierPlugin = defaultSetupTierPlugin,
	tierPluginPort,
	platform = process.platform,
	registerNightlyDreamingTask = registerNightlyDreamingTaskDefault,
	removeNightlyDreamingTask = removeNightlyDreamingTaskDefault,
	isNightlyDreamingTaskRegistered = isNightlyDreamingTaskRegisteredDefault,
	homeDir = os.homedir(),
	installStatusline = maybeInstallStatusline,
	ensureHubRootDepsInstalled = ensureHubRootDepsInstalledDefault,
}) {
	return async function run() {
		// ── Hub-root npm dependencies ──────────────────────────────────────────────
		// Runs first, before anything else: buildPackageJson() (lib/extras.js)
		// writes this hub's own package.json unconditionally on every hubType, and
		// several steps further down (the relay MCP wiring, any tier plugin that
		// spawns packages/vault/vault-guard.cjs indirectly via a prior-hub
		// migration) assume node_modules/ is already populated from it. Idempotent —
		// see lib/hub-root-install.js's own doc comment for the presence-check that
		// makes a re-run against an already-installed hub a true no-op.
		line('Hub-root dependencies ');
		ensureHubRootDepsInstalled({ hubRoot: cliOutputRoot, fsMod });

		// ── Read existing config (pre-populate defaults) ──────────────────────────
		let existingConfig = null;
		const configPath = path.join(cliOutputRoot, 'workspace.config.json');
		if (fsMod.existsSync(configPath)) {
			try {
				existingConfig = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'));
			} catch {
				// Unparseable config — treat as fresh run
			}
		}

		const prev = existingConfig ?? {};
		const prevRemoteTeam = prev.remoteTeam ?? {};
		const prevTelegram = prev.telegram ?? {};
		const prevTgHandle = prevRemoteTeam.telegram?.handle ?? '';
		const prevTgGroupId = prevTelegram.relay_group_id ?? '';
		const prevBotToken = prevTelegram.bot_token ?? '';
		const prevRelay = prev.relay ?? {};
		const prevTrackingIssue = prevRelay.github?.trackingIssue ?? '';
		const prevGithubWorkflows = prev.githubWorkflows ?? {};

		// ── Prompts ────────────────────────────────────────────────────────────────

		process.stdout.write('\n╔══════════════════════════════════════════════╗\n');
		process.stdout.write('║           Agent Workspace Setup              ║\n');
		process.stdout.write('╚══════════════════════════════════════════════╝\n');

		line('You ');
		const userName = await ask('Your name', prev.user?.name ?? '');
		const userRole = await ask('Your role (e.g. Technical Lead)', prev.user?.role ?? 'Technical Lead');

		line('Organisation ');
		const orgName = await ask('Organisation or team name', prev.org ?? '');

		line('Agent display names ');
		const prevAgents = prev.agents ?? {};
		const agentIds = discoverAgentIds(cliOutputRoot, fsMod);
		const agents = {};
		for (const id of agentIds) {
			const prevDisplayName = prevAgents[id]?.displayName ?? '';
			const displayName = await ask(`Display name for ${id} (optional)`, prevDisplayName);
			if (displayName) {
				agents[id] = { displayName };
			}
		}

		line('Remote team ');
		const hasRemoteTeam = await askYN('Do you work with a remote team?', prevRemoteTeam.enabled === true);

		let remoteTeam = { enabled: false };
		let telegramMcp = null;
		if (hasRemoteTeam) {
			const remoteTeamName = await ask('Remote team name', prevRemoteTeam.name ?? 'Remote Team');
			const remoteAgentName = await ask('Remote agent name', prevRemoteTeam.agentName ?? 'Remote Agent');
			const hasTelegram = await askYN(
				'Does the remote team use Telegram?',
				prevRemoteTeam.telegram != null,
			);
			if (hasTelegram) {
				const telegramHandle = await ask('Telegram bot handle (e.g. @mybot)', prevTgHandle);
				const tokenDefault = prevBotToken ? TOKEN_SENTINEL : '';
				const tokenAnswer = await ask('Telegram bot token (from @BotFather)', tokenDefault);
				const telegramToken = tokenAnswer === TOKEN_SENTINEL ? prevBotToken : tokenAnswer;
				const telegramGroupId = await ask('Relay group ID (e.g. -1001234567890)', prevTgGroupId);
				remoteTeam = {
					enabled: true,
					name: remoteTeamName,
					agentName: remoteAgentName,
					telegram: { handle: telegramHandle },
				};
				telegramMcp = { enabled: true, bot_token: telegramToken, relay_group_id: telegramGroupId };
			} else {
				remoteTeam = { enabled: true, name: remoteTeamName, agentName: remoteAgentName };
			}
		}

		line('GitHub workflows ');
		const wantsGithubWorkflows = await askYN(
			'Do you intend to use GitHub-based workflows (PR creation via Builder/Tester)?',
			prevGithubWorkflows.enabled === true,
		);
		let githubWorkflows = { enabled: false };
		if (wantsGithubWorkflows) {
			const { installed, authenticated } = checkGh();
			githubWorkflows = { enabled: true };
			if (!installed) {
				process.stdout.write(
					'  WARNING: `gh` CLI not found on PATH. Builder/Tester will not be able to create PRs until it is installed.\n',
				);
				if (platform === 'win32') {
					process.stdout.write(
						'  Install it with:  winget install --id GitHub.cli --source winget\n',
					);
				} else if (platform === 'darwin') {
					process.stdout.write(
						'  Install it with:  brew install gh\n',
					);
				} else {
					process.stdout.write(
						'  Install instructions for your platform: https://github.com/cli/cli/blob/trunk/docs/install_linux.md\n',
					);
				}
			} else if (!authenticated) {
				process.stdout.write(
					'  WARNING: `gh` CLI is installed but not authenticated. Run `gh auth login` before Builder/Tester create PRs.\n',
				);
			}
		}

		// Detect which platforms are present
		const platforms = detectPlatforms(cliOutputRoot);

		// Ask confirmation per detected platform (skip Claude — workspace.config.json is sufficient)
		let configureCursor = false;
		let configureGithub = false;

		if (platforms.cursor) {
			line('Cursor ');
			configureCursor = await askYN('Generate Cursor workspace identity rule?', true);
		}

		if (platforms.github) {
			line('GitHub ');
			configureGithub = await askYN('Generate GitHub Copilot instructions?', true);
		}

		let relayBlock = { ...prevRelay };

		if (platforms.github && remoteTeam.enabled) {
			line('GitHub relay ');
			const trackingIssue = await ask(
				'Relay tracking issue (owner/repo#N)',
				prevTrackingIssue,
			);
			if (trackingIssue) {
				relayBlock.github = { trackingIssue };
			}
			if (!platforms.claude && !platforms.cursor) {
				relayBlock.primaryRuntime = 'github';
			}
			process.stdout.write(
				'  Install workflow: copy pipelines/deploy/relay/adapters/github-action.yml to .github/workflows/relay-notify.yml\n',
			);
		}

		if (platforms.claude && remoteTeam.enabled && !relayBlock.primaryRuntime) {
			relayBlock.primaryRuntime = 'claude-code';
			if (relayBlock.autoDispatch === undefined) {
				relayBlock.autoDispatch = false;
			}
		}

		// hubType controls which agent profiles are expected by `npm run doctor`.
		//   "dev"       — expects: architect, builder, tester, router (no cao)
		//   "dev:graph" — same profiles as dev; Graphify setup and doctor checks active
		//   "dev:sub"   — expects: architect, builder, tester, router, cao
		//   "ops"       — expects: architect, builder, tester, router, cao
		// On first setup in a packaged archive, .hub-config.json (injected by the
		// packaging profile) provides the hub type rather than defaulting to "dev".
		// A stored hubType that disagrees with the packaged sentinel is never
		// silently trusted — resolveHubType() warns and asks.
		const hubType = await resolveHubType({
			prevHubType: prev.hubType,
			packagedHubType: readHubConfigFn()?.hubType,
			askYN,
			warn: (msg) => process.stdout.write(msg),
		});

		const config = {
			user: { name: userName, role: userRole },
			org: orgName,
			hubType,
			remoteTeam,
			githubWorkflows,
			...(telegramMcp ? { telegram: telegramMcp } : {}),
			...(Object.keys(relayBlock).length > 0 ? { relay: relayBlock } : {}),
			...(Object.keys(agents).length > 0 ? { agents } : {}),
			// Preserve the bootstrap flag across re-runs of setup — re-running setup
			// must never silently reset "has the team run its self-check" state.
			...(prev.bootstrap ? { bootstrap: prev.bootstrap } : {}),
			// Preserve the doctor last-run record across re-runs of setup — re-running
			// setup must never silently erase doctor's last-run history.
			...(prev.doctor ? { doctor: prev.doctor } : {}),
			// Preserve graphify config across re-runs of setup as defense-in-depth: the
			// dev-graph tier plugin normally re-adds this field itself from its own
			// existingConfig read after this write, but several of its own early-return
			// paths (uv not installed and declined, uv install failed, `uv tool install`
			// failure) exit before reaching that step — this line ensures those paths
			// never permanently lose a previously-recorded graphify config.
			...(prev.graphify ? { graphify: prev.graphify } : {}),
			// Preserve a pre-existing modelProvider config across re-runs of setup
			// exactly as-is. Defaulting modelProvider on a hub type that has never
			// configured it is the tier-gated model-provider setup plugin's own
			// responsibility (it runs after this write, via setupTierPlugin() below,
			// and is never shipped to a hub type that shouldn't see this field at
			// all) — this file only ever preserves an already-set value.
			...(prev.modelProvider ? { modelProvider: prev.modelProvider } : {}),
			// Preserve scanned project registrations across re-runs of setup — re-running
			// setup must never silently drop projects.<name> entries that `npm run scan`
			// wrote via registerProject() (pipelines/deploy/lib/bootstrap.js).
			...(prev.projects ? { projects: prev.projects } : {}),
		};

		fsMod.mkdirSync(cliOutputRoot, { recursive: true });
		fsMod.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

		// Warn if .gitignore does not cover the config file
		const gitignorePath = path.join(cliOutputRoot, '.gitignore');
		let gitignoreCovers = false;
		if (fsMod.existsSync(gitignorePath)) {
			const gi = fsMod.readFileSync(gitignorePath, 'utf-8');
			gitignoreCovers = gi.split('\n').some(l => l.trim() === 'workspace.config.json');
		}

		// Wire relay MCP into detected platform configs
		if (telegramMcp) {
			const targets = [
				...(platforms.claude ? ['claude-code'] : []),
				...(platforms.cursor ? ['cursor'] : []),
			];
			line('Relay MCP ');
			const { wrote } = wireRelayMcp({ config, workspaceRoot: cliOutputRoot, targets });
			if (wrote.length > 0) {
				for (const f of wrote) process.stdout.write(`  MCP wired → ${f}\n`);
			}
			if (platforms.claude) {
				const settingsPath = path.join(cliOutputRoot, '.claude', 'settings.json');
				const existing = readJsonSafe(settingsPath, fsMod) ?? { enableAllProjectMcpServers: true };
				writeJsonSafe(settingsPath, mergeRelaySessionStartHook(existing), fsMod);
				process.stdout.write(`  Relay autostart hook → ${settingsPath}\n`);
			}
		}

		// Each branch below builds the same superset of opts (ask/askYN/askSecret/
		// portOverride/platforms/readJsonSafe/writeJsonSafe) regardless of which one
		// fires, rather than a narrower per-tier subset. A hub built with
		// --with-graphify ships dev-graph.setup-plugin.js ALONGSIDE the tier's own
		// plugin file, and setupTierPlugin() (defaultSetupTierPlugin()) now runs every
		// "*.setup-plugin.js" file present, not just one — so whichever tier branch
		// below fires must supply everything ANY discovered plugin might need (e.g.
		// askSecret, for the Graphify add-on's masked API-key prompt), not just what
		// that tier's own primary plugin uses. Each plugin's own run() destructures
		// only the properties it needs; unused ones are ignored.
		const tierPluginOpts = {
			hubRoot: cliOutputRoot,
			portOverride: tierPluginPort,
			platforms,
			ask,
			askYN,
			askSecret,
			// Forwarded so a tier plugin shared across multiple hubTypes (e.g.
			// dev-sub.setup-plugin.js, shipped to both "dev:sub" and "publish") can
			// gate hubType-specific steps internally — see that plugin's own
			// LangGraph install gate.
			hubType: config.hubType,
			readJsonSafe: (p) => readJsonSafe(p, fsMod),
			writeJsonSafe: (p, v) => writeJsonSafe(p, v, fsMod),
		};

		if (config.hubType === 'dev:sub') {
			line('Knowledge retrieval ');
			// The tier plugin (dev:sub-only, discovered generically above) owns
			// both the knowledge retrieval setup and its own runtime lifecycle
			// hook wiring (SessionStart/PostToolUse/Stop) — passing
			// platforms/readJsonSafe/writeJsonSafe lets it merge into
			// .claude/settings.json itself without setup.js importing anything
			// tier-specific directly. ask/askYN are also passed through so the
			// plugin can prompt for a prior-hub migration using the same
			// injectable I/O as the rest of setup — mirroring how the
			// dev:graph tier plugin already receives them.
			await setupTierPlugin(tierPluginOpts);
		}

		if (config.hubType === 'dev:graph') {
			// The tier plugin (dev:graph-only, discovered generically by filename
			// convention) handles Graphify installation and semantic extraction opt-in.
			// ask/askYN/askSecret are passed so the plugin can prompt the user
			// interactively using the same injectable I/O as the rest of setup.
			// askSecret masks the API key input — it is never echoed to the terminal.
			await setupTierPlugin(tierPluginOpts);
		}

		if (config.hubType === 'ops') {
			// The tier plugin (ops-only, discovered generically by filename
			// convention — lib/ops.setup-plugin.js) owns the prior-hub migration
			// prompt, plus the LangGraph runtime's setup-time install. ops has
			// no other non-migration setup responsibility wired here yet (knowledge-retrieval/vault
			// provisioning) — a pre-existing, separately-flagged gap, not this
			// ticket's scope. ask/askYN are passed through the same way the
			// dev:graph/dev:sub tier plugins already receive them.
			await setupTierPlugin(tierPluginOpts);
		}

		if (config.hubType === 'publish') {
			line('Knowledge retrieval ');
			// The tier plugin discovered here is dev-sub.setup-plugin.js — it
			// ships to both "dev:sub" and "publish" hubs (see extras.js) and was
			// previously never actually invoked for "publish" (no branch existed
			// for this hubType at all, a pre-existing gap surfaced while wiring
			// the LangGraph runtime install — that plugin also
			// owns its own knowledge-retrieval setup and prior-hub migration
			// prompt, same as the dev:sub branch above). hubType is forwarded via
			// tierPluginOpts so the plugin can gate its LangGraph install step to
			// "publish" only, never "dev:sub".
			await setupTierPlugin(tierPluginOpts);
		}

		// ── Claude Code statusline ────────────────────────────────────────────────
		// Tier-agnostic — applies uniformly across hub tiers, not gated by hubType,
		// same precedent as the nightly-dreaming block below. Installs
		// unconditionally on every platform; the script shape and command it
		// writes are platform-conditional (bash .sh vs native PowerShell .ps1 —
		// see resolveStatuslineScriptFilename/buildStatuslineCommand).
		line('Claude Code statusline ');
		await installStatusline({
			askYN,
			fsMod,
			homeDir,
			scriptSourcePath: resolveStatuslineScriptSourcePath(platform),
			platform,
		});

		// ── Nightly dreaming (Windows only) ──────────────────────────────────────
		// Applies uniformly across hub tiers — not gated by hubType. Runs last (after
		// the tier plugin steps above) and does its own read-merge-write of
		// workspace.config.json, the same incremental-update pattern
		// dev-graph.setup-plugin.js already uses for its own `graphify` block, so the
		// earlier base `config` write above never needs to know about this feature.
		if (platform === 'win32') {
			line('Nightly dreaming (Windows only) ');
			process.stdout.write(
				'  Nightly dreaming runs "Good night Team" automatically every night via a\n' +
				'  Windows Scheduled Task, so end-of-day memory consolidation does not depend\n' +
				'  on remembering to say it. Off by default; you can turn it off again at any\n' +
				'  time (npm run setup -- --disable-nightly-dreaming, or decline here).\n',
			);
			const prevNightlyDreaming = prev.nightlyDreaming ?? {};
			const prevNightlyEnabled = prevNightlyDreaming.enabled === true;
			const prevNightlyTaskName = prevNightlyDreaming.taskName ?? NIGHTLY_DREAMING_TASK_NAME;
			// Presence-check before prompting: if the wizard's own record already says
			// nightly dreaming is enabled AND the live Windows Scheduled Task is confirmed
			// still registered, this run is a true no-op re-run — skip the interactive
			// re-prompt and just confirm. Drift (config says enabled but the live task was
			// deleted, e.g. manually in Task Scheduler) still falls through to the normal
			// prompt below, which is the existing self-healing (re-register) path.
			const liveTaskRegistered = prevNightlyEnabled
				? isNightlyDreamingTaskRegistered({ taskName: prevNightlyTaskName })
				: false;

			let nightlyDreaming;
			if (prevNightlyEnabled && liveTaskRegistered) {
				process.stdout.write(`  Nightly dreaming already enabled — task ${prevNightlyTaskName} is registered.\n`);
				nightlyDreaming = { enabled: true, taskName: prevNightlyTaskName };
			} else {
				const enableNightlyDreaming = await askYN(
					'Enable nightly automated end-of-day memory consolidation?',
					prevNightlyEnabled,
				);

				if (enableNightlyDreaming) {
					// Per-hub unique name — a shared/generic name across every hub on this
					// machine would let a second hub's `schtasks /create ... /f` silently
					// overwrite a first hub's already-registered task. See
					// computeNightlyDreamingTaskName's doc comment in lib/nightly-dreaming.js.
					const taskName = computeNightlyDreamingTaskName(cliOutputRoot);
					const result = registerNightlyDreamingTask({ hubRoot: cliOutputRoot, taskName });
					if (result.ok) {
						process.stdout.write(`  Nightly Scheduled Task registered (${taskName}).\n`);
						nightlyDreaming = { enabled: true, taskName };
					} else {
						process.stdout.write(`  WARNING: could not register the nightly Scheduled Task: ${result.error}\n`);
						process.stdout.write('  Setup will continue — re-run npm run setup to retry.\n');
						nightlyDreaming = { enabled: false };
					}
				} else {
					if (prevNightlyEnabled) {
						const removeResult = removeNightlyDreamingTask({ taskName: prevNightlyTaskName });
						if (removeResult.ok) {
							process.stdout.write('  Nightly Scheduled Task removed.\n');
						} else {
							process.stdout.write(
								`  WARNING: could not remove the existing nightly Scheduled Task: ${removeResult.error}\n`,
							);
						}
					}
					nightlyDreaming = { enabled: false };
				}
			}

			const onDisk = fsMod.existsSync(configPath)
				? JSON.parse(fsMod.readFileSync(configPath, 'utf-8'))
				: config;
			fsMod.writeFileSync(configPath, JSON.stringify({ ...onDisk, nightlyDreaming }, null, 2) + '\n', 'utf-8');
		}

		line('Done ');
		process.stdout.write(`  Config written → ${configPath}\n`);

		if (configureCursor) {
			generateCursorIdentity(cliOutputRoot, config);
			process.stdout.write(`  Cursor identity → ${path.join(cliOutputRoot, '.cursor', 'rules', 'workspace-identity.mdc')}\n`);
		}

		if (configureGithub) {
			generateGithubCopilotInstructions(cliOutputRoot, config);
			process.stdout.write(`  GitHub Copilot → ${path.join(cliOutputRoot, '.github', 'copilot-instructions.md')}\n`);
		}

		if (!gitignoreCovers) {
			process.stdout.write('\n  WARNING: workspace.config.json is not listed in .gitignore.\n');
			process.stdout.write('  Add the following line to prevent committing personal config:\n\n');
			process.stdout.write('    workspace.config.json\n');
		}

		if (!remoteTeam.enabled) {
			process.stdout.write('\n  Remote team disabled — Router will run in minimal mode.\n');
			process.stdout.write('  Re-run setup and enable remote team to unlock relay skills.\n');
		}

		process.stdout.write('\n');
	};
}

/**
 * Disable/remove the nightly dreaming Scheduled Task without running the full
 * interactive wizard. Windows-only — a no-op safe-degrade on any other
 * platform, matching this feature's own "Windows-only for v1" scope everywhere else.
 *
 * Also flips `nightlyDreaming.enabled` to false in workspace.config.json when that key
 * already exists, so a subsequent `npm run setup` re-run's default answer reflects the
 * disable rather than re-offering the previously-accepted "enabled: true" default.
 *
 * @param {object} opts
 * @param {string} opts.cliOutputRoot
 * @param {object} [opts.fsMod]
 * @param {string} [opts.platform]
 * @param {function} [opts.removeTask]  Injectable removeNightlyDreamingTask (testing).
 * @param {string} [opts.taskName]
 * @param {function(string): void} [opts.log]
 * @returns {{ ok: boolean, removed?: boolean, skipped?: boolean, error?: string }}
 */
export function runDisableNightlyDreaming({
	cliOutputRoot,
	fsMod = fs,
	platform = process.platform,
	removeTask = removeNightlyDreamingTaskDefault,
	taskName = NIGHTLY_DREAMING_TASK_NAME,
	log = (s) => process.stdout.write(s),
}) {
	if (platform !== 'win32') {
		log('Nightly dreaming is Windows-only — nothing to disable on this platform.\n');
		return { ok: true, skipped: true };
	}
	const result = removeTask({ taskName });
	if (result.ok) {
		log(
			result.removed
				? 'Nightly dreaming Scheduled Task removed.\n'
				: 'Nightly dreaming Scheduled Task was not registered — nothing to remove.\n',
		);
	} else {
		log(`ERROR: could not remove nightly dreaming Scheduled Task: ${result.error}\n`);
	}

	const configPath = path.join(cliOutputRoot, 'workspace.config.json');
	if (fsMod.existsSync(configPath)) {
		try {
			const cfg = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'));
			if (cfg.nightlyDreaming) {
				cfg.nightlyDreaming.enabled = false;
				fsMod.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
			}
		} catch {
			// Unparseable/unreadable config — never block the disable flow on this.
		}
	}
	return result;
}

// ── CLI entry point (only runs when executed directly, not when imported) ──────

export function parseCliArgs(argv) {
	const result = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith('--')) {
			const equalsIndex = arg.indexOf('=');
			if (equalsIndex !== -1) {
				result[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1);
				continue;
			}
			const key = arg.slice(2);
			const next = argv[i + 1];
			result[key] = (next && !next.startsWith('--')) ? next : true;
			if (next && !next.startsWith('--')) i++;
		}
	}
	return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const cliArgs = parseCliArgs(process.argv.slice(2));
	const cliOutputRoot = cliArgs.output ? path.resolve(cliArgs.output) : path.resolve('.');

	if (cliArgs['disable-nightly-dreaming']) {
		const result = runDisableNightlyDreaming({ cliOutputRoot });
		process.exit(result.ok ? 0 : 1);
	}

	const rl = readline.createInterface({ input, output });

	function ask(question, defaultValue = '') {
		const hint = defaultValue ? ` [${defaultValue}]` : '';
		return rl.question(`${question}${hint}: `).then(a => a.trim() || defaultValue);
	}

	function askYN(question, defaultYes = false) {
		const hint = defaultYes ? ' [Y/n]' : ' [y/N]';
		return rl.question(`${question}${hint}: `).then(a => {
			const v = a.trim().toLowerCase();
			if (!v) return defaultYes;
			return v === 'y' || v === 'yes';
		});
	}

	// Masked/non-echoing prompt for secrets (e.g. API keys). Temporarily
	// intercepts the readline interface's output writer so typed characters
	// are never echoed to the terminal — only the prompt text itself is shown.
	function askSecret(question) {
		const prompt = `${question}: `;
		const hasMasking = typeof rl._writeToOutput === 'function';
		if (!hasMasking) {
			// Fallback: no masking hook available — still don't log the value anywhere.
			return rl.question(prompt).then(a => a.trim());
		}
		const originalWrite = rl._writeToOutput.bind(rl);
		let promptWritten = false;
		rl._writeToOutput = function (str) {
			if (!promptWritten) {
				originalWrite(str); // let the initial prompt text render once
				promptWritten = str.includes(prompt) || promptWritten;
				return;
			}
			if (str === '\r\n' || str === '\n') {
				originalWrite(str);
				return;
			}
			// Suppress echo of typed characters.
		};
		return rl.question(prompt).then(answer => {
			rl._writeToOutput = originalWrite;
			return answer.trim();
		});
	}

	function line(label = '') {
		const dashes = '─'.repeat(Math.max(0, 44 - label.length));
		process.stdout.write(`\n── ${label}${dashes}\n\n`);
	}

	const tierPluginPort = cliArgs['tier-plugin-port'];
	const run = createRun({ ask, askYN, askSecret, line, fsMod: fs, cliOutputRoot, tierPluginPort });

	run().then(() => {
		rl.close();
	}).catch(err => {
		rl.close();
		process.stderr.write(err.message + '\n');
		process.exit(1);
	});
}
