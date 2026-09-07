import fs from 'node:fs';
import path from 'node:path';
import { readAgentManifest, normalizeSkillList } from './profiles.js';
import { buildSkillStub } from './skills.js';

/**
 * Normalise line endings and trailing whitespace for comparison.
 * Avoids false positives from CRLF vs LF differences.
 */
export function normalise(str) {
	return str.replace(/\r\n/g, '\n').trimEnd();
}

/**
 * Compare expected content against a file on disk.
 * Returns { match: true } or { match: false, reason: 'missing' | 'drift' }.
 */
export function compareFile(expectedContent, actualPath) {
	if (!fs.existsSync(actualPath)) {
		return { match: false, reason: 'missing' };
	}
	const actual = fs.readFileSync(actualPath, 'utf-8');
	return normalise(expectedContent) === normalise(actual)
		? { match: true }
		: { match: false, reason: 'drift' };
}

/**
 * Recursively compare all files in srcDir against their counterparts in destDir.
 * Returns an array of relative file paths that are missing or differ.
 */
export function diffDirs(srcDir, destDir, relPrefix = '') {
	const driftFiles = [];
	for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
		const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
		const srcPath = path.join(srcDir, entry.name);
		const destPath = path.join(destDir, entry.name);
		if (entry.isDirectory()) {
			if (!fs.existsSync(destPath)) {
				driftFiles.push(`${rel}/ (directory missing)`);
			} else {
				driftFiles.push(...diffDirs(srcPath, destPath, rel));
			}
		} else {
			const srcContent = fs.readFileSync(srcPath, 'utf-8');
			const cmp = compareFile(srcContent, destPath);
			if (!cmp.match) {
				driftFiles.push(`${rel} (${cmp.reason})`);
			}
		}
	}
	return driftFiles;
}

/**
 * Collect the union of all declared, non-optional skills across all profiles that
 * have generateSkills enabled.
 *
 * Skills marked `optional` are deliberately excluded: per the optional-third-party-skills
 * design, this repo's own deploy/validate pipeline never vendors or expects on-disk
 * presence of optional, presence-gated skills. They are fetched by the end user, into
 * their own deployed hub, via the separate `install-skill` command — never via this repo's
 * own skills/ directory or git history.
 */
export function collectAllDeclaredSkills(profileDirs) {
	const all = new Set();
	for (const profileDir of profileDirs) {
		const manifest = readAgentManifest(profileDir);
		if (manifest?.exports?.generateSkills === false) continue;
		for (const s of normalizeSkillList(manifest?.skills)) {
			if (!s.optional) all.add(s.name);
		}
	}
	return [...all].sort();
}

/**
 * Validate that each skill in declaredSkills is present in skillsOut and matches skillsRoot.
 * Returns an array of { skillName, status, driftFiles } objects.
 */
export function validateSkillsDir(declaredSkills, skillsRoot, skillsOut) {
	return declaredSkills.map(skillName => {
		const srcDir = path.join(skillsRoot, skillName);
		const destDir = path.join(skillsOut, skillName);

		if (!fs.existsSync(srcDir)) return { skillName, status: 'src-missing', driftFiles: [] };
		if (!fs.existsSync(destDir)) return { skillName, status: 'missing', driftFiles: [] };

		const driftFiles = diffDirs(srcDir, destDir);
		return { skillName, status: driftFiles.length === 0 ? 'ok' : 'drift', driftFiles };
	});
}

/**
 * Validate platform discovery stubs under outputSkillsRoot.
 * Each stub dir must contain only SKILL.md, match the generated stub content,
 * point at canonical skills/<name>/SKILL.md, and have that canonical file in outputRoot.
 */
export function validateSkillStubs({
	skillsRoot,
	outputRoot,
	outputSkillsRoot,
	skillNames,
	canonicalPrefix = 'skills',
}) {
	return skillNames.map(skillName => {
		const issues = [];
		const srcDir = path.join(skillsRoot, skillName);
		const stubDir = path.join(outputSkillsRoot, skillName);
		const canonicalPath = path.join(outputRoot, canonicalPrefix, skillName, 'SKILL.md');
		const pointer = `${canonicalPrefix}/${skillName}/SKILL.md`;

		if (!fs.existsSync(srcDir)) {
			return { skillName, status: 'src-missing', driftFiles: issues };
		}
		if (!fs.existsSync(stubDir)) {
			return { skillName, status: 'missing', driftFiles: issues };
		}

		if (!fs.existsSync(canonicalPath)) {
			issues.push(`${pointer} (canonical missing in output)`);
		}

		const entries = fs.readdirSync(stubDir);
		const extraFiles = entries.filter(name => name !== 'SKILL.md');
		if (extraFiles.length > 0) {
			issues.push(`extra files in stub dir: ${extraFiles.join(', ')}`);
		}

		const stubPath = path.join(stubDir, 'SKILL.md');
		if (!fs.existsSync(stubPath)) {
			issues.push('SKILL.md missing in stub dir');
		} else {
			const expectedStub = buildSkillStub(skillName, skillsRoot, { canonicalPrefix });
			const actualStub = fs.readFileSync(stubPath, 'utf-8');
			if (normalise(expectedStub) !== normalise(actualStub)) {
				issues.push('stub content drift');
			}
			if (!actualStub.includes(pointer)) {
				issues.push(`stub body missing pointer to ${pointer}`);
			}
		}

		return {
			skillName,
			status: issues.length === 0 ? 'ok' : 'drift',
			driftFiles: issues,
		};
	});
}
