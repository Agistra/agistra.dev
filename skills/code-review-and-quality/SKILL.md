---
name: code-review-and-quality
description: "Conducts multi-axis code review. Use before merging any change. Use when reviewing code written by yourself, another agent, or a human. Use when you need to assess code quality across multiple dimensions before it enters the main branch."
argument-hint: "PR review, code review, or diff quality question"
---

<!-- Source: addyosmani/agent-skills | Copyright 2025 Addy Osmani | MIT -->

# Code Review and Quality

## Overview

Multi-dimensional code review with quality gates. Every change gets reviewed before merge — no exceptions. Review covers five axes: correctness, readability, architecture, security, and performance.

**The approval standard:** Approve a change when it definitely improves overall code health, even if it is not perfect. Perfect code does not exist — the goal is continuous improvement. Do not block a change because it is not exactly how you would have written it. If it improves the codebase and follows the project's conventions, approve it.

**VBR approval gate:** Approval is a VBR gate — all Critical issues resolved AND tests pass AND build passes before reporting LGTM.

**CI parity check:** run `ci:local`, or read the PR's CI result, before reporting LGTM — a local pass alone does not confirm CI parity.

## When to Use

- Before merging any PR or change
- After completing a feature implementation
- When another agent or model produced code you need to evaluate
- When refactoring existing code
- After any bug fix (review both the fix and the regression test)

## Relationship to Native Review Tools

- **On Claude Code:** run the built-in `/code-review` command first for a fast, diff-scoped automated pass, then apply this skill's five-axis framework on top. `/code-review` covers the pending changeset quickly; this skill adds the structured severity vocabulary, confidence tiers, and the VBR gate that the native command does not produce.
- **On Codex:** the same relationship applies to `codex review`, which is backed by the `review-agent` system skill and produces a read-only, defect-first diff review. Run it first, then apply this skill's framework for the structured output.
- **On Cursor or GitHub Copilot:** no comparable native review command exists — apply this skill's five-axis framework directly.

Either way, the VBR approval gate — all Critical issues resolved AND tests pass AND build passes before reporting LGTM — is owned by this skill, never by the native command. A passing native review does not satisfy the VBR gate.

## The Five-Axis Review

Every review evaluates code across these five dimensions:

### 1. Correctness

Does the code do what it claims to do?

- Does it match the spec or task requirements?
- Are edge cases handled (null, empty, boundary values)?
- Are error paths handled (not just the happy path)?
- Does it pass all tests? Are the tests actually testing the right things?
- Are there off-by-one errors, race conditions, or state inconsistencies?

### 2. Readability and Simplicity

Can another engineer (or agent) understand this code without the author explaining it?

- Are names descriptive and consistent with project conventions? (No `temp`, `data`, `result` without context)
- Is the control flow straightforward (avoid nested ternaries, deep callbacks)?
- Is the code organized logically (related code grouped, clear module boundaries)?
- Are there any "clever" tricks that should be simplified?
- Could this be done in fewer lines? (1000 lines where 100 suffice is a failure)
- Are abstractions earning their complexity? (Do not generalize until the third use case)
- Would comments help clarify non-obvious intent? (But do not comment obvious code.)
- Are there dead code artifacts: no-op variables, backwards-compat shims, or `// removed` comments?

### 3. Architecture

Does the change fit the system's design?

- Does it follow existing patterns or introduce a new one? If new, is it justified?
- Does it maintain clean module boundaries?
- Is there code duplication that should be shared?
- Are dependencies flowing in the right direction (no circular dependencies)?
- Is the abstraction level appropriate (not over-engineered, not too coupled)?

### 4. Security

Does the change introduce vulnerabilities?

- Is user input validated and sanitized?
- Are secrets kept out of code, logs, and version control?
- Is authentication/authorization checked where needed?
- Are SQL queries parameterized (no string concatenation)?
- Are outputs encoded to prevent XSS?
- Are dependencies from trusted sources with no known vulnerabilities?
- Is data from external sources (APIs, logs, user content, config files) treated as untrusted?
- Are external data flows validated at system boundaries before use in logic or rendering?
- No internal ticket/issue/ADR number citations in code comments or content (see `agent-foundations` Security Baseline).

### 5. Performance

Does the change introduce performance problems?

- Any N+1 query patterns?
- Any unbounded loops or unconstrained data fetching?
- Any synchronous operations that should be async?
- Any unnecessary re-renders in UI components?
- Any missing pagination on list endpoints?
- Any large objects created in hot paths?

## Change Sizing

Small, focused changes are easier to review, faster to merge, and safer to deploy. Target these sizes:

| Lines changed | Status |
|---------------|--------|
| ~100 lines | Good. Reviewable in one sitting. |
| ~300 lines | Acceptable if it is a single logical change. |
| ~1000 lines | Too large. Split it. |

**What counts as "one change":** A single self-contained modification that addresses one thing, includes related tests, and keeps the system functional after submission. One part of a feature — not the whole feature.

**Splitting strategies when a change is too large:**

| Strategy | How | When |
|----------|-----|------|
| Stack | Submit a small change, start the next one based on it | Sequential dependencies |
| By file group | Separate changes for groups needing different reviewers | Cross-cutting concerns |
| Horizontal | Create shared code/stubs first, then consumers | Layered architecture |
| Vertical | Break into smaller full-stack slices of the feature | Feature work |

**When large changes are acceptable:** Complete file deletions and automated refactoring where the reviewer only needs to verify intent, not every line.

**Separate refactoring from feature work.** A change that refactors existing code and adds new behavior is two changes — submit them separately. Small cleanups (variable renaming) can be included at reviewer discretion.

## Five-Step Review Process

### Step 1: Understand the Context

Before looking at code, understand the intent:

- What is this change trying to accomplish?
- What spec or task does it implement?
- What is the expected behavior change?

**Gather your own evidence.** The reviewer pulls the diff directly (`gh pr diff` or equivalent), reads the changed files, and runs the test suite itself in an isolated worktree. An automated or third-party review tool's output (e.g. GitHub Copilot's PR review) is not a substitute for this independent pass — treat it, at most, as one more input to weigh alongside your own reading of the diff and your own test run, never as the review itself.

### Step 2: Review the Tests First

Tests reveal intent and coverage:

- Do tests exist for the change?
- Do they test behavior (not implementation details)?
- Are edge cases covered?
- Do tests have descriptive names?
- Would the tests catch a regression if the code changed?

### Step 3: Review the Implementation

Walk through the code with the five axes in mind:

For each file changed:
1. Correctness: Does this code do what the test says it should?
2. Readability: Can I understand this without help?
3. Architecture: Does this fit the system?
4. Security: Any vulnerabilities?
5. Performance: Any bottlenecks?

### Step 4: Label Findings

Label every comment with its severity so the author knows what is required vs optional, and with its confidence tier (see Confidence Tiers below) so the author knows how sure the review is:

| Label | Meaning | Author Action |
|-------|---------|---------------|
| _(no prefix)_ | Required change | Must address before merge |
| **Critical:** | Blocks merge | Security vulnerability, data loss, broken functionality |
| **Nit:** | Minor, optional | Author may ignore — formatting, style preferences |
| **Optional:** / **Consider:** | Suggestion | Worth considering but not required |
| **FYI** | Informational only | No action needed — context for future reference |

This prevents authors from treating all feedback as mandatory and wasting time on optional suggestions.

### Step 5: Verify the Verification

Check the author's verification story:

- What tests were run?
- Did the build pass?
- Was the change tested manually?
- Are there screenshots for UI changes?
- Is there a before/after comparison?

## Enforcement Points

- **No deferred cleanup.** Do not accept "I'll fix it later." Require cleanup before merge unless it is a genuine emergency. If surrounding issues cannot be addressed in this change, require filing a bug with self-assignment.
- **Respond within one business day.** This is the maximum, not the target. Slow reviews block entire teams. A typical change should complete multiple review rounds in a single day.
- **Prioritize fast individual responses** over quick final approval. Quick feedback reduces frustration even if multiple rounds are needed.
- **Large changes:** Ask the author to split them rather than reviewing one massive changeset.

## Severity Label Definitions

| Label | Definition |
|-------|------------|
| **Critical** | Blocks merge. Security vulnerability, data loss, or broken functionality. Must be resolved before any approval. |
| **Required** | Must be addressed before merge. Not as severe as Critical but non-negotiable. |
| **Nit** | Minor style or formatting point. Author may ignore at their discretion. |
| **Optional** / **Consider** | A suggestion worth thinking about but not required for this change. |
| **FYI** | Informational only. No action required — context for future reference. |

## Confidence Tiers

Severity and confidence answer different questions, and a finding needs both:

- **Severity** — how bad is this *if it's real*?
- **Confidence** — how sure am I that it's real?

A Critical finding can still be unconfirmed (a suspected race condition spotted from code shape, never actually reproduced). A trivial style nit can be 100% certain. Neither axis implies the other — set both independently on every finding.

Confidence is graded by the kind of evidence behind the finding, not by an abstract numeric estimate:

| Tier | Evidence basis |
|------|-----------------|
| **Confirmed** | Directly reproduced — a failing test, an actual stack trace or build error, or a concrete input/output trace walked through the code that demonstrates the problem. |
| **Likely** | Strong circumstantial evidence — the code matches a known bug class (e.g. a value the type/contract allows to be null is dereferenced unguarded) or clearly violates a documented project convention with a specific counter-example, but wasn't directly executed or reproduced. |
| **Speculative** | An inference from code shape alone, with no concrete trace, reproduction, or pattern match — "this could break if X happens" without evidence that X happens here. |

**Reporting rule:**

- **Confirmed** and **Likely** findings are always reported, at whatever severity they carry.
- **Speculative** findings are reported only when severity is **Critical** or **Required**, and must carry an explicit `(unconfirmed)` tag — never presented as settled fact.
- **Speculative** findings at **Nit**, **Optional**, or **FYI** severity are suppressed. This is the noise the tiering exists to cut: low-stakes guesses that cost the author more attention than they're worth.

This is a tiering by evidence type, not a percentage score — a reviewer (human or agent) should be able to point at *why* a finding sits in its tier, not just assert a number.

**Precedent check, before tiering a shape-based finding:** A finding inferred from code shape alone — a widened query, a new abstraction, an altered control-flow branch — that is not a directly reproduced failure needs one more step before it can be tiered Confirmed or Likely: grep the codebase for whether the same pattern already ships elsewhere as an accepted convention. A pattern that already ships unremarked elsewhere is counter-evidence, not confirmation — downgrade the finding to Speculative (and drop it per the suppression rule above if its severity isn't Critical or Required) rather than posting it and waiting for the author to supply the precedent that was available before the review shipped.

## Red Flags

- PRs merged without any review
- Review that only checks if tests pass (ignoring other axes)
- "LGTM" without evidence of actual review
- Security-sensitive changes without security-focused review
- Large PRs that are "too big to review properly" — split them
- No regression tests with bug fix PRs
- Review comments without severity labels — makes it unclear what is required vs optional
- A Speculative finding presented without the `(unconfirmed)` tag, or any Speculative finding reported at Nit/Optional/FYI severity — exactly the noise the confidence tiers exist to suppress
- Accepting "I'll fix it later" — it never happens
- AI-generated code treated as automatically correct — it needs more scrutiny, not less

## Verification Checklist

```
## Review: [PR/Change title]

### Context
- [ ] I understand what this change does and why

### Correctness
- [ ] Change matches spec/task requirements
- [ ] Edge cases handled
- [ ] Error paths handled
- [ ] Tests cover the change adequately

### Readability
- [ ] Names are clear and consistent
- [ ] Logic is straightforward
- [ ] No unnecessary complexity

### Architecture
- [ ] Follows existing patterns
- [ ] No unnecessary coupling or dependencies
- [ ] Appropriate abstraction level

### Security
- [ ] No secrets in code
- [ ] Input validated at boundaries
- [ ] No injection vulnerabilities
- [ ] Auth checks in place
- [ ] External data sources treated as untrusted
- [ ] No internal ticket/issue/ADR citations in code or content

### Performance
- [ ] No N+1 patterns
- [ ] No unbounded operations
- [ ] Pagination on list endpoints

### Verification
- [ ] Tests pass
- [ ] Build succeeds
- [ ] Manual verification done (if applicable)

### Confidence
- [ ] Every finding carries a confidence tier (Confirmed/Likely/Speculative) alongside its severity
- [ ] No Speculative finding is reported below Critical/Required without an explicit `(unconfirmed)` tag

### VBR Gate
- [ ] All Critical issues resolved
- [ ] Tests pass
- [ ] Build passes

### Verdict
- [ ] Approve — Ready to merge (VBR gate passed)
- [ ] Request changes — Issues must be addressed
```

## Common Rationalizations

| Rationalization | Reality |
|-----------------|---------|
| "It works, that's good enough" | Working code that is unreadable, insecure, or architecturally wrong creates debt that compounds. |
| "I wrote it, so I know it is correct" | Authors are blind to their own assumptions. Every change benefits from another set of eyes. |
| "We'll clean it up later" | Later never comes. The review is the quality gate — use it. Require cleanup before merge, not after. |
| "AI-generated code is probably fine" | AI code needs more scrutiny, not less. It is confident and plausible, even when wrong. |
| "The tests pass, so it is good" | Tests are necessary but not sufficient. They do not catch architecture problems, security issues, or readability concerns. |

## Dependency Discipline

Part of code review is dependency review. Before adding any dependency:

1. Does the existing stack solve this? (Often it does.)
2. How large is the dependency? (Check bundle impact.)
3. Is it actively maintained? (Check last commit, open issues.)
4. Does it have known vulnerabilities? (`npm audit`)
5. What is the license? (Must be compatible with the project.)

Prefer standard library and existing utilities over new dependencies. Every dependency is a liability.
