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
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	syncManagedMcpServers,
	reportMcpServerChanges,
} from './mcp-managed-servers.js';

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
	const { mcpServers, changed } = syncManagedMcpServers(
		existing.mcpServers ?? {},
		templateServers,
	);
	if (changed.length === 0) return { status: 'unchanged', mcpPath };
	reportMcpServerChanges(changed, mcpPath, log);
	fsMod.writeFileSync(
		mcpPath,
		JSON.stringify({ ...existing, mcpServers }, null, '\t') + '\n',
		'utf-8',
	);
	return { status: 'updated', mcpPath };
}
