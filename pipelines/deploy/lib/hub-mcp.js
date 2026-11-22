/**
 * hub-mcp.js — the hub's `.mcp.json` as a setup-owned file, the same pattern
 * `.claude/settings.json` uses (lib/hub-settings.js).
 *
 * `.mcp.json` is machine-specific (setup adds the qmd entry with a per-hub
 * port) and is in the hub .gitignore, so a release tier branch does not track
 * it. The package ships the deploy-composed file as a tracked template,
 * `pipelines/deploy/templates/hub-mcp.json`, written by packageHub() from the
 * fresh deploy output. Deploy stays the single definition of the contents;
 * nothing here names a server.
 *
 * Setup calls ensureHubMcpJson() before the qmd registration merge: it creates
 * the file from the template when missing, and otherwise syncs only the
 * template's servers into it (lib/mcp-managed-servers.js); operator-added
 * servers and other top-level keys stay.
 *
 * An existing entry keeps its `env` values (an operator's custom
 * OBSIDIAN_BASE_URL port, the API key reference) while command, args and any
 * other non-env field are refreshed from the template. The Local REST API
 * plugin's own port (vault data.json) is what Obsidian listens on, so when
 * the obsidian entry's URL disagrees with it, the URL is made to agree.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	syncManagedMcpServers,
	reportMcpServerChanges,
} from './mcp-managed-servers.js';

// The Local REST API plugin data file (the vault tiers' credentials module
// keeps the same path); not imported from it, as that module is not shipped
// to the free tiers and this one is.
const REST_API_DATA_JSON = path.join(
	'vault',
	'.obsidian',
	'plugins',
	'obsidian-local-rest-api',
	'data.json',
);

export const HUB_MCP_TEMPLATE_REL = [
	'pipelines',
	'deploy',
	'templates',
	'hub-mcp.json',
];

export function hubMcpTemplatePath(hubRoot) {
	return path.join(hubRoot, ...HUB_MCP_TEMPLATE_REL);
}

function isObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The URL with its port set to the plugin's port for that scheme (https ->
 * `port`, http -> `insecurePort`), or null when it already matches or the
 * URL / plugin data cannot be compared.
 */
function urlWithPluginPort(url, pluginData) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const secure = parsed.protocol === 'https:';
	if (!secure && parsed.protocol !== 'http:') return null;
	const wanted = secure ? pluginData?.port : pluginData?.insecurePort;
	if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) return null;
	const current = Number(parsed.port || (secure ? 443 : 80));
	if (current === wanted) return null;
	const pathPart = parsed.pathname === '/' ? '' : parsed.pathname;
	return {
		from: current,
		to: wanted,
		url: `${parsed.protocol}//${parsed.hostname}:${wanted}${pathPart}${parsed.search}`,
	};
}

/**
 * Make the obsidian entry's OBSIDIAN_BASE_URL port agree with the Local REST
 * API plugin's data.json. Nothing is read or printed beyond the two ports.
 *
 * @returns {{ mcpServers: object, change: {from: number, to: number}|null }}
 */
function reconcileObsidianPort(mcpServers, hubRoot, fsMod) {
	const current = mcpServers.obsidian?.env?.OBSIDIAN_BASE_URL;
	const dataPath = path.join(hubRoot, REST_API_DATA_JSON);
	if (typeof current !== 'string' || !fsMod.existsSync(dataPath)) {
		return { mcpServers, change: null };
	}
	let pluginData;
	try {
		pluginData = JSON.parse(fsMod.readFileSync(dataPath, 'utf-8'));
	} catch {
		return { mcpServers, change: null };
	}
	const fix = urlWithPluginPort(current, pluginData);
	if (!fix) return { mcpServers, change: null };
	const obsidian = mcpServers.obsidian;
	return {
		mcpServers: {
			...mcpServers,
			obsidian: {
				...obsidian,
				env: { ...obsidian.env, OBSIDIAN_BASE_URL: fix.url },
			},
		},
		change: { from: fix.from, to: fix.to },
	};
}

/**
 * Write the template from a deploy-composed `.mcp.json` (packaging only).
 *
 * @param {string} stagingDir
 * @param {object} [fsMod]
 * @returns {{ written: boolean, templatePath: string }}
 */
export function writeHubMcpTemplate(stagingDir, fsMod = fs) {
	const source = path.join(stagingDir, '.mcp.json');
	const templatePath = hubMcpTemplatePath(stagingDir);
	if (!fsMod.existsSync(source)) return { written: false, templatePath };
	fsMod.mkdirSync(path.dirname(templatePath), { recursive: true });
	fsMod.writeFileSync(templatePath, fsMod.readFileSync(source, 'utf-8'));
	return { written: true, templatePath };
}

/**
 * Create or complete the hub's `.mcp.json` from the shipped template (setup).
 * An unreadable or wrong-shaped file is left untouched. Writes only when the
 * content changes, so a second run is a no-op.
 *
 * @param {object} opts
 * @param {string} opts.hubRoot
 * @param {object} [opts.fsMod]
 * @param {function} [opts.log]
 * @returns {{status: 'created'|'updated'|'unchanged'|'no-template'|'unusable', mcpPath: string, reason?: string}}
 */
export function ensureHubMcpJson({ hubRoot, fsMod = fs, log = () => {} }) {
	const mcpPath = path.join(hubRoot, '.mcp.json');
	const templatePath = hubMcpTemplatePath(hubRoot);
	if (!fsMod.existsSync(templatePath)) {
		return { status: 'no-template', mcpPath };
	}
	let template;
	try {
		template = JSON.parse(fsMod.readFileSync(templatePath, 'utf-8'));
	} catch (error) {
		return {
			status: 'unusable',
			mcpPath,
			reason: `template is not valid JSON: ${error.message}`,
		};
	}
	const templateServers = isObject(template?.mcpServers)
		? template.mcpServers
		: {};

	if (!fsMod.existsSync(mcpPath)) {
		fsMod.writeFileSync(
			mcpPath,
			JSON.stringify(template, null, '\t') + '\n',
			'utf-8',
		);
		return { status: 'created', mcpPath };
	}

	const raw = fsMod.readFileSync(mcpPath, 'utf-8');
	let existing;
	try {
		existing = JSON.parse(raw);
	} catch (error) {
		return { status: 'unusable', mcpPath, reason: error.message };
	}
	if (
		!isObject(existing) ||
		(existing.mcpServers !== undefined && !isObject(existing.mcpServers))
	) {
		return {
			status: 'unusable',
			mcpPath,
			reason: 'root and mcpServers must be JSON objects',
		};
	}
	const synced = syncManagedMcpServers(
		existing.mcpServers ?? {},
		templateServers,
		{ keepEnv: true },
	);
	const { changed } = synced;
	const { mcpServers, change: portChange } = reconcileObsidianPort(
		synced.mcpServers,
		hubRoot,
		fsMod,
	);
	if (changed.length === 0 && !portChange) {
		return { status: 'unchanged', mcpPath };
	}
	reportMcpServerChanges(changed, mcpPath, log);
	if (portChange) {
		log(
			`[mcp.json] obsidian OBSIDIAN_BASE_URL port changed from ${portChange.from} to ${portChange.to} to match the Local REST API plugin (${REST_API_DATA_JSON.split(path.sep).join('/')})`,
		);
	}
	fsMod.writeFileSync(
		mcpPath,
		JSON.stringify({ ...existing, mcpServers }, null, '\t') + '\n',
		'utf-8',
	);
	return { status: 'updated', mcpPath };
}
