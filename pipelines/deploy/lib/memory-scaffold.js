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
 * True when the agent has a keyed tree even if no entry is in it: a tier
 * folder (hot, warm or cold) or a generated tier index
 * (`<agentId>/<agentId>-hot.md` and its siblings) exists. This is what a
 * migrated agent looks like once every entry has been resolved and swept away.
 * Never throws.
 */
export function hasKeyedTree({ memoryRoot, agentId, fsMod = fs }) {
	return ['hot', 'warm', 'cold'].some((tier) => {
		try {
			if (fsMod.statSync(path.join(memoryRoot, agentId, tier)).isDirectory())
				return true;
		} catch {
			// fall through to the index check
		}
		return fsMod.existsSync(
			path.join(memoryRoot, agentId, `${agentId}-${tier}.md`),
		);
	});
}

/**
 * True when the agent has been migrated to keyed entries: its single note is
 * gone and a keyed tree exists (entries, or only the empty tier folders and
 * generated indexes). A migrated agent must not get a fresh empty single
 * note, or it would look half migrated.
 */
export function isMigratedAgent({ memoryRoot, agentId, fsMod = fs }) {
	if (fsMod.existsSync(path.join(memoryRoot, `${agentId}.md`))) return false;
	return (
		hasKeyedEntries({ memoryRoot, agentId, fsMod }) ||
		hasKeyedTree({ memoryRoot, agentId, fsMod })
	);
}

/**
 * The shape of an agent's memory, the one definition the resolver
 * (tools/resolve-path.js), doctor and self-check share:
 *
 *   single-note  the single note only (or beside an empty keyed tree)
 *   migrated     a keyed tree and no note: entries, or empty tiers and indexes
 *   mixed        the single note beside keyed entries: ambiguous, never written
 *   absent       nothing yet
 */
export function memoryShape({ memoryRoot, agentId, fsMod = fs }) {
	const hasNote = fsMod.existsSync(path.join(memoryRoot, `${agentId}.md`));
	const entries = hasKeyedEntries({ memoryRoot, agentId, fsMod });
	if (hasNote) return entries ? 'mixed' : 'single-note';
	return entries || hasKeyedTree({ memoryRoot, agentId, fsMod })
		? 'migrated'
		: 'absent';
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

/**
 * True when a single memory note holds no content of its own: after the
 * headings, rules and blank lines are removed, nothing is left but `_(placeholder)_`
 * lines. This covers the scaffold starter and the deploy templates under
 * templates/claude-code/memory/, without comparing against either byte for byte.
 */
export function isPlaceholderMemoryNote(content) {
	return content
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== '' && l !== '---' && !/^#{1,6}\s/.test(l))
		.every((l) => /^_\(.*\)_$/.test(l));
}
