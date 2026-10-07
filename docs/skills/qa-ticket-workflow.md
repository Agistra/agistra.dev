[← README](../../README.md) · [Tester](../TESTER.md)

---

# qa-ticket-workflow

Tester's full QA execution playbook — from receiving the handoff through posting the GitHub report, aligning ticket state, and notifying Builder on defects.

---

## Three modes

| Mode | Trigger | What happens |
| --- | --- | --- |
| **Full QA** | Team lead starts Tester's session directly | Complete execution: handoff check → setup → test steps → report → state change → Builder notification |
| **Full QA (Architect dispatch)** | Architect spawns Tester as subagent for a non-browser ticket (CLI, file, hook, deploy, scratch-repo checks) | Same complete execution, no browser or shared tab; a step that needs the browser is marked NOT RUN |
| **Pre-QA Readiness Check** | Invoked as subagent by Builder | Validate the handoff payload is complete, queue the ticket in HOT memory — no app interaction |

Browser-driven QA requires its own session because those tests use shared browser state that cannot run inside a subagent. Builder confirms readiness via Pre-QA Check, then you trigger a dedicated Tester session for execution.

---

## Execution flow (Full QA)

### 1. Parse the ticket

Extract: acceptance criteria (each becomes a test step), target URL, user role and credentials, preconditions. Flag any gaps before starting.

### 2. Pre-flight questions

Batch all missing information — credentials, ambiguous criteria, missing URL, seed data, environment readiness — into one question set. No test step runs until all blocking questions are resolved.

### 3. Choose execution strategy

- **Sequential** — step N depends on the result or state of step N−1
- **Independent** — step can run in isolation with its own test data

Parallelized steps each get unique test data. Do not parallelize tests that touch auth rapidly or require the same shared browser window in sequence.

### 4. Execute test steps

For each step:
1. State what you are about to do in one line
2. Perform the action
3. Verify the resulting URL and visible page state
4. Mark PASS, FAIL, or BLOCKED with one-line observable evidence

If a step fails but later steps are independent — continue. If failure blocks subsequent steps — mark them BLOCKED and stop.

### 5. Verify supporting systems

Confirm via browser where applicable: email delivery, auth records, database state. Do not substitute CLI queries for browser verification.

### 6. Post report to GitHub

Structured test report posted as a GitHub issue comment:

```markdown
## Test Report — [Ticket/PR] — [YYYY-MM-DD]

**Ticket:** [org/repo#number]
**Environment:** [URL tested]
**Run date:** [date]

### Summary
[1–2 sentences: overall result and key finding]

### Test Steps
| # | Step | Expected | Actual | Result |
| - | ---- | -------- | ------ | ------ |
| 1 | ...  | ...      | ...    | PASS   |

### Defects Found
[List with description, expected, actual, severity — or None]

### Verdict
[PASS | FAIL | PARTIAL PASS | BLOCKED] — [one sentence justification]
```

### 7. Align ticket state

| Verdict | Ticket action |
| --- | --- |
| PASS | → `state:qa-passed` |
| FAIL | → `state:changes-requested` |
| PARTIAL PASS | → `state:changes-requested` |
| BLOCKED | Do not claim QA complete — return missing dependency to its owner |

### 8. Notify Builder on defects

If FAIL or PARTIAL PASS: notify Builder with ticket/PR reference, one-line defect summary, GitHub report URL, and status: *needs fix — awaiting retest*.

---

**Carried by:** [Tester](../TESTER.md)
