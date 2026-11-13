/**
 * vault-plugin-config.js — the vault's `.obsidian/community-plugins.json` and
 * `core-plugins.json` as setup-owned files, the same pattern as hub-mcp.js.
 *
 * Obsidian rewrites both files as the user toggles plugins, so release tier
 * branches do not track them (hub.gitignore ignores everything under
 * `vault/.obsidian/` except the shipped plugins' code). packageHub() keeps a
 * copy of each, taken from the deploy output, under
 * `pipelines/deploy/templates/vault-plugin-config/`. Setup creates a missing file
 * from its template. When the file exists, community-plugins.json gets back only
 * REQUIRED_COMMUNITY_PLUGINS, so a plugin the user removed is not re-enabled.
 * core-plugins.json gets the template keys the user lacks. Every other entry the
 * user added or set is kept.
 */

import fs from 'node:fs';
import path from 'node:path';

export const VAULT_PLUGIN_CONFIG_FILES = [
	'community-plugins.json',
	'core-plugins.json',
];

const COMMUNITY_PLUGINS_FILE = 'community-plugins.json';

/**
 * Community plugins that setup re-adds to an existing community-plugins.json.
 * The vault tools need the REST API plugin. The other shipped plugins are
 * enabled only when setup creates the file, so a user's removal of them stands.
 */
export const REQUIRED_COMMUNITY_PLUGINS = ['obsidian-local-rest-api'];

export function vaultPluginConfigTemplateDir(hubRoot) {
	return path.join(
		hubRoot,
		'pipelines',
		'deploy',
		'templates',
		'vault-plugin-config',
	);
}

function isObject(v) {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Copy the deploy-composed files into the template folder (packaging only).
 * @returns {{ written: string[] }}
 */
export function writeVaultPluginConfigTemplates(stagingDir, fsMod = fs) {
	const written = [];
	const outDir = vaultPluginConfigTemplateDir(stagingDir);
	for (const name of VAULT_PLUGIN_CONFIG_FILES) {
		const src = path.join(stagingDir, 'vault', '.obsidian', name);
		if (!fsMod.existsSync(src)) continue;
		fsMod.mkdirSync(outDir, { recursive: true });
		fsMod.writeFileSync(path.join(outDir, name), fsMod.readFileSync(src));
		written.push(name);
	}
	return { written };
}

/**
 * Add each required community plugin the user's list lacks. Every other entry
 * is kept as it is. Returns null when the user's value is not an array (file
 * left as is).
 */
function mergeCommunityPlugins(existing) {
	if (!Array.isArray(existing)) return null;
	const next = [...existing];
	for (const id of REQUIRED_COMMUNITY_PLUGINS) {
		if (!next.includes(id)) next.push(id);
	}
	return next;
}

/**
 * Add the template keys the user's object lacks; a value the user set is kept.
 * Returns null when either side is not an object (file left as is).
 */
function mergeObjectConfig(existing, template) {
	if (isObject(template) && isObject(existing)) {
		return { ...template, ...existing };
	}
	return null;
}

/**
 * Create or complete the vault's two plugin config files (setup).
 *
 * @param {object} opts
 * @param {string} opts.hubRoot
 * @param {object} [opts.fsMod]
 * @returns {Array<{ file: string, status: 'created'|'updated'|'unchanged'|'unusable'|'no-template'|'no-vault' }>}
 */
export function ensureVaultPluginConfig({ hubRoot, fsMod = fs }) {
	const vaultRoot = path.join(hubRoot, 'vault');
	if (!fsMod.existsSync(vaultRoot)) {
		return VAULT_PLUGIN_CONFIG_FILES.map((file) => ({
			file,
			status: 'no-vault',
		}));
	}
	const obsidianDir = path.join(vaultRoot, '.obsidian');
	const results = [];
	for (const file of VAULT_PLUGIN_CONFIG_FILES) {
		const templatePath = path.join(vaultPluginConfigTemplateDir(hubRoot), file);
		if (!fsMod.existsSync(templatePath)) {
			results.push({ file, status: 'no-template' });
			continue;
		}
		const target = path.join(obsidianDir, file);
		const templateRaw = fsMod.readFileSync(templatePath, 'utf-8');
		if (!fsMod.existsSync(target)) {
			fsMod.mkdirSync(obsidianDir, { recursive: true });
			fsMod.writeFileSync(target, templateRaw, 'utf-8');
			results.push({ file, status: 'created' });
			continue;
		}
		let merged;
		try {
			const existing = JSON.parse(fsMod.readFileSync(target, 'utf-8'));
			merged =
				file === COMMUNITY_PLUGINS_FILE
					? mergeCommunityPlugins(existing)
					: mergeObjectConfig(existing, JSON.parse(templateRaw));
		} catch {
			merged = null;
		}
		if (merged === null) {
			results.push({ file, status: 'unusable' });
			continue;
		}
		const content = JSON.stringify(merged, null, 2) + '\n';
		const current = fsMod.readFileSync(target, 'utf-8');
		if (
			content === current ||
			JSON.stringify(merged) === JSON.stringify(JSON.parse(current))
		) {
			results.push({ file, status: 'unchanged' });
			continue;
		}
		fsMod.writeFileSync(target, content, 'utf-8');
		results.push({ file, status: 'updated' });
	}
	return results;
}
