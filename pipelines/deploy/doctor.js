#!/usr/bin/env node
/**
 * doctor.js — Hub health check command.
 *
 * Runs a series of readiness checks and prints a coloured report showing
 * green/warn/fail for each configuration item. Designed to be run after
 * `npm run setup` to confirm the hub is correctly configured before starting
 * a work session.
 *
 * Usage:
 *   node pipelines/deploy/doctor.js --output <hub-root>   # check the given hub
 *   node pipelines/deploy/doctor.js                       # defaults to cwd
 *   npm run doctor                           # deployed hub shortcut
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CLAUDE_SETTINGS_PATH, readJsonSafe } from './wizard.js';
import { resolveRouterModel, parseProfileModel } from './lib/models.js';
import { scaffoldMemoryFile } from './lib/memory-scaffold.js';
import { resolveMemoryRootSegment, resolveTasksRootSegment } from './lib/memory-root.js';
import {
	isNightlyDreamingTaskRegistered,
	NIGHTLY_DREAMING_TASK_NAME,
	getNightlyDreamingTaskRuntimeInfo,
	findMostRecentArchiveDate,
} from './lib/nightly-dreaming.js';
import { markDoctorRun } from './lib/bootstrap.js';
import { discoverProfileDirs, readAgentManifest, readProfileIdentity } from './lib/profiles.js';
import { buildPortablePrompt } from './lib/compose-portable-prompt.js';
import { normalise } from './lib/validate-utils.js';
import { LANGGRAPH_RUNTIME_DIR, LANGGRAPH_GENERATED_DIR, langGraphArtifactFileName } from './lib/langgraph-paths.js';
import { checkHubRootDepsCurrent } from './lib/hub-root-install.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Check result constructors ──────────────────────────────────────────────────

// Exported (in addition to being used locally) so tier-specific doctor plugin
// modules under lib/*.doctor-plugin.js can build check results in the same
// shape without duplicating this logic.
export function pass(id, label, message) {
	return { id, label, status: 'pass', message, hint: null };
}

export function fail(id, label, message, hint) {
	return { id, label, status: 'fail', message, hint };
}

export function warn(id, label, message, hint) {
	return { id, label, status: 'warn', message, hint };
}

export function skip(id, label, message) {
	return { id, label, status: 'skip', message, hint: null };
}

// ── Individual checks ──────────────────────────────────────────────────────────

function checkWorkspaceConfig({ hubRoot, fsMod }) {
	const p = path.join(hubRoot, 'workspace.config.json');
	if (fsMod.existsSync(p)) {
		return pass(1, 'workspace config', 'workspace.config.json found');
	}
	return fail(1, 'workspace config', 'workspace.config.json not found',
		'run: npm run setup');
}

function checkGitignore({ hubRoot, fsMod }) {
	const p = path.join(hubRoot, '.gitignore');
	if (!fsMod.existsSync(p)) {
		return fail(2, '.gitignore entries', '.gitignore not found',
			'rerun the tier-specific deploy command');
	}
	const content = fsMod.readFileSync(p, 'utf-8');
	const lines = content.split('\n').map(l => l.trim());
	const missing = [];
	if (!lines.includes('workspace.config.json')) missing.push('workspace.config.json');
	if (!lines.includes('.claude/settings.local.json')) missing.push('.claude/settings.local.json');
	if (!lines.includes('workspace-identity.mdc')) missing.push('workspace-identity.mdc');
	if (!lines.includes('copilot-instructions.md')) missing.push('copilot-instructions.md');
	if (missing.length === 0) {
		return pass(2, '.gitignore entries', 'all personal files covered');
	}
	return fail(2, '.gitignore entries', `missing entries: ${missing.join(', ')}`,
		'rerun the tier-specific deploy command');
}

function checkGitattributes({ hubRoot, fsMod }) {
	const p = path.join(hubRoot, '.gitattributes');
	if (!fsMod.existsSync(p)) {
		return fail(3, '.gitattributes', '.gitattributes not found',
			'rerun the tier-specific deploy command');
	}
	const content = fsMod.readFileSync(p, 'utf-8');
	const missing = [];
	if (!/memory\/\*\.md\s+(?:\S+[ \t]+)*merge=ours/.test(content)) missing.push('memory/*.md merge=ours');
	if (!/.cursor\/rules\/workspace-identity\.mdc\s+(?:\S+[ \t]+)*merge=ours/.test(content)) {
		missing.push('.cursor/rules/workspace-identity.mdc merge=ours');
	}
	if (!/tools\/\*\.sh\s+(?:text\s+)?eol=lf/.test(content)) missing.push('tools/*.sh eol=lf');
	if (!/tools\/\*\.txt\s+(?:text\s+)?eol=lf/.test(content)) missing.push('tools/*.txt eol=lf');
	if (missing.length === 0) {
		return pass(3, '.gitattributes', 'merge=ours entries present');
	}
	return fail(3, '.gitattributes', `missing entries: ${missing.join(', ')}`,
		'rerun the tier-specific deploy command');
}

/**
 * Derive the required agent id list for memory-file scaffolding from the
 * deployed .claude/agents/*.md basenames — the same source check 9
 * (checkAgentProfiles) already reads. Never hardcoded, never dependent on
 * the source profilesRoot (a deployed hub does not have it).
 */
function discoverDeployedAgentIds({ hubRoot, fsMod }) {
	const dir = path.join(hubRoot, '.claude', 'agents');
	if (!fsMod.existsSync(dir)) return [];
	try {
		return fsMod.readdirSync(dir)
			.filter(f => f.endsWith('.md'))
			.map(f => f.slice(0, -'.md'.length));
	} catch {
		return [];
	}
}

