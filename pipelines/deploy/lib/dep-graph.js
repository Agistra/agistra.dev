import fs from 'node:fs';
import path from 'node:path';
import { walkDir } from './scan-utils.js';

// ── JS/TS dependency-graph engine ───────────────────────────────────────────
//
// Pure JS/Node, zero external dependency. Parses a project's JS/TS files with
// regex-based specifier extraction (no TypeScript compiler API, no
// tree-sitter, no native/compiled parser) and builds a module-level import
// graph restricted to files inside the project root. Only relative
// (internal) specifiers become graph edges — bare/package specifiers (e.g.
// `react`, `node:fs`) are external and intentionally excluded, since cycles
// and coupling are project-internal architecture signals.
//
// This is a separate, new implementation from tasks.js's dependency-cycle
// detection, which walks ticket dependency ids, not code import graphs.

// Extensions this engine parses and resolves. JS/TS only (Python support is
// a deferred, later-stage concern).
const IMPORT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

// Fan-out threshold used by perspectives.js to flag high-coupling modules.
// Mirrors the shape of scan-utils.js's MAX_FILE_LINES/MAX_DIR_FILES constants.
export const MAX_FAN_OUT = 10;

// Matches `import ... from '...'`, `import '...'` (side-effect import),
// `import type ... from '...'`, and `export ... from '...'` (re-exports).
// Deliberately excludes dynamic `import(...)` (no whitespace before the
// paren) and `import.meta` (no whitespace before the dot) — both fail the
// required `\s+` after the keyword, so they fall through to the dedicated
// patterns below instead of double-matching here.
const IMPORT_FROM_RE =
	/\b(?:import|export)\s+(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractSpecifiers(source) {
	const specs = new Set();
	for (const re of [IMPORT_FROM_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(source))) specs.add(m[1]);
	}
	return [...specs];
}

function toPosix(relPath) {
	return relPath.split(path.sep).join('/');
}

// Resolves a relative import specifier to a project-relative module path.
// Returns null for bare/package specifiers, unresolved files, or paths that
// escape the project root.
function resolveRelative(spec, fromFile, root) {
	if (!spec.startsWith('.')) return null;

	const basePath = path.resolve(path.dirname(fromFile), spec);
	const candidates = [
		basePath,
		...RESOLVE_EXTS.map((ext) => basePath + ext),
		...RESOLVE_EXTS.map((ext) => path.join(basePath, `index${ext}`)),
	];

	for (const candidate of candidates) {
		try {
			if (fs.statSync(candidate).isFile()) {
				const rel = toPosix(path.relative(root, candidate));
				if (rel.startsWith('..')) return null;
				return rel;
			}
		} catch {
			// candidate doesn't exist — try the next one
		}
	}
	return null;
}

/**
 * Build a module-level import graph for a project.
 * Returns Map<relPath, Set<relPath>> — every JS/TS file under `root` (minus
 * scan-utils.js's IGNORE dirs) is a node, keyed by its POSIX-style path
 * relative to root. Edges are internal (relative-specifier) imports only.
 */
export function buildImportGraph(root) {
	const graph = new Map();
	const files = [];

	walkDir(root, (f) => {
		if (!IMPORT_EXTS.has(path.extname(f))) return;
		const rel = toPosix(path.relative(root, f));
		files.push({ rel, full: f });
		graph.set(rel, new Set());
	});

	for (const { rel, full } of files) {
		let source;
		try {
			source = fs.readFileSync(full, 'utf-8');
		} catch {
			continue;
		}
		for (const spec of extractSpecifiers(source)) {
			const resolved = resolveRelative(spec, full, root);
			if (resolved && resolved !== rel && graph.has(resolved)) {
				graph.get(rel).add(resolved);
			}
		}
	}

	return graph;
}

/**
 * Detect dependency cycles in a module import graph via DFS with a
 * recursion-stack (three-color) walk. Returns an array of cycles, each an
 * array of module paths forming the loop. Cycles that revisit the same set
 * of modules from a different starting node are deduplicated.
 */
