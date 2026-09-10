---
name: task-automation-flow
description: "Use when: 'do work', 'dispatch builder', or team lead triggers automated task implementation. Governs end-to-end flow from dispatch through verification, fail handling, batch mode, and escalation."
argument-hint: "Trigger phrase, ticket reference, verifier type, or fail counter question"
---

# Task Automation Flow

Governs what happens after the team lead approves a ticket for implementation. The trigger is explicit: the team lead says **"do work"** or **"dispatch builder"** after reviewing the task and any linked GitHub issue. From that point the flow runs autonomously until it requires a human decision.

## Trigger Recognition

Load this skill when any of these phrases appear:

- `"do work"`
- `"dispatch builder"`

On trigger: Architect enters automation mode, confirms the verifier field is set on the ticket, then dispatches Builder.

A ticket without a verifier field is underscoped. Do not dispatch — return to the team lead for clarification.

## Verifier

Every ticket has acceptance criteria. Architect specifies the verifier when creating the ticket — in this flow, Architect acts as Technical Lead and is responsible for setting the verifier field at ticket creation, consistent with the Technical Lead role defined in `ticket-lifecycle-mode`. There is no "no QA" — only a question of who verifies.

| Verifier    | When Architect assigns it                           | Flow after Builder completes                                                                                                                                                                                                                                |
| ----------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tester`    | Full functional verification needed                 | Builder marks ticket `state:ready-for-qa` and notifies Architect. Architect dispatches Tester as a direct session — handing main context to Tester when operating in main, or notifying the team lead to start a dedicated Tester session when not in main. |
| `Architect` | Design or structural review sufficient              | Builder notifies Architect who reviews — smaller loop                                                                                                                                                                                                       |
| `Automated` | Build + lint + tests are the full acceptance signal | Builder self-certifies; Architect spot-checks before notifying team lead                                                                                                                                                                                    |

The verifier is recorded in the task file (and mirrored to the tracker record at ticket creation when a tracker is configured) and drives the post-completion branch in the flow.

## Ticket Creation: Tracker Mirror (Mandatory When a Tracker is Configured)

When Architect creates a local task file destined for Builder dispatch, check whether the target repo/project has a tracker configured. If so, create the matching tracker record in the same action as creating the local task file — before dispatch, not as a follow-up.

**"Tracker configured" (plugin-based check):**
1. Resolve the active tracker plugin per the Plugin Resolution Order in `ticket-lifecycle-mode` (check `workspace.config.json` for an explicit `tracker.plugin` declaration; fall back to auto-detection by running detect-configured for each plugin present in `agents/skills/ticket-lifecycle-mode/trackers/`).
2. Run the resolved plugin's detect-configured procedure. If it returns true, a tracker is configured.

The concrete detection steps (e.g. checking for a `github.com` remote and `gh auth status`) are defined by each plugin file, not by this skill — see `agents/skills/ticket-lifecycle-mode/trackers/<plugin-name>.md`.

When a tracker is configured, run the plugin's create-record procedure to open a matching record in the tracker. Record the returned reference in the task file frontmatter using the field name the plugin specifies, before dispatching Builder.

When no tracker is configured or auth is unavailable, create the local task file only and proceed with dispatch; record the reason in the task file if auth was the limiting factor so it can be reconciled later.

**Going-forward rule only:** This step is required for newly created tickets. Pre-existing local-only tickets in the backlog are not required to be back-filled retroactively.

## Mandatory dispatch inclusion: ticket-state ownership

Before dispatching Builder or Tester, include the following paragraph verbatim in the dispatch prompt. This is not optional — it closes the gap where tickets can sit in an inconsistent state (local status and tracker labels out of sync) through an entire dispatch/QA lifecycle without any agent catching it.

> You own transitioning this ticket's state at each lifecycle step: run `npm run task -- transition <id> <new-state>` (see `ticket-lifecycle-mode` State Transition CLI section) instead of manually editing the frontmatter, renaming the file, and calling the tracker plugin as separate steps — the CLI does all three atomically, including the tracker label sync and post-verify when a tracker is configured. Do not leave this for the dispatching agent to reconstruct afterward — transition state yourself as you move through each stage of the flow.

Run `npm run check:tickets` periodically (see `pipelines/deploy/lib/ticket-drift.js`) to catch any drift that slips through regardless.

## Mandatory dispatch inclusion: end-to-end run step for integration-shaped work

For any ticket that wires together two or more components (e.g. a CLI calling a library, a client calling a service, a pipeline step feeding another step), the Builder dispatch prompt must require a concrete end-to-end run — actually invoking the integrated path and observing real output — not just "tests should pass." Unit test green is not sufficient proof that integration work is actually wired up; state the specific command or flow Builder must run and what output confirms success.

## Permission Preflight

Before dispatching any subagent — single or batch — confirm the required tools are permitted in the current session. A subagent that lacks a required tool fails silently; the pipeline produces no output and the failure is invisible until the user inspects.

### Required tool sets

| Agent   | Minimum required tools                                            |
| ------- | ----------------------------------------------------------------- |
| Builder | Read, Edit, Write, Bash, Glob, Grep                               |
| Tester  | Read, Bash, Glob, Grep                                            |
| Router  | Read, Bash, Glob, Grep, mcp__relay__* (when relay is configured) |

### Preflight protocol

Run before every dispatch — both single-agent and batch:

1. Identify required tools for each agent type in the dispatch.
2. Confirm all required tools are permitted in the current session context.
3. If any required tool is blocked: **halt**. Report which tools are missing and surface to the team lead. Do not proceed silently.
4. Log the preflight outcome (pass/fail + blocked tool list if any) before issuing the first dispatch.

The preflight step does not require team lead involvement when all tools pass — it is a guard, not a gate.

## Token Budget Preflight

Before dispatching any subagent against a ticket that carries a `token-budget:` frontmatter value, check recorded spend against budget. Tickets without `token-budget:` set skip this check entirely — no behavior changes for them.

### Pre-dispatch check protocol

1. Sum every line's token count in the ticket's `## Token Spend` section to get current cumulative spend.
2. Estimate the token cost of the dispatch about to run (use the prior dispatch of the same type on this ticket as the estimate when available; otherwise a conservative estimate is acceptable).
3. If `current spend + estimated dispatch cost` would exceed `token-budget:` — **do not dispatch.** Park the ticket and escalate to the team lead instead.
4. If the dispatch is within budget, proceed with dispatch as normal. After the dispatch completes, append the actual reported cost to `## Token Spend` per the convention in `ticket-lifecycle-mode`.

