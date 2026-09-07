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

	if (description.length > 500) {
		description = description.slice(0, 500);
	}

	return { name, description };
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

/**
 * Write stub SKILL.md files for the given skill names under outputSkillsRoot.
 *
 * Returns { copied: string[], missing: string[] }
 */
export function writeSkillStubs({ skillsRoot, outputSkillsRoot, skillNames, canonicalPrefix = 'skills' }) {
	const copied = [];
	const missing = [];
	const writtenFiles = [];

	fs.mkdirSync(outputSkillsRoot, { recursive: true });

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