export function detectCycles(graph) {
	const WHITE = 0,
		GRAY = 1,
		BLACK = 2;
	const color = new Map([...graph.keys()].map((k) => [k, WHITE]));
	const stack = [];
	const cycles = [];
	const seen = new Set();

	function dfs(node) {
		color.set(node, GRAY);
		stack.push(node);

		for (const neighbor of graph.get(node) || []) {
			if (!graph.has(neighbor)) continue;
			if (color.get(neighbor) === WHITE) {
				dfs(neighbor);
			} else if (color.get(neighbor) === GRAY) {
				const startIdx = stack.indexOf(neighbor);
				const cyclePath = stack.slice(startIdx);
				const key = [...cyclePath].sort().join('|');
				if (!seen.has(key)) {
					seen.add(key);
					cycles.push(cyclePath);
				}
			}
		}

		stack.pop();
		color.set(node, BLACK);
	}

	for (const node of graph.keys()) {
		if (color.get(node) === WHITE) dfs(node);
	}

	return cycles;
}

/**
 * Compute fan-in/fan-out coupling per module.
 * Returns Map<relPath, { fanIn, fanOut }>.
 */
export function computeCoupling(graph) {
	const coupling = new Map();
	for (const node of graph.keys()) coupling.set(node, { fanIn: 0, fanOut: 0 });

	for (const [node, deps] of graph) {
		coupling.get(node).fanOut = deps.size;
		for (const dep of deps) {
			if (coupling.has(dep)) coupling.get(dep).fanIn += 1;
		}
	}

	return coupling;
}

/**
 * Run the full dependency-graph engine against a project root.
 * Returns { files, graph, cycles, coupling }.
 */
export function analyzeDependencyGraph(root) {
	const graph = buildImportGraph(root);
	const cycles = detectCycles(graph);
	const coupling = computeCoupling(graph);
	return { files: [...graph.keys()], graph, cycles, coupling };
}

// ── Graphify graph.json interop ──────────────────────────────────────────────
//
// When a project has already run `graphify extract`/`update`, its
// graphify-out/graph.json is a richer, real call/import graph than this
// engine's own regex-based scan can produce. Schema confirmed by running the
// real Graphify CLI (graphifyy 0.9.20, `graphify extract <path> --out <path>
// --code-only --no-cluster`) against a small fixture with an induced import
// cycle — not assumed from documentation. Top level: { nodes[], edges[],
// hyperedges[], input_tokens, output_tokens }. Each node carries
// { id, label, file_type, source_file, source_location, _origin }; each edge
// carries { source, target, relation, context, confidence, source_file,
// source_location, weight, _origin } (plus confidence_score on "calls"
// edges). `relation: "imports_from"` is the file-to-file import edge type —
// distinct from "imports" (file-to-symbol), "contains" (file-to-symbol), and
// "calls" (symbol-to-symbol) — so it alone reconstructs the same
// module-level import graph buildImportGraph() produces from source, letting
// detectCycles()/computeCoupling() run unchanged against either source.

/**
 * Build a module-level import graph (same Map<relPath, Set<relPath>> shape
 * as buildImportGraph()) from a Graphify-generated graph.json file, using
 * only "imports_from" edges (file-level import relations).
 *
 * Returns null if the file is missing, unreadable, not valid JSON, or does
 * not look like Graphify's schema (no `nodes`/`edges` arrays) — callers
 * should fall back to buildImportGraph()/analyzeDependencyGraph() in that
 * case, never throw.
 */
export function buildGraphFromGraphifyJson(graphJsonPath) {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(graphJsonPath, 'utf-8'));
	} catch {
		return null;
	}
	if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges))
		return null;

	const fileById = new Map();
	for (const node of parsed.nodes) {
		if (
			node &&
			typeof node.id === 'string' &&
			typeof node.source_file === 'string'
		) {
			fileById.set(node.id, toPosix(node.source_file));
		}
	}

	const graph = new Map();
	for (const file of fileById.values()) {
		if (!graph.has(file)) graph.set(file, new Set());
	}

	for (const edge of parsed.edges) {
		if (!edge || edge.relation !== 'imports_from') continue;
		const from = fileById.get(edge.source);
		const to = fileById.get(edge.target);
		if (!from || !to || from === to) continue;
		graph.get(from).add(to);
	}

	return graph;
}

/**
 * Run the dependency-graph engine against a Graphify-generated graph.json
 * file instead of scanning source. Same return shape as
 * analyzeDependencyGraph(): { files, graph, cycles, coupling }. Returns null
 * when the file can't be parsed as Graphify's schema — callers fall back to
 * analyzeDependencyGraph(root).
 */
export function analyzeDependencyGraphFromGraphify(graphJsonPath) {
	const graph = buildGraphFromGraphifyJson(graphJsonPath);
	if (!graph) return null;
	const cycles = detectCycles(graph);
	const coupling = computeCoupling(graph);
	return { files: [...graph.keys()], graph, cycles, coupling };
}
