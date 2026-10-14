---
name: qa-ticket-workflow
description: "Use when: Tester runs a full QA session, processes a Builder handoff, executes test steps, writes a GitHub test report, or aligns ticket state after verification."
argument-hint: "Ticket reference, handoff payload, acceptance criteria, or QA execution question"
---

# QA Ticket Workflow

Use this skill when Tester receives a ticket or PR handoff that requires the full QA execution flow, GitHub reporting, and ticket-state alignment.

## Modes

### Full QA — direct team-lead-initiated session

When run directly by the team lead, execute the complete workflow below (handoff check → pre-test setup → execution → report → state alignment → defect notification → cleanup).

### Pre-QA Readiness Check — Builder subagent dispatch

When invoked as a subagent by Builder (not by the team lead), Tester operates in readiness-check mode only:

- Do NOT execute tests, navigate browsers, or interact with the running app.
- Validate the Developer → QA handoff payload is complete (against `ticket-lifecycle-mode`).
- Add the ticket to Tester's HOT memory queue so it is tracked.
- Return to Builder: `READY` (handoff complete) | `INCOMPLETE: [list of missing fields]`.

Browser-driven QA requires a direct Tester session because those tests use shared browser state that cannot run inside a subagent. After Builder confirms readiness, the team lead triggers browser-driven Tester QA in a dedicated session.

### Full QA — Architect subagent dispatch (non-browser ticket)

When invoked as a subagent by Architect for a non-browser ticket (CLI, file, hook, deploy, scratch-repo checks), execute the complete workflow below. Do NOT use the browser or the shared tab. If a step turns out to need the browser, mark it NOT RUN with the reason and return; never improvise. Builder-dispatched Tester remains Pre-QA only.

## Required Handoff

The canonical Developer → QA handoff payload is defined in `ticket-lifecycle-mode`. Tester blocks execution if any required field is missing and asks for it before proceeding.

## Pre-Test Setup

Before executing any test step:

1. Confirm the environment URL matches the ticket target. Navigate to it and do not run server commands.
2. Confirm infrastructure is ready. If a dependency is missing, surface it as BLOCKER and stop.
3. Note the initial page and auth state as the test baseline.

## Execution Workflow

### Step 1 - Parse the ticket

Extract:

- acceptance criteria, each becoming a test step
- target URL
- user role and credentials
- preconditions

List any gaps not answerable from the ticket or `.env.local`.

### Step 2 - Ask all pre-flight questions

Batch missing credentials, ambiguous acceptance criteria, missing URL, required seed data, and infrastructure readiness into one question set before starting. Do not execute any test step until all blocking questions are resolved.

### Step 3 - Choose execution strategy

- **Sequential** - step N depends on the result or state of step N-1
- **Independent** - a step can run in isolation with its own test data

Parallelization rules:

- each parallel sub-agent gets unique test data
- do not parallelize tests that touch auth rapidly
- do not parallelize tests that require the same shared browser window sequentially
- wait for all sub-agents to complete before writing the report

### Step 4 - Execute test steps

For each step:

1. State what you are about to do in one line.
2. Perform the action.
3. Verify resulting URL and visible page text after each navigation or submission.
4. Mark the step PASS, FAIL, or BLOCKED with one-line evidence.

If a step fails but later steps are independent, continue. If failure blocks subsequent steps, mark them BLOCKED and stop.

### Step 5 - Verify supporting systems

Where applicable, confirm via shared browser windows:

- email delivery
- auth records and profile rows in Supabase

Do not substitute CLI queries for browser verification.

## Report Format

```markdown
## Test Report - [Ticket/PR] - [YYYY-MM-DD]

**Ticket:** [org/repo#number]
**PR:** [org/repo#number] (if applicable)
**Environment:** [base URL tested]
**Tester:** Tester
**Run date:** [date]

### Summary

[1-2 sentences: overall result and key finding]

### Test Steps

| #   | Step | Expected | Actual | Result |
| --- | ---- | -------- | ------ | ------ |
| 1   | ...  | ...      | ...    | PASS   |

### Defects Found

[List with description, expected, actual, severity - or None]

### Additional Observations

[Out-of-scope findings, or None]

### Verdict

[PASS | FAIL | PARTIAL PASS | BLOCKED] - [one sentence justification]
```

