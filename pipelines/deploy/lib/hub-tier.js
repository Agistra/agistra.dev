/**
 * Packaged hub tier: the .hub-config.json sentinel and the reconciliation of it
 * against a stored hubType.
 *
 * Lives in lib/ rather than setup.js because lib modules (source-tier.js,
 * bootstrap.js) need it, and setup.js imports the tier plugins that import those
 * modules. A lib module importing setup.js back would leave setup.js's own
 * startup waiting on an import that cannot finish.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineQuestion } from './setup-questions.js';

const DEPLOY_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

export function hubTypeQuestion(packagedHubType) {
	return defineQuestion({
		id: 'correct_hub_type',
		prompt: `Correct hubType to the packaged value ("${packagedHubType}")?`,
		type: 'yes/no',
		default: true,
	});
}

/**
 * Read the static hub-type config file injected into the archive by the packaging
 * profile (e.g. package-dev-graph.js → pipelines/deploy/.hub-config.json).
 * Returns the parsed object, or null if absent or unparseable.
 *
 * Used by setup.js to determine the hub tier on first run (before
 * workspace.config.json exists and prev.hubType is set).
 *
 * @param {string} [deployDir]  Directory containing .hub-config.json (defaults to pipelines/deploy).
 * @returns {{ hubType?: string }|null}
 */
export function readHubConfig(deployDir = DEPLOY_DIR) {
	const p = path.join(deployDir, '.hub-config.json');
	if (!fs.existsSync(p)) return null;
	try {
		return JSON.parse(fs.readFileSync(p, 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * Resolve the hubType to write into workspace.config.json, reconciling a
 * previously-stored hubType (from an existing workspace.config.json) against
 * the packaged tier sentinel (.hub-config.json, read via readHubConfig()).
 *
 * A stored hubType is trusted as-is when there is nothing to compare it
 * against (no packaged sentinel — e.g. a "dev" hub) or when it agrees with
 * the packaged value (the common no-op rerun case — no prompt, no output).
 * When the two disagree, the customer is warned and asked whether to correct
 * hubType to the packaged value. Neither value is ever silently applied over
 * the other: a stored hubType is never overridden without asking, and a
 * disagreeing packaged value is never ignored without saying so.
 *
 * This reconciliation closes the gap where a stale
 * workspace.config.json — e.g. left over from an earlier "dev" setup run in
 * the same target directory, which a fresh archive's unzip-merge never
 * removes because the archive itself never ships workspace.config.json —
 * silently locked in the wrong tier forever with no way to recover except
 * hand-editing the file.
 *
 * @param {object} deps
 * @param {string|undefined} deps.prevHubType      hubType from an existing workspace.config.json, if any.
 * @param {string|undefined} deps.packagedHubType  hubType from readHubConfig(), if any.
 * @param {function(string, boolean=): Promise<boolean>} deps.askYN
 * @param {function(string): void} deps.warn        Writer for warning lines (e.g. process.stdout.write).
 * @returns {Promise<string>} the resolved hubType to store.
 */
export async function resolveHubType({
	prevHubType,
	packagedHubType,
	askYN,
	warn,
	meta,
}) {
	if (!prevHubType) {
		// First run (or an unparsable/absent previous config) — trust the
		// packaged sentinel if present, else fall back to the free "dev" tier.
		return packagedHubType ?? 'dev';
	}
	if (!packagedHubType || packagedHubType === prevHubType) {
		// No packaged sentinel to compare against, or it agrees with the
		// stored value — nothing to reconcile, no prompt.
		return prevHubType;
	}
	// Mismatch: a stored hubType exists and disagrees with this package's own
	// tier. Never silently let either value win — warn and ask.
	warn(
		`\n  WARNING: stored hub type "${prevHubType}" does not match this package's hub type "${packagedHubType}".\n` +
			'  This can happen if an old workspace.config.json survived from a previous setup in this same directory.\n',
	);
	const question = hubTypeQuestion(packagedHubType);
	const acceptPackaged = await askYN(
		question.prompt,
		question.default,
		meta ?? question,
	);
	if (acceptPackaged) return packagedHubType;
	warn(
		`  Keeping stored hubType "${prevHubType}". Re-run setup later if this was unintentional.\n`,
	);
	return prevHubType;
}
