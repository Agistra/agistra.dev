---
name: dreaming
description: "Use when: Good night Team, EOD, Wrapping up, or end-of-day consolidation. Archives session context, promotes durable patterns, and compacts live agent memory files for the next session."
argument-hint: "EOD trigger phrase or agent name for targeted consolidation"
---

# Dreaming

End-of-day archive-and-compact routine. Reviews the current session plus relevant memory touched during the day, promotes durable patterns, writes a dated archive snapshot, then compacts the live repo memory file down to current state for the next session. Runs on demand — triggered by the team lead saying **"Good night Team"** (or variants).

## Trigger

Phrases that activate dreaming: `"Good night Team"`, `"Good night"`, `"Goodnight Team"`, `"Wrapping up"`, `"EOD"`.

Read your agent identity and follow the per-agent delta below after running the shared consolidation steps.

## Consolidation Rules

- Preserve scope. Do not flatten all memories into one file. Session, repo, and user memory remain in their native stores.
- Treat the agent's live memory record (accessed via the active storage plugin using `read-memory(agent)`) as the current-state file for the next session, not as the full historical archive.
- Write a dated archive snapshot via the active storage plugin using `archive-memory(agent, date)` before compacting the live file.
- If the storage plugin's write tool (e.g. `obsidian-mcp-server`) is unavailable, do **not** switch to the free-tier path (`memory/<agent>.md`) — write via a direct file edit to the **same** vault path instead (`vault/Memory/<agent>.md`). This is not a "free-tier fallback" — the vault path never changes, only the write mechanism does.
- Before compacting, run `npm run memory -- ensure <agent>` to scaffold the agent's memory record (with HOT / WARM / COLD headings) and the archive directory if either does not already exist yet. This is a no-op — it never overwrites or truncates an existing file — so it is safe to run unconditionally at the start of every dreaming cycle.
- Session memory may be deleted after it has been captured in the daily checkpoint or promoted elsewhere.
- Repo and user memory compaction is opt-in only. Rewrite or delete entries there only when they are explicitly marked `dreaming-managed` or were created as transient capture for the same dreaming cycle.
- Never clear the full user, session, or repo memory stores wholesale.
- When compacting the live file, keep only current HOT items, explicit carry-forward items, and durable WARM/COLD knowledge. Move fully resolved day-specific detail into the archive snapshot.

## Compaction Decision Table

An entry or item is eligible for retirement to archive (and not carried forward to the live file) when it meets one of these criteria:

| Criterion | Applies To | Decision | Action |
|-----------|-----------|----------|--------|
| **Resolved signal present** | Any section | "done", "✓ CLOSED", "✓ MERGED", "closed", "merged" in entry text | Retire to archive. Summarise outcome (1 line) if exceeding 500 chars. |
| **No open ticket/PR reference** | LAST_EVENT | Entry is older than 7 days AND contains no active GitHub issue, PR, or blocker reference | Move to archive. |
| **LAST_EVENT age cap** | LAST_EVENT | More than 10 entries in LAST_EVENT section | Keep only the 10 most recent; move older to archive. |
| **HOT entry not referenced in 48h** | HOT | Entry not touched/updated in last 48 hours | Move to WARM during EOD consolidation. |
| **WARM entry not referenced in 7d** | WARM | Entry not touched/updated in last 7 days | Move to COLD during EOD consolidation. |
| **Explicit carry-forward marker** | Any section | Entry contains `carry-forward: true` or `EOD-keep` | Keep in live file (overrides age/size rules). |
| **Transient resolved detail** | Any section | Entry explicitly marked `dreaming-managed` AND has been captured in archive | Delete from live file. |

**Size cap rule:** Individual LAST_EVENT entries in the live file are soft-capped at 500 chars. Entries exceeding this during compaction are summarised to a one-liner (date + outcome + ticket reference) in the live file; full detail is archived.

## Shared Consolidation Steps

Every agent runs these steps. Per-agent sections below specify only the variables (which file, what to promote, who to dispatch).

