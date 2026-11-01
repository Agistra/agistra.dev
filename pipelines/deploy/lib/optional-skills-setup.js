import path from 'node:path';
import { loadSkillCatalog, installSkillFromCatalog } from './skill-sources.js';

/**
 * Interactive opt-in installer for every entry in skill-catalog.json — the
 * third-party, presence-gated skills (frontend-design, skill-development,
 * codebase-design) Builder/Architect declare `optional: true` for in every
 * hub tier's own manifest (see docs/product/optional-third-party-skills-PRD.md).
 * Mirrors dev-sub.setup-plugin.js's marketing-skills opt-in shape (one y/n
 * question, default "no", installs the whole catalog on acceptance), but is
 * tier-agnostic — unlike marketing skills, these three are declared in every
 * tier's profiles, not gated to dev:sub.
 *
 * A failed install (network error, 404, unreachable source) for one catalog
 * entry warns and continues to the next entry — it must never abort the rest
 * of setup. Never prompts at all when there is no askYN (a non-interactive
 * run) or the catalog is empty.
 *
 * @param {object} opts
 * @param {string} opts.hubRoot
 * @param {string} opts.catalogPath  Absolute path to skill-catalog.json.
 * @param {function(string, boolean=): Promise<boolean>} [opts.askYN]
 * @param {typeof fetch} [opts.fetchFn]  Injectable fetch, forwarded to installFn.
 * @param {function} [opts.installFn]  Injectable installSkillFromCatalog()
 *   (skill-sources.js), for testing. Receives ({ entry, destRoot, fetchFn }).
 * @param {function(string): void} [opts.log]
 * @returns {Promise<{ installed: string[], errors: {name: string, error: string}[] }>}
 */
export async function offerOptionalSkillsInstall({
	hubRoot,
	catalogPath,
	askYN,
	fetchFn,
	installFn = installSkillFromCatalog,
	log = (s) => process.stdout.write(s),
}) {
	const installed = [];
	const errors = [];
	if (!askYN) return { installed, errors };

	const catalog = loadSkillCatalog(catalogPath);
	if (catalog.length === 0) return { installed, errors };

	const names = catalog.map((entry) => entry.name).join(', ');
	const wantsInstall = await askYN(
		`Install optional skills for Builder/Architect (${names})?`,
		false,
	);
	if (!wantsInstall) return { installed, errors };

	log('  Installing optional skills...\n');
	const destRoot = path.join(hubRoot, 'skills');
	for (const entry of catalog) {
		const result = await installFn({ entry, destRoot, fetchFn });
		if (result.status === 'error') {
			log(`  WARNING: could not install "${entry.name}": ${result.error}\n`);
			errors.push({ name: entry.name, error: result.error });
			continue;
		}
		log(
			`  [install-skill] ${entry.name} → skills/${entry.name} — ${result.status}\n`,
		);
		installed.push(entry.name);
	}
	return { installed, errors };
}