function checkMemoryFiles({ hubRoot, fsMod }) {
	const agentIds = discoverDeployedAgentIds({ hubRoot, fsMod });
	// hubType-aware: vault-backed tiers (dev:sub/ops/publish) scaffold into
	// vault/Memory (see lib/memory-root.js, the single source of truth shared
	// with lib/extras.js and lib/session-cli.js). readHubConfig() is the same
	// workspace.config.json reader checkHubType() (check 15) uses below.
	const { config } = readHubConfig(hubRoot, fsMod);
	const segment = resolveMemoryRootSegment(config?.hubType);
	const displaySegment = segment.replace(/\\/g, '/');
	const memoryRoot = path.join(hubRoot, segment);
	//
	// Unlike the free-tier "memory" default, this check deliberately does NOT
	// auto-scaffold vault/Memory via a raw fs.mkdirSync when it is missing on
	// a vault-backed tier. Two reasons: (1) a raw mkdirSync here bypasses the
	// vault storage plugin's own mutation path the Storage Plugin Contract
	// (agents/skills/agent-foundations/SKILL.md) documents for all vault
	// writes; (2) since this check runs earlier in runChecks() than the
	// vault-readiness check further down (a dev:sub-only tier plugin, excluded
	// from this file when it ships to the free "dev" tier — see
	// checkOptionalTierReadiness below), an unconditional mkdirSync here would
	// make the vault root appear to exist before that later check evaluates it,
	// masking its own "vault root not found" fail with a misleading "present"
	// signal on every doctor run. vault/Memory is instead scaffolded at deploy
	// time by lib/extras.js — same precedent already established for
	// vault/Tasks (see checkProjectsDir below).
	if (segment !== 'memory' && !fsMod.existsSync(memoryRoot)) {
		return warn(4, 'memory files', `${displaySegment}/ directory not found`,
			'run the tier-specific deploy command (e.g. npm run deploy:dev:sub) to scaffold the vault-canonical memory root');
	}
	const scaffolded = [];
	for (const agentId of agentIds) {
		if (scaffoldMemoryFile({ memoryRoot, agentId, fsMod })) {
			scaffolded.push(`${agentId}.md`);
		}
	}
	if (scaffolded.length === 0) {
		return pass(4, 'memory files', `all ${agentIds.length} agent memory file(s) present`);
	}
	return pass(4, 'memory files', `${scaffolded.length} file(s) scaffolded: ${scaffolded.join(', ')}`);
}

function checkMcpJson({ hubRoot, fsMod }) {
	const p = path.join(hubRoot, '.mcp.json');
	if (!fsMod.existsSync(p)) {
		return fail(5, '.mcp.json', '.mcp.json not found',
			'rerun the tier-specific deploy command');
	}
	let data;
	try {
		data = JSON.parse(fsMod.readFileSync(p, 'utf-8'));
	} catch {
		return fail(5, '.mcp.json', '.mcp.json is not valid JSON',
			'rerun the tier-specific deploy command');
	}
	if (data?.mcpServers?.['agent-browser']) {
		return pass(5, '.mcp.json', 'agent-browser wired');
	}
	return fail(5, '.mcp.json', 'mcpServers.agent-browser missing',
		'rerun the tier-specific deploy command');
}

export function readHubConfig(hubRoot, fsMod) {
	const configPath = path.join(hubRoot, 'workspace.config.json');
	if (!fsMod.existsSync(configPath)) {
		return { config: null, skipReason: 'workspace.config.json absent — skipping relay check' };
	}
	try {
		return { config: JSON.parse(fsMod.readFileSync(configPath, 'utf-8')), skipReason: null };
	} catch {
		return { config: null, skipReason: 'workspace.config.json unreadable — skipping relay check' };
	}
}

function isRemoteTeamEnabled(config) {
	return Boolean(config?.remoteTeam?.enabled);
}

async function checkRelayDaemonAsync({ hubRoot, fsMod, probeHealth }) {
	const { config, skipReason } = readHubConfig(hubRoot, fsMod);
	if (skipReason) return skip(6, 'relay daemon', skipReason);
	if (!isRemoteTeamEnabled(config)) {
		return skip(6, 'relay daemon', 'remoteTeam not enabled — relay check skipped');
	}

	// relay/core/config.js is only present on hubs where relay/ was deployed
	// (extras.js copies it conditionally). Dynamic import here — placed after
	// early-return guards — ensures doctor.js loads without error on hubs that
	// don't have relay/ at all. By this point remoteTeam.enabled is true, so
	// the relay directory is guaranteed present.
	const { DEFAULT_DAEMON_PORT } = await import('./relay/core/config.js');

	const port = Number(config?.relay?.daemonPort) || DEFAULT_DAEMON_PORT;
	const result = await probeHealth(port);
	if (result === 'ok') {
		return pass(6, 'relay daemon', `GET localhost:${port}/health returned ok`);
	}
	return warn(6, 'relay daemon',
		result === 'bad' ? `daemon on port ${port} did not return ok` : `daemon not reachable on port ${port}`,
		'start: npm run relay -- --hub . (from profiles repo) or npm run relay (deployed hub)');
}

function checkRelayMcp({ hubRoot, fsMod }) {
	const { config, skipReason } = readHubConfig(hubRoot, fsMod);
	if (skipReason) return skip(7, 'relay MCP', skipReason);
	if (!isRemoteTeamEnabled(config)) {
		return skip(7, 'relay MCP', 'remoteTeam not enabled — relay check skipped');
	}

	const claudeSettings = readJsonSafe(CLAUDE_SETTINGS_PATH, fsMod);
	const cursorMcpPath = path.join(hubRoot, '.cursor', 'mcp.json');
	const cursorSettings = readJsonSafe(cursorMcpPath, fsMod);
	const hasClaude = Boolean(claudeSettings?.mcpServers?.relay);
	const hasCursor = Boolean(cursorSettings?.mcpServers?.relay);

	if (hasClaude && hasCursor) {
		return pass(7, 'relay MCP', 'mcpServers.relay in Claude settings and .cursor/mcp.json');
	}
	if (hasClaude) {
		return pass(7, 'relay MCP', 'mcpServers.relay present in ~/.claude/settings.json');
	}
	if (hasCursor) {
		return pass(7, 'relay MCP', 'mcpServers.relay present in .cursor/mcp.json');
	}

	return fail(7, 'relay MCP',
		'remoteTeam enabled but mcpServers.relay missing in Claude settings and .cursor/mcp.json',
		'run: npm run setup (re-enter telegram credentials to wire relay MCP)');
}