1. **Review session memory** — read the session working buffer if it exists (session context captured during the session by the Working Buffer Protocol in `proactive-agent`; the concrete path is defined in the active storage plugin file).
2. **Review relevant durable memory touched this session** — inspect the live repo memory file plus any user-memory or repo-memory topics updated during the session; skip unrelated memory topics.
3. **Identify promotable patterns, carry-forward items, and compaction candidates** — using the agent's promotion focus and the Compaction Decision Table (above). Apply decay rules explicitly:
   - **HOT → WARM decay:** Items last referenced more than 48 hours ago move to WARM.
   - **WARM → COLD decay:** Items last referenced more than 7 days ago move to COLD.
   - **LAST_EVENT retirement:** Entries older than 7 days with no open ticket/PR/blocker reference go to archive. Cap LAST_EVENT at 10 most recent entries total.
4. **Size audit LAST_EVENT entries** — entries exceeding 500 chars are summarised to a one-liner (date + outcome + ticket ref) in the live file; full detail moves to archive.
5. **Contradiction review pass (best-effort, human-review only)** — before or alongside promoting durable items (next step), review this agent's own recent memory for statements that appear to contradict an existing entry on the same tracked topic (same entity/fact — e.g. a tier's stack description, a port number, a repo path, a capability claim — asserted with a different value in two places).
   - **Scope: own memory only.** Never read another agent's memory record (do not call `read-memory(other-agent)`) or their archive snapshots for this step — the Cascade rule below ("no agent reads or writes another agent's memory during dreaming") applies here too. The review covers this agent's own current HOT section plus its own archive snapshots from roughly the last 7 days (the same window the WARM → COLD decay rule already uses), not its full historical archive — a full-history semantic scan is out of scope and would blow out a nightly pass's cost.
   - **Gather the scan corpus mechanically, judge it yourself.** Run `node pipelines/deploy/lib/dreaming-contradiction-scan.js scan <agent-id> --hub-root <hub root>` to assemble the corpus (own live memory + own recent archive snapshots, scoped to the window above) — this is pure file-gathering, not detection. Its JSON output includes `indexAvailable`: when `true`, a memory-index CLI has shipped into this hub and `node pipelines/deploy/lib/memory-index.js find <keyword>` can additionally be used for cheaper cross-entry lookup within this agent's own entries only (filter any results to `agent === <this agent's own id>` — never act on another agent's indexed entries this way, same isolation rule as above); when `false` (memory-index hasn't shipped in this hub, or hasn't been built yet), the scan-corpus script's own file reads are already the full fallback — no separate action needed.
   - **Deciding whether two statements actually conflict is judgment, not mechanics** — per established best-practice and architectural decision-making protocols. Only flag entries that plausibly assert a different value for the same tracked fact; do not flag a routine update, a correction already reconciled by a later entry, or two entries that merely share a keyword without actually disagreeing.
   - **Write findings, never resolve them.** Record each finding in a new `## Flagged Contradictions` section in this cycle's archive snapshot (see structure below): both conflicting statements (verbatim or a faithful excerpt), their source (tier/section and date), and nothing else. Never edit, delete, or pick a winner between the two entries as part of this step — a human (the team lead) decides which is current. Omit the section entirely from the snapshot when no contradiction is found this cycle.
   - **This is a best-effort net, not a guarantee.** The pass will miss real contradictions — it only catches what a routine read of the scoped window surfaces, depends on the judgment quality of whichever model runs `dreaming`, and does not attempt full-corpus or semantic coverage. Never present this step to a customer as complete or guaranteed contradiction detection.
6. **Promote durable items** — append to the targets listed in the agent's per-agent delta, preserving source labels when helpful.
7. **Write daily archive snapshot** — create or overwrite the archive file at the per-agent path using the structure below. Record before/after line counts in the "Compacted" section.
8. **Compact live memory** — rewrite the live file so it remains a short current-state file:
   - keep active HOT items only (apply 48h decay rule)
   - preserve explicit carry-forward items that still matter tomorrow
   - move durable longer-lived facts into WARM / COLD as appropriate (apply 7d decay rule for WARM → COLD)
   - retire resolved or expired LAST_EVENT entries (apply 7d retirement rule and 10-entry cap)
   - remove resolved day-only detail that is now preserved in the archive snapshot
