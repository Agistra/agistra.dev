#!/usr/bin/env node
/**
 * skills-audit.js — deterministic Skills-table counter/classifier.
 *
 * Usage: node tools/skills-audit.js <path-to-own-profile-file>
 *
 * Parses the `## Skills` table a deployed agent profile renders (see
 * pipelines/deploy/lib/compose-claude.js), classifies each row as
 * guaranteed or optional using the exact literal marker string the
 * generator emits for optional rows, checks each referenced skill file's
 * existence on disk (resolved relative to cwd — the calling agent's
 * pinned hub root), and prints one JSON object with counts and any
 * missing skills.
 *
 * This replaces hand-counting/hand-classifying the Skills table during
 * the Bootstrap Self-Check's "Skills catalogue" point — a script does not
 * miscount or fabricate a classification the way an agent transcribing a
 * markdown table by hand can.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The exact literal substring compose-claude.js embeds in an optional
// row's hint cell (compose-claude.js line ~137: `(optional — install via
// \`install-skill ${skillName}\` if needed)`). Matched as an exact
// substring — never a loose match on the word "optional" appearing
// anywhere in the cell.
const OPTIONAL_MARKER = '(optional — install via';

// Matches a single Skills-table row in the exact shape the generator
// emits (compose-claude.js line ~139):
//   | ${skillName} | ${hintCell} | `skills/${skillName}/SKILL.md` |
// The literal `skills/<name>/SKILL.md` third column is what distinguishes
// a real Skills-table row from the table header/separator rows and from
// unrelated tables elsewhere in the same profile (e.g. dispatch-target or
// model-selection tables) — none of those emit that literal path shape.
const ROW_RE =
	/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*`skills\/([^`]+?)\/SKILL\.md`\s*\|\s*$/;

/**
 * Returns the lines of the profile that fall under any `## Skills`
 * heading, up to (but not including) the next `## `-level heading or EOF.
 * Some profiles (e.g. Architect's own hand-authored "skills to load"
 * table under a "Routing" section) reuse the literal heading text "##
 * Skills" for unrelated prose tables — collecting every such section
 * rather than only the first one means the real generator-emitted table
 * further down the file is never silently skipped.
 * @param {string} text
 * @returns {string[]}
 */
export function extractSkillsSection(text) {
	const lines = text.split(/\r\n|\n/);
	const collected = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() !== '## Skills') continue;
		const rest = lines.slice(i + 1);
		const endIdx = rest.findIndex((line) => /^##\s/.test(line));
		collected.push(...(endIdx === -1 ? rest : rest.slice(0, endIdx)));
	}
	return collected;
}

/**
 * @param {string} text — full profile file contents
 * @returns {{ name: string, optional: boolean }[]}
 */
export function parseSkillsTable(text) {
	const sectionLines = extractSkillsSection(text);
	const rows = [];
	for (const line of sectionLines) {
		const match = ROW_RE.exec(line);
		if (!match) continue;
		const [, name, hintCell] = match;
		rows.push({
			name: name.trim(),
			optional: hintCell.includes(OPTIONAL_MARKER),
		});
	}
	return rows;
}

/**
 * @param {string} profilePath
 * @param {object} [options]
 * @param {string} [options.cwd] — resolution root for `skills/<name>/SKILL.md` (defaults to process.cwd())
 * @param {typeof fs} [options.fsMod]
 * @returns {{ agent: string, profilePath: string, counts: { total: number, guaranteed: number, optional: number }, missingGuaranteed: string[], missingOptional: string[] }}
 */
export function auditProfile(
	profilePath,
	{ cwd = process.cwd(), fsMod = fs } = {},
) {
	const text = fsMod.readFileSync(profilePath, 'utf-8');
	const rows = parseSkillsTable(text);

	const missingGuaranteed = [];
	const missingOptional = [];
	let guaranteed = 0;
	let optional = 0;

	for (const row of rows) {
		const skillFile = path.join(cwd, 'skills', row.name, 'SKILL.md');
		const exists = fsMod.existsSync(skillFile);
		if (row.optional) {
			optional += 1;
			if (!exists) missingOptional.push(row.name);
		} else {
			guaranteed += 1;
			if (!exists) missingGuaranteed.push(row.name);
		}
	}

	return {
		agent: path.basename(profilePath, path.extname(profilePath)),
		profilePath,
		counts: { total: rows.length, guaranteed, optional },
		missingGuaranteed,
		missingOptional,
	};
}

function main() {
	const profilePath = process.argv[2];
	if (!profilePath) {
		process.stderr.write(
			'Usage: node tools/skills-audit.js <path-to-own-profile-file>\n',
		);
		process.exit(1);
		return;
	}

	let result;
	try {
		result = auditProfile(profilePath);
	} catch (err) {
		process.stderr.write(
			`skills-audit: failed to read/parse ${profilePath}: ${err.message}\n`,
		);
		process.exit(1);
		return;
	}

	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exit(result.missingGuaranteed.length > 0 ? 1 : 0);
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	main();
}
