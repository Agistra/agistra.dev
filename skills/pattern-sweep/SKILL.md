---
name: pattern-sweep
description: "Use immediately after RBR confirms a root cause, or after any confirmed finding from security-audit-lens, legacy-investigation-lens, a scan skill, or a Critical/Required code-review finding, before considering the finding complete. Checks whether the confirmed defect is one instance of a structurally identical pattern elsewhere in the same file family, workflow, or business-domain area, and folds in or explicitly defers every other instance found. Mandatory for Architect — not an optional lens the agent judges when to apply."
argument-hint: "The confirmed root cause / defect just found, plus the file, workflow, or domain area it lives in"
---

# Pattern Sweep

A confirmed root cause describes one instance of a defect. It rarely describes the defect's full
blast radius. This skill is the mandatory step between "I found and fixed the reported case" and
"I am done" — spend one deliberate pass checking whether the same shape of gap exists anywhere
else structurally similar, before closing the finding.

This skill is domain-agnostic. It applies to any defect Architect confirms during ticket scoping, in code,
configuration or process. Nothing here references a specific project, stack, or business domain.

## Why this is mandatory, not optional

`assumptions-audit` already exists for pre-flight scope review, and it is explicitly optional —
Architect judges when a plan's ambiguity warrants it. This skill is different in kind: it fires
*after* a defect or finding is already confirmed (via RBR or an audit, investigation, scan, or review), not before a plan is finalized, and it is not
optional. The reasoning: an optional step only fires when the agent remembers to reach for it —
which is precisely when it is *not* needed, because the moment a root cause is confirmed is also
the moment attention is narrowest (fixed on the one reported case) and momentum is highest (toward
closing the finding, not widening it). Making the sweep mandatory removes the dependency on
remembering.

**A concrete incident that produced this skill:** an agent confirmed one real gap in a file and
fixed it. The same investigation separately found that a second location in that same file had the
identical gap, and fixed that too. But a third instance of the exact same shape existed in a
different file entirely, and it was never checked, because the investigation stopped once two
instances were found in the original file rather than asking "where else does this shape of gap
live?" It only surfaced because someone else asked a pointed question after the fact. A mandatory
sweep at the time of the original finding would have caught it without needing that prompt.

## When to load

- Architect: immediately after RBR's step 3 ("STATE the confirmed root cause with evidence"),
  before step 4 ("propose the fix") — the sweep's findings should shape the fix's actual scope, not
  arrive after the ticket is already filed.
- Architect: also after any confirmed finding from `security-audit-lens`, `legacy-investigation-lens`,
  a scan skill, or a Critical/Required code-review finding, before the finding is reported complete.

This is an always-on discipline, not a task-triggered lens — it is not listed in Architect's
conditional skills table; it is a mandatory step baked into RBR's own sequence (see
`agent-foundations/SKILL.md`'s Root Before Repair section, which cross-references this skill) and
into the confirmed-finding triggers above.

## Method

### 1. Strip the instance down to its general shape

State the defect one level of abstraction above the specific case. Not "the checkout retry prompt
has no memory of a prior decision" but "a re-entrant prompt/decision point has no memory of its own
prior resolution." If the general shape can't be stated in one sentence without naming the specific file or case, it hasn't been abstracted enough yet.

### 2. Define the family to search

Identify the smallest scope that plausibly contains other instances of the same general shape —
not the whole codebase by default, but the natural unit the original
instance belongs to:

- Code: the same file, the same file's sibling files (same naming convention, same shared
  function signature, same plugin-loader family), or every caller of a shared helper.

Widen the family only if the first pass finds nothing and the general shape (step 1) is broad
enough that a wider search is still cheap relative to the risk of missing a real instance.

### 3. Actually search it

Grep, read, or review every member of the family — not a sample, not "the ones that come to mind."
For code, this is almost always a literal `grep`/`Glob` pass against the general shape's
distinguishing signal (a function name, a prompt string pattern, an absent parameter).

### 4. For every additional instance found: fold in or defer explicitly, never drop silently

- **Fold in now** when the fix is the same shape and the additional cost is small — this is the
  default when the ticket or task is still open.
- **Defer explicitly** when folding in would meaningfully change the scope or risk of the current
  work — state the deferred instance, why it's deferred, and where it's tracked (a new ticket or a
  flagged line in the current one) so it cannot be silently lost.
- **Never** report a finding as complete while silently having found — but not mentioned — another
  instance of the same shape.

### 5. State the sweep happened

In the ticket, PR, memory entry, or report where the finding is recorded, say explicitly what was
swept and what was found: "Swept every file in the same plugin family for the same
re-entrant-prompt-with-no-memory shape — found and fixed one additional instance." A sweep that isn't
stated is indistinguishable, to anyone reviewing later, from a sweep that never happened.

## Non-goals

- This is not a license to redesign or refactor the family you searched — fixing the found
  instances of the *same* defect shape, not unrelated issues noticed along the way.
- This is not `assumptions-audit` — that interrogates a single finished plan for what it silently
  assumes, before handoff. This sweeps a *confirmed* defect's blast radius across a family of
  similar cases, after root-causing, and is mandatory rather than judged case-by-case.
- Do not let the sweep become the reason a fix ships late. If the family is large and the sweep
  itself would take meaningfully longer than the original fix, timebox it, state what was and
  wasn't covered, and say so explicitly rather than silently truncating the search.