9. **Compact safe memory only** — delete session memory files whose content has been captured above; optionally trim or rewrite only `dreaming-managed` entries; never clear untouched repo or user memory.
10. **Refresh vault index** (vault-backed hubs only — `dev:sub`, `ops`) — run `npm run vault:index` from the hub root. This is the nightly maintenance pass that keeps the hierarchical index notes current after any task, memory, or document activity during the day. The script is idempotent and deterministic: it adds only links that are not yet present in existing index notes and produces zero writes when nothing has changed. Skip silently on free-tier (`dev`, `dev:graph`) hubs where no `vault/` directory exists. **Interactive/manual trigger only.** This step is a prose instruction to whichever agent is running the trigger by hand and has no execution guarantee on its own — a real incident found it silently skipped or run against a stale on-disk state across several consecutive automated nights (see `nightly-dreaming.js`'s own header comment). For the automated Scheduled Task path specifically, `pipelines/deploy/lib/nightly-dreaming.js`'s `runNightlyDreamingWithLogging()` already invokes the equivalent scan directly in code, unconditionally, after the whole session's `claude -p` subprocess has exited — so that path does not depend on this prose step at all. Still follow this step for every interactive/manual "Good night Team" run, since there is no wrapping process to guarantee it there.
11. **Sweep the Learnings store for threshold-crossing entries and promote** — repo-wide, not agent-scoped (`.learnings/LEARNINGS.md`/`.learnings/ERRORS.md`, or their vault-tier `Research/Learnings/` equivalents, live once at the project root, not per agent — see `agent-foundations/SKILL.md`'s Storage Plugin Contract Learnings store). Read `self-improving-agent/SKILL.md`'s own "Promotion threshold" definition and Promotion table directly rather than restating either here — both may evolve independently of this step, and a copy here would drift.
    - Read pending entries via `list-pending-learnings('LEARNINGS')` and `list-pending-learnings('ERRORS')` — the active storage plugin's operation, not a raw file read. On free tier this resolves to a direct read of `.learnings/LEARNINGS.md`/`.learnings/ERRORS.md`; on vault-backed tiers it resolves to `Research/Learnings/LEARNINGS.md`/`Research/Learnings/ERRORS.md` (see `storage/obsidian.md`) — so this step is correct on every tier without a tier-specific branch here.
    - Sweep the returned entries for ones that meet the promotion threshold defined in `self-improving-agent`'s own "Promotion threshold" section.
    - Promote every entry that crosses the threshold in this same pass — not just flag it for a human to promote later — using `self-improving-agent`'s own Promotion table to pick the correct target (including that table's storage-plugin note for vault-backed tiers).
    - Mark the entry `**Status**: promoted` and add `**Promoted**: <target file>`, per `self-improving-agent`'s own Resolving Entries format — write the update via `write-learning-entry` on vault-backed tiers rather than a raw file edit.
    - Record what was promoted in this cycle's archive snapshot (`## Promoted Memory` → `Learnings:` line below) so it is never a silent side effect.
    - This step is idempotent: an entry already marked `promoted` is not re-swept or re-promoted on a later run, so it is safe for every agent's consolidation pass to run it independently — the same tolerance step 10's vault-index refresh already relies on above.

### Daily Archive Snapshot Structure

```markdown
# <Agent> Archive — YYYY-MM-DD

## Completed Today

- [...]

## Promoted Memory

- Repo: [...]
- User: [...]    <!-- omit if the agent does not promote to user memory -->
- Learnings: [...]    <!-- `.learnings/`/Learnings-store entries promoted this cycle via step 11, with their target file; omit if none crossed the threshold -->

## Flagged Contradictions

<!-- Omit this section entirely when no contradiction was found this cycle. Never auto-resolved — see the Contradiction review pass step above. -->
- Statement A: [...] (source: [tier/section], [date]) vs. Statement B: [...] (source: [tier/section], [date]) — unresolved, needs human review.

## Carry-Forward

- [...]

## Blockers For Team Lead

- [...]

## Compacted

- Before: XXX lines | After: YYY lines (NNN chars removed from LAST_EVENT; M entries archived)
- Entries moved: [date range], ticket refs: [#XX, #YY, ...]
- [...]
```

The "Compacted" section must always report:
- **Line count delta:** "Before: XXX lines | After: YYY lines" (count the full live file before and after compaction).
- **LAST_EVENT delta:** Number of chars removed and number of entries archived.
- **Date range and ticket refs:** Which entries were retired (by date) and which tickets they reference.

---

## Per-Agent Deltas

### Architect

**Live file:** accessed via the active storage plugin using `read-memory('architect')`
**Archive file:** written via the active storage plugin using `archive-memory('architect', date)`

**Promotion focus:** recurring design patterns, confirmed conventions, architectural decisions, corrections from the team lead, unresolved next-day items, transient notes safe to collapse.

**Promotion targets:**

- Session corrections from the team lead → agent memory WARM/COLD tiers via `write-memory-entry('architect', tier, content)` every run
- Cross-project architectural patterns → auto-memory (user-level memory files) when the pattern recurs across 2+ projects
- Dreaming-managed transient captures → compacted in their original memory file after checkpoint (only when explicitly marked)

**Compaction enforcement (Architect):**

- LAST_EVENT: Cap at 10 most recent entries. Retire entries older than 7 days with no open ticket/PR/blocker reference. Summarise entries exceeding 500 chars to one-liner + archive full detail.
- HOT decay: Items not referenced in 48h move to WARM.
- Cross-agent tracking: After reviewing Architect's HOT entries, check whether any HOT entry references a ticket, topic, or capability also tracked as open or handed-off in another agent's memory (using the status contributions collected in the status-report phase). Surface any matches under a 'Cross-agent tracking' note in the EOD report. This check is informational — a visibility signal, not a blocker.
- WARM decay: Items not referenced in 7d move to COLD.
- Archive snapshot must report before/after line counts and compaction delta.
- Contradiction review: scoped to this agent's own memory only (never another agent's file); findings recorded in `## Flagged Contradictions` in the archive snapshot — best-effort, human-review only, never auto-resolved.

