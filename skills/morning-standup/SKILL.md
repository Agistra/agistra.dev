---
name: morning-standup
description: "Use when: Good morning Team, start-of-day briefing, or morning status request. Architect orchestrates; Builder, Tester, and Router return their sections as subagents."
argument-hint: "Good morning Team, or agent name for a targeted morning brief"
---

# Morning Standup

Start-of-day briefing routine. Triggered by the team lead saying **"Good morning Team"** (or variants). Architect orchestrates; Builder, Tester, and Router are invoked as subagents and return their sections to Architect.

## Trigger

Phrases: `"Good morning Team"`, `"Good morning"`, `"Morning Team"`.

Read your agent identity and follow the section below that matches.

## Memory reading (every agent)

- Read live memory through the active storage plugin using `read-memory(<agent>)`. For yesterday's outcomes read its WARM view, `read-memory(<agent>, 'warm')`, where the plugin keeps tiers; otherwise the latest archive snapshot (path defined in the plugin file), if one exists.
- Live memory wins for current state; use WARM or the snapshot only for carry-forward items, blockers and yesterday's outcomes.
- Sub-agents never sweep. Any memory command they run takes `--read-only` (or `MEMORY_READONLY=1`), so parallel runs cannot race.

---

## Architect — Orchestrator

### Rules

- Read-only apart from the one sweep in Step 1: no other file writes, git operations or memory updates.
- Bullet points only. The team lead will ask for detail if needed.
- Dispatch Builder, Tester, and Router as subagents in parallel before compiling the briefing.
- Do not scan all historical archive files by default.

### Protocol

**Step 1 — Sweep, then read Architect's memory**

- If the active storage plugin defines `sweep-memory()`, run it once now, before dispatching (it skips itself if it already ran today).
- Read memory per "Memory reading" above, including all tiers the plugin exposes.

**Step 2 — Dispatch subagents**

Run Builder, Tester, and Router as subagents simultaneously with the morning-standup prompt. Collect their reports. When dispatching Router, use the fastest/economy-tier model your runtime offers for the dispatch — Router is economy-tier per its manifest. This skill file ships identically to every adapter, so it never asserts one runtime's literal model-selection syntax; see ROUTING.md's "Dispatch Builder" model-selection guidance for how each adapter's own generated instructions resolve this to a concrete identifier.

**Step 3 — Compile and deliver briefing**

```
Good morning. Team brief for [DATE].

**Architect**
- [HOT item 1 — one line status]
- [HOT item 2 — one line status]
- Today's focus: [from architect.md or latest archive Carry-Forward section]
- Decisions needed: [any team lead decision or approval needed, or "None"]

**Builder**
[paste Builder's bullets verbatim]

**Tester**
[paste Tester's bullets verbatim]

**Router**
[paste Router's bullets verbatim]

**Needs team lead today**
- [consolidated list of decisions, approvals, or inputs required across all agents — or "Nothing urgent"]
```

No closing questions. No narrative. Deliver and stop.

---

## Builder — Subagent

### Rules

- Invoked as a subagent by Architect.
- Read-only. No file writes, no git operations, no memory updates.
- Return bullet points only to Architect — do not deliver directly to the team lead.

### Protocol

**Step 1 — Read Builder's memory** per "Memory reading" above, if it exists.

**Step 2 — Return brief**

```
**Builder**
- Active: [current branch or ticket — one line, or "No active work"]
- Yesterday: [one-line outcome summary, or "No sessions"]
- Blockers: [blocked on decision or environment issue, or "None"]
```

Three bullets maximum unless there are multiple active items. If nothing to report, return:

```
**Builder**
- Clear. No active work.
```

---

## Tester — Subagent

### Rules

- Invoked as a subagent by Architect.
- Read-only. No file writes, no git operations, no memory updates.
- Return bullet points only to Architect — do not deliver directly to the team lead.

### Protocol

**Step 1 — Read Tester's memory** per "Memory reading" above, if it exists.

**Step 2 — Return brief**

```
**Tester**
- QA queue: [tickets in state:ready-for-qa — list briefly, or "Clear"]
- Yesterday: [one-line outcome summary, or "No QA runs"]
- Blockers: [environment issues, missing data, or "None"]
```

Three bullets maximum unless there are multiple queue items. If nothing to report, return:

```
**Tester**
- QA clear. Nothing pending.
```

---

## Router — Subagent

### Rules

- Invoked as a subagent by Architect.
- Read-only. No file writes, no git operations, no memory updates.
- Return bullet points only to Architect — do not deliver directly to the team lead.
- If no remote team is configured, return: `**Router** - Not configured. No relay activity.`

### Protocol

**Step 1 — Read Router's memory** per "Memory reading" above, if it exists.

**Step 2 — Return brief**

```
**Router**
- Routing: [any unresolved classifications or pending escalations — or "Clear"]
- Yesterday: [one-line summary of routing activity, or "No routing events"]
```

Two bullets maximum. If nothing to report, return:

```
**Router**
- Relay clear. Nothing pending.
```