function checkTelegramConfig({ hubRoot, fsMod }) {
	const { config, skipReason } = readHubConfig(hubRoot, fsMod);
	if (skipReason) return skip(8, 'telegram config', skipReason);
	if (!isRemoteTeamEnabled(config)) {
		return skip(8, 'telegram config', 'remoteTeam not enabled — telegram check skipped');
	}

	const telegram = config?.telegram;
	const missing = [];
	if (!telegram || telegram.enabled === false) missing.push('telegram.enabled');
	if (!telegram?.bot_token) missing.push('telegram.bot_token');
	if (!telegram?.relay_group_id) missing.push('telegram.relay_group_id');

	if (missing.length === 0) {
		return pass(8, 'telegram config', 'telegram credentials complete in workspace.config.json');
	}
	return fail(8, 'telegram config',
		`incomplete telegram block: missing ${missing.join(', ')}`,
		'run: npm run setup');
}

function checkAgentProfiles({ hubRoot, fsMod }) {
	const dir = path.join(hubRoot, '.claude', 'agents');
	if (!fsMod.existsSync(dir)) {
		return fail(9, 'agent profiles', '.claude/agents/ directory not found',
			'rerun the tier-specific deploy command');
	}
	let entries;
	try {
		entries = fsMod.readdirSync(dir).filter(f => f.endsWith('.md'));
	} catch {
		return fail(9, 'agent profiles', 'could not read .claude/agents/',
			'rerun the tier-specific deploy command');
	}
	if (entries.length === 0) {
		return fail(9, 'agent profiles', '.claude/agents/ is empty',
			'rerun the tier-specific deploy command');
	}
	return pass(9, 'agent profiles', `${entries.length} agent profile(s) found in .claude/agents/`);
}

function checkCodexAgentProfiles({ hubRoot, fsMod }) {
	const dir = path.join(hubRoot, '.codex', 'agents');
	if (!fsMod.existsSync(dir)) {
		return fail(10, 'codex agent profiles', '.codex/agents/ directory not found',
			'rerun the tier-specific deploy command');
	}
	let entries;
	try {
		entries = fsMod.readdirSync(dir).filter(f => f.endsWith('.toml'));
	} catch {
		return fail(10, 'codex agent profiles', 'could not read .codex/agents/',
			'rerun the tier-specific deploy command');
	}
	if (entries.length === 0) {
		return fail(10, 'codex agent profiles', '.codex/agents/ is empty',
			'rerun the tier-specific deploy command');
	}
	return pass(10, 'codex agent profiles', `${entries.length} Codex agent profile(s) found in .codex/agents/`);
}

function isAutoDispatchEnabled(config) {
	return config?.relay?.autoDispatch === true;
}

function checkAutoDispatchClaude({ hubRoot, fsMod, execFn }) {
	const { config, skipReason } = readHubConfig(hubRoot, fsMod);
	if (skipReason || !isAutoDispatchEnabled(config)) {
		return skip(11, 'auto-dispatch: claude', 'autoDispatch not enabled — check skipped');
	}
	try {
		execFn('claude', ['--version'], { stdio: 'pipe' });
		return pass(11, 'auto-dispatch: claude', '`claude` found on PATH');
	} catch {
		return fail(11, 'auto-dispatch: claude', '`claude` not found on PATH',
			'install Claude Code CLI: https://claude.ai/download');
	}
}

function checkAutoDispatchRouterProfile({ hubRoot, fsMod }) {
	const { config, skipReason } = readHubConfig(hubRoot, fsMod);
	if (skipReason || !isAutoDispatchEnabled(config)) {
		return skip(12, 'auto-dispatch: router profile', 'autoDispatch not enabled — check skipped');
	}
	const profilePath = path.join(hubRoot, '.claude', 'agents', 'router.md');
	if (fsMod.existsSync(profilePath)) {
		return pass(12, 'auto-dispatch: router profile', '.claude/agents/router.md found');
	}
	return fail(12, 'auto-dispatch: router profile', '.claude/agents/router.md not found',
		'rerun the tier-specific deploy command');
}

function checkAutoDispatchRouterModel({ hubRoot, fsMod, profilesRoot }) {
	const { config, skipReason } = readHubConfig(hubRoot, fsMod);
	if (skipReason || !isRemoteTeamEnabled(config)) {
		return skip(13, 'router model tier', 'remoteTeam not enabled — check skipped');
	}
	const profilePath = path.join(hubRoot, '.claude', 'agents', 'router.md');
	if (!fsMod.existsSync(profilePath)) {
		return skip(13, 'router model tier', '.claude/agents/router.md absent — skipping model check');
	}
	let deployedModel;
	try {
		deployedModel = parseProfileModel(fsMod.readFileSync(profilePath, 'utf-8'));
	} catch {
		return skip(13, 'router model tier', 'could not read router profile — skipping model check');
	}
	let expectedModel;
	try {
		expectedModel = resolveRouterModel(profilesRoot, fsMod);
	} catch {
		return skip(13, 'router model tier', 'router manifest unavailable — skipping model check');
	}
	if (!deployedModel) {
		return warn(13, 'router model tier',
			'deployed router.md has no model field — economy tier not enforced',
			`rerun the tier-specific deploy command (expected model: ${expectedModel})`);
	}
	if (deployedModel !== expectedModel) {
		return warn(13, 'router model tier',
			`deployed model (${deployedModel}) ≠ manifest economy tier (${expectedModel})`,
			'rerun the tier-specific deploy command');
	}
	return pass(13, 'router model tier', `router uses economy model ${deployedModel}`);
}