**Dispatch behaviour:**

- If Architect receives the trigger directly:
  1. **Status report phase** — invoke Builder, Tester, and Router as subagents simultaneously with the status-contribution prompt: `"EOD status check. Read your memory file and return your status contribution: active tickets, dispatched-but-unreturned work, and any blockers. Bullets only."` Also invoke CAO with the same status-contribution prompt under the same terms *when and only when* CAO's own profile file exists in the hub — probe the adapter-matching path (e.g. `.claude/agents/cao.md` for Claude Code), the same presence-gating pattern the Bootstrap Self-Check section of `agent-foundations` already uses for this identical problem. If the file is absent, skip CAO silently; that is the expected state on hubs that don't ship CAO, not a gap to report. Collect all responses (three, or four when CAO is present).
  2. **Compile and deliver EOD report** — using the status contributions plus Architect's own HOT section, compile a single project-grouped report (per the multi-project output format in `agent-foundations`: group by project, mention the relevant agent owner inside each section). Deliver to the team lead before any consolidation output.
  3. **Consolidation phase** — run shared steps (including decay rules + LAST_EVENT retirement), then invoke Builder, Tester, and Router as subagents simultaneously with the dreaming consolidation prompt: `"End of day consolidation. Run the dreaming skill for [role] workspace."` Also invoke CAO with the same consolidation prompt, presence-gated on the same terms as the status report phase above — skip silently if CAO's profile file is absent. Wait for all invoked agents to acknowledge (three, or four when CAO is present).
  4. Confirm to the team lead: `"Good night. All agents consolidated."`

- If the trigger arrives via subagent dispatch: run shared steps (including decay rules + LAST_EVENT retirement) only, then acknowledge: `"Architect consolidated. Good night."`

### Builder

**Live file:** accessed via the active storage plugin using `read-memory('builder')`
**Archive file:** written via the active storage plugin using `archive-memory('builder', date)`

**Promotion focus:** project conventions, coding patterns, resolved edge cases, corrections from the team lead or Architect, unresolved next-day items, transient notes safe to collapse.

**Promotion targets:**

