[← README](../../README.md) · [Architect](../ARCHITECT.md)

---

# scan perspectives

Six health lenses the project scanner uses to score your codebase from 0.0–1.0. Architect uses these when reviewing project health — either via `npm run scan` (automated) or manually during an architecture session.

---

## The six perspectives

### SYS — System

Structural and architectural health.

| Dimension | What it measures |
| --- | --- |
| Complexity | 50/50 blend of a line-count heuristic (files exceeding 300 lines) and a real JS/TS dependency-graph fan-out signal (modules importing more than 10 internal dependencies) |
| Cohesion | 50/50 blend of a directory-count heuristic (directories with more than 20 source files) and real dependency-cycle detection over the JS/TS import graph |
| Infrastructure | TypeScript project without `tsconfig.json` = 0; no CI/CD pipeline = 0; both present = 1.0 |

A pure JS/Node dependency-graph engine (no TypeScript compiler API, no native/compiled parser) builds the module-level import graph behind Complexity and Cohesion, and reports fan-in/fan-out coupling and hard cycle detection. JS/TS only; other languages aren't covered yet. Ships to every tier. On tiers where Graphify is available, an already-generated `.graphify/<project>/graphify-out/graph.json` is preferred over the engine's own source scan when present; the engine's own scan is always the fallback when no Graphify graph exists for a project.

**Findings generated:** oversized files (high), high-fan-out modules (medium), overloaded directories (medium), dependency cycles (high or medium depending on count), missing `tsconfig.json` (high), missing CI/CD (medium)

---

### TST — Test

Test surface health.

| Dimension | What it measures |
| --- | --- |
| Coverage | Ratio of test files to source files — target ≥ 50% |
| Test script | Whether `package.json` defines a test script |

**Findings generated:** low test file ratio (high or medium depending on severity), missing test script (high)

---

### USR — User

Documentation and discoverability quality.

| Dimension | What it measures |
| --- | --- |
| README | Presence and length of README.md |
| Package description | Whether `package.json` has a description |
| Changelog | Presence of CHANGELOG.md |

**Findings generated:** missing or thin README (medium), missing package description (low), missing changelog (low)

---

### ANL — Analytics

Delivery and automation health.

| Dimension | What it measures |
| --- | --- |
| CI/CD automation | Presence of GitHub Actions workflows |
| Commit fix rate | Ratio of fix commits to total commits — high fix rate signals instability |
| Uncommitted changes | Presence of uncommitted changes at scan time |

**Findings generated:** no CI automation (medium), high fix-commit rate (medium), uncommitted changes at scan time (low)

---

### DBG — Debug

Code hygiene health.

| Dimension | What it measures |
| --- | --- |
| TODO/FIXME density | Count of TODO and FIXME comments relative to source size |
| console.log hygiene | Count of `console.log` calls in production source paths |

**Findings generated:** high TODO/FIXME density (medium), console.log in production paths (low)

---

### CTX — Context Budget

How much context a deployed agent pays every session before real work starts. Scoped to this repo's own `agents/profiles/<id>-workspace/` authoring layout — pre-composition Markdown source, not any adapter's composed/deployed profile format (Codex composes TOML, for example). A project without this layout has no ctx signal to measure and scores a neutral 1.0.

| Dimension | What it measures |
| --- | --- |
| File size | Lines summed across a workspace's `AGENTS.md`, `IDENTITY.md`, `ROUTING.md`, `SOUL.md`, `TOOLS.md` (`MEMORY.md` excluded — per-session state, not fixed startup cost) |
| Skill count | Number of entries in that workspace's `agent.manifest.json` `skills` array |

**Findings generated:** oversized composed profile (high above 800 lines, medium above 300), high merged-skill count (medium above 8)

---

## Score interpretation

| Range | Meaning |
| --- | --- |
| 0.9–1.0 | Healthy — no immediate action needed |
| 0.7–0.9 | Minor issues — targeted fixes in the next sprint |
| 0.5–0.7 | Significant problems — plan a dedicated pass |
| 0.0–0.5 | Blocking productivity — prioritize before new features |

Scores and trends (▲ up ▼ down → unchanged) are saved to `projects/<project>/health.json` after every scan. Re-running scan skips findings that already have task files.

---

**Carried by:** [Architect](../ARCHITECT.md)
