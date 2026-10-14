#!/usr/bin/env node
/**
 * self-check.js — emits the Bootstrap Self-Check 7-point report
 * (agents/skills/agent-foundations/SKILL.md) as a tested CLI command
 * instead of an agent assembling it by hand from doctor.js, skills-audit.js,
 * a memory read and workspace.config.json.
 *
 * Usage: node tools/self-check.js <agent> [--json]
 * (also exposed as `npm run self-check -- <agent>`)
 *
 * Run from the hub root. Exit code 0 for a `ready`/`ready-with-warnings`
 * verdict, 1 for `blocked`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditProfile } from './skills-audit.js';
import {
	resolvePath,
	detectPlugin,
	loadMemoryRootModule,
} from './resolve-path.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Adapter-specific profile path, relative to the hub root. See the Working
 * Directory Verification protocol table for the source of this mapping. */
const ADAPTER_PROFILE_PATHS = [
	{
		adapter: 'claude-code',
		relPath: (agent) => path.join('.claude', 'agents', `${agent}.md`),
	},
	{
		adapter: 'cursor',
		relPath: (agent) => path.join('.cursor', 'agents', `${agent}.md`),
	},
	{
		adapter: 'copilot',
		relPath: (agent) => path.join('.github', 'agents', `${agent}.agent.md`),
	},
	{
		adapter: 'codex',
		relPath: (agent) => path.join('.codex', 'agents', `${agent}.toml`),
	},
];

/** Per-role one-liner for what VBR requires, mirrored from agent-foundations/SKILL.md's "By role" list. */
const VBR_BY_ROLE = {
	architect:
		'ADR file exists in the repo AND the decision is documented with rationale AND any resulting ticket has testable, unambiguous acceptance criteria',
	builder:
		'feature works in the running app, not just that build/lint/tests passed; verify by process exit code, not stdout pass counts',
	tester:
		'verdict is supported by observable URL / rendered text / visible UI state captured in the report',
	router:
		'routed message actually reached its destination and the audit comment is visible on the referenced issue or PR',
};
const VBR_FALLBACK =
	'never report completion without end-to-end verification of the observable outcome, not just the action taken';
const WAL_LINE =
	'write corrections, decisions, proper nouns, preferences, and specific values to memory before composing the response, on every turn where a trigger fires';
const RBR_LINE =
	'confirm the root cause with file/line or log evidence, and sweep for the same pattern elsewhere, before proposing any code or config change';

const LIFECYCLE_STATES = [
	'state:ready-for-implementation',
	'state:in-progress',
	'state:ready-for-review',
	'state:ready-for-qa',
	'state:changes-requested',
	'state:qa-passed',
	'closed',
];

/** Vault-tier memory notes under this count, with the agent's own memory
 * stub-scaffolded, trigger the setup-ordering caveat rather than an
 * unqualified "stub-scaffolded" finding. A heuristic, not an exact count. */
const NEAR_ZERO_VAULT_NOTE_COUNT = 3;

function readJsonSafe(filePath, fsMod) {
	try {
		return JSON.parse(fsMod.readFileSync(filePath, 'utf-8'));
	} catch {
		return null;
	}
}

/** Resolve the first adapter whose profile file exists for this agent. */
function resolveIdentity(hubRoot, agent, fsMod) {
	for (const { adapter, relPath } of ADAPTER_PROFILE_PATHS) {
		const abs = path.join(hubRoot, relPath(agent));
		if (fsMod.existsSync(abs)) {
			const content = fsMod.readFileSync(abs, 'utf-8');
			const contentHash = crypto
				.createHash('sha256')
				.update(content)
				.digest('hex');
			return { adapter, profilePath: abs, contentHash };
		}
	}
	return { adapter: null, profilePath: null, contentHash: null };
}

function skillsCatalogue(profilePath, hubRoot, fsMod) {
	if (!profilePath) {
		return { ok: false, error: 'no profile file found for any known adapter' };
	}
	try {
		return { ok: true, ...auditProfile(profilePath, { cwd: hubRoot, fsMod }) };
	} catch (err) {
		return { ok: false, error: err.message };
	}
}