This mirrors the existing 3rd-fail park behavior: the ticket halts, no further agent loop runs unsupervised, and the team lead makes the next call.

### Park-and-escalate on budget exceeded

```
Architect: about to dispatch (e.g. Builder for ticket fix)
  └─> pre-dispatch check: current spend + estimated cost > token-budget
      └─> do not dispatch
          └─> ticket: parked: true
              └─> Architect notifies Team Lead with:
                  - current cumulative spend (from ## Token Spend)
                  - the ticket's token-budget
                  - the dispatch that was about to happen (agent + purpose)
```

The team lead may raise the budget, approve the dispatch anyway, or redirect the ticket. Resume follows the same Parked Task Resumption flow used for fail-counter parking.

### Worked Example

Ticket frontmatter: `token-budget: 30000`. `## Token Spend` starts empty.

**Dispatch 1 (Builder, implementation) — under budget:**

- Current spend: `0`. Estimated cost: `~18000` (no prior dispatch on this ticket, conservative estimate used).
- Check: `0 + 18000 = 18000` ≤ `30000` → dispatch proceeds.
- Builder completes; usage data reports `18400` tokens actually spent.
- Appended to the ticket's `## Token Spend`:

  ```
  - 2026-06-25T14:02:00Z | Builder | dispatch-1 | 18400 tokens | running total: 18400
  ```

**Dispatch 2 (Tester, QA verification) — would exceed budget:**

- Current spend: `18400`. Estimated cost: `~13000` (based on a comparable prior Tester dispatch).
- Check: `18400 + 13000 = 31400` > `30000` → dispatch does **not** proceed.
- Ticket is parked (`parked: true`); no line is appended to `## Token Spend` since the dispatch never ran.
- Architect notifies the team lead: "Ticket parked on token budget — current spend 18400 / budget 30000; the next dispatch (Tester QA verification) was estimated at ~13000 tokens, which would bring total spend to ~31400, exceeding budget. Awaiting direction: raise budget, approve anyway, or redirect."
- Team lead raises `token-budget` to `35000` and approves. Architect updates the frontmatter, dispatches Tester, and the flow resumes. Tester completes; usage data reports `12900` tokens, appended as:

  ```
  - 2026-06-25T15:40:00Z | Tester | dispatch-2 | 12900 tokens | running total: 31300
  ```

