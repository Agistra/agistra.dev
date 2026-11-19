/**
 * check-adr-sources.js — ADR source-citation convention check.
 *
 * Scans `Projects/<project>/ADRs/ADR-*.md` and `Workspace/ADRs/ADR-*.md` on a
 * hub using the projects vault layout (see resolveAdrDirs), or the single
 * folder a hub that is not vault-backed keeps its own ADRs in
 * (`docs/decisions/` by default), and reports (does not block — like
 * `ticket-drift.js`, this is not wired into `validate.yml`/CI, only into
 * `npm run check:*` for periodic/manual use) any ADR missing the structured
 * `## Sources` section defined in `documentation-and-adrs` SKILL.md's ADR
 * Structure section.
 *
 * Modeled directly on `pipelines/deploy/lib/ticket-drift.js`'s style: pure,
 * injectable-fs functions plus a thin CLI entry point.
 *
 * Exemptions: a project can exempt the ADRs that predate the `Sources`
 * convention through an optional `adrSources` block in the `package.json`
 * of the folder the check runs in:
 *
 *   "adrSources": { "exempt": [{ "project": "<name>", "belowNumber": <n> }] }
 *
 * ADRs of that project numbered below `belowNumber` are never flagged and
 * never expected to be retrofitted. Without the block nothing is exempt.
 * This mirrors the going-forward pattern already used for the
 * `depends_on`/`touches` frontmatter fields in `ticket-lifecycle-mode`
 * ("Backward compatible — absent on existing task files, which continue to
 * parse normally"). The exemption is a plain ADR number rather than a
 * git-blame/date lookup, keeping the check dependency-free and deterministic.
 *
 * `--report-only` prints the same report but always exits 0: the hubs this
 * file is shipped to run it that way (`npm run check:adr-sources`), because
 * the check reports and never blocks.
 */
import { installCrashReporter } from './error-sources.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	LAYOUT_PROJECTS,
	PROJECTS_ROOT_FOLDER,
	listProjectFolders,
	projectPaths,
	resolveVaultLayoutForHub,
	vaultRootFor,
	workspacePaths,
} from './vault-layout.js';

/**
 * Read the optional `adrSources.exempt` list from `<root>/package.json`.
 * Missing file, missing block or malformed entries give no exemptions.
 *
 * @param {string} root
 * @param {object} [fsMod]
 * @returns {Array<{project: string, belowNumber: number}>}
 */
export function loadExemptions(root, fsMod = fs) {
	let list;
	try {
		list = JSON.parse(
			fsMod.readFileSync(path.join(root, 'package.json'), 'utf-8'),
		)?.adrSources?.exempt;
	} catch {
		return [];
	}
	if (!Array.isArray(list)) return [];
	return list.filter(
		(e) =>
			e &&
			typeof e.project === 'string' &&
			e.project !== '' &&
			Number.isInteger(e.belowNumber),
	);
}

const ADR_FILENAME_PATTERN = /^ADR-(\d+)-.*\.md$/;
// Matches the "## Sources" section heading (the ADR template's convention for
// body-level list sections — same style as "## Assumptions"/"## Consequences",
// not the single-line bold-field style used for the Status/Deciders/Related
// metadata block).
const SOURCES_FIELD_PATTERN = /^## Sources\b/m;

/**
 * Extract the ADR number from a filename like "ADR-7-some-title.md".
 * Returns null if the filename doesn't match the expected ADR naming shape.
 */
export function parseAdrNumber(filename) {
	const match = filename.match(ADR_FILENAME_PATTERN);
	return match ? parseInt(match[1], 10) : null;
}

/**
 * True if the ADR body contains a `## Sources` section heading.
 */
export function hasSourcesField(content) {
	return SOURCES_FIELD_PATTERN.test(content);
}

/**
 * Scan a decisions directory for `ADR-<N>-*.md` files. Returns an array of
 * { file, filePath, number, content }. Files that don't match the ADR
 * filename shape are skipped (not returned).
 */
export function scanAdrFiles(decisionsDir, fsMod = fs) {
	if (!fsMod.existsSync(decisionsDir)) return [];
	const files = fsMod
		.readdirSync(decisionsDir)
		.filter((f) => ADR_FILENAME_PATTERN.test(f));
	const results = [];
	for (const file of files) {
		const number = parseAdrNumber(file);
		if (number === null) continue;
		const filePath = path.join(decisionsDir, file);
		const content = fsMod.readFileSync(filePath, 'utf-8');
		results.push({ file, filePath, number, content });
	}
	return results;
}

/**
 * Detect a missing-Sources finding for a single ADR entry (as returned by
 * scanAdrFiles). Returns a finding description string, or null if the ADR
 * is exempt for its project or already carries the field.
 *
 * @param {object} entry
 * @param {string|null} [project]  project the ADR belongs to, when known
 * @param {Array<{project: string, belowNumber: number}>} [exemptions]
 */