function checkProjectsDir({ hubRoot, fsMod }) {
	// hubType-aware: vault-backed tiers (dev:sub/ops/publish) use vault/Tasks
	// (see lib/memory-root.js, the single source of truth shared with
	// lib/extras.js). readHubConfig() is the same workspace.config.json
	// reader checkHubType() (check 15) uses below.
	//
	// Unlike the free-tier "projects" default, this check deliberately does
	// NOT auto-scaffold vault/Tasks via a raw fs.mkdirSync when it is missing
	// on a vault-backed tier. Two reasons: (1) a raw mkdirSync here bypasses
	// the vault storage plugin's own mutation path the Storage Plugin
	// Contract (agents/skills/agent-foundations/SKILL.md) documents for all
	// vault writes; (2) reproduced directly — since this check runs earlier
	// in runChecks() than the vault-readiness check further down (a
	// dev:sub-only tier plugin, excluded from this file when it ships to the
	// free "dev" tier — see checkOptionalTierReadiness below), an
	// unconditional mkdirSync here would make the vault root appear to exist
	// before that later check evaluates it, masking its own "vault root not
	// found" fail with a misleading "present" signal on every doctor run.
	// vault/Tasks is instead scaffolded at deploy time by lib/extras.js —
	// same precedent already established for vault/Memory.
	const { config } = readHubConfig(hubRoot, fsMod);
	const segment = resolveTasksRootSegment(config?.hubType);
	const displaySegment = segment.replace(/\\/g, '/');
	const tasksPath = path.join(hubRoot, segment);
	if (fsMod.existsSync(tasksPath)) {
		return pass(14, 'projects directory', `${displaySegment}/ directory present`);
	}
	if (segment !== 'projects') {
		return warn(14, 'projects directory', `${displaySegment}/ directory not found`,
			'run the tier-specific deploy command (e.g. npm run deploy:dev:sub) to scaffold the vault-canonical tasks root');
	}
	// Auto-scaffold: create the directory in the same run (free-tier default only)
	fsMod.mkdirSync(tasksPath, { recursive: true });
	return pass(14, 'projects directory', `${displaySegment}/ directory scaffolded`);
}

const HUB_TYPE_DEV_REQUIRED = ['architect', 'builder', 'tester', 'router'];
const HUB_TYPE_DEV_SUB_REQUIRED = ['architect', 'builder', 'tester', 'router', 'cao'];
const HUB_TYPE_OPS_REQUIRED = ['architect', 'builder', 'tester', 'router', 'cao'];

/**
 * Check 15: hubType-aware agent profile verification.
 *
 * Reads `hubType` from workspace.config.json and verifies that the correct
 * set of agent profiles is deployed in .claude/agents/:
 *   "dev"     — architect, builder, tester, router (cao must NOT be present)
 *   "dev:sub" — architect, builder, tester, router, cao (all five required)
 *   "ops"     — architect, builder, tester, router, cao (all five required)
 *
 * If hubType is absent or unrecognised, warns and falls back to dev checks.
 */
function checkHubType({ hubRoot, fsMod }) {
	const { config, skipReason } = readHubConfig(hubRoot, fsMod);
	if (skipReason) return skip(15, 'hub type', skipReason);

	const hubType = config?.hubType;
	const agentIds = discoverDeployedAgentIds({ hubRoot, fsMod });
	const agentSet = new Set(agentIds);

	if (!hubType || !['dev', 'dev:graph', 'ops', 'dev:sub'].includes(hubType)) {
		// Warn and fall back to dev checks
		const missingDev = HUB_TYPE_DEV_REQUIRED.filter(a => !agentSet.has(a));
		if (missingDev.length > 0) {
			return warn(15, 'hub type',
				`hubType not set — defaulting to dev checks; missing profiles: ${missingDev.join(', ')}`,
				'set hubType in workspace.config.json ("dev", "dev:graph", "ops", or "dev:sub"), then redeploy');
		}
		return warn(15, 'hub type',
			'hubType not set in workspace.config.json — defaulting to dev verification',
			'set hubType: "dev", "dev:graph", "ops", or "dev:sub" in workspace.config.json');
	}

	if (hubType === 'dev:graph') {
		const missingAgents = HUB_TYPE_DEV_REQUIRED.filter(a => !agentSet.has(a));
		if (missingAgents.length > 0) {
			return fail(15, 'hub type',
				`hubType=dev:graph but missing profiles: ${missingAgents.join(', ')}`,
				'run: npm run package:dev:graph then unzip to reinstall the hub');
		}
		if (agentSet.has('cao')) {
			return warn(15, 'hub type',
				'hubType=dev:graph but cao profile found — unexpected in a dev:graph hub',
				'remove cao or change hubType in workspace.config.json');
		}
		return pass(15, 'hub type', 'hubType=dev:graph — architect, builder, tester, router all present');
	}

	if (hubType === 'dev:sub') {
		const missingAgents = HUB_TYPE_DEV_SUB_REQUIRED.filter(a => !agentSet.has(a));
		if (missingAgents.length > 0) {
			return fail(15, 'hub type',
				`hubType=dev:sub but missing profiles: ${missingAgents.join(', ')}`,
				'run: npm run deploy:dev:sub (redeploy subscriber hub)');
		}
		return pass(15, 'hub type', 'hubType=dev:sub — architect, builder, tester, router, cao all present');
	}

	if (hubType === 'dev') {
		const missingAgents = HUB_TYPE_DEV_REQUIRED.filter(a => !agentSet.has(a));
		if (missingAgents.length > 0) {
			return fail(15, 'hub type',
				`hubType=dev but missing profiles: ${missingAgents.join(', ')}`,
				'run: npm run deploy:dev (redeploy dev hub)');
		}
		if (agentSet.has('cao')) {
			return warn(15, 'hub type',
				'hubType=dev but cao profile found — unexpected in a dev hub',
				'remove cao or change hubType to "ops" in workspace.config.json');
		}
		return pass(15, 'hub type', 'hubType=dev — architect, builder, tester, router all present');
	}

	// hubType === 'ops'
	const missingAgents = HUB_TYPE_OPS_REQUIRED.filter(a => !agentSet.has(a));
	if (missingAgents.length > 0) {
		return fail(15, 'hub type',
			`hubType=ops but missing profiles: ${missingAgents.join(', ')}`,
			'run: npm run deploy:ops (redeploy ops hub)');
	}
	return pass(15, 'hub type', 'hubType=ops — architect, builder, tester, router, cao all present');
}