## Happy Path

### verifier: Tester

```
Team Lead: "do work" / "dispatch builder"
  └─> Architect dispatches Builder
      └─> Builder: implements ticket
          └─> ticket: state:ready-for-qa
              └─> Builder notifies Architect
                  └─> Architect dispatches Tester (direct session)
                      └─> Tester: all ACs pass → state:qa-passed
                          └─> Tester notifies Architect
                              └─> Architect notifies Team Lead
                                  └─> Team Lead: merges + closes ticket
```

After Tester exits (pass or fail), main context returns to Architect. Builder does not spawn Tester — Architect dispatches Tester as a direct session — handing main context to Tester when operating in main, or notifying the team lead to start a dedicated Tester session when not in main.

### verifier: Architect

```
Team Lead: "do work" / "dispatch builder"
  └─> Architect dispatches Builder
      └─> Builder: implements ticket
          └─> Builder notifies Architect: complete
              └─> Architect reviews ACs
                  ├─ Pass → state:qa-passed
                  │   └─> Architect notifies Team Lead
                  │         └─> Team Lead: merges + closes ticket
                  └─> Fail → Architect gives instructions → Builder fixes → Architect re-reviews
```

### verifier: Automated

```
Team Lead: "do work" / "dispatch builder"
  └─> Architect dispatches Builder
      └─> Builder: implements ticket
          └─> Builder: build + lint + tests pass → self-certifies
              └─> Builder notifies Architect
                  └─> Architect spot-checks → state:qa-passed
                      └─> Architect notifies Team Lead
                            └─> Team Lead: merges + closes ticket
```

## Fail Paths

Fail paths below are written for `verifier: Tester`.

For `verifier: Architect`, Architect acts as the verifier for pass/fail decisions; apply the same fail-counter thresholds and escalation rules, but replace “Tester” actions with “Architect” actions.

For `verifier: Automated`, treat an Architect spot-check FAIL as a verifier fail and apply the same fail-counter thresholds and escalation rules. Automated gate failures (build/lint/test) are handled as normal implementation work by Builder until gates pass (do not advance to `state:ready-for-qa`).

### 1st Fail

Tester fails → ticket transitions to `state:changes-requested`. Label applied: `qa-fail-1`. Per `qa-ticket-workflow`, Tester appends a `## Gap Closure` section to the task file (one entry per failed AC) as part of the FAIL verdict write.

```
Tester: FAIL (1st)
  └─> Tester runs plugin update-record to signal fail-1 on tracker (when configured)
      └─> Tester appends ## Gap Closure section to the task file (per qa-ticket-workflow)
          └─> Tester spawns Builder (sub-agent)
              └─> Builder fixes
                  └─> ticket: state:ready-for-qa
                      └─> Tester re-runs
```

**Re-dispatch prompt requirement:** the Builder re-dispatch prompt includes the task file's `## Gap Closure` section verbatim as the work list — do not re-summarize or paraphrase the gaps in the dispatch prompt; point Builder at the section (or paste it in full) so each `### Gap N` entry is the unit of work. Builder marks each gap closed directly in the section (e.g. `**Status:** closed — <one-line fix summary>` appended under the relevant `### Gap N`) as part of the fix commit, rather than deleting the entries or rewriting the ticket body.

### 2nd Fail

Architect reviews and corrects. Builder does not loop autonomously again. Label applied: `qa-fail-2`.

```
Tester: FAIL (2nd)
  └─> Tester runs plugin update-record to signal fail-2 on tracker (when configured)
      └─> Tester appends/updates ## Gap Closure section to the task file (per qa-ticket-workflow)
          └─> Architect reviews the ## Gap Closure section (not the whole ticket thread)
              ├─ Architect can resolve:
              │   └─> Architect corrects/re-scopes entries directly in the Gap Closure section
              │       (e.g. narrowing an AC's expected behavior, correcting a wrong
              │       suspected-location hint, merging or splitting entries) → Builder fixes
              │       against the corrected section → Tester re-runs
              │
              └─ Architect needs a user decision:
                  └─> task parked → Architect escalates to Team Lead
                      └─> Team Lead answers
                          └─> Architect updates the Gap Closure section → dispatches Builder → flow resumes
```

