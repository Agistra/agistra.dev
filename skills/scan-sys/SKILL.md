---
name: scan-sys
description: "Use when: analysing a project's architecture, structure, and infrastructure health from the System perspective."
argument-hint: "Project directory, module, or area to assess"
---

# System Perspective (SYS)

Evaluates the structural and architectural health of a codebase. Assigns a score from 0.0 to 1.0 across three dimensions.

## Dimensions

**Complexity** — Are individual files understandable, and how much surrounding context does a change pull in?
- Blends two signals, 50/50:
  - Line-count heuristic: files exceeding 300 lines are a signal of creeping complexity; each oversized file reduces this half of the score proportionally
  - Real coupling signal: a JS/TS dependency-graph engine computes fan-out (how many internal modules a file imports) per module; modules importing more than 10 internal dependencies reduce this half of the score proportionally

**Cohesion** — Are responsibilities well-grouped, and is the module graph actually acyclic?
- Blends two signals, 50/50:
  - Directory-count heuristic: directories with more than 20 source files have too many concerns; each overloaded directory reduces this half of the score proportionally
  - Real cycle-detection signal: the same dependency-graph engine performs hard cycle detection over the JS/TS import graph (DFS with a recursion-stack walk); modules involved in any import cycle reduce this half of the score proportionally — a cycle is a direct, hard signal that two or more modules are not well-separated

**Infrastructure** — Is the project properly configured?
- TypeScript: If no .ts files are present, marked N/A; otherwise tsconfig.json present = 1.0, missing = 0.0
- CI/CD health is assessed by scan-anl; see that skill for pipeline evaluation

### The dependency-graph engine

A pure JS/Node module (`pipelines/deploy/lib/dep-graph.js`, no TypeScript compiler API, no tree-sitter, no native/compiled dependency) parses a project's `.ts`/`.tsx`/`.js`/`.jsx` files with regex-based specifier extraction (`import`/`export ... from`, dynamic `import()`, and `require()`), resolves relative specifiers to files inside the project, and builds a module-level import graph. Bare/package specifiers (e.g. `react`, `node:fs`) are external and excluded from the graph — only project-internal edges count toward cycles and coupling. The engine reports two real metrics per scan: dependency cycles (with the modules involved) and fan-in/fan-out coupling per module. Python and other non-JS/TS languages are not yet covered.

This is a separate implementation from the ticket-dependency-cycle check the task-tracking CLI uses internally — that one walks ticket ids, not code imports, and the two are never conflated.

### Graphify preference (tier-aware)

On tiers where Graphify is available, `scan-sys` checks for an already-generated `.graphify/<project>/graphify-out/graph.json` before running its own source scan. Graphify produces a richer, real call/import graph than `dep-graph.js`'s own regex-based extraction; when the file is present and parses as a valid Graphify graph, its `imports_from` edges (file-to-file import relations — distinct from Graphify's symbol-level `imports`/`contains`/`calls` edges) are used to build the same module-level import graph shape, and cycles/coupling are computed from that instead.

Graphify is optional and derived, never canonical — running it is a separate, explicit step (`npm run graph:generate`), and its absence is never an error. When no `graph.json` exists for a project — whether Graphify was never run, or the tier doesn't ship Graphify at all — `scan-sys` falls back to `dep-graph.js`'s own source scan unconditionally, on every tier. This preference check happens fresh on every scan; a stale `graph.json` (regenerated less recently than the source it describes) is still preferred over a fresh source scan, since `npm run graph:refresh <project>` is how a project keeps its graph current, not `scan-sys`.

## Scoring

```
sys_score = (complexity + cohesion + infrastructure) / 3
```

Score interpretation:
- 0.9–1.0  Architecture is clean, well-structured, and properly configured
- 0.7–0.9  Minor structural issues — manageable with targeted refactors
- 0.5–0.7  Significant coupling or cohesion problems — plan a structural pass
- 0.0–0.5  Architecture debt is blocking productivity — prioritise before new features

## Tasks Generated

| Finding | Priority |
|---|---|
| Source files > 300 lines (>3 files) | high |
| Source files > 300 lines (≤3 files) | medium |
| Modules with fan-out > 10 internal dependencies | medium |
| Directories > 20 source files | medium |
| Import cycles found (>3 cycles) | high |
| Import cycles found (≤3 cycles) | medium |
| tsconfig.json missing (TS project) | high |

## Agent Analysis Guide

When performing a manual SYS analysis:

1. Count source files per directory — flag any over 20
2. Measure file lengths — flag anything over 300 lines and note the dominant concern
3. Check for tsconfig.json **only if .ts files are present**; verify `strict: true` is set; mark TypeScript N/A if no .ts files found
4. Look for real circular imports (the dependency-graph engine detects these automatically for JS/TS; for other languages, trace import statements manually) and cross-layer dependencies (service importing from controller, etc.)
5. Look for modules with unusually high fan-out — importing many internal dependencies is itself a complexity signal, independent of line count
6. Identify God objects — single classes or modules that do too many things

Output: a ranked list of structural issues, each with the file or directory, the dimension it violates, and a recommended remediation.