function protocolsAcknowledged(agent) {
	return {
		VBR: VBR_BY_ROLE[agent] ?? VBR_FALLBACK,
		WAL: WAL_LINE,
		RBR: RBR_LINE,
		lifecycleStates: LIFECYCLE_STATES,
	};
}

/** Count markdown notes under a vault root (recursive), for the setup-ordering caveat. */
function countVaultNotes(vaultRoot, fsMod) {
	let count = 0;
	let entries;
	try {
		entries = fsMod.readdirSync(vaultRoot, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const full = path.join(vaultRoot, entry.name);
		if (entry.isDirectory()) {
			count += countVaultNotes(full, fsMod);
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			count += 1;
		}
	}
	return count;
}

/** A freshly scaffolded memory note's placeholder line, e.g. `_(nothing yet)_`
 * or `_(nothing active)_` — see lib/memory-scaffold.js's own template and the
 * obsidian-tier vault scaffold it mirrors. Not real content. */
const PLACEHOLDER_LINE_RE = /^_\(.*\)_$/;

/** `missing` | `stub-scaffolded` | `has-content`, from a memory file's body
 * once headings, blank lines, and scaffold placeholder lines are stripped. */
function classifyMemoryContent(filePath, fsMod) {
	if (!fsMod.existsSync(filePath)) return 'missing';
	const text = fsMod.readFileSync(filePath, 'utf-8');
	const meaningfulLines = text
		.split(/\r\n|\n/)
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.length > 0 &&
				!line.startsWith('#') &&
				!PLACEHOLDER_LINE_RE.test(line),
		);
	return meaningfulLines.length === 0 ? 'stub-scaffolded' : 'has-content';
}

async function memoryState(hubRoot, agent, fsMod) {
	const resolved = await resolvePath({
		hubRoot,
		store: 'memory',
		arg: agent,
		fsMod,
	});
	if (!resolved.ok) {
		return { state: 'unresolvable', reason: resolved.error, caveat: null };
	}
	const plugin = resolved.plugin;
	const state = classifyMemoryContent(resolved.path, fsMod);

	let caveat = null;
	if (plugin === 'obsidian' && state === 'stub-scaffolded') {
		const vaultRoot = path.join(hubRoot, 'vault');
		const noteCount = countVaultNotes(vaultRoot, fsMod);
		if (noteCount <= NEAR_ZERO_VAULT_NOTE_COUNT) {
			caveat =
				'memory stub-scaffolded; if `npm run setup` has not yet run on this hub, this finding will go stale the moment it does — re-run Bootstrap Self-Check manually to confirm after setup completes.';
		}
	}
	return { state, path: resolved.path, plugin, caveat };
}

/**
 * "projects/ directory scaffolded" mirrors doctor.js's own check 14
 * (checkProjectsDir): vault-backed tiers (dev:sub/ops) scaffold
 * `vault/Tasks`, not a literal `projects/` — resolved via the same
 * `resolveTasksRootSegment(hubType)` doctor.js uses, read from
 * workspace.config.json's hubType, matching doctor.js's own precedent
 * exactly rather than a tier-naive literal path check.
 */
async function workspaceSignals(hubRoot, fsMod) {
	const configPath = path.join(hubRoot, 'workspace.config.json');
	const configPresent = fsMod.existsSync(configPath);
	const config = configPresent ? readJsonSafe(configPath, fsMod) : null;
	const doctorLastRanAtPresent = Boolean(config?.doctor?.lastRanAt);

	let projectsScaffolded = fsMod.existsSync(path.join(hubRoot, 'projects'));
	const mod = await loadMemoryRootModule(hubRoot);
	if (mod) {
		const segment = mod.resolveTasksRootSegment(config?.hubType);
		projectsScaffolded = fsMod.existsSync(path.join(hubRoot, segment));
	}

	const signals = {
		workspaceConfigPresent: configPresent,
		doctorLastRanAtPresent,
		projectsScaffolded,
		activeStoragePlugin: null,
	};

	if (config?.hubType === 'dev:sub') {
		signals.activeStoragePlugin = detectPlugin(hubRoot, fsMod);
	}
	return signals;
}

