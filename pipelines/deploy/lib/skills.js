import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './tasks.js';
import { addWrittenFile, addWrittenFiles, copyDirTracked } from './written-files.js';

function yamlDoubleQuoted(str) {
	return `"${String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function stripYamlQuotes(value) {
	return value.replace(/^["']|["']$/g, '');
}

/** Claude Code's skill description limit. Descriptions are never truncated; longer ones fail validation. */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Extract name and description from a source skill's SKILL.md frontmatter.
 * Falls back to the directory name and first heading or line when frontmatter is absent.
 */
export function parseSkillFrontmatter(skillsRoot, skillName) {
	const skillPath = path.join(skillsRoot, skillName, 'SKILL.md');
	if (!fs.existsSync(skillPath)) {
		return { name: skillName, description: '', missing: true };
	}

	const content = fs.readFileSync(skillPath, 'utf-8');
	const { meta, body } = parseFrontmatter(content);

	let name = stripYamlQuotes(meta.name ?? skillName);
	let description = stripYamlQuotes(meta.description ?? '');

	if (!description) {
		const headingMatch = body.match(/^#\s+(.+)$/m);
		if (headingMatch) {
			description = headingMatch[1].trim();
		} else {
			const line = body.split(/\r?\n/).find(l => l.trim());
			description = line?.trim() ?? skillName;
		}
	}

	return { name, description };
}

/**
 * List skills under skillsRoot (one level deep, directories holding a SKILL.md)
 * whose description exceeds SKILL_DESCRIPTION_MAX_LENGTH.
 *
 * Returns [{ skill, length }]
 */
export function findOverlongSkillDescriptions(skillsRoot, maxLength = SKILL_DESCRIPTION_MAX_LENGTH) {
	if (!fs.existsSync(skillsRoot)) return [];
	const overlong = [];
	for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md'))) continue;
		const { description } = parseSkillFrontmatter(skillsRoot, entry.name);
		if (description.length > maxLength) overlong.push({ skill: entry.name, length: description.length });
	}
	return overlong;
}

/**
 * Build a platform discovery stub SKILL.md that points at canonical skills/<name>/SKILL.md.
 */
export function buildSkillStub(skillName, skillsRoot, { canonicalPrefix = 'skills' } = {}) {
	const { name, description } = parseSkillFrontmatter(skillsRoot, skillName);
	const canonicalPath = `${canonicalPrefix}/${skillName}/SKILL.md`;
	const assetPrefix = `${canonicalPrefix}/${skillName}/`;

	return `---
name: ${name}
description: ${yamlDoubleQuoted(description)}
---

Read and follow \`${canonicalPath}\` (canonical). Resolve scripts and assets relative to \`${assetPrefix}\`. This stub exists for platform skill discovery only.
`;
}

const STUB_MARKER = 'This stub exists for platform skill discovery only.';

/**
 * Remove stub directories under outputSkillsRoot that are not in keepNames.
 * Only directories whose SKILL.md carries the stub marker are touched, so a
 * hand-authored skill in an adapter dir is never removed.
 */
function removeStaleStubs(outputSkillsRoot, keepNames) {
	if (!fs.existsSync(outputSkillsRoot)) return;
	const keep = new Set(keepNames);
	for (const entry of fs.readdirSync(outputSkillsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || keep.has(entry.name)) continue;
		const skillFile = path.join(outputSkillsRoot, entry.name, 'SKILL.md');
		if (!fs.existsSync(skillFile)) continue;
		if (fs.readFileSync(skillFile, 'utf-8').includes(STUB_MARKER)) {
			fs.rmSync(path.join(outputSkillsRoot, entry.name), { recursive: true, force: true });
		}
	}
}

/**
 * Write stub SKILL.md files for the given skill names under outputSkillsRoot.
 * With pruneStale, stubs from an earlier deploy that are not in skillNames are removed;
 * leave it off when several callers (one per profile) share one output dir.
 *
 * Returns { copied: string[], missing: string[] }
 */
export function writeSkillStubs({ skillsRoot, outputSkillsRoot, skillNames, canonicalPrefix = 'skills', pruneStale = false }) {
	const copied = [];
	const missing = [];
	const writtenFiles = [];

	fs.mkdirSync(outputSkillsRoot, { recursive: true });
	if (pruneStale) removeStaleStubs(outputSkillsRoot, skillNames);

	for (const skillName of skillNames) {
		const src = path.join(skillsRoot, skillName);
		if (!fs.existsSync(src)) {
			missing.push(skillName);
			continue;
		}

		const destDir = path.join(outputSkillsRoot, skillName);
		if (fs.existsSync(destDir)) {
			fs.rmSync(destDir, { recursive: true, force: true });
		}
		fs.mkdirSync(destDir, { recursive: true });
		const stub = buildSkillStub(skillName, skillsRoot, { canonicalPrefix });
		const destPath = path.join(destDir, 'SKILL.md');
		fs.writeFileSync(destPath, stub, 'utf-8');
		addWrittenFile(writtenFiles, destPath);
		copied.push(skillName);
	}

	return { copied, missing, writtenFiles };
}

/**
 * Copy only the declared skills from skillsRoot to outputSkillsRoot.
 * Skills not in the declaredSkills list are never copied.
 *
 * Returns { copied: string[], missing: string[] }
 *   copied  — skill names that were successfully copied
 *   missing — skill names declared in the manifest but not found in skillsRoot
 */
export function copyDeclaredSkills(skillsRoot, outputSkillsRoot, declaredSkills) {
	const copied = [];
	const missing = [];
	const writtenFiles = [];

	for (const skillName of declaredSkills) {
		const src = path.join(skillsRoot, skillName);
		if (!fs.existsSync(src)) {
			missing.push(skillName);
			continue;
		}
		const dest = path.join(outputSkillsRoot, skillName);
		addWrittenFiles(writtenFiles, copyDirTracked(src, dest));
		copied.push(skillName);
	}

	return { copied, missing, writtenFiles };
}
