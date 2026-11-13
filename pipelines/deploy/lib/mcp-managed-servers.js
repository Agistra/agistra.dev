/**
 * mcp-managed-servers.js — sync logic for the `mcpServers` entries a deploy
 * owns outright (currently `agent-browser` and `dep-graph`) inside a hub's
 * `.mcp.json`.
 *
 * These keys are regenerated from this repo's own pinned versions and
 * launch args on every deploy, so an already-present entry for one of them
 * is always overwritten with the current generated value — that is the
 * only way a version bump (e.g. mcp-pins.js's agentBrowser pin) or an
 * argv/launch-shape fix ever reaches a hub that was deployed before the
 * change shipped. Any other `mcpServers` key — one this module was never
 * told about — is a user-added server and is left exactly as found: this
 * module never iterates `mcpServers` itself, it only ever writes the keys
 * it was explicitly given.
 */

/**
 * @param {Record<string, object>} existingServers The hub's current
 *   `.mcp.json` `mcpServers` object (or `{}` for a fresh file).
 * @param {Record<string, object>} managedServers The deploy-managed server
 *   definitions to sync in, keyed by server name.
 * @returns {{ mcpServers: Record<string, object>, changed: Array<{ key: string, from: object|null, to: object }> }}
 *   `mcpServers` is `existingServers` with every `managedServers` key set to
 *   its current generated value; every other existing key is unchanged.
 *   `changed` lists each managed key whose value was added or differed from
 *   what was already there, in `managedServers` order.
 */
export function syncManagedMcpServers(existingServers, managedServers) {
	const mcpServers = { ...existingServers };
	const changed = [];
	for (const [key, value] of Object.entries(managedServers)) {
		const previous = mcpServers[key] ?? null;
		const isSame =
			previous !== null && JSON.stringify(previous) === JSON.stringify(value);
		mcpServers[key] = value;
		if (!isSame) {
			changed.push({ key, from: previous, to: value });
		}
	}
	return { mcpServers, changed };
}

/**
 * Print one line per added/updated managed server so the operator sees what
 * a deploy changed. Mirrors gitignore-retired.js's
 * reportRemovedGitignoreLines and gitattributes-merge.js's
 * reportGitattributesChanges.
 *
 * @param {Array<{ key: string, from: object|null, to: object }>} changed
 * @param {string} mcpJsonPath
 * @param {function} [log]
 */
export function reportMcpServerChanges(
	changed,
	mcpJsonPath,
	log = console.log,
) {
	for (const { key, from } of changed) {
		const action = from === null ? 'added' : 'updated';
		log(`[mcp.json] ${action} "${key}" MCP server entry in ${mcpJsonPath}`);
	}
}
