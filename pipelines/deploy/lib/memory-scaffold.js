/**
 * memory-scaffold.js — shared memory/<agent>.md starter content + create-if-absent write.
 *
 * Used by both deploy-time scaffolding (pipelines/deploy/lib/extras.js's deployExtras) and
 * doctor's auto-fix (pipelines/deploy/doctor.js's checkMemoryFiles) so starter content never
 * drifts between the two call sites.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Starter content for a freshly scaffolded memory/<agent>.md file.
 *
 * @param {string} agentId
 * @returns {string}
 */
export function memoryStarter(agentId) {
	return `# ${agentId} memory\n\n## HOT\n\n_(nothing yet)_\n\n## WARM\n\n## COLD\n`;
}

/**
 * True when the agent has at least one keyed entry file under
 * `<memoryRoot>/<agentId>/hot|warm|cold/`. Never throws: a missing folder, or
 * a filesystem object without `readdirSync`, counts as no entries.
 */
export function hasKeyedEntries({ memoryRoot, agentId, fsMod = fs }) {
	return ['hot', 'warm', 'cold'].some((tier) => {
		try {
			return fsMod
				.readdirSync(path.join(memoryRoot, agentId, tier))
				.some((name) => /\.md$/i.test(name) && !name.startsWith('.'));
		} catch {
			return false;
		}
	});
}

/**
 * True when the agent has been migrated to keyed entries: its single note is
 * gone and entry files exist. A migrated agent must not get a fresh empty
 * single note, or it would look half migrated.
 */
export function isMigratedAgent({ memoryRoot, agentId, fsMod = fs }) {
	if (fsMod.existsSync(path.join(memoryRoot, `${agentId}.md`))) return false;
	return hasKeyedEntries({ memoryRoot, agentId, fsMod });
}

/**
 * Create memory/<agentId>.md under memoryRoot if it does not already exist.
 * Never overwrites an existing file — this is the one invariant call sites rely on.
 * Does nothing for a migrated agent (see isMigratedAgent).
 *
 * @param {object} options
 * @param {string} options.memoryRoot Absolute path to the hub's memory/ directory.
 * @param {string} options.agentId
 * @param {object} [options.fsMod] Injectable fs module for testability.
 * @returns {boolean} true if a file was scaffolded, false if it already existed
 *   or the agent is migrated.
 */
export function scaffoldMemoryFile({ memoryRoot, agentId, fsMod = fs }) {
	const memFile = path.join(memoryRoot, `${agentId}.md`);
	if (fsMod.existsSync(memFile)) return false;
	if (isMigratedAgent({ memoryRoot, agentId, fsMod })) return false;
	fsMod.mkdirSync(memoryRoot, { recursive: true });
	fsMod.writeFileSync(memFile, memoryStarter(agentId), 'utf-8');
	return true;
}