export function detectMissingSources(entry, project = null, exemptions = []) {
	if (
		project !== null &&
		exemptions.some(
			(e) => e.project === project && entry.number < e.belowNumber,
		)
	)
		return null; // going-forward only, exempt by configuration
	if (hasSourcesField(entry.content)) return null;
	return `${entry.file}: missing required "## Sources" section`;
}

/**
 * Where a hub keeps its ADRs. On the projects vault layout: every project's
 * `ADRs/` folder plus the cross-project `Workspace/ADRs/`. Otherwise the
 * single legacy folder (`legacyDir`).
 *
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {string} options.legacyDir  folder to scan when the hub is not on the projects layout
 * @param {object} [options.fsMod]
 * @returns {{ dirs: string[], labelRoot: string|null, dirProjects: Object<string,string> }}
 *   `labelRoot` is the folder findings are reported relative to (null: report
 *   bare file names); `dirProjects` maps a project's ADR folder to its project
 *   name (the legacy and workspace folders have no entry)
 */
export function resolveAdrDirs({ hubRoot, legacyDir, fsMod = fs }) {
	const layout = resolveVaultLayoutForHub(hubRoot, { fsMod });
	if (layout !== LAYOUT_PROJECTS) {
		return { dirs: [legacyDir], labelRoot: null, dirProjects: {} };
	}
	const vaultRoot = vaultRootFor(hubRoot);
	const projects = listProjectFolders(
		path.join(vaultRoot, PROJECTS_ROOT_FOLDER),
		fsMod,
	);
	const dirProjects = {};
	const dirs = projects.map((p) => {
		const dir = projectPaths(hubRoot, layout, p).adrs;
		dirProjects[dir] = p;
		return dir;
	});
	dirs.push(workspacePaths(hubRoot, layout).adrs);
	return { dirs, labelRoot: vaultRoot, dirProjects };
}

/**
 * Run the check across every ADR file in decisionsDir (or in each of
 * decisionsDirs, when given).
 *
 * @param {object} options
 * @param {string} [options.decisionsDir]
 * @param {string[]} [options.decisionsDirs]
 * @param {string|null} [options.labelRoot]  report files relative to this folder
 * @param {Object<string,string>} [options.dirProjects]  folder -> project name
 * @param {Array<{project: string, belowNumber: number}>} [options.exemptions]
 * @param {object} [options.fsMod]
 * @returns {Array<{file:string, description:string}>}
 */
export function runCheck({
	decisionsDir,
	decisionsDirs,
	labelRoot = null,
	dirProjects = {},
	exemptions = [],
	fsMod = fs,
}) {
	const dirs = decisionsDirs ?? [decisionsDir];
	const findings = [];
	for (const dir of dirs) {
		for (const entry of scanAdrFiles(dir, fsMod)) {
			const description = detectMissingSources(
				entry,
				dirProjects[dir] ?? null,
				exemptions,
			);
			if (description) {
				const label = labelRoot
					? path.relative(labelRoot, entry.filePath).split(path.sep).join('/')
					: entry.file;
				findings.push({
					file: label,
					description: labelRoot
						? description.replace(entry.file, label)
						: description,
				});
			}
		}
	}
	return findings;
}

export function computeExitCode(findings) {
	return findings.length > 0 ? 1 : 0;
}

export function formatReport(findings) {
	if (findings.length === 0) {
		return 'No ADRs missing the required Sources field.\n';
	}
	const lines = [
		`Found ${findings.length} ADR(s) missing the required Sources field:`,
		'',
	];
	for (const f of findings) {
		lines.push(`  - ${f.description}`);
	}
	return lines.join('\n') + '\n';
}

/** Folder a hub that is not vault-backed keeps its own ADRs in. */
export const DEFAULT_DECISIONS_DIR = 'docs/decisions';

// ── CLI entry point ────────────────────────────────────────────────────────────

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	installCrashReporter({ source: 'npm-run' });
	const flagIdx = process.argv.indexOf('--decisions-dir');
	const decisionsDir =
		flagIdx !== -1
			? path.resolve(process.argv[flagIdx + 1])
			: path.resolve(process.cwd(), DEFAULT_DECISIONS_DIR);

	// An explicit --decisions-dir always wins; otherwise a hub on the projects
	// vault layout is scanned in its per-project and workspace ADR folders.
	const { dirs, labelRoot, dirProjects } =
		flagIdx !== -1
			? { dirs: [decisionsDir], labelRoot: null, dirProjects: {} }
			: resolveAdrDirs({ hubRoot: process.cwd(), legacyDir: decisionsDir });
	const findings = runCheck({
		decisionsDirs: dirs,
		labelRoot,
		dirProjects,
		exemptions: loadExemptions(process.cwd()),
	});
	process.stdout.write(formatReport(findings));
	process.exit(
		process.argv.includes('--report-only') ? 0 : computeExitCode(findings),
	);
}
