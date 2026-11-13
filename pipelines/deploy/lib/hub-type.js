/**
 * hub-type.js — the hub tier before `npm run setup` has written
 * workspace.config.json.
 *
 * Release tier branches do not track workspace.config.json (the hub
 * .gitignore excludes it), so a fresh clone has only the packaged sentinel,
 * pipelines/deploy/.hub-config.json, to say which tier it is. Every reader
 * that can run before setup resolves the tier through this module:
 * workspace.config.json's hubType wins when it is set; the sentinel fills the
 * gap otherwise. Dependency-free on purpose, so any lib file can import it.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The tier recorded by the packaging profile, or undefined when the sentinel
 * is absent, unreadable or has no hubType (source checkout, hand-built hub).
 *
 * @param {string} hubRoot
 * @param {object} [fsMod]
 * @returns {string|undefined}
 */
export function readPackagedHubType(hubRoot, fsMod = fs) {
	try {
		const parsed = JSON.parse(
			fsMod.readFileSync(
				path.join(hubRoot, 'pipelines', 'deploy', '.hub-config.json'),
				'utf-8',
			),
		);
		return typeof parsed?.hubType === 'string' && parsed.hubType
			? parsed.hubType
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * hubType from an already-parsed workspace.config.json, else from the
 * sentinel. Never throws.
 *
 * @param {string} hubRoot
 * @param {object|null|undefined} config  parsed workspace.config.json, if any
 * @param {object} [fsMod]
 * @returns {string|undefined}
 */
export function effectiveHubType(hubRoot, config, fsMod = fs) {
	return config?.hubType || readPackagedHubType(hubRoot, fsMod);
}

/**
 * `config` with hubType filled from the sentinel when it has none. A missing
 * config (null) becomes `{ hubType }` when the sentinel names a tier, and stays
 * null otherwise. A config that already has a hubType is returned as is.
 *
 * @param {string} hubRoot
 * @param {object|null|undefined} config
 * @param {object} [fsMod]
 * @returns {object|null}
 */
export function withHubType(hubRoot, config, fsMod = fs) {
	if (config?.hubType) return config;
	const packaged = readPackagedHubType(hubRoot, fsMod);
	if (!packaged) return config ?? null;
	return { ...(config ?? {}), hubType: packaged };
}

/**
 * True when `dir` is a hub root: it has a workspace.config.json, or it is a
 * packaged hub that has not been through setup yet (tier sentinel present).
 *
 * @param {string} dir
 * @param {object} [fsMod]
 * @returns {boolean}
 */
export function isHubRoot(dir, fsMod = fs) {
	return (
		fsMod.existsSync(path.join(dir, 'workspace.config.json')) ||
		readPackagedHubType(dir, fsMod) !== undefined
	);
}