- Project conventions and verified practices → agent memory WARM/COLD tiers via `write-memory-entry('builder', tier, content)` every run
- Cross-project coding patterns → auto-memory (user-level memory files) when the pattern recurs across 2+ projects
- Dreaming-managed transient captures → compacted in their original memory file after checkpoint (only when explicitly marked)

**Compaction enforcement (Builder):**

- LAST_EVENT: Cap at 10 most recent entries. Retire entries older than 7 days with no open ticket/PR/blocker reference. Summarise entries exceeding 500 chars to one-liner + archive full detail.
- HOT decay: Items not referenced in 48h move to WARM.
- WARM decay: Items not referenced in 7d move to COLD.
- Archive snapshot must report before/after line counts and compaction delta.
- Contradiction review: scoped to this agent's own memory only (never another agent's file); findings recorded in `## Flagged Contradictions` in the archive snapshot — best-effort, human-review only, never auto-resolved.

**Dispatch behaviour:**

- Builder runs end-of-day consolidation when dispatched by Architect as a subagent. Builder does NOT cascade the trigger.
- If dispatched with the **status-contribution prompt**: read the HOT section from the agent's memory record via the active storage plugin using `read-memory('builder')`. Return bullets only — active tickets (branch/ticket reference), dispatched-but-unreturned items, blockers. Do not run consolidation steps; Architect will dispatch again for that separately.
- If dispatched with the **consolidation prompt**: run shared steps (including decay rules + LAST_EVENT retirement). Acknowledge: `"Builder consolidated. Good night."`

### Tester

**Live file:** accessed via the active storage plugin using `read-memory('tester')`
**Archive file:** written via the active storage plugin using `archive-memory('tester', date)`

**Promotion focus:** recurring QA failure patterns, environment gotchas, acceptance criteria that consistently catch regressions, reliable distinguishing tests, blockers, unresolved next-day items, transient notes safe to collapse.

**Promotion targets:**

- Recurring QA failure patterns → agent memory WARM/COLD tiers via `write-memory-entry('tester', tier, content)` every run
- Environment-specific gotchas → agent memory WARM/COLD tiers via `write-memory-entry('tester', tier, content)` every run
- Dreaming-managed transient captures → compacted in their original memory file after checkpoint (only when explicitly marked)

(Tester does not promote to user memory — QA intelligence is project-scoped.)

**Compaction enforcement (Tester):**

- LAST_EVENT: Cap at 10 most recent entries. Retire entries older than 7 days with no open ticket/PR/blocker reference. Summarise entries exceeding 500 chars to one-liner + archive full detail.
- HOT decay: Items not referenced in 48h move to WARM.
- WARM decay: Items not referenced in 7d move to COLD.
- Archive snapshot must report before/after line counts and compaction delta.
- Contradiction review: scoped to this agent's own memory only (never another agent's file); findings recorded in `## Flagged Contradictions` in the archive snapshot — best-effort, human-review only, never auto-resolved.

**Dispatch behaviour:**

- Tester runs end-of-day consolidation when dispatched by Architect as a subagent. Tester does NOT cascade the trigger.
- If dispatched with the **status-contribution prompt**: read the HOT section from the agent's memory record via the active storage plugin using `read-memory('tester')`. Return bullets only — QA queue (tickets in state:ready-for-qa or in-progress), blockers, any outstanding verdicts. Do not run consolidation steps; Architect will dispatch again for that separately.
- If dispatched with the **consolidation prompt**: run shared steps (including decay rules + LAST_EVENT retirement). Acknowledge: `"Tester consolidated. Good night."`

### Router

**Live file:** accessed via the active storage plugin using `read-memory('router')`
**Archive file:** written via the active storage plugin using `archive-memory('router', date)`

**Promotion focus:** stable classification patterns, resolved ambiguous-message types, known escalation triggers and outcomes, unresolved next-day items, transient notes safe to collapse.

**Promotion targets:**

- Stable routing classification patterns → agent memory WARM/COLD tiers via `write-memory-entry('router', tier, content)` every run
- Resolved ambiguous message types → same as above
- Dreaming-managed transient captures → compacted in their original memory file after checkpoint (only when explicitly marked)

(Router does not promote to user memory.)

**Compaction enforcement (Router):**

