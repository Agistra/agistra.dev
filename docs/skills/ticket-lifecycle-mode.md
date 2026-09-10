[← README](../../README.md) · [Architect](../ARCHITECT.md) · [Builder](../BUILDER.md) · [Tester](../TESTER.md) · [Router](../ROUTER.md)

---

# ticket-lifecycle-mode

The shared rule set that governs how work moves through the team — who can transition a ticket, what gates must pass first, and what the handoff payload must contain. Every agent binds to one or more lifecycle roles and follows the rules for those roles.

---

## Roles

| Role | Agent | What they own |
| --- | --- | --- |
| Developer | Builder | Implements and addresses defects |
| Technical Lead | Architect / Builder | Approves implementation quality, decides when work is ready for QA |
| QA | Tester | Verifies acceptance criteria, returns pass/fail/blocked verdicts |
| Relay | Router | Classifies and routes — never transitions ticket states |
| Human Approver | You | Final merge, close, and direction decisions |

---

## States and flow

```
ready-for-implementation   ← Architect creates, you approve
  → in-progress            ← Builder starts
  → ready-for-review       ← Builder completes
  → changes-requested      ← Architect/Builder rejects (loops back)
  → ready-for-qa           ← Architect/Builder accepts, QA payload complete
  → qa-passed              ← Tester passes with evidence
  → closed / next          ← You decide
```

---

## Transition permissions

| From | To | Who | Gate |
| --- | --- | --- | --- |
| backlog | `ready-for-implementation` | Technical Lead | Scope and owner are clear |
| `ready-for-implementation` | `in-progress` | Developer | Implementation has started |
| `in-progress` | `ready-for-review` | Developer | Work complete, ready for review |
| `ready-for-review` | `changes-requested` | Technical Lead | Review found defects or missing requirements |
| `ready-for-review` | `ready-for-qa` | Technical Lead | Engineering accepted, handoff payload complete |
| `ready-for-qa` | `qa-passed` | QA | PASS verdict with evidence |
| `ready-for-qa` | `changes-requested` | QA | FAIL or PARTIAL PASS requiring engineering work |
| `qa-passed` | closed / next | Human Approver | Your decision |

---

## Entry gates

### Before `state:ready-for-qa`

- Implementation is complete for all scoped acceptance criteria
- Engineering review is complete
- Branch is pushed and PR exists (when the repo uses PR workflow)
- Build, lint, and tests pass
- Migrations, env vars, and environment setup are ready
- QA environment is live and reachable
- Developer → QA handoff payload is complete (see below)

### Before `state:qa-passed`

- Tester executed all required verification steps
- QA report contains pass evidence
- No unresolved blocker prevents human approval

---

## Developer → QA handoff payload

Builder provides these fields before Tester starts:

- Ticket or PR reference
- Acceptance criteria or explicit test steps
- Environment URL
- Starting auth state and user role
- Test data source (no secrets in chat)
- Validation already completed by Builder
- Known blockers or limitations

Tester blocks execution if any required field is missing.

---

## Hard rules

- Builder never declares QA done — only Tester moves to `state:qa-passed`
- Router classifies and routes but never transitions ticket states
- `state:qa-passed` is Tester-only — Technical Lead must advance to `state:ready-for-qa`, never skip to `state:qa-passed`
- You (Human Approver) are the final authority on merge and close

---

**Carried by:** [Architect](../ARCHITECT.md) · [Builder](../BUILDER.md) · [Tester](../TESTER.md) · [Router](../ROUTER.md)
