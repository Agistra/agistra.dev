---
name: self-improving-agent
description: "Use when: the agent captures a correction from the team lead, hits an unexpected error, discovers a capability gap, or finds a better practice. Logs to .learnings/ and promotes durable patterns to permanent project memory."
argument-hint: "Correction, unexpected error, capability gap, or recurring pattern to log or promote"
---

# Self-Improving Agent

Adapted from [pskoett/self-improving-agent v3.0.21](https://clawhub.ai/pskoett/self-improving-agent) — MIT License. Defines the mechanics that `agent-foundations`' WAL protocol routes through automatically: the trigger table below, the log formats, and the promotion rules for turning durable learnings into permanent project memory. This is not a skill an agent separately decides to load — WAL's "Learnings routing" step already folds a matching trigger into its mandatory write, the same turn it fires. Going forward, a correction or recurring pattern gets a structured `.learnings/` entry as a matter of course, in the same motion as the agent-memory write, not as an afterthought that depends on remembering to open this file later.

## When to Log

The five trigger types WAL's mandatory write scans for. When one matches, the `.learnings/` entry is written as part of that same write — not a follow-up step to schedule for later.

| Trigger | Where |
| ------- | ----- |
| Command or operation fails unexpectedly | `.learnings/ERRORS.md` |
| the team lead corrects the agent ("No, that's wrong...", "Actually...") | `.learnings/LEARNINGS.md` — category: `correction` |
| the team lead requests a capability that does not exist | `.learnings/FEATURE_REQUESTS.md` |
| The agent's knowledge proves outdated or incorrect | `.learnings/LEARNINGS.md` — category: `knowledge_gap` |
| A better approach is discovered for a recurring task | `.learnings/LEARNINGS.md` — category: `best_practice` |

**Storage-plugin note:** every `.learnings/*.md` path in this skill (the table above,
First-Use Initialisation, Recurring Pattern Detection, Periodic Review) is the free-tier
default. Before writing or reading, check for an active storage plugin file at
`storage/*.md` — the same presence-gated check `agent-foundations`'s Memory Path Resolution
protocol uses for Memory/Task/Document. When one is present, writes route through that
plugin's Learnings-store `write-learning-entry(store, category, content)` operation
(`store` is `LEARNINGS`, `ERRORS`, or `FEATURE_REQUESTS`, matching the three files below)
instead of a literal file write, and reads (Recurring Pattern Detection's search, Periodic
Review's pending count) route through `list-pending-learnings(store)` instead of a raw
`grep`. On free tier (no plugin file present), the literal paths below remain correct as-is.

Also review `.learnings/` before starting a major task or entering a new codebase area — this review step is separate from the WAL-triggered logging above, and still requires the agent to actively open this file.

---

## First-Use Initialisation

Free-tier only — see the Storage-plugin note above; on vault-backed tiers the plugin
provisions `Research/Learnings/` itself, no manual initialisation step applies. Before
logging anything, ensure the `.learnings/` directory exists in the project root. If missing, create:

```
.learnings/LEARNINGS.md
.learnings/ERRORS.md
.learnings/FEATURE_REQUESTS.md
```

Never overwrite existing files.

Do not log secrets, tokens, private keys, environment variables, or raw command output with sensitive data. Prefer short summaries or redacted excerpts.

---

## Log Formats

### Learning Entry — `.learnings/LEARNINGS.md`

```
## [LRN-YYYYMMDD-XXX] category

**Logged**: ISO-8601 timestamp
**Priority**: low | medium | high | critical
**Status**: pending
**Area**: frontend | backend | infra | tests | docs | config

### Summary
One-line description of what was learned

### Details
What happened, what was wrong, what is correct

### Suggested Action
Specific fix or improvement

### Metadata
- Agent: architect | builder | tester | router
- Source: conversation | error | user_feedback
- Related Files: path/to/file.ext
- Tags: tag1, tag2
- See Also: LRN-20250110-001
- Pattern-Key: simplify.dead_code | harden.input_validation (optional)
- Recurrence-Count: 1 (optional)

---
```

### Error Entry — `.learnings/ERRORS.md`

```
## [ERR-YYYYMMDD-XXX] skill_or_command_name

**Logged**: ISO-8601 timestamp
**Priority**: high
**Status**: pending
**Area**: frontend | backend | infra | tests | docs | config

### Summary
Brief description of what failed

### Error
Actual error message or output (redact secrets)

### Context
- Command attempted
- Input or parameters used
- Environment details if relevant

### Suggested Fix
If identifiable, what might resolve this

### Metadata
- Reproducible: yes | no | unknown
- Related Files: path/to/file.ext
- See Also: ERR-20250110-001

---
```

### Feature Request Entry — `.learnings/FEATURE_REQUESTS.md`

```
## [FEAT-YYYYMMDD-XXX] capability_name

**Logged**: ISO-8601 timestamp
**Priority**: medium
**Status**: pending
**Area**: frontend | backend | infra | tests | docs | config

### Requested Capability
What the team lead wanted to do

### User Context
Why it was needed, what problem it solves

### Complexity Estimate
simple | medium | complex

### Suggested Implementation
How this could be built

### Metadata
- Frequency: first_time | recurring
- Related Features: existing_feature_name

---
```

---

## ID Format

`TYPE-YYYYMMDD-XXX` where TYPE is `LRN`, `ERR`, or `FEAT` and XXX is a sequential number or 3-char token.

---

## Resolving Entries

When an issue is fixed, update the entry:

1. Change `**Status**: pending` → `**Status**: resolved`
2. Add after Metadata:

```
### Resolution
- **Resolved**: ISO-8601 timestamp
- **Commit/PR**: abc123 or #42
- **Notes**: Brief description of what was done
```

Other status values: `in_progress`, `wont_fix`, `promoted`.

---

## Promotion to Project Memory

When a learning applies across multiple files or features, or prevents a recurring mistake, promote it.

| Promotion target | What goes there |
| ---------------- | --------------- |
| `memory/<agent>.md` COLD section (or the active storage plugin's memory store on vault-backed tiers — see the storage-plugin note below) | Project facts, conventions, verified practices |
| `AGENTS.md` in the workspace | Workflow improvements, automation rules — applies to Codex and GitHub Copilot environments; for Claude Code the equivalent is `CLAUDE.md` |
| `.cursor/rules/*.mdc` | Workflow improvements, automation rules — Cursor's equivalent mechanism to the `CLAUDE.md`/`AGENTS.md` row above |
| `~/.claude/projects/.../memory/` auto-memory | Cross-project patterns and preferences — Claude-Code-only; there is no equivalent promotion target on Cursor, Codex, or GitHub Copilot |

**Storage-plugin note (`memory/<agent>.md` COLD row):** before promoting to `memory/<agent>.md`, check for an active storage plugin file at `agents/skills/agent-foundations/storage/*.md` — the same presence-gated check `agent-foundations`'s Memory Path Resolution protocol uses. If no plugin file is present, the literal `memory/<agent>.md` path is correct as-is (free-tier default). If a plugin file is present (vault-backed tier, e.g. `dev:sub`/`ops`), the literal repo-relative path is wrong — promote instead via that plugin's `write-memory-entry(agent, 'COLD', content)` operation (see `agent-foundations`'s Memory Path Resolution protocol and the active plugin file, e.g. `storage/obsidian.md`, for the authoritative procedure). Writing to the literal path on a vault-backed tier creates a stray file outside the vault, bypassing the knowledge index.

### Promotion threshold

Promote when `Recurrence-Count >= 3`, seen across at least 2 distinct tasks, within a 30-day window.

After promoting: change `**Status**: pending` → `**Status**: promoted` and add `**Promoted**: <target file>`.

---

## Recurring Pattern Detection

Before logging, search: `grep -r "keyword" .learnings/`

If a match exists, link entries with `See Also` and increment `Recurrence-Count`. Recurring patterns indicate missing documentation, missing automation, or an architectural problem — consider a ticket.

---

## Periodic Review

Review `.learnings/` at natural breakpoints: before a major task, after completing a feature, or weekly during active development.

```bash
# Count pending items
grep -h '\*\*Status\*\*: pending' .learnings/*.md | wc -l

# List high-priority pending
grep -B5 '\*\*Priority\*\*: high' .learnings/*.md | grep "^## \["
```