## GitHub And State Actions

**The only documented path: `npm run task -- qa-report <id> <verdict> [--gaps <path>] [--findings <path>] [--projects-root <path>]`.** This single command composes the report, posts it to the linked GitHub issue and (if an open PR is discoverable for the current branch) the PR, re-fetches the comment list to confirm each post actually landed (failing loudly, non-zero exit, if not), appends the local `## QA Report` section (and `## Gap Closure` on FAIL/PARTIAL PASS when `--gaps` is supplied), and performs the matching state transition — `state:qa-passed` on PASS, or `state:changes-requested` + the correct `qa-fail-N` label on FAIL/PARTIAL PASS. It replaces Steps 6-8 below with one call. `--projects-root <path>` reliably resolves task files regardless of which repo the CLI process itself is running from — pass it whenever the task file lives outside the CLI's own cwd (e.g. Tester running from the source repo against task files under the deployed hub's `projects/` directory).

- Write findings/gap-closure content to a temp file first (avoids inline multi-line `--body` escaping), then pass its path via `--findings` and/or `--gaps`.
- Check the command's JSON output `ok` field and exit code. `ok: false` means the report did not verifiably land, or the transition failed — do not treat any output as success without checking `ok`.
- **If the CLI command errors, do not fall back to manually editing the task file or the GitHub issue.** Read the JSON `error` field, fix the underlying cause (missing `--projects-root`, invalid id, `gh` auth, etc.) and retry the command. There is no manual-edit fallback path — exactly one documented path exists for this operation.

Steps 6 and 7 below describe the sequence the CLI command automates internally; they remain a reference for what the command does — not an alternative manual procedure to perform by hand. The VBR gate is the local task file update; the GitHub comment is the mandatory-when-configured mirror step.

### Step 6 - Write QA Report to local task file (VBR gate)

**This is the primary VBR gate.** A verdict is not complete until the local task file is updated with the QA report and the state transition is recorded.

1. **Append a `## QA Report` section** to the task file with the same report content (verdict, AC table, date, defects, observations).
2. **On a FAIL or PARTIAL PASS verdict, also append a `## Gap Closure` section** — see Gap Closure Section below. This is required on every FAIL/PARTIAL PASS verdict, not optional documentation.
3. **Update the frontmatter**:
   - Set `status:` to the new lifecycle state
   - Update `fail-count:` if applicable (increment on FAIL or PARTIAL PASS)
   - Set `parked: true` if fail-count reaches 3
4. **Rename the file** to reflect the new state token:
   - PASS → `task_N_done_<slug>.md` (or `task_N_qa-passed_<slug>.md` if not terminal)
   - FAIL or PARTIAL PASS → `task_N_changes-requested_<slug>.md`
   - BLOCKED → leave as `ready-for-qa` and note blocker in the QA Report section

**VBR check:** Verify the local task file now has the `## QA Report` section (and, on FAIL/PARTIAL PASS, the `## Gap Closure` section) and the filename reflects the new state before proceeding to Step 7.

## Gap Closure Section

On a FAIL or PARTIAL PASS verdict, Tester appends a `## Gap Closure` section to the task file — one entry per failed acceptance criterion. This turns the fix guidance from prose Tester writes once and Builder re-derives from, into a structured work list Builder consumes directly on 1st-fail re-dispatch (see `task-automation-flow`'s 1st Fail path) and Architect corrects directly on 2nd-fail review (see `task-automation-flow`'s 2nd Fail path), instead of rewriting the ticket body.

### Format

