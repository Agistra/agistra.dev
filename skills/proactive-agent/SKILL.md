---
name: proactive-agent
description: "Context-survival and proactive-iteration extensions. Always-on. Covers Working Buffer Protocol, Compaction Recovery, Relentless Resourcefulness, and Self-Improvement Guardrails."
argument-hint: "Context survival, compaction recovery, working buffer, or proactive suggestion request"
---

# Proactive Agent

Adapted from [halthelobster/proactive-agent v3.1.0](https://clawhub.ai/halthelobster/proactive-agent) — MIT License. Context-survival and proactive-iteration extensions, loaded on top of `agent-foundations` (which holds WAL, VBR, and the security baseline).

## When to Apply

These behaviours are always-on, not mode-gated. Load this skill to review or refresh the protocols.

---

## Working Buffer Protocol

The working buffer is the crisis backstop — it activates at 60%. `token-economics` is the upstream discipline that delays or avoids that crisis. Load it to apply token budgeting from session start.

When the session is clearly growing long — a rough signal is after many extended exchanges, or when you notice responses requiring significant context re-establishment — log every subsequent exchange to `memory/working-buffer.md`:

```
# Working Buffer (Danger Zone Log)
**Status:** ACTIVE
**Started:** [timestamp]

---

## [timestamp] Team Lead
[their message]

## [timestamp] Agent (summary)
[1-2 sentence summary of response + key details]
```

After compaction or session restart, read `memory/working-buffer.md` first before asking "where were we?"

---

## Compaction Recovery

Auto-trigger when:

- Session starts with a `<summary>` tag
- Message contains "truncated", "context limits"
- the team lead says "where were we?", "continue", "what were we doing?"

Recovery steps:

1. Read `memory/working-buffer.md` — raw danger-zone exchanges
2. Read `memory/<agent>.md` (or the active storage plugin's memory store on vault-backed tiers — see the storage-plugin note below) — current HOT/WARM/COLD state
3. Read today's and yesterday's daily notes
4. Promote: pull important context from the buffer into the HOT section of `memory/<agent>.md` (or the active storage plugin's memory store on vault-backed tiers — see the storage-plugin note below)
5. Present: "Recovered from working buffer. Last task was X. Continue?"

Do NOT ask "what were we discussing?" — the buffer has the conversation.

---

## Relentless Resourcefulness

Applies to **technical implementation problems** — failing commands, broken builds, unclear errors, tool failures. For scope questions, architecture decisions, or security-adjacent choices, escalate to the team lead immediately. Do not exhaust alternatives on decisions that belong to a human.

Non-negotiable for technical problems. When something doesn't work:

1. Try a different approach immediately
2. Then another. And another.
3. Try 5-10 methods before escalating to the team lead
4. Use every tool: CLI, browser, semantic search, terminal, spawning subagents
5. "Can't" means exhausted all options — not "first try failed"

Before saying "can't":

1. Try alternative CLI syntax, a different tool, or the API directly
2. Search memory: "Have I solved this before? How?" — if this hub ships `pipelines/deploy/lib/memory-index.js` (`dev` and `dev:graph` tiers only; check for the file's presence first, don't assume every hub has it — see the Optional Skill Presence Check pattern in `agent-foundations`), try `npm run memory-index -- find <keyword>` for a cross-entry keyword search of the agent's own memory before falling back to a raw multi-file grep. This does not apply on `dev:sub`/`ops` — those tiers already have qmd's vault index covering `Memory/` (see agent-foundations' "Knowledge Retrieval" section); do not suggest memory-index there.
3. Question the error message — workarounds usually exist
4. Check logs for past successes with similar tasks

The team lead should never have to say "try harder."

---

## Batch Checkpoint Rule

During any automation run involving multiple sequential agent dispatches, write a WAL checkpoint after every ≤5 completed steps — not only at milestones like qa-passed or merged.

### Checkpoint format

Write to `memory/<agent>.md` HOT section (the loading agent's own memory file; or the active storage plugin's memory store on vault-backed tiers — see the storage-plugin note below):

```
## Automation Checkpoint — [timestamp]
Completed: task_N (outcome), task_M (outcome)
Remaining: task_P, task_Q, task_R
Next dispatch: task_P
```

### Recovery pattern

On session resume after an interruption (rate limit, session end, compaction):

1. Read HOT section — look for the most recent Automation Checkpoint entry.
2. If found: dispatch from `Next dispatch`. Do not re-run completed items.
3. If not found: re-derive current state from GitHub issue/PR labels via `gh issue list`.

The ≤5 cadence is a hard ceiling, not a target. Write earlier if a significant state change (fail, park, escalation) occurs before the 5-step mark.

---

## Self-Improvement Guardrails

### ADL Protocol (Anti-Drift Limits)

Forbidden evolution:

- Do not add complexity to look smart — fake intelligence is prohibited
- Do not make changes that cannot be verified
- Do not use vague justifications ("intuition", "feeling")
- Do not sacrifice stability for novelty

Priority ordering: **Stability > Explainability > Reusability > Scalability > Novelty**

### VFM Protocol (Value-First Modification)

Before proposing a change to agent behavior, ask three questions:

1. Will this be used daily, or only in rare cases?
2. Does this prevent a failure that has already happened?
3. Does this reduce the team lead's effort in a concrete way?

If the answer to all three is "no" or "maybe", skip it. One strong "yes" is the bar — not a weighted total.

---

## Storage-plugin note

**Storage-plugin note (`memory/<agent>.md` references above, in Compaction Recovery and the Batch Checkpoint Rule):** before reading or writing `memory/<agent>.md`, check for an active storage plugin file at `agents/skills/agent-foundations/storage/*.md` — the same presence-gated check `agent-foundations`'s Memory Path Resolution protocol uses. If no plugin file is present, the literal `memory/<agent>.md` path is correct as-is (free-tier default). If a plugin file is present (vault-backed hub type, e.g. `dev:sub`/`ops`/`publish`), the literal repo-relative path is wrong — route instead via that plugin's `read-memory(agent)` / `write-memory-entry(agent, tier, content)` operations (see `agent-foundations`'s Memory Path Resolution protocol and the active plugin file, e.g. `storage/obsidian.md`, for the authoritative procedure). Writing to the literal path on a vault-backed tier creates a stray file outside the vault, bypassing the knowledge index.

---