/**
 * Check 18: nightly dreaming Scheduled Task readiness.
 *
 * Windows-only, applies uniformly across hub tiers (not gated by hubType) — a core
 * check, not a "*.doctor-plugin.js" tier plugin, so it always runs alongside whichever
 * optional tier-specific plugin checks (ids 16/17) also run; id 18 is the next free
 * slot to avoid colliding with those.
 *
 * This is a retroactive catch-up backfill for hubs set up before this feature shipped:
 * it never registers the task itself (doctor.js has no interactive prompting anywhere —
 * every other check in this file that needs customer consent for a side effect, e.g.
 * checkRelayMcp/checkTelegramConfig, warns with a hint pointing back at `npm run setup`
 * rather than acting unilaterally) — silently registering a background task that spends
 * API usage without being asked is exactly what this feature's own scope decision rules
 * out.
 */
function checkNightlyDreamingTask({ hubRoot, fsMod, execFn, platform = process.platform }) {
	if (platform !== 'win32') {
		return skip(18, 'nightly dreaming', 'Windows-only feature — not applicable on this platform');
	}
	const { config, skipReason } = readHubConfig(hubRoot, fsMod);
	if (skipReason) return skip(18, 'nightly dreaming', skipReason);

	const nightlyDreaming = config?.nightlyDreaming;
	if (!nightlyDreaming) {
		// Never configured — the exact hubs-set-up-before-this-shipped case AC4 targets.
		// No need to query schtasks to know the answer here.
		return warn(18, 'nightly dreaming',
			'not configured — opt-in nightly end-of-day memory consolidation is available',
			'run: npm run setup (enable nightly automated end-of-day memory consolidation)');
	}
	if (nightlyDreaming.enabled !== true) {
		return skip(18, 'nightly dreaming', 'disabled by choice (declined during setup)');
	}

	// Config says enabled — cross-check reality rather than trusting the config value
	// (VBR: "config exists" != "feature works"). Covers drift, e.g. the task was
	// manually removed via the Task Scheduler GUI after setup registered it.
	const taskName = nightlyDreaming.taskName ?? NIGHTLY_DREAMING_TASK_NAME;
	if (isNightlyDreamingTaskRegistered({ taskName, execFn })) {
		return pass(18, 'nightly dreaming', `Scheduled Task "${taskName}" registered`);
	}
	return warn(18, 'nightly dreaming',
		`enabled in workspace.config.json but Scheduled Task "${taskName}" is not registered`,
		'run: npm run setup (re-enable nightly dreaming to re-register the Scheduled Task)');
}

// A dated archive snapshot older than this many days, despite the Scheduled Task's last
// reported result being success (exit 0), is treated as the known regression pattern:
// Windows-level success with no real consolidation work underneath it.
const NIGHTLY_DREAMING_STALE_ARCHIVE_DAYS = 2;

/**
 * Check 19: nightly dreaming consolidation freshness.
 *
 * Check 18 above only confirms the Scheduled Task is registered — it never verifies the
 * task actually did anything. Real production evidence showed the task firing overnight,
 * reporting `LastTaskResult: 0` (success) and `NumberOfMissedRuns: 0`, while zero
 * consolidation work happened: no dated archive snapshot was written and no memory
 * compaction occurred. This check closes that specific gap by cross-checking the task's
 * own last-run outcome against the newest dated archive snapshot under
 * `memory/archive/` — flagging exactly the "Windows says success, nothing actually
 * happened" pattern that made the original regression invisible until someone asked by
 * hand.
 */
function checkNightlyDreamingConsolidationFreshness({ hubRoot, fsMod, execFn, platform = process.platform }) {
	if (platform !== 'win32') {
		return skip(19, 'nightly dreaming freshness', 'Windows-only feature — not applicable on this platform');
	}
	const { config, skipReason } = readHubConfig(hubRoot, fsMod);
	if (skipReason) return skip(19, 'nightly dreaming freshness', skipReason);

	const nightlyDreaming = config?.nightlyDreaming;
	if (!nightlyDreaming || nightlyDreaming.enabled !== true) {
		return skip(19, 'nightly dreaming freshness', 'nightly dreaming not enabled — nothing to check');
	}

	// Deliberately does not call isNightlyDreamingTaskRegistered() separately — that
	// would be a second, redundant `schtasks` call for the same task (check 18 already
	// covers "not registered" as its own drift case). A missing/never-run task and an
	// unregistered task both surface here as "no usable last-run info", which is the
	// correct skip either way — check 18 is still the authoritative source for the
	// registered/not-registered distinction itself.
	const taskName = nightlyDreaming.taskName ?? NIGHTLY_DREAMING_TASK_NAME;
	const { lastRunTime, lastResult } = getNightlyDreamingTaskRuntimeInfo({ taskName, execFn });
	if (!lastRunTime || /^(N\/A|Never)$/i.test(lastRunTime)) {
		return skip(19, 'nightly dreaming freshness', 'Scheduled Task not registered or has not run yet — see check 18');
	}

	const latestArchiveDate = findMostRecentArchiveDate({ hubRoot, agent: 'architect', fsMod });
	const staleDays = latestArchiveDate
		? Math.floor((Date.now() - Date.parse(latestArchiveDate)) / 86_400_000)
		: Infinity;

	if (lastResult === 0 && staleDays > NIGHTLY_DREAMING_STALE_ARCHIVE_DAYS) {
		return fail(19, 'nightly dreaming freshness',
			`Scheduled Task last reported success (exit 0, ${lastRunTime}) but the newest archived ` +
			`memory snapshot (memory/archive/architect-*.md) is ${latestArchiveDate ?? 'missing entirely'}` +
			`${latestArchiveDate ? ` (${staleDays} days old)` : ''} — the task reported success but ` +
			'consolidation did not actually run',
			`inspect logs/nightly-dreaming-<date>.log; re-run manually via: schtasks /run /tn ${taskName}`);
	}
	return pass(19, 'nightly dreaming freshness',
		latestArchiveDate
			? `most recent archived snapshot: ${latestArchiveDate} (task last ran ${lastRunTime}, exit ${lastResult})`
			: `task last ran ${lastRunTime} (exit ${lastResult}); no stale-success gap detected`);
}