**2nd-fail scope:** Architect's 2nd-fail review operates on the `## Gap Closure` section — correcting or re-scoping individual gap entries — rather than rewriting the ticket body or acceptance criteria. This keeps the review focused on the specific gaps Tester already isolated instead of re-deriving fix scope from the full ticket/QA thread each time.

### 3rd Fail

No further agent loops. Escalates directly to the team lead.

```
Tester: FAIL (3rd)
  └─> task parked → Architect notifies Team Lead
```

## Partial Pass

Some ACs pass, some fail. Tester transitions ticket to `state:changes-requested` and applies the appropriate `qa-fail-*` label for the current fail attempt (removing any prior `qa-fail-*` label).

```
Tester: PARTIAL PASS
  └─> goes to Builder
      ├─ Builder: "no change required"
      │   └─> goes to Architect to verify
      │       ├─ Architect agrees → goes to Team Lead
      │       └─ Architect disagrees → Builder fixes (with Architect's instructions)
      │
      └─ Builder: fixes required → Builder fixes → Tester re-runs (counts as next fail attempt)
```

## Tester Can't Run (Environment / Setup Failure)

Not a functional failure — Tester cannot execute the test suite at all.

```
Tester: BLOCKED (can't run)
  └─> goes to Architect for decision + instructions
      └─> Architect escalates to Team Lead
```

## Builder Has a Question During Fix

```
Builder: question arises
  └─> Builder spawns Architect (sub-agent)
      ├─ Architect can decide:
      │   └─> decision flows back to Builder → Builder continues
      │
      └─ Architect needs Team Lead:
          └─> task parked → Architect escalates to Team Lead
              └─> Team Lead answers
                  └─> Architect updates instructions → dispatches Builder → flow resumes
```

## Parked Task Resumption

Whenever the team lead answers a parked question:

```
Team Lead answers
  └─> Architect updates instructions
      └─> Architect dispatches Builder per flow
```

## Fail Attempt Counter

The fail counter is tracked in the task file's `fail-count:` frontmatter field (authoritative) and mirrored to the tracker record when a tracker is configured (using the active plugin's update-record procedure — see `ticket-lifecycle-mode` Tracker Plugin Contract).

| Fail # | Frontmatter `fail-count:`      | Who acts                                                       | Tracker update (when configured)       |
| ------ | ------------------------------ | -------------------------------------------------------------- | -------------------------------------- |
| 1st    | `1`                            | Tester spawns Builder directly                                 | plugin update-record: signal fail-1    |
| 2nd    | `2`                            | Architect reviews + corrects (or escalates if decision needed) | plugin update-record: signal fail-2    |
| 3rd    | — (task marked `parked: true`) | Park + escalate to Team Lead unconditionally                   | —                                      |

Rules:

- The counter is independent per ticket — a fail on Ticket 1 does not affect Ticket 2's counter.
- The counter is stored in the local task file frontmatter `fail-count:` field.
- The counter resets if the team lead provides new direction and the flow restarts from a parked state. On reset, set `fail-count: 0` and `parked: false` in the task file frontmatter; if a tracker is configured, run the plugin's update-record procedure to clear any fail signals before the flow resumes.
- When a tracker is configured, the fail-counter update is applied via the active plugin's update-record procedure at the moment of each corresponding fail.

## Lifecycle State Mapping

This flow operates within `ticket-lifecycle-mode`.

| Flow event                                                     | Lifecycle state                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Builder starts implementation (after dispatch)                 | `state:in-progress`                                                    |
| Builder complete (`verifier: Tester` or `verifier: Automated`) | `state:ready-for-qa`                                                   |
| Builder complete (`verifier: Architect`)                       | `state:ready-for-review`                                               |
| Tester fails                                                   | `state:changes-requested`                                              |
| Tester passes all ACs                                          | `state:qa-passed`                                                      |
| Team Lead merges + closes                                      | Team Lead merges and closes — out-of-band action, not a managed label. |

