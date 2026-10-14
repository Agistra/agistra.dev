---
name: team-relay
description: "Use when: remote team, delegate, delegated lane, delegated implementation, delegated QA, or non-sensitive ticket routing to the remote team's implementation lane."
argument-hint: "Ticket to delegate, remote agent handoff, or cross-team routing question"
---

# Team Relay

Use this skill when Builder needs to coordinate delegated work with the remote team. The remote team has a single AI agent (the remote agent) who does both implementation and first-pass QA.

Builder remains the accountable engineering lead throughout the delegated lane. The remote agent implements and runs first-pass QA. Builder reviews all code before QA. The team lead is the merge and close authority.

All inter-team communication runs through Router via the configured relay channel — see `telegram-relay`. Builder never contacts the remote agent directly; Builder dispatches Router when a state transition warrants a notification.

## Delegation Decision

- Sensitive tickets stay in Builder's direct lane and route Builder → Tester.
- Non-sensitive tickets may be delegated and route Builder → remote agent → Builder review → remote agent (QA) → Builder → team lead.
- Tester is outside the default delegated lane and returns only when the team lead explicitly requests re-validation.

**A ticket is sensitive if it touches:** credentials, payment flows, privileged data, or confidential business logic. When in doubt, keep it in the direct lane.

If scope drifts into a sensitive area mid-ticket, pull it back into Builder's direct lane before more code is written.

## Delegated Lane Workflow

1. Builder reviews the ticket and confirms it is safe to delegate.
2. Builder writes the handoff in the GitHub issue using the template below and moves the ticket to `state:ready-for-implementation`.
3. Builder dispatches Router to notify the remote agent per `telegram-relay` state-transition trigger table.
4. Remote agent implements the scoped work, opens the PR, runs validation, moves the ticket to `state:ready-for-review`.
5. Builder reviews the code. If changes are needed, Builder moves to `state:changes-requested` and dispatches Router with a notification; loop continues until Builder accepts the implementation.
6. Only after Builder accepts the implementation does Builder move the ticket to `state:ready-for-qa`. Builder dispatches Router with the QA-ready notification.
7. Remote agent runs first-pass QA and returns a verdict:
   - On PASS: moves the ticket to `state:qa-passed` and dispatches Router with the QA-passed notification.
   - On FAIL / PARTIAL PASS: moves the ticket to `state:changes-requested` with defect evidence on the ticket; dispatches Router with the QA-failed notification.
8. On FAIL, Builder triages: either the remote agent loops on the fix, or Builder pulls the work back into the direct lane if the defect implies a sensitive change.
9. On PASS, Builder adds the final engineering recommendation while the ticket sits in `state:qa-passed` for team lead review.
10. The team lead remains the only merge and close authority.

## Builder Responsibilities in the Delegated Lane

- Scope the ticket fully before delegating (all acceptance criteria testable, all assumptions documented).
- Write the scoped handoff for the remote agent (template below).
- Dispatch Router at each state transition that crosses the inter-team boundary, per `telegram-relay`.
- Review all remote-agent code before moving to `state:ready-for-qa`.
- Triage remote-agent QA findings and decide whether Tester re-validation is needed (only when the team lead asks).
- Prepare the final engineering recommendation for the team lead after PASS.

## Delegated Lane State Table

| State | Meaning | Owner |
| ----- | ------- | ----- |
| `state:ready-for-implementation` | Builder has scoped the ticket and assigned the delegated lane | Builder |
| `state:in-progress` | Remote agent is actively implementing | Remote agent |
| `state:ready-for-review` | Delegated implementation complete and waiting for Builder review | Builder |
| `state:changes-requested` | Builder rejected the implementation, or remote-agent QA returned defects | Remote agent (to fix) |
| `state:ready-for-qa` | Builder approved the code; remote agent may now run first-pass QA | Remote agent (QA) |
| `state:qa-passed` | Remote-agent QA passed. Builder adds engineering recommendation for team lead review. | Builder (recommendation) → team lead (merge) |

## Builder → Remote Agent Handoff Template

Post this as a comment on the GitHub issue when the ticket moves to `state:ready-for-implementation`.

```markdown
## Builder → Remote Agent Handoff

**Ticket:** #N
**Implementation owner:** Remote agent
**Branch plan:** [new branch name or "remote agent chooses"]

**Acceptance Criteria**
- [ ] [criterion 1]
- [ ] [criterion 2]

**Environment:** [URL or environment name for the deployed build]

**Credentials or Test Data Source:** [where the remote agent gets access — not the secret itself]

**Scope Boundaries**
- In scope: [what to build]
- Out of scope: [explicit exclusions]

**Assumptions**
- [assumption and verification need]

### Test Focus (used by remote agent in QA mode after Builder review)
- [area to focus testing on]

### Validation Required (before remote agent moves ticket to state:ready-for-review)
- [ ] Build passes
- [ ] Lint passes
- [ ] Unit tests pass
- [ ] Manual smoke test: [specific steps]

### Communication Protocol
- After implementation: return owner Builder, state state:ready-for-review.
- After Builder approves and moves to state:ready-for-qa, remote agent runs first-pass QA.
- Dispatch Router on each state transition per `telegram-relay`.
```

## Tester Re-Validation

Only include Tester if the team lead explicitly requests re-validation of a remote-agent-QA'd ticket. The route in that case:

1. The team lead asks Builder for Tester re-validation.
2. Builder creates a fresh Developer → QA handoff using `ticket-lifecycle-mode`.
3. Tester runs full QA as Architect classifies it: a subagent in Full QA mode for non-browser tickets, a direct Tester session for browser-driven QA.
4. Tester's verdict updates the ticket state. Router is not involved in this route since it is an internal team escalation.