/**
 * Check 21: LangGraph compile target freshness.
 *
 * Not tier-gated and not a `*.doctor-plugin.js` plugin — that mechanism is
 * reserved for content deployExtras() ships into hubs at certain tiers.
 * This check is generic like checkAgentProfiles/checkCodexAgentProfiles above,
 * but gracefully skips when `runtime/langgraph/` is absent. That skip is the
 * normal packaged-hub path because the LangGraph runtime source is only present
 * in the source repository during compile-target development.
 * Running `node pipelines/deploy/doctor.js --output .` from the source repo
 * checkout (hubRoot = the repo root) is what exercises this check when the
 * compile target is being maintained.
 *
 * Regenerates the expected prompt from the CAO profile source using the same
 * regenerate-and-diff flow the other compile targets use, then compares the
 * generated artifact against the copy on disk via the injectable fsMod.
 * `compareFile` cannot be reused directly here because it hardcodes real `fs`
 * access; this check needs the same normalized diff logic while honoring the
 * doctor command's fs injection seam.
 */
function checkLangGraphCompileTarget({ hubRoot, fsMod, profilesRoot }) {
	const runtimeDir = path.join(hubRoot, LANGGRAPH_RUNTIME_DIR);
	if (!fsMod.existsSync(runtimeDir)) {
		return skip(21, 'langgraph compile target', 'runtime/langgraph/ not present — nothing to check');
	}

	const agentsProfilesRoot = path.join(profilesRoot, 'agents', 'profiles');
	const agentsSkillsRoot = path.join(profilesRoot, 'agents', 'skills');

	let profileDirs;
	try {
		profileDirs = discoverProfileDirs(agentsProfilesRoot);
	} catch {
		return warn(21, 'langgraph compile target', 'could not read agents/profiles/ to determine eligible profiles',
			'run from a setchin-agent-profiles checkout, or pass --profiles-root explicitly');
	}

	const eligible = profileDirs
		.map(profileDir => ({ profileDir, manifest: readAgentManifest(profileDir) }))
		.filter(({ manifest }) => manifest?.exports?.generatePortablePrompt === true);

	if (eligible.length === 0) {
		return skip(21, 'langgraph compile target', 'no profile declares exports.generatePortablePrompt: true — nothing to check');
	}

	const generatedDir = path.join(hubRoot, LANGGRAPH_GENERATED_DIR);
	const problems = [];
	const fresh = [];
	for (const { profileDir, manifest } of eligible) {
		const identity = readProfileIdentity(profileDir);
		const artifactPath = path.join(generatedDir, langGraphArtifactFileName(identity.id));
		if (!fsMod.existsSync(artifactPath)) {
			problems.push(`${identity.id}: artifact missing (${path.relative(hubRoot, artifactPath)})`);
			continue;
		}
		let expected;
		try {
			expected = buildPortablePrompt(profileDir, agentsSkillsRoot, manifest.skills ?? []);
		} catch (err) {
			problems.push(`${identity.id}: could not regenerate expected prompt (${err.message})`);
			continue;
		}
		const actual = fsMod.readFileSync(artifactPath, 'utf-8');
		if (normalise(expected) !== normalise(actual)) {
			problems.push(`${identity.id}: stale relative to profile source`);
		} else {
			fresh.push(identity.id);
		}
	}

	if (problems.length > 0) {
		// This check only detects a stale compiled artifact on
		// disk — it cannot (and does not try to) detect whether the runtime
		// *process* has picked up a fresh artifact from a prior redeploy (the
		// deploy pipeline is file-sync only, never an auto-restart — see the
		// runbook below). Point remediation at both: regenerate the artifact,
		// then restart the runtime process per the documented lifecycle.
		return fail(21, 'langgraph compile target', problems.join('; '),
			'run: npm run compile:langgraph, then restart the runtime process — see docs/langgraph-runtime-lifecycle.md');
	}
	return pass(21, 'langgraph compile target', `compiled prompt artifact(s) present and fresh: ${fresh.join(', ')}`);
}