Note: For `verifier: Architect`, the intermediate state is `state:ready-for-review` (not `state:ready-for-qa`). On pass, Architect transitions directly from `state:ready-for-review` to `state:qa-passed` — no separate QA phase is required. See the Transition Permissions table in `ticket-lifecycle-mode`.

### Post-Merge Hygiene

Immediately after any confirmed merge (single-ticket or batch), before moving on to the next ticket or action, the agent whose local checkout tracks the merged branch runs `git fetch origin && git pull` on the default branch. This keeps the local checkout current so the next dispatch, review, or branch cut starts from the merged state rather than a stale one.

## Batch Mode (Sequential Pair)

Removes the per-ticket merge gate. Two tickets run back-to-back; the team lead merges both at the end.

Sequential means Ticket 2 does not start until Ticket 1 completes its active work — with one defined exception: if Ticket 1 parks waiting for team lead input, Ticket 2 starts immediately rather than blocking on the parked question. This maximises throughput while preserving the no-concurrent-implementation constraint.

### Eligibility

Architect proposes a candidate pair from eligible backlog tickets. Before proposing, Architect runs `npm run task -- waves <project>` to mechanically compute which `todo` tickets have no `depends_on` edge and no overlapping `touches` globs between them — this replaces ad hoc manual comparison with a computed grouping. Architect presents the computed grouping to the team lead alongside the proposal.

**The `waves` command informs the proposal; it does not replace the confirmation gate.** Team lead and Architect still jointly confirm the pair meets all three criteria before any dispatch:

- do not touch overlapping files or modules (non-conflicting) — cross-checked by `waves`' `touches` comparison, but the team lead's judgment governs, not the tool's output alone
- are not dependent on each other (B does not need A to land first) — cross-checked by `waves`' `depends_on` comparison
- do not require a merge between them before the second can start

Neither ticket is declared eligible unilaterally — this is a joint call every time, computed grouping or not. Architect does not self-select a batch from `waves` output without team lead confirmation.

### Batch Flow

```
Joint review → Team Lead approves pair (Ticket 1, Ticket 2)

Ticket 1: full automation flow runs
  ├─ Ticket 1 reaches state:qa-passed:
  │   └─> Ticket 2 starts immediately (no merge gate)
  │
  └─ Ticket 1 parks (needs Team Lead input):
      └─> Ticket 2 starts immediately while Ticket 1 waits
          Architect queues the parking question for Team Lead
          Team Lead answers when ready → Ticket 1 remains parked until Ticket 2 completes, then resumes per standard parked-resumption flow

Both tickets reach state:qa-passed → queued

Architect notifies Team Lead:
  - which tickets are ready
  - recommended merge order (Ticket 1 first, then Ticket 2)

Team Lead: reviews → merges in recommended order → closes both tickets
```

### Merge Order

Architect always recommends merge order at batch completion, even if tickets were declared non-conflicting. Branch history can create ordering sensitivity that wasn't visible at selection time.

### Batch Fail Handling

Each ticket runs its own fail counter independently. A 3rd fail on either ticket parks that ticket and notifies the team lead; the other ticket continues unaffected.

### Hard Rules (Batch)

- Max batch size: 2 tickets.
- Ticket selection is a joint call — Architect proposes (using `npm run task -- waves <project>` to compute the candidate grouping), team lead confirms. Architect does not self-select.
- Concurrent Builder dispatches, when the team lead approves running a wave in parallel rather than sequentially, are capped at 2 at a time — current practice — unless the team lead explicitly raises the cap. This is prompt-level guidance for Architect, not something `task waves` or any CLI enforces.
- No auto-merge in batch mode. Team lead merges both at the end.
- Tickets run sequentially — Ticket 2 does not start until Ticket 1 completes or parks. When Ticket 1 parks, Ticket 2 starts immediately as a defined exception; this is not concurrent execution but a parking carve-out.
- Architect notifies team lead of each completion as it happens, not only at batch end.

## State Management Protocol

All three rules below are mandatory during an automation run.

### Rule 1 — Local task file (canonical)

**Local task files are the canonical system of record.** On every lifecycle transition:

1. **Run the state transition CLI** (`npm run task -- transition <id> <new-state>`, see `ticket-lifecycle-mode` State Transition CLI section) instead of hand-editing the frontmatter, renaming the file, and calling the tracker plugin as separate steps:
   - Updates `status:` frontmatter field to the new lifecycle state (e.g., `state:in-progress`, `state:ready-for-qa`, `state:qa-passed`, `state:changes-requested`) — set `fail-count:` and `parked: true` (when fail-count reaches 3) via `npm run task -- update-field <id> <field> <value>`
   - Renames the file to reflect the new state token (e.g., `task_N_ready-for-qa_slug.md` → `task_N_changes-requested_slug.md`)
   - **If a tracker is configured** (presence of a tracker reference field in the task file frontmatter, or workspace tracker config): the same CLI invocation syncs the tracker's `state:*` label and post-verifies it landed — this is mandatory, not optional, and happens automatically as part of the atomic transition
   - **If the CLI reports a non-zero exit / `ok: false`:**
     - The JSON output names the specific failed step (`local-write`, `label-sync`, or `verify`) — append the failure to the task file's `## Log` section (timestamp, attempted action, error)
     - Record the failed outbound in Router's memory HOT section under `failed-outbound` via the active storage plugin using `write-memory-entry('router', 'HOT', content)` (if Router is active)
     - Reconcile the mirror before the ticket is considered closed
   - **A transition is not complete** until the CLI reports `ok: true` (exit 0) or the failure is explicitly recorded for retry
   - Fail-counter and QA-report tracker comments (as opposed to the `state:*` label) still use the active tracker plugin's update-record procedure directly (see `trackers/<plugin-name>.md`)
2. **No tracker configured:** the CLI performs a local-only transition (`mirror: "skipped (no tracker configured)"` in its output); no mirror obligation exists

The CLI (`pipelines/deploy/lib/task-cli.js`) handles the atomic local write (frontmatter + filename) and tracker sync/verify. Agents performing transitions must call the CLI rather than perform equivalent manual updates.

### Rule 2 — Task tracking (TaskCreate / TaskUpdate)

- At automation run start: create a task using TaskCreate with ticket reference, verifier, and initial state
- On every state change: call TaskUpdate immediately — do not batch state changes
- Record at minimum: current state, verifier, fail count, and any parking reason

**Fallback (non-Claude Code environments):** Create a task file in the project's `projects/<project-name>/` directory and update it on each state change in place of TaskCreate/TaskUpdate.

### Rule 3 — WAL enforcement (non-negotiable)

All agents write to their own memory file before every response during an automation run. This is not optional.

- Architect writes via the active storage plugin using `write-memory-entry('architect', tier, content)`
- Builder writes via the active storage plugin using `write-memory-entry('builder', tier, content)`
- Tester writes via the active storage plugin using `write-memory-entry('tester', tier, content)`

Each write must reflect the current ticket state and any decisions made in that turn. An agent that has not updated its memory file has not completed its turn.

During batch runs, apply the Batch Checkpoint Rule from `proactive-agent`: write a progress checkpoint after every ≤5 completed steps so a resumed session continues from the last checkpoint rather than restarting.

## Hard Rules

- Architect must never instruct Builder to commit directly to a shared branch (main, master, or develop) or skip PR creation, regardless of change size. No exceptions.
- Architect never edits files in any source repository directly, regardless of how small or obvious the change appears. Every file change — one line or one hundred — requires a scoped ticket and a Builder dispatch. There are no exceptions for docs, config, or "trivial" fixes.
- The team lead's "do work" / "dispatch builder" is the only valid trigger. Architect does not self-start.
- Architect specifies the verifier on every ticket at creation time. A ticket without a verifier is underscoped and must not be dispatched.
- For `verifier: Tester` — Builder never declares QA done. Only Tester transitions to `state:qa-passed`.
- For `verifier: Architect` — Builder never self-approves. Architect is the sole reviewer.
- For `verifier: Automated` — Builder self-certifies on passing build + lint + tests; Architect spot-checks before notifying team lead.
- After a 3rd fail the flow stops on all verifier paths. No further agent loops without team lead direction.
- Merge and close always belong to the team lead.
- After Tester exits main, main returns to Architect.
