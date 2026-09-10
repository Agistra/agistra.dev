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

---

## Architect — Orchestrator

### Rules

- Read-only. No file writes, no git operations, no memory updates.
- Bullet points only. The team lead will ask for detail if needed.
- Dispatch Builder, Tester, and Router as subagents in parallel before compiling the briefing.
- Read the live memory file first. Use only the latest available archive snapshot for additional context on carry-forward items or yesterday's outcomes.
- Do not scan all historical archive files by default.

### Protocol

**Step 1 — Read Architect's memory**

- Read the HOT, WARM, and COLD sections via the active storage plugin using `read-memory('architect')`
- Read the latest available archive snapshot via the active storage plugin if one exists (the concrete path is defined in the active plugin file)
- Prefer the live memory record for current state. Use the archive snapshot only for context on carry-forward items, blockers, and yesterday's outcomes.

**Step 2 — Dispatch subagents**

Run Builder, Tester, and Router as subagents simultaneously with the morning-standup prompt. Also dispatch the coordination agent (CAO) as a subagent with the same morning-standup prompt when and only when CAO's own profile file exists in the hub — probe the adapter-matching path (e.g. `.claude/agents/cao.md` for Claude Code); skip silently if absent. Collect their reports. When dispatching Router, use the fastest/economy-tier model your runtime offers for the dispatch — Router is economy-tier per its manifest. This skill file ships identically to every adapter, so it never asserts one runtime's literal model-selection syntax; see ROUTING.md's "Dispatch Builder" model-selection guidance for how each adapter's own generated instructions resolve this to a concrete identifier.

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

**CAO**
[paste CAO's bullets verbatim if present, or omit this block if CAO is not configured]

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

**Step 1 — Read Builder's memory**

- Read the live memory record via the active storage plugin using `read-memory('builder')` if it exists
- Read the latest available archive snapshot via the active storage plugin if one exists (the concrete path is defined in the active plugin file)
- Prefer the live memory record for current state. Use the archive snapshot only for context on carry-forward items and yesterday's outcomes.

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

**Step 1 — Read Tester's memory**

- Read the live memory record via the active storage plugin using `read-memory('tester')` if it exists
- Read the latest available archive snapshot via the active storage plugin if one exists (the concrete path is defined in the active plugin file)
- Prefer the live memory record for current state. Use the archive snapshot only for context on carry-forward items and yesterday's outcomes.

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

**Step 1 — Read Router's memory**

- Read the live memory record via the active storage plugin using `read-memory('router')` if it exists
- Read the latest available archive snapshot via the active storage plugin if one exists (the concrete path is defined in the active plugin file)
- Prefer the live memory record for current state. Use the archive snapshot only for context on carry-forward items and yesterday's outcomes.

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

---

## CAO — Subagent

### Rules

- Invoked as a subagent by Architect when CAO's own profile file exists in the hub.
- Read-only. No file writes, no git operations, no memory updates.
- Return bullet points only to Architect — do not deliver directly to the team lead.
- If CAO is not configured, this section does not run.

### Protocol

**Step 1 — Read CAO's memory**

- Read the live memory record via the active storage plugin using `read-memory('cao')` if it exists
- Read the latest available archive snapshot via the active storage plugin if one exists (the concrete path is defined in the active plugin file)
- Prefer the live memory record for current state. Use the archive snapshot only for context on carry-forward items and yesterday's outcomes.

**Step 2 — Return brief**

```
**CAO**
- Active: [current active leads, offers, or calls — one line, or "No active work"]
- Yesterday: [one-line outcome summary of lead triage or deals, or "No sessions"]
- Blockers: [pending approvals or founder decisions, or "None"]
```

Three bullets maximum unless there are multiple active items. If nothing to report, return:

```
**CAO**
- Clear. No active work.
```