/**
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {string} options.agent
 * @param {object} [options.fsMod]
 * @returns {Promise<object>} the full 7-point report plus a top-level verdict/exitCode
 */
export async function runSelfCheck({ hubRoot, agent, fsMod = fs }) {
	const identity = resolveIdentity(hubRoot, agent, fsMod);
	const skills = skillsCatalogue(identity.profilePath, hubRoot, fsMod);
	const protocols = protocolsAcknowledged(agent);
	const memory = await memoryState(hubRoot, agent, fsMod);
	const workspace = await workspaceSignals(hubRoot, fsMod);

	const gaps = [];
	if (!identity.profilePath)
		gaps.push('no profile file found for any known adapter');
	if (!skills.ok) gaps.push(`skills catalogue unavailable: ${skills.error}`);
	else if (skills.missingGuaranteed?.length)
		gaps.push(
			`missing guaranteed skills: ${skills.missingGuaranteed.join(', ')}`,
		);
	if (memory.state === 'missing') gaps.push('memory record missing');
	if (memory.state === 'stub-scaffolded')
		gaps.push('memory record stub-scaffolded');
	if (memory.state === 'unresolvable')
		gaps.push(`memory path unresolvable: ${memory.reason}`);
	if (!workspace.workspaceConfigPresent)
		gaps.push('workspace.config.json missing');
	if (!workspace.doctorLastRanAtPresent)
		gaps.push(
			'doctor has never run (workspace.config.json doctor.lastRanAt unset)',
		);
	if (!workspace.projectsScaffolded)
		gaps.push('projects/ directory not scaffolded');

	const blocked =
		!identity.profilePath ||
		(skills.ok && skills.missingGuaranteed?.length > 0);
	let verdict;
	let reason;
	if (blocked) {
		verdict = 'blocked';
		reason = !identity.profilePath
			? 'no profile file found for any known adapter'
			: `missing guaranteed skills: ${skills.missingGuaranteed.join(', ')}`;
	} else if (gaps.length > 0) {
		verdict = 'ready-with-warnings';
		reason = memory.caveat ?? gaps[0];
	} else {
		verdict = 'ready';
		reason = 'no gaps found';
	}

	return {
		agent,
		identity,
		skills,
		protocols,
		memory,
		workspace,
		gaps,
		verdict,
		reason,
		exitCode: verdict === 'blocked' ? 1 : 0,
	};
}

function formatHuman(report) {
	const lines = [];
	lines.push(
		`1. Identity — agent: ${report.agent}, adapter: ${report.identity.adapter ?? 'none found'}, profile: ${report.identity.profilePath ?? 'n/a'}, hash: ${report.identity.contentHash ?? 'n/a'}`,
	);
	lines.push(
		`2. Skills catalogue — ${report.skills.ok ? JSON.stringify(report.skills) : `unavailable: ${report.skills.error}`}`,
	);
	lines.push(`3. Protocols — VBR: ${report.protocols.VBR}`);
	lines.push(`   WAL: ${report.protocols.WAL}`);
	lines.push(`   RBR: ${report.protocols.RBR}`);
	lines.push(
		`   lifecycle states: ${report.protocols.lifecycleStates.join(', ')}`,
	);
	lines.push(
		`4. Memory state — ${report.memory.state}${report.memory.caveat ? ` (${report.memory.caveat})` : ''}`,
	);
	lines.push(`5. Workspace signals — ${JSON.stringify(report.workspace)}`);
	lines.push(
		`6. Gaps — ${report.gaps.length ? report.gaps.join('; ') : 'none'}`,
	);
	lines.push(`7. Verdict — ${report.verdict}: ${report.reason}`);
	return lines.join('\n');
}

async function main() {
	const args = process.argv.slice(2);
	const asJson = args.includes('--json');
	const agent = args.find((a) => !a.startsWith('--'));
	if (!agent) {
		process.stderr.write('Usage: node tools/self-check.js <agent> [--json]\n');
		process.exit(1);
		return;
	}

	const report = await runSelfCheck({ hubRoot: process.cwd(), agent });
	process.stdout.write(
		asJson ? `${JSON.stringify(report)}\n` : `${formatHuman(report)}\n`,
	);
	process.exit(report.exitCode);
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	main();
}
