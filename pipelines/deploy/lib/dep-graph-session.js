import fs from 'node:fs';
import path from 'node:path';
import { analyzeDependencyGraph } from './dep-graph.js';

// ── Dependency-graph MCP session ─────────────────────────────────────────────
//
// Session-scoped state wrapping the dep-graph.js engine for the dep-graph MCP
// server: scan(path) runs the engine and remembers the result in-memory for
// the life of this process; baseline() persists that result to a local file
// next to the scanned directory; diff() and check() re-scan and compare
// against the saved baseline. No persistent daemon — one session object per
// spawned MCP server process.

export const BASELINE_FILENAME = '.dep-graph-baseline.json';

// analyzeDependencyGraph() returns Maps (graph, coupling) that are not
// directly JSON-serializable. Convert to a plain, tool-response-safe shape.
// The raw edge-level graph itself is intentionally omitted from the
// tool/baseline payload — cycles + per-module coupling are the two metrics
// this MCP surface exposes; the full edge map is an internal engine detail,
// not part of the session's public contract.
function toJsonSafe(raw) {
	return {
		files: raw.files,
		cycles: raw.cycles,
		coupling: Object.fromEntries(raw.coupling.entries()),
	};
}

function cycleFingerprint(cycle) {
	return [...cycle].sort().join('|');
}

function cycleFingerprints(cycles) {
	return new Set(cycles.map(cycleFingerprint));
}

/**
 * Create a session-scoped dependency-graph session.
 *
 * @param {object} [options]
 * @param {typeof fs} [options.fsMod] Injectable fs module for testing.
 * @returns {{ scan: Function, baseline: Function, diff: Function, check: Function }}
 */
export function createDepGraphSession({ fsMod = fs } = {}) {
	/** @type {{ path: string, result: ReturnType<typeof toJsonSafe> } | null} */
	let current = null;

	function baselinePathFor(scanPath) {
		return path.join(scanPath, BASELINE_FILENAME);
	}

	function readBaseline(scanPath) {
		const src = baselinePathFor(scanPath);
		if (!fsMod.existsSync(src)) return null;
		return JSON.parse(fsMod.readFileSync(src, 'utf-8'));
	}

	function requireScan(toolName) {
		if (!current) {
			throw new Error(
				`${toolName}() requires a prior scan() call in this session`,
			);
		}
	}

	function scan(targetPath) {
		if (!targetPath) {
			throw new Error('scan(path) requires a path argument');
		}
		const resolved = path.resolve(targetPath);
		const result = toJsonSafe(analyzeDependencyGraph(resolved));
		current = { path: resolved, result };
		return { path: resolved, ...result };
	}

	function baseline() {
		requireScan('baseline');
		const dest = baselinePathFor(current.path);
		const payload = {
			path: current.path,
			savedAt: new Date().toISOString(),
			result: current.result,
		};
		fsMod.writeFileSync(
			dest,
			JSON.stringify(payload, null, '\t') + '\n',
			'utf-8',
		);
		return { path: current.path, baselineFile: dest, savedAt: payload.savedAt };
	}

	// Shared by diff() and check(): re-scan the last-scanned path so both
	// tools always compare against the current on-disk state, not a stale
	// in-memory snapshot from an earlier scan() call.
	function rescan() {
		const result = toJsonSafe(analyzeDependencyGraph(current.path));
		current = { path: current.path, result };
		return result;
	}

	function diff() {
		requireScan('diff');
		const rescanned = rescan();
		const saved = readBaseline(current.path);

		if (!saved) {
			return {
				path: current.path,
				baselineFound: false,
				newCycles: [],
				resolvedCycles: [],
			};
		}

		const baselineCycles = cycleFingerprints(saved.result.cycles);
		const currentCycles = cycleFingerprints(rescanned.cycles);

		return {
			path: current.path,
			baselineFound: true,
			baselineSavedAt: saved.savedAt,
			newCycles: rescanned.cycles.filter(
				(c) => !baselineCycles.has(cycleFingerprint(c)),
			),
			resolvedCycles: saved.result.cycles.filter(
				(c) => !currentCycles.has(cycleFingerprint(c)),
			),
		};
	}

	// v1 rule (Builder's call per the ticket): fail if any dependency cycle
	// exists now that was not present in the saved baseline. exitCode is
	// included alongside pass/reason so a CI wrapper around this tool call
	// can map the result directly to a process exit code.
	function check() {
		requireScan('check');
		const saved = readBaseline(current.path);
		if (!saved) {
			return {
				pass: false,
				exitCode: 1,
				reason: 'no baseline found — call baseline() before check()',
				newCycles: [],
			};
		}

		const rescanned = rescan();
		const baselineCycles = cycleFingerprints(saved.result.cycles);
		const newCycles = rescanned.cycles.filter(
			(c) => !baselineCycles.has(cycleFingerprint(c)),
		);
		const pass = newCycles.length === 0;

		return {
			pass,
			exitCode: pass ? 0 : 1,
			reason: pass
				? 'no new dependency cycles introduced since baseline'
				: `${newCycles.length} new dependency cycle(s) introduced since baseline`,
			newCycles,
		};
	}

	return { scan, baseline, diff, check };
}