/**
 * Check 22: hub-root npm dependency install.
 *
 * buildPackageJson() (lib/extras.js) writes outputRoot/package.json
 * unconditionally on every hub tier, and a package-lock.json ships alongside
 * it — but a hub set up before setup.js's own early hub-root install step
 * shipped (lib/hub-root-install.js), or one where that step's `npm ci`/`npm
 * install` call failed silently, can still be missing node_modules/ entirely.
 * That gap surfaced for real: a vault-backed tier's stdio MCP proxy script
 * (packages/vault/vault-guard.cjs) requires
 * '@modelcontextprotocol/sdk/server/stdio.js' at spawn time and crashed with
 * MODULE_NOT_FOUND on a hub whose node_modules/ simply did not exist, while
 * doctor previously had no signal for it at all.
 *
 * Not tier-gated and not a "*.doctor-plugin.js" plugin — that discovery
 * mechanism is reserved for content deployExtras() ships conditionally by
 * hub tier (see checkOptionalTierReadiness below). package.json ships to
 * every hub tier unconditionally (buildPackageJson() has no hubType branch
 * around its own call site in lib/extras.js), so this check runs the same
 * way regardless of hubType — same "core check, not a tier plugin, because
 * the underlying content is universal" precedent checkLangGraphCompileTarget
 * above already established.
 *
 * id 22 (not 20): a tier plugin discovered by checkOptionalTierReadiness
 * below already owns id 20 for its own vault-content sampling check — 22 is
 * the next id past checkLangGraphCompileTarget (21), the highest numbered
 * check in this file.
 *
 * Generic like checkHubRootDepsCurrent() itself: reads whichever
 * dependencies package.json actually declares rather than hardcoding a
 * package name, so this keeps working unchanged if that dependency set ever
 * grows or shrinks.
 */
function checkHubRootDependencies({ hubRoot, fsMod }) {
	const pkgPath = path.join(hubRoot, 'package.json');
	if (!fsMod.existsSync(pkgPath)) {
		return skip(22, 'hub-root dependencies', 'package.json not found — nothing to check');
	}
	const { declared, missing } = checkHubRootDepsCurrent({ hubRoot, fsMod });
	if (declared.length === 0) {
		return pass(22, 'hub-root dependencies', 'no runtime dependencies declared in package.json');
	}
	if (missing.length === 0) {
		return pass(22, 'hub-root dependencies', `all ${declared.length} declared dependenc${declared.length === 1 ? 'y' : 'ies'} present in node_modules/`);
	}
	return fail(22, 'hub-root dependencies',
		`node_modules/ missing ${missing.length} declared dependenc${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}`,
		'run: npm install');
}

/**
 * Checks 16+: optional tier-specific readiness (dev:sub, ops, publish hubs only).
 *
 * Manifest-driven, not hardcoded: some hub tiers ship one or more additional
 * doctor checks as self-contained plugin modules under lib/ (filename
 * convention: "*.doctor-plugin.js"). deployExtras() only copies those plugin
 * files into non-free hub tiers (see pipelines/deploy/lib/extras.js); a free
 * "dev" hub never receives any of them. This function discovers every plugin
 * file present on disk (sorted, so results are stable) and runs each one,
 * flattening their results into the returned array — a dev hub, with no
 * plugin files present, simply returns a single clean skip result instead of
 * one skip per (absent) plugin. Each plugin module owns its own check
 * `id`/`label`, hardcoded in that module, so numbering stays stable and
 * non-colliding as more plugins are added. This keeps doctor.js itself
 * generic and free of any tier-specific
 * feature names, so a dev-hub deploy carries zero disclosure of paid-tier
 * feature details.
 */
async function checkOptionalTierReadiness({
	hubRoot, fsMod, execFn, platform = process.platform, env = process.env,
	fetchFn = globalThis.fetch, pluginOptions = {},
}) {
	let pluginFiles = [];
	try {
		pluginFiles = fs.readdirSync(path.join(__dirname, 'lib'))
			.filter(f => f.endsWith('.doctor-plugin.js'))
			.sort();
	} catch {
		pluginFiles = [];
	}
	if (pluginFiles.length === 0) {
		return [skip(16, 'optional tier readiness', 'no optional tier-specific checks present in this hub')];
	}
	const results = [];
	for (const file of pluginFiles) {
		const mod = await import(`./lib/${file}`);
		const result = await mod.check({
			hubRoot, fsMod, execFn, platform, env, fetchFn,
			readHubConfig, pass, fail, warn, skip,
			...pluginOptions,
		});
		// A plugin's check() may return either a single check object (the
		// original convention, used by most plugins) or an array of check
		// objects (used by any plugin that legitimately reports more than one
		// check per hub). Flatten either shape into `results` so
		// formatReport() always sees individual check objects, never a
		// nested array.
		if (Array.isArray(result)) {
			results.push(...result);
		} else {
			results.push(result);
		}
	}
	return results;
}

/**
 * Default health probe — GET /health and expect JSON with ok: true.
 *
 * @param {number} port
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<'ok'|'bad'|'unreachable'>}
 */
export async function probeRelayHealth(port, fetchFn = globalThis.fetch) {
	try {
		const res = await fetchFn(`http://127.0.0.1:${port}/health`);
		const data = await res.json();
		return res.ok && data?.ok === true ? 'ok' : 'bad';
	} catch {
		return 'unreachable';
	}
}

// ── runChecks (exported for testing) ──────────────────────────────────────────

/**
 * Run all hub health checks.
 *
 * @param {object} options
 * @param {string}   options.hubRoot      Absolute path to the hub root.
 * @param {object}   [options.fsMod]      Injectable fs module for testability.
 * @param {function(number): Promise<'ok'|'bad'|'unreachable'>} [options.probeHealth]
 * @param {function} [options.execFn]     Injectable execFileSync for PATH checks.
 * @param {string}   [options.profilesRoot] Absolute path to profiles repo root.
 * @param {string}   [options.platform]    Injectable process.platform for testability.
 * @param {object}   [options.env]         Injectable process.env for testability.
 * @param {typeof fetch} [options.fetchFn] Injectable fetch for optional-tier plugin checks.
 * @param {object}   [options.pluginOptions] Extra injectable overrides passed through to
 *   every discovered *.doctor-plugin.js module's check() call (e.g. probe functions for
 *   testability) — kept generic here so doctor.js never names a specific plugin's options.
 * @returns {Promise<Array<{id, label, status, message, hint}>>}
 */
