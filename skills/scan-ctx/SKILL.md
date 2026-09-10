---
name: scan-ctx
description: "Use when: assessing how much context a deployed agent profile consumes before real work starts."
argument-hint: "Agent id, workspace directory, or project to assess"
---

# Context Budget Perspective (CTX)

Measures the context budget a deployed agent pays every session before real work starts. Assigns a score from 0.0 to 1.0 across two dimensions.

## Scope

This perspective scans this repository's own agent-profile authoring layout — `agents/profiles/<id>-workspace/`. It does not parse or score any composed/deployed profile format: Claude Code and Cursor compose Markdown, Codex composes a per-agent `.toml` file. Measuring the pre-composition Markdown source files is a deliberate scope boundary, not a gap — a project without this repo's own `agents/profiles/` layout has no ctx signal to measure and scores a neutral 1.0 rather than being penalized.

## Dimensions

**File size** — How many lines does an agent's composed profile cost every session?
- Sums line counts across a workspace's fixed set of source files: `AGENTS.md`, `IDENTITY.md`, `ROUTING.md`, `SOUL.md`, `TOOLS.md`. `MEMORY.md` is excluded — memory is per-session state, not fixed startup cost.
- `Score = max(0, min(1, 1 - (lines - 300) / 1500))`
- Under 300 lines = 1.0 (clean); 1,800 lines = 0.0 (at limit)

**Skill count** — How many skills does an agent's manifest merge in?
- Counts entries in `agent.manifest.json`'s `skills` array for that workspace.
- `Score = max(0, min(1, 1 - (skillCount - 5) / 10))`
- 5 or fewer merged skills = 1.0; 15+ = 0.0

## Scoring

```
ctx_score = (file_size + skill_count) / 2
```

When a repo has multiple agent workspaces, each dimension is averaged across all workspaces found under `agents/profiles/`.

Score interpretation:
- 0.9–1.0  Agent profiles are lean — startup cost is low and skill surface is focused
- 0.7–0.9  Some profiles are getting heavy — worth a trim before they compound
- 0.5–0.7  Meaningful context tax on every session — plan a reduction pass
- 0.0–0.5  Startup cost or skill sprawl is likely degrading reliability — prioritise trimming

## Tasks Generated

| Finding | Priority |
|---|---|
| Composed profile > 800 lines | high |
| Composed profile > 300 lines (≤800) | medium |
| Manifest declares > 8 merged skills | medium |

## Out of Scope

- Enforcing context budgets in CI (future work)
- Deciding what to trim from any specific skill or profile — this perspective only measures and surfaces the signal
- Scoring composed/deployed profile formats (Claude Code Markdown output, Cursor Markdown output, Codex TOML output) — only the pre-composition Markdown source is measured

## Agent Analysis Guide

When performing a manual CTX analysis:

1. Sum lines across a workspace's `AGENTS.md`, `IDENTITY.md`, `ROUTING.md`, `SOUL.md`, `TOOLS.md` — flag anything over 300, and treat anything over 800 as high priority
2. Count the `skills` array length in that workspace's `agent.manifest.json` — flag anything over 8
3. Look for repeated incident narratives, overlapping routing/storage instructions, or conditional protocols that could move behind an explicit reference instead of staying in the always-loaded contract
4. Recommend consolidating overlapping skills or narrowing routing for rarely-used ones rather than proposing a full rewrite

Output: a ranked list of oversized profiles or skill-heavy manifests, each with the measured value, the dimension it violates, and a recommended remediation.
