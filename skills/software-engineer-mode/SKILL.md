---
name: software-engineer-mode
description: "Use when: implement a scoped ticket, fix a bug, add tests, prepare a PR-ready code change, or reuse a standard builder workflow across software engineer agents."
argument-hint: "Ticket, PR, failing behavior, repo context, or implementation task"
---

# Software Engineer Mode

Reusable builder mode for software engineer agents. This skill captures the shared engineering workflow that should stay consistent across engineer-type agents while leaving identity, stakeholder relationships, domain guardrails, and routing rules in the owning agent profile.

## When to Enter Software Engineer Mode

Load this skill when any of these are true:

- the agent is asked to implement a scoped issue, bug fix, or small feature
- the task requires code changes, tests, validation, and PR-ready reporting
- the agent is reviewing code with intent to identify defects, regressions, or missing tests
- the owning profile wants reusable engineering discipline without copying a full agent persona into every engineer agent

## Mode Rules

- The ticket or explicit task is the contract. Do not add unrequested features.
- If acceptance criteria are missing, ambiguous, or point to multiple reasonable approaches, ask focused clarification questions before editing.
- Start from the nearest concrete anchor: failing test, file, symbol, command, or call site.
- Name the exact evidence supporting the current hypothesis or requested behavior: file, symbol, route, config key, failing test, command output, screenshot, log line, migration, or review comment.
- If critical evidence is missing, collect it before editing instead of guessing.
- For non-trivial implementation choices, compare at least two viable approaches before choosing the smallest workable path.
- Define the current observable state, the next observable state that should prove the change, and the first validation slice before editing.
- Prefer the smallest change that satisfies the acceptance criteria and existing patterns.
- Tests are required for every behavior change when the repository has a test surface for that slice.
- Validate immediately after the first substantive edit using the narrowest check that can falsify the current hypothesis.
- Compare observed validation output against the expected next state; if they do not match, repair locally or revise the hypothesis before widening scope.
- Do not widen scope after a failed validation until the local defect is understood and repaired.
- Follow repository-specific branch, PR, review, and release rules. If the repository defines stricter workflow than this skill, the repository wins.
- Keep agent-specific identity, client communication rules, workstream separation, and memory policy outside this skill.

## Intake Checklist

Before editing, identify:

- ticket, PRD, acceptance criteria, and any review-comment follow-up already in scope
- scope boundaries and explicit non-goals
- owning repository and workflow document
- nearest implementation anchor
- exact evidence already available and the artifacts it comes from
- one local hypothesis about the defect or required behavior
- whether the task is simple enough for one local hypothesis or non-trivial enough to require comparing at least two viable approaches
- current observable state and the next observable state that should validate the change
- cheapest discriminating validation check
- smallest first validation slice or evidence-collection step
- implementation constraints inherited from architecture work, if any
- missing information that blocks safe implementation
- **ticket type** — classify before starting (see Ticket Type and Lens Activation below)
- **active lenses** — declare which of UIX / CSV / INF apply to this ticket

## Ticket Type and Lens Activation

Classify the ticket before writing any code. The classification sets the TDD requirement and activates the relevant domain lens skills.

| Type | Examples | TDD gate | Active lenses |
| ---- | -------- | -------- | ------------- |
| **Logic / Service / Bug** | Supabase RPC logic, TypeScript utility, auth flow, data processing, bug with a clear reproduction | **Required** — write failing test before implementation | CSV if a contract surface changes |
| **UI / Layout** | React component, page, form, loading state, error boundary, auth-gated view | Optional — write component or E2E test if the repo supports it; otherwise implement then test | **UIX required** |
| **Contract / Migration** | Supabase migration, type definition change, edge function, environment variable, deployment config | Write contract test or type check first when possible | **CSV and/or INF** as applicable |
| **Architecture / BD** | ADR, C4 diagram, proposal draft, scope document | None — no code | None |

A ticket may span types (a feature that adds a migration AND a React form activates UIX + INF, and applies the Logic TDD gate to any backend logic involved). When types overlap, apply the strictest TDD requirement and activate all applicable lenses.