export async function runChecks({
	hubRoot,
	fsMod = fs,
	probeHealth = probeRelayHealth,
	execFn = execFileSync,
	profilesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
	platform = process.platform,
	env = process.env,
	fetchFn = globalThis.fetch,
	pluginOptions = {},
}) {
	return [
		checkWorkspaceConfig({ hubRoot, fsMod }),
		checkGitignore({ hubRoot, fsMod }),
		checkGitattributes({ hubRoot, fsMod }),
		checkMemoryFiles({ hubRoot, fsMod }),
		checkMcpJson({ hubRoot, fsMod }),
		await checkRelayDaemonAsync({ hubRoot, fsMod, probeHealth }),
		checkRelayMcp({ hubRoot, fsMod }),
		checkTelegramConfig({ hubRoot, fsMod }),
		checkAgentProfiles({ hubRoot, fsMod }),
		checkCodexAgentProfiles({ hubRoot, fsMod }),
		checkAutoDispatchClaude({ hubRoot, fsMod, execFn }),
		checkAutoDispatchRouterProfile({ hubRoot, fsMod }),
		checkAutoDispatchRouterModel({ hubRoot, fsMod, profilesRoot }),
		checkProjectsDir({ hubRoot, fsMod }),
		checkHubType({ hubRoot, fsMod }),
		checkNightlyDreamingTask({ hubRoot, fsMod, execFn, platform }),
		checkNightlyDreamingConsolidationFreshness({ hubRoot, fsMod, execFn, platform }),
		checkHubRootDependencies({ hubRoot, fsMod }),
		checkLangGraphCompileTarget({ hubRoot, fsMod, profilesRoot }),
		...(await checkOptionalTierReadiness({ hubRoot, fsMod, execFn, platform, env, fetchFn, pluginOptions })),
	];
}

// ── computeExitCode (exported for testing) ────────────────────────────────────

/**
 * Compute exit code from check results.
 *
 * @param {Array} checks
 * @returns {0|1|2}  0 = all pass/skip, 1 = any fail, 2 = warnings only (no fails)
 */
export function computeExitCode(checks) {
	if (checks.some(c => c.status === 'fail')) return 1;
	if (checks.some(c => c.status === 'warn')) return 2;
	return 0;
}

// ── formatReport (exported for testing) ───────────────────────────────────────

const LABEL_WIDTH = 24;

function formatCheck(check, useColor) {
	const green = useColor ? '\x1b[32m' : '';
	const red = useColor ? '\x1b[31m' : '';
	const yellow = useColor ? '\x1b[33m' : '';
	const dim = useColor ? '\x1b[2m' : '';
	const reset = useColor ? '\x1b[0m' : '';

	let sym;
	switch (check.status) {
		case 'pass': sym = `${green}✓${reset}`; break;
		case 'fail': sym = `${red}✗${reset}`; break;
		case 'warn': sym = `${yellow}⚠${reset}`; break;
		default: sym = '-';
	}

	const label = check.label.padEnd(LABEL_WIDTH);
	const lines = [`  ${sym}  ${label} ${check.message}`];
	if (check.hint) {
		const indent = ' '.repeat(LABEL_WIDTH + 5);
		lines.push(`  ${indent} ${dim}→ ${check.hint}${reset}`);
	}
	return lines;
}

/**
 * Format the full doctor report as a string.
 *
 * @param {Array}   checks     Results from runChecks.
 * @param {boolean} useColor   Whether to emit ANSI colour codes.
 * @returns {string}
 */
export function formatReport(checks, useColor = false) {
	const lines = [];

	lines.push('╔══════════════════════════════════════════════╗');
	lines.push('║           Hub Health Check (doctor)          ║');
	lines.push('╚══════════════════════════════════════════════╝');
	lines.push('');

	for (const check of checks) {
		for (const line of formatCheck(check, useColor)) {
			lines.push(line);
		}
	}

	lines.push('');
	lines.push('── Result ────────────────────────────────────');
	lines.push('');

	const exitCode = computeExitCode(checks);
	if (exitCode === 0) {
		const green = useColor ? '\x1b[32m' : '';
		const reset = useColor ? '\x1b[0m' : '';
		lines.push(`  ${green}READY${reset} — hub is correctly configured`);
	} else {
		const red = useColor ? '\x1b[31m' : '';
		const yellow = useColor ? '\x1b[33m' : '';
		const reset = useColor ? '\x1b[0m' : '';
		const fails = checks.filter(c => c.status === 'fail').length;
		const warns = checks.filter(c => c.status === 'warn').length;
		const parts = [];
		if (fails > 0) parts.push(`${red}${fails} error${fails > 1 ? 's' : ''}${reset}`);
		if (warns > 0) parts.push(`${yellow}${warns} warning${warns > 1 ? 's' : ''}${reset}`);
		lines.push(`  NOT READY — ${parts.join(', ')}`);
	}

	lines.push('');

	return lines.join('\n');
}

// ── CLI entry point ────────────────────────────────────────────────────────────

const isMain = process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	const outputIdx = process.argv.indexOf('--output');
	const hubRoot = outputIdx !== -1
		? path.resolve(process.argv[outputIdx + 1])
		: process.cwd();

	const checks = await runChecks({ hubRoot });
	const useColor = Boolean(process.stdout.isTTY);
	process.stdout.write(formatReport(checks, useColor));
	const exitCode = computeExitCode(checks);
	markDoctorRun(hubRoot, { exitCode });
	// Set process.exitCode instead of calling process.exit(exitCode) directly.
	// process.exit() forces immediate, synchronous process termination, which
	// on Windows can race libuv's teardown of any handle still mid-close (a
	// dynamic import(), a real network probe made by an optional-tier
	// doctor-plugin check, or a spawned child process) — producing
	// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c"
	// and a crash after the report has already printed correctly. Setting
	// process.exitCode instead lets Node drain the event loop naturally and
	// close every pending handle before exiting on its own with the same
	// code.
	process.exitCode = exitCode;
}