Write the section via the task CLI's `append-task-section` operation (`npm run task -- append-section <id> "Gap Closure" <content> [--projects-root <path>]`, piping multi-line content via stdin — see `ticket-lifecycle-mode` State Transition CLI section for the CLI's general usage pattern). Do not hand-edit the section with a text editor — the CLI is the only documented path; if it errors, fix the underlying cause and retry, do not bypass it with a manual `Edit`.

Each entry is a `### Gap N` subsection with these fields:

- **AC:** the acceptance criterion number/reference this gap closes
- **Observed:** what Tester actually saw (URL, rendered text, visible state, or command output)
- **Expected:** what the AC requires
- **Suspected location:** (optional) file/line/component Tester suspects is responsible — a hint for Builder, not a diagnosis Builder must accept as-is

One `### Gap N` entry per failed AC. Passing ACs do not get an entry — the Gap Closure section is the failure work list, not a full AC recap (the AC table in `## QA Report` already covers pass/fail per AC).

### Worked example

Ticket has 3 ACs. Tester verdict is FAIL — AC 2 and AC 3 fail, AC 1 passes. Tester runs:

```bash
npm run task -- append-section "demo#42" "Gap Closure" "$(cat <<'EOF'
### Gap 1

- **AC:** 2
- **Observed:** Submitting the form with an empty email field shows no validation
  message; the request is sent to the server and returns a 500.
- **Expected:** AC 2 requires client-side validation to block submission and show
  "Email is required" inline before any request is sent.
- **Suspected location:** src/components/SignupForm.tsx — no onBlur/onSubmit
  validation wired for the email field.

### Gap 2

- **AC:** 3
- **Observed:** Success toast never appears after a valid submission; console shows
  `Cannot read properties of undefined (reading 'toast')`.
- **Expected:** AC 3 requires a visible success toast within 2s of a valid submit.
- **Suspected location:** src/hooks/useSignup.ts — toast import likely missing after
  the recent notifications refactor.
EOF
)"
```

Resulting section appended to the task file:

```markdown
## Gap Closure

### Gap 1

- **AC:** 2
- **Observed:** Submitting the form with an empty email field shows no validation
  message; the request is sent to the server and returns a 500.
- **Expected:** AC 2 requires client-side validation to block submission and show
  "Email is required" inline before any request is sent.
- **Suspected location:** src/components/SignupForm.tsx — no onBlur/onSubmit
  validation wired for the email field.

### Gap 2

- **AC:** 3
- **Observed:** Success toast never appears after a valid submission; console shows
  `Cannot read properties of undefined (reading 'toast')`.
- **Expected:** AC 3 requires a visible success toast within 2s of a valid submit.
- **Suspected location:** src/hooks/useSignup.ts — toast import likely missing after
  the recent notifications refactor.
```

On re-dispatch, Builder marks each gap closed directly in this section as part of the fix commit (e.g. appending `**Status:** closed — <one-line fix summary>` under each `### Gap N`) rather than deleting or rewriting the entries — this keeps the section a durable record across fail attempts.

### Re-QA: per-gap verification (no blanket verdict)

When re-running QA against a task file that carries a `## Gap Closure` section from a prior fail, Tester verifies each gap entry individually — not a blanket re-test of the whole ticket:

1. For each `### Gap N` entry, re-run the specific check described in **Observed**/**Expected** and record PASS or FAIL for that gap specifically, with fresh evidence (URL, rendered text, or command output) — the prior FAIL evidence is not reusable as re-QA evidence.
2. If Builder marked a gap closed but Tester's re-check shows the underlying behavior still fails, record it as still FAILING with the new observed behavior — do not accept the `**Status:** closed` annotation as evidence.
3. The overall verdict is PASS only when every gap in the section (plus all other ACs) passes. A single remaining FAIL gap keeps the overall verdict FAIL/PARTIAL PASS, per the existing verdict rules — this section does not change verdict vocabulary.
4. On the next FAIL, append a new `## Gap Closure` entry set (or update the existing one) following the same format — do not silently drop gaps that are still open.

### Step 7 - Post report to GitHub (mandatory — hard requirement)

**Posting the full QA report to GitHub is a hard requirement after every verdict.** When a tracker is configured (presence of `github:` or `github-issue:` field in task frontmatter, or workspace tracker config), the GitHub comment is **mandatory**, not optional.

The report **must include**: verdict, evidence for each acceptance criterion, `npm run validate:manifests` result, and `npm test` exit code.

Write the report to a temp file. On Linux/Mac use `mktemp`; on Windows (PowerShell) use `Join-Path $env:TEMP "qa-report.md"`. Write the report line by line to that path. Never inline multi-line content with `--body`. Remove the temp file after posting.

Post destinations (all that apply):

1. **GitHub issue** — when the ticket references an issue number:
   ```bash
   gh issue comment <number> --repo <org/repo> --body-file <path>
   ```
2. **GitHub PR** — when a PR is open for the work (even if an issue also exists):
   ```bash
   gh pr comment <number> --repo <org/repo> --body-file <path>
   ```
   Post the same report to both issue and PR when both exist — the PR comment is the primary evidence artifact.

**VBR check (mirror write):** After posting, verify the comment is visible:

```bash
gh issue view <number> --repo <org/repo> --comments
gh pr view <number> --repo <org/repo> --comments
```

**If the mirror write fails:**

- Append the failure to the task file's `## Log` section (timestamp, attempted action, error)
- Record the failed outbound in Router's HOT memory section under `failed-outbound` (if Router is active)
- Reconcile the mirror before the ticket is considered closed

**No tracker configured:** skip this step entirely; the local QA Report is sufficient.

For CLI/tooling tickets with no deployed URL, set **Environment:** to `local / CLI` and cite command output or test counts as evidence in the Test Steps table.

### Step 8 - Align ticket state labels (hard requirement — when tracker configured)

**Covered automatically by `npm run task -- qa-report`** — the CLI command performs the state transition and label sync as part of the same call. The description below is a reference for what the command does internally, not an alternative manual procedure — do not run `gh issue edit` by hand as a substitute.

**Aligning ticket state and renaming the local task file are hard requirements**, both performed atomically by the CLI:

- PASS → `state:qa-passed` label applied, task file renamed to `_qa-passed_`
- FAIL or PARTIAL PASS → `state:changes-requested` label applied (also syncs the `qa-fail-*` label to match local `fail-count:`), task file renamed to `_changes-requested_` (Builder picks it up)

**Tester memory:** Append a one-line HOT entry with verdict, ticket/PR refs, local task file path, and GitHub comment URL (if posted).

### Step 9 - Notify Builder on defects

If verdict is FAIL or PARTIAL PASS:

**Preferred path — dispatch Builder as subagent:**
Dispatch Builder in development mode. Pass:

- one-line defect summary
- ticket / PR reference
- local task file path (with `## QA Report` section appended)
- GitHub report URL (if posted)
- status: needs fix — awaiting retest

**Fallback path — when subagent dispatch is unavailable in the current session:**
Append to Builder's HOT memory section:

- QA result summary (one line)
- defects (one line per defect)
- ticket / PR reference
- local task file path
- GitHub report URL (if posted)
- status: needs fix — awaiting retest

Do not modify any other section of Builder's memory file. Builder will read the local task file's `## QA Report` section for full context; the HOT append ensures the defect is tracked for the next Builder session.

**Fail counter automation rules:** When operating inside a `task-automation-flow` run, see `skills/ticket-lifecycle-mode/SKILL.md` for the complete fail counter rules. On 1st fail, dispatch Builder (same as preferred path above). On 2nd fail, route to Architect — do not dispatch Builder again.

If verdict is PASS with no defects, skip this step — Builder will see the local task file update and (if posted) the GitHub comment.

### Step 10 - Clean up

Remove temp report files and summarize the final verdict in chat.
