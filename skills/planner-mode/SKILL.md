---
name: planner-mode
description: "Use when: planner mode, planning mode, proposal, scope definition, estimate, timeline, how hard, feasibility, effort, how long, how big, client message, external communication, pricing, delivery confidence, commercial risk, or project delivery planning."
argument-hint: "Proposal, client message, scope/timeline question, estimate, or delivery-risk question"
---

# Planner Mode

Use this mode when work touches external promises, client wording, scope, price, timeline, commercial assumptions, delivery confidence, proposal support, or project sequencing.

Architect remains accountable for the internal draft. The team lead remains the external gate.

## When to Enter BD/Delivery Mode

Load this skill when:

- the team lead says: "planner mode", "planning mode", "draft a proposal", "draft the scope", "scope this", "timeline", "estimate", "client message", or "external commitment"
- The work involves client commitments, commercial assumptions, proposal wording, scope boundaries, schedule risk, or delivery confidence

Architect should also load this skill automatically when a task involves external messaging, pricing, bid support, or anything that could become a client-facing commitment.

## Hard Boundaries

- Do not send client-facing messages.
- Do not commit to price, timeline, staffing, delivery date, or scope.
- Do not imply the team lead has approved anything unless they explicitly have.
- Do not turn technical assumptions into client commitments.
- Do not hide uncertainty. Express confidence and verification needs plainly.
- Do not mention internal agent structure or private team strategy in client-ready wording.

## Planner Checklist

Classify the request:

- Proposal or bid support
- Client response draft
- Scope clarification
- Timeline or estimate support
- Delivery risk review
- Internal go/no-go recommendation
- Architecture-to-delivery translation

Extract:

- Client-visible ask
- Internal assumptions
- Deliverables
- Exclusions
- Dependencies
- Risks
- Verification required before commitment
- Decision needed from the team lead

## Output Format

```markdown
## Planner Draft

**Purpose:** [why this draft exists]
**Audience:** [team-lead internal | client-ready draft for team lead review]
**Commitment Status:** Draft only. Team lead approval required before external use.

### Scope Summary
[what is included]

### Exclusions
[what is not included]

### Assumptions
- [assumption and verification need]

### Delivery Risks
| Risk | Impact | Mitigation | Owner |
| ---- | ------ | ---------- | ----- |
| ... | ... | ... | ... |

### Confidence
[High | Medium | Low] - [short reason]

### Team Lead Decisions Needed
- [decision]

### Draft Wording
[client-safe wording, if requested]
```

## Architecture Interaction

If the BD/delivery question depends on unsettled technical architecture, load `architecture-mode` first. Do not draft confident scope, timeline, or client wording while the technical basis is unresolved.

## Worked Example

### Example — Scope summary for a consulting engagement

```markdown
## Planner Draft

**Purpose:** Scope and effort estimate for an AI agent workflow build
**Audience:** Team-lead internal
**Commitment Status:** Draft only. Team lead approval required before external use.

### Scope Summary
Build and deploy three AI agents (Architect, Builder, Tester) using the agistra agent framework into the client's existing VS Code + GitHub workflow. Includes: agent definitions, skill configuration, memory scaffold, deploy CLI setup, and one end-to-end test run of the ticket lifecycle.

### Exclusions
- CI/CD pipeline changes
- Custom skill authoring beyond the standard library
- Ongoing maintenance or hosted infrastructure

### Assumptions
- Client has an existing Node.js/npm environment — **verify before commit**
- Client uses GitHub for issue tracking — **verify before commit**
- One-week timeline assumes availability of a technical contact for 2 hrs/day

### Delivery Risks
| Risk | Impact | Mitigation | Owner |
| ---- | ------ | ---------- | ----- |
| Client environment incompatible with deploy CLI | Blocks setup | Pre-qualify environment in discovery call | Team lead |
| Scope creep into custom skill authoring | +2–3 days | Explicitly exclude in engagement letter | Team lead |
| No existing ticket workflow | Delays lifecycle test | Agree on a minimal GitHub Projects board | Consultant |

### Confidence
Medium — timeline estimate assumes smooth environment setup. Add 2-day buffer if environment has not been pre-qualified.

### Team Lead Decisions Needed
- Approve or adjust the exclusions list before sharing with client
- Confirm whether custom skill authoring is in scope (affects price)
- Sign off on the confidence level before committing to a delivery date

### Draft Wording
"We will set up your AI agent workflow — including agent definitions, skill configuration, and an end-to-end test of the ticket lifecycle — within one week, assuming your team can provide 2 hours of availability per day for environment access and feedback."
```

## Exit Criteria

Planner mode is complete when Architect has produced an internal team-lead-reviewable draft, surfaced assumptions and risks, and made clear what the team lead must approve before anything external happens.
