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
import { PROBE_TIMEOUT_MS } from './lib/npm-install.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	wireRelayMcp,
	readJsonSafe,
	writeJsonSafe,
	readSettingsForMerge,
	stringifySettings,
	unusableSettingsMessage,
	SETTINGS_SHAPE,
} from './wizard.js';
import { mergeRelaySessionStartHook } from './lib/claude-hooks.js';
import { ensureHubSettings } from './lib/hub-settings.js';
import { ensureHubMcpJson } from './lib/hub-mcp.js';
import { ensureVaultPluginConfig } from './lib/vault-plugin-config.js';
import {
	ensureVaultPlugins as ensureVaultPluginsDefault,
	VAULT_PLUGIN_REPAIR_COMMAND,
} from './lib/vault-plugin-install.js';
import {
	isVaultBackedHubType,
	resolveMemoryRoot,
	resolveTasksRootSegment,
} from './lib/memory-root.js';
import { scaffoldRulesFiles } from './lib/memory-scaffold.js';
import { discoverAgentIds as discoverDeployedAgentIds } from './lib/agent-discovery.js';
import {
	NIGHTLY_DREAMING_TASK_NAME,
	computeNightlyDreamingTaskName,
	registerNightlyDreamingTask as registerNightlyDreamingTaskDefault,
	removeNightlyDreamingTask as removeNightlyDreamingTaskDefault,
	isNightlyDreamingTaskRegistered as isNightlyDreamingTaskRegisteredDefault,
} from './lib/nightly-dreaming.js';
import {
	offerTaskCliPermissions as offerTaskCliPermissionsDefault,
	taskPermissionQuestion,
	TASK_PERMISSION_CONFIG_KEY,
} from './lib/task-permission.js';
import { defineQuestion, stampSetupCompleted } from './lib/setup-questions.js';
import { failuresOf, warningsOf } from './lib/setup-step-result.js';
import {
	readHubConfig,
	resolveHubType,
	hubTypeQuestion,
} from './lib/hub-tier.js';

