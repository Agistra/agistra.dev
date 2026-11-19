import fs from 'node:fs';
import path from 'node:path';

/**
 * Where each adapter writes its agent profiles, relative to the hub root, and
 * how a profile file name maps back to an agent id. A hub built for a single
 * adapter has only that adapter's folder, so no one folder is the source of
 * truth: the agent list is the union across every folder that exists.
 */
export const AGENT_PROFILE_LOCATIONS = [
	{ adapter: 'claude-code', dir: ['.claude', 'agents'], suffix: '.md' },
	{ adapter: 'cursor', dir: ['.cursor', 'agents'], suffix: '.md' },
	{ adapter: 'vscode', dir: ['.github', 'agents'], suffix: '.agent.md' },
	{ adapter: 'codex', dir: ['.codex', 'agents'], suffix: '.toml' },
];

/**
 * List the agent ids deployed in one adapter's agents folder.
 *
 * @returns {{ present: boolean, ids: string[] }} present is false when the folder is absent or unreadable
 */
export function listAdapterAgentIds({ hubRoot, location, fsMod = fs }) {
	const dir = path.join(hubRoot, ...location.dir);
	try {
		if (!fsMod.existsSync(dir)) return { present: false, ids: [] };
		const ids = fsMod
			.readdirSync(dir)
			.filter((f) => f.endsWith(location.suffix))
			.map((f) => f.slice(0, -location.suffix.length))
			.filter((id) => id.length > 0);
		return { present: true, ids };
	} catch {
		return { present: false, ids: [] };
	}
}

/**
 * The agent ids deployed in any installed adapter, sorted and de-duplicated.
 * Never hardcoded and never dependent on the source profiles folder, which a
 * deployed hub does not have.
 */
export function discoverAgentIds({ hubRoot, fsMod = fs }) {
	const all = new Set();
	for (const location of AGENT_PROFILE_LOCATIONS) {
		for (const id of listAdapterAgentIds({ hubRoot, location, fsMod }).ids) {
			all.add(id);
		}
	}
	return [...all].sort();
}