### Declare at intake

State this before implementation starts — it is the commitment that determines the pre-handoff gate:

```
Ticket type:   [Logic/Service/Bug | UI/Layout | Contract/Migration | Architecture/BD]
Active lenses: [UIX | CSV | INF | none]
TDD gate:      [required | optional | not applicable]
```

Domain lens skills to load when active:
- `uix-lens` — UI state coverage (five states) for React components
- `csv-lens` — Client-service contract for Supabase RPCs and TypeScript client
- `inf-lens` — Infrastructure readiness for migrations, env vars, and deployments

## Shared Evidence and Validation Frame

Use this frame internally before editing and preserve it in closeout when architecture work exists upstream. This keeps architecture output and implementation handoff in the same shape.

```markdown
### Entry Point
- [failing test, file, command, route, user flow, or review comment]

### Evidence and Current State
- [exact artifact -> observed behavior, gap, or constraint]

### Options or Local Hypothesis
- [local hypothesis for a simple task]
- [option A vs option B when the choice is non-trivial]

### Implementation Constraints
- [constraints from ticket, repo workflow, or architecture recommendation]

### First Validation Slice
- [smallest edit or evidence-collection step that can falsify the hypothesis]

### Verification Signals
- [tests, logs, metrics, traces, command output, UI states, or build signals expected to change]
```

If architecture-mode has already produced `Evidence and Current State`, `Implementation Constraints`, `First Validation Slice`, or `Verification Plan`, reuse those fields directly instead of inventing a new implementation narrative.

## Delivery Workflow

### Step 1 - Read local process

- Read the repository workflow doc if the task is new to that repo, such as `IMPLEMENTATION.md`, `WORKFLOW.md`, `CONTRIBUTING.md`, or equivalent.
- Read the ticket, PRD, acceptance criteria, and in-scope review comments before editing.
- Read the affected module and one nearby test, call site, or failing command before editing.
- Capture the entry point, evidence, local hypothesis or viable options, first validation slice, and expected verification signals before the first edit.

### Step 2 - Branch and setup

- Follow the repository branch policy.
- Fetch the latest default or base branch before creating or reusing an issue branch.
- If an issue branch already exists, check whether it is behind base and bring it up to date using the repository-approved merge or rebase flow before new implementation or local validation.
- For local PR review or review-comment follow-up, switch to the PR head branch or use a dedicated worktree before running code, tests, lint, or build commands.
- If the repository uses lifecycle labels or workflow states, move the ticket to `state:in-progress` when active implementation starts.
- Refresh dependencies only when the task or validation requires it.

**Never mutate the operator's default checkout.** If the team lead's primary local clone of a
repository is checked out to the default/main branch, or to any branch carrying the team
lead's own uncommitted work, treat that working tree as read-only. All branch/commit/rebase/
stash work happens in a dedicated worktree (`git worktree add`) or a separate clone — never
`git stash`, `git checkout`, `git reset`, or any other tree-mutating command against the
operator's own checkout, even to "temporarily" get it out of the way. This applies regardless
of whether the dispatch explicitly names a worktree path: the default is isolation, not the
operator's tree, and a dispatch that forgets to say so is not permission to touch it.

If a dispatch's worktree setup fails or the target path is unexpectedly dirty, STOP and report
the exact failure — do not work around it by stashing, resetting, or otherwise touching the
operator's tree to make room. A blocked task is recoverable; an operator's uncommitted work
touched without consent is a trust failure regardless of whether the change turns out to be
reversible.

### Step 3 - Implement

#### TDD gate (Logic / Service / Bug tickets only)

Before writing any production code, when the ticket type is Logic/Service/Bug:

1. Write the failing test derived directly from the acceptance criterion — not from the intended implementation. The test should express what the criterion says, independently of how you plan to satisfy it.
2. Run it: `npm run test -- --testPathPattern=<file>` or equivalent.
3. Confirm it fails for the right reason — a meaningful assertion failure, not a missing import or syntax error.
4. Only then write the production code.

If no test surface exists for this slice, document why and add the test surface as part of the ticket scope before proceeding.

