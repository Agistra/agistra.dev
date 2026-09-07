import path from 'node:path';
import {
	readOptionalFile,
	readProfileIdentity,
	normalizeSkillList,
	skillShipsToHubType,
} from './profiles.js';

/**
 * Build a plain-text, surface-agnostic system prompt for a profile — the
 * "portable prompt" gated by a manifest's `exports.generatePortablePrompt`
 * flag (schemas/agent.manifest.schema.json). Unlike the four IDE wrappers
 * (compose.js/compose-claude.js/compose-cursor.js/compose-codex.js), this is
 * not a markdown document meant for a human or an IDE agent-file loader — it
 * is fed directly to an LLM as a system message (LangGraph's `SystemMessage`,
 * see runtime/langgraph/src/agistra_ops/agent.py), so it renders as plain
 * prose, not headings/tables.
 *
 * Composed from the same source files the 4 IDE targets already use
 * (IDENTITY.md + SOUL.md + declared skills), so identity text is authored
 * exactly once and compiled per surface. No markdown-table skills
 * catalogue here — LangGraph tool availability is a plain list of names, not
 * a "read this file when this scenario applies" pointer (there is no
 * skills/ directory read-on-demand mechanism in the LangGraph runtime).
 *
 * @param {string} profileDir
 * @param {string} skillsRoot
 * @param {Array} declaredSkills
 * @returns {string}
 */
export function buildPortablePrompt(profileDir, skillsRoot, declaredSkills) {
	const identity = readProfileIdentity(profileDir);

	const soulPath = path.join(profileDir, 'SOUL.md');
	const soulContent = readOptionalFile(soulPath);
	if (!soulContent) {
		throw new Error(`Required profile file not found: ${soulPath}`);
	}
	const soulBody = soulContent
		.replace(/^# [^\r\n]+\r?\n/, '')
		.replace(/^\r?\n/, '')
		.trimEnd();

	const openingLines = [`You are ${identity.name}, the ${identity.role}.`];
	if (identity.tagline) openingLines.push(identity.tagline);

	// Same eligibility rule the 4 deploy targets already apply to physical skill
	// copying: no hubType passed (LangGraph is not hubType-tiered) excludes any
	// hubType-gated entry, and optional/third-party skills are never vendored
	// outside the deployed hub's own install-skill flow — a LangGraph runtime
	// has no skills/ directory to read them from on demand.
	const normalizedSkills = normalizeSkillList(declaredSkills)
		.filter(({ optional }) => !optional)
		.filter(({ hubType, requiresGraphify }) => skillShipsToHubType(hubType, null, { requiresGraphify, withGraphify: false }));

	const sections = [openingLines.join('\n\n'), soulBody];

	if (normalizedSkills.length > 0) {
		const skillLines = normalizedSkills.map(({ name }) => `- ${name}`);
		sections.push(['Behavioral disciplines you follow (source: setchin-agent-profiles skills):', ...skillLines].join('\n'));
	}

	// Normalize to LF for cross-platform consistency
	return sections.join('\n\n').replace(/\r\n/g, '\n').trimEnd() + '\n';
}