// Re-exported: these used to live here, and callers import them from setup.js.
export { readHubConfig, resolveHubType };
import { createMaskableOutput } from './lib/masked-output.js';
import { ensureHubRootDepsInstalled as ensureHubRootDepsInstalledDefault } from './lib/hub-root-install.js';
import {
	runSetupTipStep as runSetupTipStepDefault,
	tipQuestion,
} from './lib/tips.js';
import {
	printTrialNotice,
	runErrorReportOptIn,
	runErrorReportsFlag,
	errorReportQuestion,
} from './lib/error-report-optin.js';
import {
	offerOptionalSkillsInstall as offerOptionalSkillsInstallDefault,
	optionalSkillsInstallQuestion,
} from './lib/optional-skills-setup.js';
import {
	installCrashReporter,
	reportSetupFailure,
} from './lib/error-sources.js';
import { hubTypesWith } from './lib/tier-descriptor.js';

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
 * @returns {Promise<{failures: Array<{step: string, message: string}>, warnings: Array<{step: string, message: string, summary: string}>}>}
 *   The steps that failed and the advisory warnings, across every plugin (each
 *   plugin's run() returns a result; see lib/setup-step-result.js). Both are
 *   empty when every step finished. A plugin that returns nothing is treated as
 *   having neither.
 */
export async function defaultSetupTierPlugin(
	opts,
	{ libDir = path.join(__dirname, 'lib') } = {},
) {
	let pluginFiles;
	try {
		pluginFiles = fs
			.readdirSync(libDir)
			.filter((f) => f.endsWith('.setup-plugin.js'))
			.sort();
	} catch {
		pluginFiles = [];
	}
	const failures = [];
	const warnings = [];
	for (const file of pluginFiles) {
		const mod = await import(pathToFileURL(path.join(libDir, file)).href);
		const result = await mod.run(opts);
		failures.push(...failuresOf(result));
		warnings.push(...warningsOf(result));
	}
	return { failures, warnings };
}

/**
 * The questions every discovered "*.setup-plugin.js" would ask, in the same
 * order defaultSetupTierPlugin() runs the plugins. A plugin describes its own
 * questions by exporting `questions(opts)` (opts is the same object its run()
 * receives, minus the prompt helpers); a plugin that asks nothing exports none.
 * setup.js never names a plugin's questions.
 *
 * @param {object} opts
 * @param {object} [deps]
 * @param {string} [deps.libDir]
 * @returns {Promise<object[]>}
 */
export async function defaultSetupTierPluginQuestions(
	opts,
	{ libDir = path.join(__dirname, 'lib') } = {},
) {
	let pluginFiles;
	try {
		pluginFiles = fs
			.readdirSync(libDir)
			.filter((f) => f.endsWith('.setup-plugin.js'))
			.sort();
	} catch {
		pluginFiles = [];
	}
	const out = [];
	for (const file of pluginFiles) {
		const mod = await import(pathToFileURL(path.join(libDir, file)).href);
		if (typeof mod.questions === 'function') {
			out.push(...(await mod.questions(opts)));
		}
	}
	return out;
}
// Source-repo agents/profiles/ dir, relative to this script's own location (not cliOutputRoot).
// Present when running `npm run setup` from inside the profiles source repository itself.
// Absent in a deployed hub (agents/profiles/ is a source-repo-only concept there).
const SOURCE_PROFILES_ROOT = path.resolve(
	__dirname,
	'..',
	'..',
	'agents',
	'profiles',
);

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
	return platform === 'win32'
		? STATUSLINE_SCRIPT_FILENAME_WINDOWS
		: STATUSLINE_SCRIPT_FILENAME_UNIX;
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
		const scriptPath = path.join(
			homeDir,
			'.claude',
			STATUSLINE_SCRIPT_FILENAME_WINDOWS,
		);
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
export function buildStatuslineSettingsEntry(
	homeDir,
	platform = process.platform,
) {
	return {
		type: 'command',
		command: buildStatuslineCommand(homeDir, platform),
	};
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
export function isAgistraStatusline(
	statusLineEntry,
	homeDir,
	platform = process.platform,
) {
	return (
		!!statusLineEntry &&
		typeof statusLineEntry === 'object' &&
		statusLineEntry.type === 'command' &&
		statusLineEntry.command === buildStatuslineCommand(homeDir, platform)
	);
}

const STATUSLINE_INSTALL_QUESTION = defineQuestion({
	id: 'statusline_install',
	prompt:
		'Install the Claude Code statusline (context/rate-limit/cost visibility in your terminal)?',
	type: 'yes/no',
	default: true,
});

function statuslineOverwriteQuestion(existingStatusLine) {
	return defineQuestion({
		id: 'statusline_overwrite',
		prompt: `  An existing statusLine command is already configured (${JSON.stringify(existingStatusLine)}). Overwrite it with the Agistra statusline?`,
		type: 'yes/no',
		default: false,
		when: { id: 'statusline_install', equals: true },
	});
}

/**
 * The questions maybeInstallStatusline would ask for this home directory: none
 * when the settings file is unusable or the statusline is already installed.
 *
 * @returns {object[]}
 */
export function statuslineQuestions({
	fsMod,
	homeDir,
	platform = process.platform,
}) {
	const settingsRead = readSettingsForMerge(
		path.join(homeDir, '.claude', 'settings.json'),
		{ fsMod },
	);
	if (settingsRead.status === 'unusable') return [];
	const existing = settingsRead.settings?.statusLine;
	if (isAgistraStatusline(existing, homeDir, platform)) return [];
	return existing
		? [STATUSLINE_INSTALL_QUESTION, statuslineOverwriteQuestion(existing)]
		: [STATUSLINE_INSTALL_QUESTION];
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
export async function maybeInstallStatusline({
	askYN,
	fsMod,
	homeDir,
	scriptSourcePath,
	platform = process.platform,
	log = (s) => process.stdout.write(s),
}) {
	const claudeDir = path.join(homeDir, '.claude');
	const settingsPath = path.join(claudeDir, 'settings.json');
	const scriptTargetPath = path.join(
		claudeDir,
		resolveStatuslineScriptFilename(platform),
	);

	// A settings file that does not parse is never rewritten: it would lose every
	// other key the user has in it. Skip the install and say why.
	const settingsRead = readSettingsForMerge(settingsPath, { fsMod });
	if (settingsRead.status === 'unusable') {
		const reason = unusableSettingsMessage(
			settingsPath,
			settingsRead.reason,
			'The statusline was not installed.',
		);
		log(`  WARNING: ${reason}\n`);
		return { installed: false, error: reason };
	}
	const existingSettings = settingsRead.settings;
	const existingStatusLine = existingSettings?.statusLine;
	const alreadyInstalledByThisMechanism = isAgistraStatusline(
		existingStatusLine,
		homeDir,
		platform,
	);

	// Already installed by this exact mechanism on a prior `npm run setup` run —
	// skip the initial install prompt entirely and go straight to a silent
	// refresh below (script content + settings.json), rather than re-asking
	// the same yes/no question on every rerun.
	if (!alreadyInstalledByThisMechanism) {
		const wantsInstall = await askYN(
			STATUSLINE_INSTALL_QUESTION.prompt,
			STATUSLINE_INSTALL_QUESTION.default,
			STATUSLINE_INSTALL_QUESTION,
		);
		if (!wantsInstall) return { installed: false };

		if (existingStatusLine) {
			const overwriteQuestion = statuslineOverwriteQuestion(existingStatusLine);
			const overwrite = await askYN(
				overwriteQuestion.prompt,
				overwriteQuestion.default,
				overwriteQuestion,
			);
			if (!overwrite) {
				log(
					'  Skipping statusline install — existing statusLine command left untouched.\n',
				);
				return { installed: false, skippedExisting: true };
			}
		}
	}

	let scriptSource;
	try {
		scriptSource = fsMod.readFileSync(scriptSourcePath, 'utf-8');
	} catch (err) {
		log(
			`  WARNING: could not read the statusline script (${err.message}) — skipping install.\n`,
		);
		return { installed: false, error: err.message };
	}

	fsMod.mkdirSync(claudeDir, { recursive: true });
	// Always refresh the script content, even when settings.json already has
	// the right statusLine entry — this is what lets future script
	// improvements reach the customer on a later `npm run setup` re-run.
	fsMod.writeFileSync(scriptTargetPath, scriptSource, 'utf-8');

	const updatedSettings = {
		...(existingSettings ?? {}),
		statusLine: buildStatuslineSettingsEntry(homeDir, platform),
	};
	fsMod.writeFileSync(
		settingsPath,
		stringifySettings(updatedSettings, settingsRead.indent, 2),
		'utf-8',
	);

	log(
		`  Statusline ${alreadyInstalledByThisMechanism ? 'refreshed' : 'installed'} → ${scriptTargetPath}\n`,
	);
	return { installed: true, refreshed: alreadyInstalledByThisMechanism };
}

/**
 * Create <hubRoot>/projects when it is missing.
 *
 * @param {object} opts
 * @param {string} opts.hubRoot
 * @param {object} [opts.fsMod]
 * @returns {string} one-line outcome for the setup log
 */
export function ensureProjectsDir({ hubRoot, fsMod = fs }) {
	const dir = path.join(hubRoot, 'projects');
	if (fsMod.existsSync(dir)) return `projects/ already present → ${dir}`;
	fsMod.mkdirSync(dir, { recursive: true });
	return `projects/ created → ${dir}`;
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
 *      .cursor/agents/*.md, .github/agents/*.agent.md, .codex/agents/*.toml —
 *      whichever are present (lib/agent-discovery.js).
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

	// 2. Deployed-hub agent directories: every installed adapter's folder
	for (const id of discoverDeployedAgentIds({
		hubRoot: cliOutputRoot,
		fsMod,
	})) {
		ids.add(id.trim().toLowerCase());
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
		execFn('gh', ['--version'], { stdio: 'pipe', timeout: PROBE_TIMEOUT_MS });
		installed = true;
	} catch {
		// gh not on PATH — installed stays false
	}
	if (installed) {
		try {
			execFn('gh', ['auth', 'status'], {
				stdio: 'pipe',
				timeout: PROBE_TIMEOUT_MS,
			});
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
			lines.push(
				'- **Telegram bot token:** see workspace.config.json → telegram.bot_token',
			);
		}
	}

	return lines.join('\n');
}

const GENERATED_HEADER =
	'<!-- Generated by setup.js — do not edit manually -->';

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

	fs.writeFileSync(
		path.join(rulesDir, 'workspace-identity.mdc'),
		content,
		'utf-8',
	);
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

	fs.writeFileSync(
		path.join(githubDir, 'copilot-instructions.md'),
		content,
		'utf-8',
	);
}

// ── Setup questions (exported for `--questions`, `--answers` and tests) ───────

function nightlyDreamingQuestion(prevEnabled) {
	return defineQuestion({
		id: 'nightly_dreaming',
		prompt: 'Enable nightly automated end-of-day memory consolidation?',
		type: 'yes/no',
		default: prevEnabled,
	});
}

/**
 * Store the Telegram bot token the way setup records it: in
 * workspace.config.json under `telegram.bot_token`.
 */
function storeTelegramBotToken({ hubRoot, fsMod = fs }, value) {
	const configPath = path.join(hubRoot, 'workspace.config.json');
	let config = {};
	try {
		config = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'));
	} catch {
		// No readable config yet: start one that holds only the token.
	}
	fsMod.mkdirSync(hubRoot, { recursive: true });
	fsMod.writeFileSync(
		configPath,
		JSON.stringify(
			{ ...config, telegram: { ...(config.telegram ?? {}), bot_token: value } },
			null,
			2,
		) + '\n',
		'utf-8',
	);
}

/**
 * The questions setup.js itself asks before the tier plugins run, keyed by name.
 * run() takes its prompt text and default from these objects, so the interactive
 * wizard and the question listing cannot drift apart.
 *
 * @param {object} o
 * @param {object} [o.prev]      The existing workspace.config.json, if any.
 * @param {string[]} [o.agentIds]
 */
export function buildCoreQuestions({ prev = {}, agentIds = [] } = {}) {
	const prevRemoteTeam = prev.remoteTeam ?? {};
	const remote = { id: 'remote_team', equals: true };
	const telegram = [remote, { id: 'remote_telegram', equals: true }];
	return {
		userName: defineQuestion({
			id: 'user_name',
			prompt: 'Your name',
			default: prev.user?.name ?? '',
			required: true,
		}),
		userRole: defineQuestion({
			id: 'user_role',
			prompt: 'Your role (e.g. Technical Lead)',
			default: prev.user?.role ?? 'Technical Lead',
		}),
		org: defineQuestion({
			id: 'org_name',
			prompt: 'Organisation or team name',
			default: prev.org ?? '',
			required: true,
		}),
		agentNames: agentIds.map((id) =>
			Object.assign(
				defineQuestion({
					id: `agent_display_name_${id}`,
					prompt: `Display name for ${id} (optional)`,
					default: prev.agents?.[id]?.displayName ?? '',
				}),
				{ agentId: id },
			),
		),
		remoteTeam: defineQuestion({
			id: 'remote_team',
			prompt: 'Do you work with a remote team?',
			type: 'yes/no',
			default: prevRemoteTeam.enabled === true,
		}),
		remoteTeamName: defineQuestion({
			id: 'remote_team_name',
			prompt: 'Remote team name',
			default: prevRemoteTeam.name ?? 'Remote Team',
			when: remote,
		}),
		remoteAgentName: defineQuestion({
			id: 'remote_agent_name',
			prompt: 'Remote agent name',
			default: prevRemoteTeam.agentName ?? 'Remote Agent',
			when: remote,
		}),
		remoteTelegram: defineQuestion({
			id: 'remote_telegram',
			prompt: 'Does the remote team use Telegram?',
			type: 'yes/no',
			default: prevRemoteTeam.telegram != null,
			when: remote,
		}),
		telegramHandle: defineQuestion({
			id: 'telegram_handle',
			prompt: 'Telegram bot handle (e.g. @mybot)',
			default: prevRemoteTeam.telegram?.handle ?? '',
			required: true,
			when: telegram,
		}),
		telegramToken: defineQuestion({
			id: 'telegram_bot_token',
			prompt: 'Telegram bot token (from @BotFather)',
			secret: true,
			when: telegram,
			store: storeTelegramBotToken,
		}),
		telegramKeepToken: defineQuestion({
			id: 'telegram_keep_stored_token',
			prompt: 'Telegram bot token already stored. Keep it?',
			type: 'yes/no',
			default: true,
			when: telegram,
		}),
		telegramGroupId: defineQuestion({
			id: 'telegram_group_id',
			prompt: 'Relay group ID (e.g. -1001234567890)',
			default: prev.telegram?.relay_group_id ?? '',
			required: true,
			when: telegram,
		}),
		githubWorkflows: defineQuestion({
			id: 'github_workflows',
			prompt:
				'Do you intend to use GitHub-based workflows (PR creation via Builder/Tester)?',
			type: 'yes/no',
			default: (prev.githubWorkflows ?? {}).enabled === true,
		}),
		cursorRule: defineQuestion({
			id: 'cursor_identity_rule',
			prompt: 'Generate Cursor workspace identity rule?',
			type: 'yes/no',
			default: true,
		}),
		copilotInstructions: defineQuestion({
			id: 'github_copilot_instructions',
			prompt: 'Generate GitHub Copilot instructions?',
			type: 'yes/no',
			default: true,
		}),
		relayTrackingIssue: defineQuestion({
			id: 'relay_tracking_issue',
			prompt: 'Relay tracking issue (owner/repo#N)',
			default: (prev.relay ?? {}).github?.trackingIssue ?? '',
			when: remote,
		}),
	};
}

/**
 * Every question `npm run setup` can ask on this hub, in prompt order: the core
 * questions, then each tier plugin's own (via the plugin interface), then the
 * tier-agnostic steps that close the run. A question that applies only for some
 * answers carries a `when`; a step this hub's environment never reaches (no
 * Cursor directory, a non-Windows machine, an unusable settings file) is left
 * out. Reads only; writes nothing.
 *
 * @param {object} deps
 * @param {string} deps.cliOutputRoot
 * @param {Record<string, unknown>} [deps.answers]  Resolves answer-dependent
 *   steps, such as which hubType the plugins see.
 * @param {boolean} [deps.allSecrets]  Also list every secret a plugin could ask
 *   for, whatever this hub's current state (used by `--secret <id>`).
 * @returns {Promise<object[]>}
 */
export async function listSetupQuestions({
	cliOutputRoot,
	fsMod = fs,
	cliArgs = {},
	platform = process.platform,
	homeDir = os.homedir(),
	readHubConfig: readHubConfigFn = readHubConfig,
	tierPluginQuestions = defaultSetupTierPluginQuestions,
	tierPluginPort,
	isNightlyDreamingTaskRegistered = isNightlyDreamingTaskRegisteredDefault,
	env = process.env,
	answers = {},
	allSecrets = false,
}) {
	let prev = {};
	try {
		prev = JSON.parse(
			fsMod.readFileSync(
				path.join(cliOutputRoot, 'workspace.config.json'),
				'utf-8',
			),
		);
	} catch {
		// No readable config: a fresh hub.
	}
	const platforms = detectPlatforms(cliOutputRoot);
	const packagedHubType = readHubConfigFn()?.hubType;
	const cq = buildCoreQuestions({
		prev,
		agentIds: discoverAgentIds(cliOutputRoot, fsMod),
	});

	const list = [
		cq.userName,
		cq.userRole,
		cq.org,
		...cq.agentNames,
		cq.remoteTeam,
		cq.remoteTeamName,
		cq.remoteAgentName,
		cq.remoteTelegram,
		cq.telegramHandle,
		...(prev.telegram?.bot_token ? [cq.telegramKeepToken] : []),
		cq.telegramToken,
		cq.telegramGroupId,
		cq.githubWorkflows,
	];
	if (platforms.cursor) list.push(cq.cursorRule);
	if (platforms.github)
		list.push(cq.copilotInstructions, cq.relayTrackingIssue);

	let hubType;
	if (!prev.hubType) {
		hubType = packagedHubType ?? 'dev';
	} else if (!packagedHubType || packagedHubType === prev.hubType) {
		hubType = prev.hubType;
	} else {
		list.push(hubTypeQuestion(packagedHubType));
		hubType =
			answers.correct_hub_type === false ? prev.hubType : packagedHubType;
	}

	if (platforms.claude) {
		const permission = taskPermissionQuestion({
			hubRoot: cliOutputRoot,
			fsMod,
			reAsk: Boolean(cliArgs['ask-permissions']),
		});
		if (permission) list.push(permission);
	}

	if (hubTypesWith('tierPluginQuestions').includes(hubType)) {
		list.push(
			...(await tierPluginQuestions({
				hubRoot: cliOutputRoot,
				portOverride: tierPluginPort,
				platforms,
				hubType,
				readJsonSafe: (p) => readJsonSafe(p, fsMod),
				writeJsonSafe: (p, v) => writeJsonSafe(p, v, fsMod),
				cliArgs,
				allSecrets,
			})),
		);
	}

	list.push(...statuslineQuestions({ fsMod, homeDir, platform }));

	if (platform === 'win32') {
		const prevNightly = prev.nightlyDreaming ?? {};
		const enabled = prevNightly.enabled === true;
		const live = enabled
			? isNightlyDreamingTaskRegistered({
					taskName: prevNightly.taskName ?? NIGHTLY_DREAMING_TASK_NAME,
				})
			: false;
		if (!(enabled && live)) list.push(nightlyDreamingQuestion(enabled));
	}

	for (const q of [
		errorReportQuestion({ hubRoot: cliOutputRoot, tier: hubType, fsMod }),
		tipQuestion({ hubRoot: cliOutputRoot, fsMod, env, hubType }),
		optionalSkillsInstallQuestion({
			catalogPath: path.join(cliOutputRoot, 'skill-catalog.json'),
		}),
	]) {
		if (q) list.push(q);
	}

	const seen = new Set();
	for (const q of list) {
		if (seen.has(q.id)) throw new Error(`Duplicate setup question id: ${q.id}`);
		seen.add(q.id);
	}
	return list;
}

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
 * @param {function} [deps.offerTaskPermissions]
 *   Injectable task-CLI permission offer step (see lib/task-permission.js).
 * @param {function(): boolean} [deps.isInteractive]
 *   Injectable TTY probe. Setup has no other non-interactive mode, so a run without a
 *   TTY on both stdin and stdout never adds permission rules or records a decline.
 * @param {boolean} [deps.askPermissions]
 *   Ask about the task-CLI rules again even after a recorded decline (--ask-permissions).
 * @param {object} [deps.cliArgs]
 *   Raw parsed CLI flags (see parseCliArgs() below), forwarded verbatim into every
 *   discovered tier plugin's opts as `cliArgs` — a generic passthrough, deliberately
 *   never destructured or named here. This is how a tier plugin's own non-interactive
 *   flags (e.g. an enable/disable pair for one of that plugin's own opt-in features)
 *   reach the plugin's run() without setup.js itself ever naming that flag or the
 *   feature it controls — unlike tierPluginPort/hubType below, which setup.js's own
 *   generic wiring needs by value and so names explicitly. Defaults to {} so callers
 *   that never pass cliArgs behave exactly as before this parameter existed.
 * @param {function} [deps.runTipStep]
 *   Injectable end-of-setup tip step (see lib/tips.js runSetupTipStep).
 * @param {function} [deps.offerOptionalSkillsInstall]
 *   Injectable optional-skills opt-in install step (see
 *   lib/optional-skills-setup.js offerOptionalSkillsInstall). Tier-agnostic —
 *   see that function's own doc comment for why it differs from the
 *   dev:sub-only marketing-skills prompt it mirrors.
 * @param {function} [deps.ensureVaultPlugins]
 *   Injectable vault plugin install step (see lib/vault-plugin-install.js).
 * @param {string} [deps.setupVersion]
 *   Version recorded as bootstrap.setupVersion on success. Defaults to the
 *   hub's own version (see readSetupVersion in lib/setup-questions.js).
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
	cliArgs = {},
	platform = process.platform,
	registerNightlyDreamingTask = registerNightlyDreamingTaskDefault,
	removeNightlyDreamingTask = removeNightlyDreamingTaskDefault,
	isNightlyDreamingTaskRegistered = isNightlyDreamingTaskRegisteredDefault,
	homeDir = os.homedir(),
	installStatusline = maybeInstallStatusline,
	ensureHubRootDepsInstalled = ensureHubRootDepsInstalledDefault,
	offerTaskPermissions = offerTaskCliPermissionsDefault,
	isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
	askPermissions = false,
	runTipStep = runSetupTipStepDefault,
	offerOptionalSkillsInstall = offerOptionalSkillsInstallDefault,
	ensureVaultPlugins = ensureVaultPluginsDefault,
	setupVersion,
}) {
	return async function run() {
		// ── Hub-root npm dependencies ──────────────────────────────────────────────
		// Runs first, before anything else: buildPackageJson() (lib/extras.js)
		// writes this hub's own package.json unconditionally on every hubType, and
		// several steps further down (the relay MCP wiring, any tier plugin that
		// spawns the vault write guard indirectly via a prior-hub
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
		const prevTelegram = prev.telegram ?? {};
		const prevBotToken = prevTelegram.bot_token ?? '';
		const prevRelay = prev.relay ?? {};
		const cq = buildCoreQuestions({
			prev,
			agentIds: discoverAgentIds(cliOutputRoot, fsMod),
		});
		// A secret question always goes through the masked prompt, so a new one
		// cannot be added with an echoing prompt by accident.
		const askQ = (q, defaultValue = q.default) =>
			q.secret
				? askSecret(q.prompt, q)
				: q.type === 'yes/no'
					? askYN(q.prompt, defaultValue, q)
					: ask(q.prompt, defaultValue, q);

		// ── Prompts ────────────────────────────────────────────────────────────────

		process.stdout.write(
			'\n╔══════════════════════════════════════════════╗\n',
		);
		process.stdout.write('║           Agent Workspace Setup              ║\n');
		process.stdout.write('╚══════════════════════════════════════════════╝\n');

		// hubType comes from the packaged sentinel and needs no answer, so persist it
		// before the first prompt: a run that stops early still leaves the tier set.
		// A stored hubType is left alone here; resolveHubType() reconciles it later.
		if (!prev.hubType) {
			fsMod.mkdirSync(cliOutputRoot, { recursive: true });
			fsMod.writeFileSync(
				configPath,
				JSON.stringify(
					{ ...prev, hubType: readHubConfigFn()?.hubType ?? 'dev' },
					null,
					2,
				) + '\n',
				'utf-8',
			);
		}

		line('You ');
		const userName = await askQ(cq.userName);
		const userRole = await askQ(cq.userRole);

		line('Organisation ');
		const orgName = await askQ(cq.org);

		line('Agent display names ');
		const agents = {};
		for (const q of cq.agentNames) {
			const displayName = await askQ(q);
			if (displayName) {
				agents[q.agentId] = { displayName };
			}
		}

		line('Remote team ');
		const hasRemoteTeam = await askQ(cq.remoteTeam);

		let remoteTeam = { enabled: false };
		let telegramMcp = null;
		if (hasRemoteTeam) {
			const remoteTeamName = await askQ(cq.remoteTeamName);
			const remoteAgentName = await askQ(cq.remoteAgentName);
			const hasTelegram = await askQ(cq.remoteTelegram);
			if (hasTelegram) {
				const telegramHandle = await askQ(cq.telegramHandle);
				// Same pattern as the Graphify key: offer to keep a stored token
				// without printing it, and read a new one with the masked prompt.
				const keepToken = prevBotToken
					? await askYN(
							cq.telegramKeepToken.prompt,
							cq.telegramKeepToken.default,
							cq.telegramKeepToken,
						)
					: false;
				const telegramToken = keepToken
					? prevBotToken
					: await askQ(cq.telegramToken);
				const telegramGroupId = await askQ(cq.telegramGroupId);
				remoteTeam = {
					enabled: true,
					name: remoteTeamName,
					agentName: remoteAgentName,
					telegram: { handle: telegramHandle },
				};
				telegramMcp = {
					enabled: true,
					bot_token: telegramToken,
					relay_group_id: telegramGroupId,
				};
			} else {
				remoteTeam = {
					enabled: true,
					name: remoteTeamName,
					agentName: remoteAgentName,
				};
			}
		}

		line('GitHub workflows ');
		const wantsGithubWorkflows = await askQ(cq.githubWorkflows);
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
					process.stdout.write('  Install it with:  brew install gh\n');
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
			configureCursor = await askQ(cq.cursorRule);
		}

		if (platforms.github) {
			line('GitHub ');
			configureGithub = await askQ(cq.copilotInstructions);
		}

		let relayBlock = { ...prevRelay };

		if (platforms.github && remoteTeam.enabled) {
			line('GitHub relay ');
			const trackingIssue = await askQ(cq.relayTrackingIssue);
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
		//   "dev"       — expects: architect, builder, tester, router (nothing else)
		//   "dev:graph" — same profiles as dev; Graphify setup and doctor checks active
		//   "dev:sub"   — expects the four dev profiles plus the subscription-only one
		//   "ops"       — expects the four dev profiles plus the subscription-only one
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
			// Preserve the licence unit id the packaged config was seeded with across
			// re-runs of setup. Verification of it lives in a paid-tier plugin.
			...(prev.licenceUnitId ? { licenceUnitId: prev.licenceUnitId } : {}),
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
			// Preserve the tip-of-the-day settings (tips.enabled, tips.icon) across re-runs.
			...(prev.tips ? { tips: prev.tips } : {}),
			// Preserve the error-report opt-in across re-runs: the sender only reads
			// it, and re-writing this file must not switch reporting off.
			...(prev.errorReports ? { errorReports: prev.errorReports } : {}),
			// Preserve a recorded task-CLI permission decline across re-runs of setup.
			...(prev[TASK_PERMISSION_CONFIG_KEY]
				? { [TASK_PERMISSION_CONFIG_KEY]: prev[TASK_PERMISSION_CONFIG_KEY] }
				: {}),
		};

		fsMod.mkdirSync(cliOutputRoot, { recursive: true });
		fsMod.writeFileSync(
			configPath,
			JSON.stringify(config, null, 2) + '\n',
			'utf-8',
		);

		// Free tiers keep permanent rules in memory/rules/ (team.md plus one file per
		// agent). Create them now, create-if-absent, so the first Session Start finds
		// them; `npm run doctor` repairs any that go missing. Vault tiers write rules
		// through `npm run memory`.
		if (!isVaultBackedHubType(hubType)) {
			try {
				const agentIds = discoverDeployedAgentIds({
					hubRoot: cliOutputRoot,
					fsMod,
				});
				if (agentIds.length > 0) {
					scaffoldRulesFiles({
						memoryRoot: resolveMemoryRoot(cliOutputRoot, hubType),
						agentIds,
						fsMod,
					});
				}
			} catch {
				// Not fatal: doctor creates any missing rules file.
			}
		}

		// Warn if .gitignore does not cover the config file
		const gitignorePath = path.join(cliOutputRoot, '.gitignore');
		let gitignoreCovers = false;
		if (fsMod.existsSync(gitignorePath)) {
			const gi = fsMod.readFileSync(gitignorePath, 'utf-8');
			gitignoreCovers = gi
				.split('\n')
				.some((l) => l.trim() === 'workspace.config.json');
		}

		// Wire relay MCP into detected platform configs
		if (telegramMcp) {
			const targets = [
				...(platforms.claude ? ['claude-code'] : []),
				...(platforms.cursor ? ['cursor'] : []),
			];
			line('Relay MCP ');
			const { wrote, skipped = [] } = wireRelayMcp({
				config,
				workspaceRoot: cliOutputRoot,
				targets,
				fsMod,
			});
			if (wrote.length > 0) {
				for (const f of wrote) process.stdout.write(`  MCP wired → ${f}\n`);
			}
			for (const { message } of skipped) {
				process.stdout.write(`  WARNING: ${message}\n`);
			}
			if (platforms.claude) {
				const settingsPath = path.join(
					cliOutputRoot,
					'.claude',
					'settings.json',
				);
				const read = readSettingsForMerge(settingsPath, {
					fsMod,
					expect: SETTINGS_SHAPE.sessionStartHook,
				});
				if (read.status === 'unusable') {
					process.stdout.write(
						`  WARNING: ${unusableSettingsMessage(settingsPath, read.reason, 'The relay autostart hook was not added.')}\n`,
					);
				} else {
					const existing = read.settings ?? {
						enableAllProjectMcpServers: true,
					};
					writeJsonSafe(
						settingsPath,
						mergeRelaySessionStartHook(existing),
						fsMod,
						read.indent,
					);
					process.stdout.write(`  Relay autostart hook → ${settingsPath}\n`);
				}
			}
		}

		// ── Hub .claude/settings.json (Claude Code) ──────────────────────────────
		// Creates the file when a clone has none, or adds whatever baseline hook or
		// key is missing, through the same code deploy uses (lib/hub-settings.js).
		// The user's own entries are kept; an unusable file is left untouched.
		if (platforms.claude) {
			line('Hub settings ');
			const result = ensureHubSettings({ hubRoot: cliOutputRoot, fsMod });
			const msg =
				result.status === 'unusable'
					? `  WARNING: ${unusableSettingsMessage(result.settingsPath, result.reason, 'The hub hooks and settings were not added.')}`
					: result.status === 'unchanged'
						? `  Hub settings already complete → ${result.settingsPath}`
						: `  Hub settings ${result.status} → ${result.settingsPath}`;
			process.stdout.write(`${msg}\n`);
		}

		// ── Hub .mcp.json ───────────────────────────────────────────────────────
		// Ignored in release tier branches, so a clone has none. Created from the
		// shipped template, or the template's servers are synced into an existing
		// file (operator-added servers stay). Runs on every tier.
		line('Hub MCP config ');
		{
			const result = ensureHubMcpJson({
				hubRoot: cliOutputRoot,
				fsMod,
				log: (m) =>
					process.stdout.write(`  ${m}
`),
			});
			const msg =
				result.status === 'unusable'
					? `  WARNING: ${result.mcpPath} cannot be used (${result.reason}); the hub MCP servers were not added.`
					: result.status === 'no-template'
						? `  No MCP template shipped; ${result.mcpPath} left as is`
						: `  Hub MCP config ${result.status} → ${result.mcpPath}`;
			process.stdout.write(`${msg}
`);
		}

		// ── Vault plugin config ─────────────────────────────────────────────────
		// Release tier branches do not track the vault's two plugin config files;
		// they ship as templates. Created when missing, otherwise the shipped
		// plugins are added and the user's own entries stay. No vault, no step.
		{
			const results = ensureVaultPluginConfig({
				hubRoot: cliOutputRoot,
				fsMod,
			});
			if (results.some((r) => r.status !== 'no-vault')) {
				line('Vault plugin config ');
				for (const r of results) {
					process.stdout.write(`  ${r.file} ${r.status}\n`);
				}
			}
		}

		// ── Vault plugins ───────────────────────────────────────────────────────
		// Release trees carry no plugin code. Each missing plugin is downloaded from
		// its pinned release and checked against its pinned SHA-256; one that is
		// already present (including an upgraded copy) is left alone. A plugin that
		// cannot be installed is a warning, never a failed setup. No vault, no step.
		{
			const results = await ensureVaultPlugins({
				hubRoot: cliOutputRoot,
				fsMod,
			});
			if (results.some((r) => r.status !== 'no-vault')) {
				line('Vault plugins ');
				for (const r of results) {
					const label = `${r.id} ${r.version}`;
					if (r.status === 'installed') {
						process.stdout.write(`  ${label} installed\n`);
					} else if (r.status === 'present') {
						process.stdout.write(`  ${r.id} already present, left as is\n`);
					} else {
						process.stdout.write(
							`  WARNING: ${r.id} was not installed (${r.status}): ${r.detail}\n` +
								`  Setup continues. Run "${VAULT_PLUGIN_REPAIR_COMMAND}" again to retry the install.\n`,
						);
					}
				}
			}
		}

		// ── Projects folder ─────────────────────────────────────────────────────
		// Release tier branches do not track projects/ (the hub .gitignore lists
		// it), so a fresh clone has none. Only the repo-files tasks root is made
		// here; a vault-backed tier ships its own vault/Projects.
		if (resolveTasksRootSegment(config.hubType) === 'projects') {
			line('Projects folder ');
			process.stdout.write(
				`  ${ensureProjectsDir({ hubRoot: cliOutputRoot, fsMod })}
`,
			);
		}

		// ── Task CLI permission rules (Claude Code) ──────────────────────────────
		// Tier-agnostic. Only meaningful where a Claude Code adapter is deployed.
		if (platforms.claude) {
			line('Task CLI permissions ');
			await offerTaskPermissions({
				hubRoot: cliOutputRoot,
				fsMod,
				askYN,
				isInteractive,
				reAsk: askPermissions,
			});
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
			// bedrock.setup-plugin.js) can gate hubType-specific steps
			// internally — see that plugin's own eligibility check.
			hubType: config.hubType,
			readJsonSafe: (p) => readJsonSafe(p, fsMod),
			writeJsonSafe: (p, v) => writeJsonSafe(p, v, fsMod),
			// Generic passthrough of every raw CLI flag this run was invoked with — see
			// createRun()'s own doc comment on cliArgs above. setup.js never inspects or
			// names any specific flag inside this object; only a tier plugin's own run()
			// interprets whichever flag names are its concern.
			cliArgs,
		};

		// Steps a plugin reported as failed. Setup still runs its remaining steps,
		// but a run with any failure is not recorded as a completed setup.
		const failedSteps = [];
		// Advisory steps that did not finish: listed at the end, never blocking.
		const warnings = [];
		const collectPluginFailures = (outcome) => {
			if (Array.isArray(outcome)) {
				failedSteps.push(...outcome);
			} else if (
				outcome &&
				outcome.ok === undefined &&
				(Array.isArray(outcome.failures) || Array.isArray(outcome.warnings))
			) {
				failedSteps.push(...(outcome.failures ?? []));
				warnings.push(...(outcome.warnings ?? []));
			} else {
				failedSteps.push(...failuresOf(outcome));
				warnings.push(...warningsOf(outcome));
			}
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
			collectPluginFailures(await setupTierPlugin(tierPluginOpts));
		}

		if (config.hubType === 'dev:graph') {
			// The tier plugin (dev:graph-only, discovered generically by filename
			// convention) handles Graphify installation and semantic extraction opt-in.
			// ask/askYN/askSecret are passed so the plugin can prompt the user
			// interactively using the same injectable I/O as the rest of setup.
			// askSecret masks the API key input — it is never echoed to the terminal.
			collectPluginFailures(await setupTierPlugin(tierPluginOpts));
		}

		if (config.hubType === 'ops') {
			// The tier plugin (ops-only, discovered generically by filename
			// convention — lib/ops.setup-plugin.js) owns the prior-hub migration
			// prompt, plus the LangGraph runtime's setup-time install. ops has
			// no other non-migration setup responsibility wired here yet (knowledge-retrieval/vault
			// provisioning) — a pre-existing, separately-flagged gap, not this
			// ticket's scope. ask/askYN are passed through the same way the
			// dev:graph/dev:sub tier plugins already receive them.
			collectPluginFailures(await setupTierPlugin(tierPluginOpts));
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
					'  time (npm.cmd run setup -- --disable-nightly-dreaming, or decline here).\n',
			);
			const prevNightlyDreaming = prev.nightlyDreaming ?? {};
			const prevNightlyEnabled = prevNightlyDreaming.enabled === true;
			const prevNightlyTaskName =
				prevNightlyDreaming.taskName ?? NIGHTLY_DREAMING_TASK_NAME;
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
				process.stdout.write(
					`  Nightly dreaming already enabled — task ${prevNightlyTaskName} is registered.\n`,
				);
				nightlyDreaming = { enabled: true, taskName: prevNightlyTaskName };
			} else {
				const nightlyQuestion = nightlyDreamingQuestion(prevNightlyEnabled);
				const enableNightlyDreaming = await askYN(
					nightlyQuestion.prompt,
					nightlyQuestion.default,
					nightlyQuestion,
				);

				if (enableNightlyDreaming) {
					// Per-hub unique name — a shared/generic name across every hub on this
					// machine would let a second hub's `schtasks /create ... /f` silently
					// overwrite a first hub's already-registered task. See
					// computeNightlyDreamingTaskName's doc comment in lib/nightly-dreaming.js.
					const taskName = computeNightlyDreamingTaskName(cliOutputRoot);
					const result = registerNightlyDreamingTask({
						hubRoot: cliOutputRoot,
						taskName,
					});
					if (result.ok) {
						process.stdout.write(
							`  Nightly Scheduled Task registered (${taskName}).\n`,
						);
						nightlyDreaming = { enabled: true, taskName };
					} else {
						process.stdout.write(
							`  WARNING: could not register the nightly Scheduled Task: ${result.error}\n`,
						);
						process.stdout.write(
							'  Setup will continue — re-run npm run setup to retry.\n',
						);
						nightlyDreaming = { enabled: false };
					}
				} else {
					if (prevNightlyEnabled) {
						const removeResult = removeNightlyDreamingTask({
							taskName: prevNightlyTaskName,
						});
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
			fsMod.writeFileSync(
				configPath,
				JSON.stringify({ ...onDisk, nightlyDreaming }, null, 2) + '\n',
				'utf-8',
			);
		}

		// ── Error reports opt-in ─────────────────────────────────────────────────
		// Asked once, only in an interactive run, and only while no yes or no is
		// saved. An unattended run asks nothing and leaves reporting off.
		await runErrorReportOptIn({
			hubRoot: cliOutputRoot,
			tier: hubType,
			askYN,
			isInteractive,
			announce: () => line('Error reports '),
			fsMod,
		});

		line('Done ');
		process.stdout.write(`  Config written → ${configPath}\n`);

		if (configureCursor) {
			generateCursorIdentity(cliOutputRoot, config);
			process.stdout.write(
				`  Cursor identity → ${path.join(cliOutputRoot, '.cursor', 'rules', 'workspace-identity.mdc')}\n`,
			);
		}

		if (configureGithub) {
			generateGithubCopilotInstructions(cliOutputRoot, config);
			process.stdout.write(
				`  GitHub Copilot → ${path.join(cliOutputRoot, '.github', 'copilot-instructions.md')}\n`,
			);
		}

		if (!gitignoreCovers) {
			process.stdout.write(
				'\n  WARNING: workspace.config.json is not listed in .gitignore.\n',
			);
			process.stdout.write(
				'  Add the following line to prevent committing personal config:\n\n',
			);
			process.stdout.write('    workspace.config.json\n');
		}

		if (!remoteTeam.enabled) {
			process.stdout.write(
				'\n  Remote team disabled — Router will run in minimal mode.\n',
			);
			process.stdout.write(
				'  Re-run setup and enable remote team to unlock relay skills.\n',
			);
		}

		// Trial reminder or end notice: terminal output only. It ignores
		// tips.enabled and prints before the tip.
		printTrialNotice({ hubRoot: cliOutputRoot, fsMod });

		// -- Tip of the day: prints last among the "normal" steps, so the tip is
		// one of the final things the user reads. Prints and asks nothing for a
		// hub type without tips or in CI.
		await runTipStep({ hubRoot: cliOutputRoot, askYN, fsMod, platform });

		// ── Optional skills ────────────────────────────────────────────────────────
		// Tier-agnostic, runs genuinely last: Builder/Architect declare
		// frontend-design/skill-development/codebase-design `optional: true` in
		// every hub tier's own manifest (docs/product/optional-third-party-skills-PRD.md),
		// not gated to one tier the way the dev:sub-only marketing-skills prompt is.
		// Placed after every other prompt in this run so a declined/empty answer
		// here can never shift which answer an earlier prompt in this same run
		// consumes.
		await offerOptionalSkillsInstall({
			hubRoot: cliOutputRoot,
			catalogPath: path.join(cliOutputRoot, 'skill-catalog.json'),
			askYN,
		});

		// A failed plugin step means setup did not finish its job: no stamp, so the
		// first-start flow does not take this hub for a completed setup. The caller
		// turns the result into a non-zero exit. A re-run that succeeds stamps.
		const warningLines = warnings.map((w) => `  - ${w.summary}\n`).join('');
		if (failedSteps.length > 0) {
			process.stdout.write(
				'\n  Setup did not complete. Failed step(s): ' +
					failedSteps.map((f) => f.step).join(', ') +
					'\n  Fix the problem above, then re-run: npm run setup\n' +
					(warnings.length > 0
						? `  Also ${warnings.length} warning(s):\n${warningLines}`
						: '') +
					'\n',
			);
			return { ok: false, failedSteps, warnings };
		}

		// A run that got this far finished every step. Only now is it recorded as a
		// completed setup; a run that fails or is stopped earlier leaves no stamp.
		stampSetupCompleted({
			hubRoot: cliOutputRoot,
			fsMod,
			...(setupVersion ? { version: setupVersion } : {}),
		});

		if (warnings.length > 0) {
			process.stdout.write(
				`\nSetup complete, with ${warnings.length} warning(s):\n${warningLines}`,
			);
		}

		process.stdout.write('\n');
		return { ok: true, failedSteps: [], warnings };
	};
}

/**
 * The process exit code for what run() returned: 1 when a plugin step failed
 * (run() returns `{ ok: false }`), else 0. A run that throws never gets here.
 *
 * @param {{ok?: boolean}|undefined} outcome
 * @returns {number}
 */
export function setupExitCode(outcome) {
	return outcome && outcome.ok === false ? 1 : 0;
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
		log(
			'Nightly dreaming is Windows-only — nothing to disable on this platform.\n',
		);
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
		log(
			`ERROR: could not remove nightly dreaming Scheduled Task: ${result.error}\n`,
		);
	}

	const configPath = path.join(cliOutputRoot, 'workspace.config.json');
	if (fsMod.existsSync(configPath)) {
		try {
			const cfg = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'));
			if (cfg.nightlyDreaming) {
				cfg.nightlyDreaming.enabled = false;
				fsMod.writeFileSync(
					configPath,
					JSON.stringify(cfg, null, 2) + '\n',
					'utf-8',
				);
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
			result[key] = next && !next.startsWith('--') ? next : true;
			if (next && !next.startsWith('--')) i++;
		}
	}
	return result;
}

/**
 * Build the ask / askYN / askSecret prompt helpers over a readline interface.
 *
 * Interactive (TTY) runs use rl.question() exactly as before.
 *
 * When stdin is not a terminal, lines are read through our own queue instead.
 * rl.question() on a closed stdin never settles, which let Node exit 0 with
 * setup half done, and readline drops piped lines that arrive while no
 * question is pending. With the queue, piped answers are used in order, and
 * once input has ended every remaining prompt resolves to its default (ask:
 * the default value or empty; askYN: its default; askSecret: empty). Each
 * defaulted prompt prints one "using default" line so the run is auditable.
 *
 * @param {object} deps
 * @param {import('node:readline/promises').Interface} deps.rl
 * @param {boolean} deps.isTty
 * @param {{ write: function(string): unknown }} deps.output
 */
export function createPromptHelpers({ rl, isTty, output }) {
	const queue = [];
	let waiter = null;
	let closed = false;

	if (!isTty) {
		rl.on('line', (l) => {
			if (waiter) {
				const w = waiter;
				waiter = null;
				w(l);
			} else {
				queue.push(l);
			}
		});
		rl.on('close', () => {
			closed = true;
			if (waiter) {
				const w = waiter;
				waiter = null;
				w(null);
			}
		});
	}

	// Resolves to the next answer line, or null once piped input is exhausted.
	function readLine(prompt) {
		output.write(prompt);
		if (queue.length > 0) return Promise.resolve(queue.shift());
		if (closed) return Promise.resolve(null);
		return new Promise((resolve) => {
			waiter = resolve;
		});
	}

	function noteDefault(question, shown) {
		output.write(`\nusing default for "${question}": ${shown || '(blank)'}\n`);
	}

	function ask(question, defaultValue = '') {
		const hint = defaultValue ? ` [${defaultValue}]` : '';
		const prompt = `${question}${hint}: `;
		if (isTty) return rl.question(prompt).then((a) => a.trim() || defaultValue);
		return readLine(prompt).then((a) => {
			if (a === null) {
				noteDefault(question, defaultValue);
				return defaultValue;
			}
			return a.trim() || defaultValue;
		});
	}

	function askYN(question, defaultYes = false) {
		const hint = defaultYes ? ' [Y/n]' : ' [y/N]';
		const prompt = `${question}${hint}: `;
		const parse = (a) => {
			const v = a.trim().toLowerCase();
			if (!v) return defaultYes;
			return v === 'y' || v === 'yes';
		};
		if (isTty) return rl.question(prompt).then(parse);
		return readLine(prompt).then((a) => {
			if (a === null) {
				noteDefault(question, defaultYes ? 'yes' : 'no');
				return defaultYes;
			}
			return parse(a);
		});
	}

	// Masked/non-echoing prompt for secrets (API keys, the Telegram bot token).
	// On a terminal, `output` must be the maskable output the readline interface
	// was created with (lib/masked-output.js): readline echoes by writing to it,
	// and for the length of one question only the prompt and the newline get
	// through. Without one we cannot hide the echo, so we refuse to read a secret
	// rather than show it.
	function askSecret(question) {
		const prompt = `${question}: `;
		if (!isTty) {
			return readLine(prompt).then((a) => {
				if (a === null) {
					noteDefault(question, '');
					return '';
				}
				return a.trim();
			});
		}
		if (
			typeof output?.beginMask !== 'function' ||
			typeof output?.endMask !== 'function'
		) {
			return Promise.reject(
				new Error(
					'Cannot read a secret on a terminal without a maskable output (see lib/masked-output.js).',
				),
			);
		}
		output.beginMask(prompt);
		return rl
			.question(prompt)
			.then((answer) => answer.trim())
			.finally(() => output.endMask());
	}

	return { ask, askYN, askSecret };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	installCrashReporter({ source: 'npm-run' });
	const cliArgs = parseCliArgs(process.argv.slice(2));
	const cliOutputRoot = cliArgs.output
		? path.resolve(cliArgs.output)
		: path.resolve('.');

	if (cliArgs['disable-nightly-dreaming']) {
		const result = runDisableNightlyDreaming({ cliOutputRoot });
		if (!result.ok) {
			await reportSetupFailure(
				{ code: 'setup-disable-nightly-dreaming' },
				{ hubRoot: cliOutputRoot },
			);
		}
		process.exit(result.ok ? 0 : 1);
	}

	if (cliArgs['error-reports'] !== undefined) {
		const result = runErrorReportsFlag({
			hubRoot: cliOutputRoot,
			value: cliArgs['error-reports'],
		});
		(result.ok ? process.stdout : process.stderr).write(`${result.message}
`);
		process.exit(result.ok ? 0 : 1);
	}

	if (
		cliArgs.questions !== undefined ||
		cliArgs.answers !== undefined ||
		cliArgs.secret !== undefined
	) {
		// Machine output: stdout carries only the final JSON. Child processes the
		// setup steps start (npm install, uv) inherit file descriptor 1, so the
		// mode re-runs itself with fd 1 pointed at stderr and the real stdout
		// passed down as fd 3, which only the JSON is written to.
		const jsonFd = process.env.AGISTRA_SETUP_JSON_FD;
		if (!jsonFd) {
			const child = spawnSync(process.execPath, process.argv.slice(1), {
				stdio: [0, 2, 2, 1],
				env: { ...process.env, AGISTRA_SETUP_JSON_FD: '3' },
			});
			process.exit(child.status ?? 1);
		}
		const { runSetupCliMode, writeAllSync } =
			await import('./lib/setup-cli-modes.js');
		let outcome;
		try {
			outcome = await runSetupCliMode({
				cliArgs,
				cliOutputRoot,
				setup: { createRun, createPromptHelpers, listSetupQuestions },
			});
		} catch (err) {
			outcome = {
				exitCode: 1,
				error: err,
				json: { ok: false, error: 'setup-failed', message: err.message },
			};
		}
		if (outcome.error) {
			await reportSetupFailure(
				{ heading: outcome.step ?? '', error: outcome.error },
				{ hubRoot: cliOutputRoot },
			);
		}
		writeAllSync(Number(jsonFd), JSON.stringify(outcome.json, null, 2) + '\n');
		process.exit(outcome.exitCode);
	}

	// The gate lets askSecret hide what readline echoes (see lib/masked-output.js).
	const gate = createMaskableOutput(output);
	const rl = readline.createInterface({ input, output: gate });
	const { ask, askYN, askSecret } = createPromptHelpers({
		rl,
		isTty: Boolean(input.isTTY),
		output: gate,
	});

	// The last step setup announced. If setup stops with an error, this names the
	// step in the error report.
	let currentStep = '';
	function line(label = '') {
		currentStep = label;
		const dashes = '─'.repeat(Math.max(0, 44 - label.length));
		process.stdout.write(`\n── ${label}${dashes}\n\n`);
	}

	const tierPluginPort = cliArgs['tier-plugin-port'];
	const run = createRun({
		ask,
		askYN,
		askSecret,
		line,
		fsMod: fs,
		cliOutputRoot,
		tierPluginPort,
		cliArgs,
		askPermissions: Boolean(cliArgs['ask-permissions']),
	});

	run()
		.then((outcome) => {
			rl.close();
			const code = setupExitCode(outcome);
			if (code !== 0) process.exit(code);
		})
		.catch(async (err) => {
			rl.close();
			process.stderr.write(err.message + '\n');
			await reportSetupFailure(
				{ heading: currentStep, error: err },
				{ hubRoot: cliOutputRoot },
			);
			process.exit(1);
		});
}