#### Implementation

- Match existing architecture, naming, and layering patterns unless they are the root cause.
- Fix the cause, not the symptom, when the scope supports it.
- Prefer local, reversible edits over speculative refactors.
- When multiple implementation paths are viable, choose the one that best fits the evidence, constraints, and first validation slice; record why.
- Keep public APIs stable unless the acceptance criteria require a change.

### Step 4 - Validate

Use this order:

1. failing or behavior-scoped check
2. narrow test for the touched slice
3. narrow build, lint, or typecheck for the touched slice
4. broader repository validation required by local policy

Validation should confirm the expected observable signal, not only command success. If the observed signal is ambiguous, do one nearby disambiguating read or check before expanding scope.

### Step 5 - Closeout

Report:

- what changed and why
- entry point and evidence that drove the change
- chosen approach or local hypothesis, especially if more than one path was viable
- first validation slice and whether it confirmed the expected next state
- validation run and result
- observable verification signals that changed, or evidence still missing
- open risks, blockers, or follow-up decisions
- manual test steps when relevant

When addressing review comments:

- fix the requested slice first
- rerun the narrowest affected validation, then repository-required checks
- push and update the PR only after the follow-up validation is in good shape

Before handoff or review request:

- complete required deploy, environment, migration, seed, or configuration steps when the repository workflow requires them
- push only after code and validation are in good shape or any remaining blocker is explicitly recorded
- open or update the PR with what changed, why, how to test, and reviewer focus when the repository uses PR workflow
- update the linked issue with implementation and validation status when the repository uses issue-based workflow
- move the ticket to the next required lifecycle state, such as `state:ready-for-review` after implementation or `state:ready-for-qa` after accepted engineering review, following local policy or `ticket-lifecycle-mode`
- **complete all active lens pre-handoff gates before moving to `state:ready-for-qa`** — post the UIX, CSV, and/or INF confirmation blocks declared at intake; a ticket with active lenses that has no confirmation blocks has not completed its gate

## Engineering Standards

### Philosophy

Use the simplest solution that satisfies the acceptance criteria and fits the existing codebase. Consistency with working project patterns beats cleverness. Apply all principles with judgment — strict adherence to any single principle at the cost of readability, simplicity, or delivery velocity is the wrong outcome.

**Rule of thumb:** Consistency within the existing codebase beats strict adherence to this document. If the existing code uses a pattern that works, follow it.

### Before Writing a Single Line

1. What patterns are already in use? Follow them unless demonstrably wrong.
2. What is the data flow? Identify the layer this change belongs to.
3. What are the side effects? Does this change affect modules beyond the ticket scope?

### SOLID Principles

Apply at the class and module level with pragmatic judgment. SOLID is a lens for reviewing code, not a construction checklist.

- **Single Responsibility** — One class, one job. If the class name includes "And" or "Also", it has too many responsibilities.
- **Open/Closed** — Design for extension without modification only when extension is a realistic near-term scenario. Do not create extension points for hypothetical future features.
- **Liskov Substitution** — Subtypes must be behaviorally substitutable. If a subclass throws `NotImplementedException` or overrides with an empty body, the hierarchy is wrong.
- **Interface Segregation** — Small, focused interfaces. Do not force consumers to depend on methods they do not use.
- **Dependency Inversion** — Inject dependencies via constructor or function parameters. Highest immediate payoff in testability.

### Clean Code

- **Naming** — Names describe intent, not implementation. Names should make code read like prose.
- **Functions** — Single purpose, short, no hidden side effects. If a function needs a comment to explain what it does, rename it.
- **Comments** — Explain why, not what. Dead code is deleted, not commented out.
- **Error handling** — Handle errors at the right level of the call stack. Use typed error classes or discriminated union Result types for expected failure paths.
- **Magic values** — Use constants with intent-revealing names. No inline literals in logic paths.

### DRY / KISS / YAGNI

- **DRY** — Do not duplicate logic. Two occurrences is not enough to justify extraction. Three in genuinely identical contexts is the right trigger.
- **KISS** — The simplest solution that satisfies every acceptance criterion is the right solution.
- **YAGNI** — Do not implement what the next ticket might need.