- LAST_EVENT: Cap at 10 most recent entries. Retire entries older than 7 days with no open ticket/PR/blocker reference. Summarise entries exceeding 500 chars to one-liner + archive full detail.
- HOT decay: Items not referenced in 48h move to WARM.
- WARM decay: Items not referenced in 7d move to COLD.
- Archive snapshot must report before/after line counts and compaction delta.
- Contradiction review: scoped to this agent's own memory only (never another agent's file); findings recorded in `## Flagged Contradictions` in the archive snapshot — best-effort, human-review only, never auto-resolved.

**Dispatch behaviour:**

- Router runs end-of-day consolidation when dispatched by Architect as a subagent. Router does NOT cascade the trigger.
- If dispatched with the **status-contribution prompt**: read the HOT section from the agent's memory record via the active storage plugin using `read-memory('router')`. Return bullets only — any unresolved routing classifications, pending escalations, or relay activity since last session. Do not run consolidation steps; Architect will dispatch again for that separately.
- If dispatched with the **consolidation prompt**: run shared steps (including decay rules + LAST_EVENT retirement). Acknowledge: `"Router consolidated. Good night."`

### CAO

**Live file:** accessed via the active storage plugin using `read-memory('cao')` — see the Memory Path Resolution protocol in `skills/agent-foundations/SKILL.md`.
**Archive file:** written via the active storage plugin using `archive-memory('cao', date)` (the same plugin-resolution rule applies).

**Promotion focus:** stable offer structures, pricing patterns, resolved lead-triage decisions, client relationship notes, unresolved next-day items (open leads, pending call prep, awaited founder approvals), transient notes safe to collapse. CAO does not manage other agents' memory and does not run status-report or consolidation dispatches of its own — it only promotes within its own HOT/WARM/COLD tiers, per its `SOUL.md` memory schema (HOT: current active leads, in-progress offers, upcoming calls; WARM: recently closed deals, completed campaigns, resolved lead triage decisions; COLD: stable offer structures, pricing patterns, client relationship notes).

**Promotion targets:**

- Recently closed deals, completed campaigns, and resolved lead-triage decisions → agent memory WARM/COLD tiers via `write-memory-entry('cao', tier, content)` every run
- Stable offer structures, pricing patterns, and client relationship notes → agent memory COLD tier via `write-memory-entry('cao', 'COLD', content)` every run
- Dreaming-managed transient captures → compacted in their original memory file after checkpoint (only when explicitly marked)

(CAO does not promote to user memory beyond its own role — commercial/strategic intelligence stays scoped to the CAO agent's memory store, mirroring Tester's and Router's "does not promote to user memory" convention above.)

**Compaction enforcement (CAO):**

- LAST_EVENT: Cap at 10 most recent entries. Retire entries older than 7 days with no open ticket/PR/blocker reference. Summarise entries exceeding 500 chars to one-liner + archive full detail.
- HOT decay: Items not referenced in 48h move to WARM.
- WARM decay: Items not referenced in 7d move to COLD.
- Archive snapshot must report before/after line counts and compaction delta.
- Contradiction review: scoped to this agent's own memory only (never another agent's file); findings recorded in `## Flagged Contradictions` in the archive snapshot — best-effort, human-review only, never auto-resolved.

**Dispatch behaviour:**

- CAO runs end-of-day consolidation when dispatched by Architect as a subagent, presence-gated as described in Architect's "Dispatch behaviour" above — CAO is only dispatched when its own profile file exists in the hub. CAO does NOT cascade the trigger and does not dispatch Builder, Tester, or Router itself (CAO never dispatches them directly, per its own `ROUTING.md`).
- If dispatched with the **status-contribution prompt**: read the HOT section from the agent's memory record via the active storage plugin using `read-memory('cao')`. Return bullets only — active leads, in-progress offers, upcoming calls, any blockers or pending founder approvals. Do not run consolidation steps; Architect will dispatch again for that separately.
- If dispatched with the **consolidation prompt**: run shared steps (including decay rules + LAST_EVENT retirement). Acknowledge: `"CAO consolidated. Good night."`

This is internal-only. Do not post to GitHub issues, PRs, or any external channel.