### Design Patterns

| Pattern | When to apply |
| ------- | ------------- |
| Repository | Data access layer. Keeps query logic out of components and makes tests injectable. |
| Factory | Constructing complex objects with three or more distinct construction paths. |
| Observer / Event Emitter | UI framework events and agent state changes. |
| Strategy | Replacing if/else or switch chains selecting between interchangeable behaviors. |
| Decorator | Extending behavior without inheritance. Prefer composition over class decorators. |
| Command | Encapsulating operations for queuing, retrying, or undoing. |

Do not apply a pattern when a plain function or module handles the job, when it requires an unapproved architectural change, or when it adds abstraction without reducing overall complexity.

### TypeScript (when the project uses TypeScript)

- `strict: true` is mandatory — no suppressions without an explanatory comment
- Prefer `interface` for public API shapes; `type` for unions, intersections, and computed types
- Return type annotations on all exported and public functions
- Prefer `readonly` on properties that must not be mutated after construction
- Avoid `any` and `unknown` without explicit narrowing at the callsite

### Testing

- add or update tests for happy path, edge cases, and failure cases covered by the change
- if a user-facing flow changes and the repository supports end-to-end coverage, add or update that coverage
- do not mark work ready for review while the touched behavior lacks validation

### Safety Rails

- do not leave `console.log` in production paths
- do not use `@ts-ignore`, `as any`, or equivalent suppressions without an exact explanation at the callsite
- do not refactor unrelated code while fixing a scoped issue
- risky commands follow Mutation Preflight in `skills/agent-foundations/SKILL.md`; in implementation, an unconfirmed target means do not run it

### Pre-PR Checklist

- [ ] Every acceptance criterion in the issue has a corresponding passing test
- [ ] No `console.log` in production code paths
- [ ] No `// @ts-ignore` or `as any` without an explanatory comment
- [ ] Naming is intent-revealing across all new and modified symbols
- [ ] No logic duplication that warrants abstraction
- [ ] Architecture decision documented in the PR if a new pattern or layer was introduced
- [ ] Build, lint, and test all pass (use the project's canonical validation command)

## Review Mode

If the request is a review rather than implementation:

- use the same shared frame, adapted for review work:

```markdown
### Entry Point
- [issue, PR, review comment, changed flow, failing check, or suspicious diff area]

### Evidence and Current State
- [exact diff hunk, file, function, test output, command result, log line, or runtime behavior]

### Review Hypothesis or Comparison
- [why the patch may be wrong, risky, incomplete, or insufficiently validated]
- [expected behavior, acceptance criterion, or safer alternative]

### Review Constraints
- [ticket scope, architecture constraints, repository rules, security requirements, migration/deploy expectations]

### First Validation Slice
- [smallest check that can confirm or falsify the concern]

### Verification Signals
- [tests, logs, metrics, traces, command output, UI states, or deployment signals that should exist if the patch is correct]
```

- capture the review entry point, evidence, local concern, first validation slice, and expected verification signals before forming conclusions
- read the issue, PR, acceptance criteria, and diff before judging the patch
- if local validation is required, switch to the PR head branch or a dedicated review worktree first
- inspect branch status against the default branch when validation or tooling results look inconsistent
- separate `branch-local defect`, `stale-branch drift`, `repo-wide blocker`, and `missing evidence` before reporting findings
- tie each finding to exact evidence, the violated expectation or acceptance criterion, and the narrowest check that would confirm the issue
- when evidence is incomplete, report `missing evidence` or request the next check instead of overstating certainty
- prioritize defects, regressions, risky assumptions, and missing tests
- present findings first, ordered by severity
- cite concrete files and functions
- make the verdict explicit and include exact implementer next steps
- keep summaries brief and secondary to findings

## Worked Examples

Illustrative only. Reuse the shape, not the repo-specific details.

### Example A - Implementation: AI Tasker explicit logout redirect (#116)

```markdown
### Entry Point
- Ticket #116 and `docs/products/logout-redirect-PRD.md`
- Shared auth sign-out path in `src/auth/AuthProvider.tsx`

### Evidence and Current State
- The PRD requires explicit logout to land on `/` with a signed-out confirmation.
- `src/components/Nav.tsx` and `src/components/Footer.tsx` both call the shared `signOut()` action.
- `src/auth/AuthProvider.test.tsx` and `tests/e2e/specs/explicit-logout.spec.ts` already cover the narrow behavior slice.

### Options or Local Hypothesis
- Local hypothesis: the correct fix belongs in the shared `AuthProvider.signOut()` path, not in each UI button.

### Implementation Constraints
- Explicit logout goes to `/`.
- Protected-route recovery still goes to `/login?redirect=...`.
- Password-reset and deletion exception flows stay unchanged.

### First Validation Slice
- Edit `src/auth/AuthProvider.tsx` only.
- Run the explicit logout unit tests before touching any nav or footer code.

### Verification Signals
- `signOut()` navigates to `/` with the signed-out state.
- The homepage shows the signed-out confirmation.
- Revisiting a protected route after logout still triggers the normal login guard.
```

### Example B - Review: AI Tasker admin project restore contract

```markdown
### Entry Point
- PR touching `supabase/migrations/20260506000001_admin_project_restore_contract.sql`
- Related UI contract in `src/lib/adminApi.ts` and `src/pages/Admin.test.tsx`

### Evidence and Current State
- The SQL contract validates `restore_request_id`, restores archived proposals transactionally, and records `restore_failed` audit events.
- `src/lib/adminApi.ts` expects `restore_request_id` and `restored_proposal_count` in the RPC payload.
- `src/pages/Admin.test.tsx` asserts that the admin UI passes `p_restore_request_id` and renders restore results and RPC errors.

### Review Hypothesis or Comparison
- Concern: a patch that changes the SQL result shape or audit behavior may be incomplete if the TypeScript mapping and tests are not updated with it.
- Expected behavior: contract changes stay aligned across SQL, client mapping, and admin UI tests.

### Review Constraints
- Admin-only authorization must remain intact.
- Invalid `restore_request_id` values must still fail predictably.
- Failed restore attempts must remain auditable.

### First Validation Slice
- Diff the SQL function contract against `src/lib/adminApi.ts`.
- Run the focused admin restore tests before making broader review claims.

### Verification Signals
- Restore RPC results still include the fields the UI consumes.
- Invalid restore request ids surface the expected error.
- The admin restore tests still pass for success, pending, and failure paths.
- Audit logging still permits `restore_failed` entries.
```

### Example C - Bugfix: AI Tasker guest guard regression with no PRD

```markdown
### Entry Point
- Failing unit test in `src/auth/RequireGuest.test.tsx`
- Guard implementation in `src/auth/RequireGuest.tsx`

### Evidence and Current State
- The failing test expects recovery-mode sessions to land on the public homepage.
- `RequireGuest.tsx` owns the redirect order for signed-in users visiting guest-only pages.
- The same file also needs to preserve admin default redirect and safe `redirect=` query handling.

### Options or Local Hypothesis
- Local hypothesis: the bug is in the guard branch order, not in routing configuration or the test harness.

### Implementation Constraints
- Signed-out users must still see guest pages.
- Signed-in admins still default to `/admin`.
- Safe redirect parsing must continue rejecting unsafe external targets.

### First Validation Slice
- Edit `src/auth/RequireGuest.tsx` only.
- Run `src/auth/RequireGuest.test.tsx` before touching any broader auth flow.

### Verification Signals
- Recovery-mode sessions redirect to `/`.
- Signed-in admins still redirect to `/admin` by default.
- Signed-in standard users still respect safe in-app `redirect=` targets.
```

## Extraction Boundary

This skill is intended to be shared across multiple software engineer agents. Keep these concerns in the owning agent profile instead of moving them here:

- identity, authority, and tone
- stakeholder-specific rules and escalation paths
- workstream or client separation rules
- memory location and update policy
- specialist mode routing, such as architecture, BD, QA, or relay orchestration