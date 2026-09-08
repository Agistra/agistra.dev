---
name: legacy-investigation-lens
description: "Use when: investigating a legacy, inherited, third-party-built, or otherwise newly-unfamiliar codebase before scoping a migration or major refactor. Formalizes a repeatable five-step investigation pass — entry-point census, business-rule classification, side-effect/idempotency cataloging, implicit-contract discovery, semantic-duplication detection — plus a canonical per-project Open Questions document. Requires checkable signals: ticket keywords or prior documentation gaps. Not a mandatory gate; reserved for entry-point-heavy work in code areas with no prior investigation record."
argument-hint: "Legacy module, unfamiliar codebase, or migration/refactor ticket to investigate before scoping"
---

# Legacy Investigation Lens

Use this skill as a stack-agnostic method for understanding an unfamiliar legacy module before
committing to a migration, refactor, or fix plan. It does not replace dependency mapping
(`graph-lens`), structural mapping (`scan-sys`), or the design process itself (`architecture-mode`).
It fills the gap between "I can see the code" and "I understand what it actually does, what
happens if it breaks, and who else depends on its current shape" — the reading and classification
pass that has to happen before any of those other tools produce a trustworthy result.

Nothing in this skill assumes a specific language, framework, or hosting model. No
framework-specific example code is baked into the procedure below — categories and worked
examples are illustrative; the investigation itself supplies the concrete evidence from the actual
module under review.

## When to Load

Load this skill when the work involves any of the following:

- The ticket, project, or team lead's own framing uses words like legacy, inherited, third-party-built,
  lift-and-shift, migrate, or modernize — a direct signal that this code is being treated as
  unfamiliar territory requiring a formal investigation pass before scoping.
- No ADRs, architecture docs, or prior Architect/Builder memory entries exist yet for this module.
  Architect can verify this by checking `docs/decisions/` for existing ADRs on this module, searching
  memory via `npm run memory-index -- find <module-name>` (on `dev`/`dev:graph` tiers), and
  confirming zero HOT/WARM/COLD coverage of this codebase area in prior sessions — an absence that
  signals this is the first recorded investigation of this module.
- the team lead or a ticket explicitly asks for an upfront investigation pass before scoping begins

Do not treat this as a mandatory gate on every ticket. Routine tickets in a well-understood area of
the codebase do not need a formal census — reactive, per-ticket discovery is fine there. Reserve
this skill for entry-point-heavy unfamiliar-territory work, mirroring how `security-audit-lens` is
not a mandatory gate on every ticket either.

## Relationship to `architecture-mode`

This pass runs **before or alongside** `architecture-mode` when the ticket involves an unfamiliar
legacy module — it does not run after. `architecture-mode` turns understanding into a decision;
this skill produces the understanding `architecture-mode` needs to make that decision safely. On a
familiar module, `architecture-mode` can proceed directly. On an unfamiliar one, run this
investigation first (or interleave the two — surfacing an implicit contract mid-investigation can
immediately reshape the architecture question being asked) so the resulting ADR or ticket is
grounded in verified findings rather than assumptions about what the legacy code does.

## Evidence Discipline (Read First)

Apply the same evidence discipline as VBR and as `security-audit-lens`'s Evidence Discipline
section:

- Every classification, cataloged side effect, or discovered contract must cite the actual file
  path and line number (or the smallest locatable unit — function, table name, endpoint) where the
  evidence was observed.
- If you suspect a business rule, side effect, or consumer exists but have not located concrete
  evidence, do not classify it. Record it as an entry in the Open Questions artifact instead of
  guessing.
- Prefer under-reporting with an explicit "not fully covered" note over over-reporting with
  low-confidence guesses. A confident wrong classification is worse than an honest "unknown."

## Step 1 — Entry-Point Census

Before touching anything, sweep the module for every way execution can enter it. Search each
category systematically rather than stopping at the first obvious path:

| Category | What to search for |
| --- | --- |
| HTTP endpoints | Route definitions, controller/handler registrations, API gateway configs |
| Scheduled jobs | Cron definitions, task scheduler configs, timer-triggered functions |
| Queue / event consumers | Message queue subscribers, event bus handlers, webhook receivers |
| Webhooks | Inbound webhook routes, signature-verification middleware naming a specific caller |
| Direct calls from other repos/modules | Cross-repo imports, shared-library function calls, internal SDK usage, direct DB/API access that bypasses this module's own interface |
| Manual/operator-triggered entry | Admin scripts, CLI tools, one-off maintenance endpoints |

Record each entry point found, its trigger category, and its file/route location. An entry point
with no located evidence (suspected but not found) goes into the Open Questions artifact, not the
census — the census only records what was actually located.

## Step 2 — Business-Rule Classification

Classify every conditional, validation, or branching decision found during investigation into one
of four categories. This is a 4-way taxonomy, not a binary "rule or not":

| Category | Definition | Evidence bar |
| --- | --- | --- |
| **Explicit rule** | The business intent is directly readable — a comment, a named validation, or a domain-named constant states why the check exists | A comment, docstring, or self-documenting name naming the business reason |
| **Likely rule** | The code shape strongly suggests intentional business logic, but no comment or naming confirms it | A consistent, repeated pattern across multiple call sites using the same threshold/condition |
| **Infrastructure concern** | The check exists for technical/operational reasons (performance, retry safety, resource limits), not business intent | The value or condition maps to a known technical concern (timeout, batch size, pool size, retry cap) rather than a domain rule |
| **Unknown** | A condition or branch exists with no confident classification possible from the evidence at hand | None yet — this is exactly what it means to be Unknown; log it as an Open Question rather than guessing |

### Worked Example

```
if (amount > 10000) {
  requireManagerApproval(); // Regulatory threshold — approval required above $10k
}
```
→ **Explicit rule** (`payment.js:42`). The comment states the business reason directly.

```
if (retryCount > 3) {
  return calculateWithFallback();
}
```
appearing with the same magic number `3` in five independent modules, with no comment anywhere.
→ **Likely rule** (`orders.js:88`, `invoices.js:31`, `shipments.js:120`, ...). The repetition across
independently-written modules suggests a shared business ceiling, not a coincidence, but nothing
confirms the intent.

```
connectionPool.maxSize = 20;
```
→ **Infrastructure concern** (`db-config.js:15`). This is a resource-sizing decision, not a business
rule — do not classify infrastructure tuning as a business rule just because it uses a number.

```
if (record.status === 'X3') {
  skipNotification(record);
}
```
with no comment, no other reference to status code `X3` anywhere else in the codebase, and no
domain documentation naming it.
→ **Unknown** (`notifications.js:203`). Log as an Open Question: "What does status `X3` represent,
and is skipping notification for it still correct behavior?"

## Step 3 — Side-Effect / Idempotency Cataloging

Distinct from Step 2: for each entry point found in Step 1, catalog every observable consequence it
produces — not what decision it makes, but what it actually changes in the outside world.

For each entry point, build a row:

| Entry point | Side effect | Sync/Async | Idempotent? | Retry-safe? |
| --- | --- | --- | --- | --- |
| [entry point from census] | [DB write / message sent / email sent / cache mutation / file written / external API call] | [sync/async] | [yes/no — re-running produces the same end state] | [yes/no — safe to retry without side-effect duplication, e.g. a de-dupe key or upsert vs. a bare INSERT/send] |

A migration or lift-and-shift that re-triggers a non-idempotent side effect (duplicate email sent,
duplicate charge, duplicate write on retry) is a worse failure mode than a missed business rule —
treat gaps in this catalog as high-priority Open Questions, not as a lower-priority nice-to-have.

## Step 4 — Implicit Contract Discovery

Before "cleaning up" an API response shape, database table, export format, or error message,
enumerate who actually consumes it today. Do not infer consumers from the shape alone — verify by
searching for actual consumption:

- grep the current repo and any sibling/consumer repos for the literal endpoint path, table name,
  column name, export filename pattern, or exact error-message string
- check API gateway or service-mesh routing configs for registered consumers of the endpoint
- check for generated/exported schemas (OpenAPI, GraphQL SDL, Avro/Protobuf) that name the contract
  and cross-reference who imports them
- check scheduled export/import jobs and data-warehouse ingestion configs that may consume a table
  or file format without going through the module's own interface
- ask whether the shape is consumed cross-database or cross-repo (a table read directly by a
  different service's queries, not just through this module's own API)

Record each discovered consumer with its location (file/config) and how it consumes the contract
(read/write, exact fields relied on). A consumer suspected but not located goes into Open
Questions, not the discovery table.

## Step 5 — Semantic Duplication Detection

Look for cases where two or more modules implement the same business capability independently,
under different names or shapes — the kind of overlap `scan-sys`'s structural/syntactic checks
cannot see because the code is not textually similar, only semantically similar.

This step is explicitly harder to mechanize than the previous four and relies on the investigating
agent's own reading, not a script:

- when reading two modules that operate on the same domain concept (e.g. two independent
  validation paths for the same entity), compare what business outcome each one actually produces,
  not just their code shape
- watch for the same vocabulary (field names, status codes, business terms) appearing in unrelated
  modules — a strong signal that they evolved to solve the same problem separately
- when two independent implementation branches of the same capability are found running
  simultaneously, flag it as a finding requiring reconciliation, not merely a duplication note —
  running two independent implementations of the same business capability concurrently is a
  correctness risk, not just a maintenance cost

Record findings as: capability, the modules/functions implementing it, evidence of overlap, and
whether they currently agree or disagree in behavior.

## Open Questions Artifact

This pass produces one canonical per-project document: the **Open Questions** doc. Every
unresolved item surfaced in Steps 1–5 — a suspected entry point not located, an Unknown-classified
rule, a side effect whose idempotency could not be confirmed, a suspected consumer not found, or a
duplication finding not yet reconciled — lands here rather than scattered across HOT memory prose
or a chat transcript.

### Location

Create the document via the active storage plugin's `create-document` operation (see
`agent-foundations`' Storage Plugin Contract), never a hardcoded vault-only or repo-only path.
This Open Questions doc is project-scoped content, not a hub-wide report — pass the project id
as the `collection` argument and a bare, un-prefixed filename:

```
create-document("<project>", "open-questions.md", content)
```

On a repo-files-backed hub this resolves to `projects/<project>/docs/open-questions.md` (see
`storage/repo-files.md`'s Document store section for the full project-scoped path rule) — not
`docs/reports/...`. This skill does not assume the resolved path beyond what the active plugin's
contract defines.

### Required Sections

```markdown
# <Project> — Open Questions

## Entry-Point Census
[summary table or link to where the full census lives]

## Business-Rule Classification
[summary of explicit/likely/infrastructure/unknown counts, link to full classification]

## Side-Effect / Idempotency Catalog
[summary of entry points with unresolved idempotency status]

## Implicit Contracts
[summary of discovered and suspected-but-unconfirmed consumers]

## Semantic Duplication Findings
[summary of overlap findings, including any requiring reconciliation]

## Open Questions

| # | Question | Raised during | Status | Answer (when resolved) |
| --- | --- | --- | --- | --- |
| 1 | [specific, answerable question] | [Step 1-5 that surfaced it] | Open / Answered | [evidence-backed answer, or blank while open] |
```

### Living-Document Rule

Finding the answer to a listed question **updates the existing row** in the Open Questions doc —
it does not leave the row stale and does not spawn a second document. Update `Status` to
`Answered` and fill in the `Answer` column with the evidence that resolved it (file/line, log
output, or a confirmed test result). A stale "Open" row sitting next to a codebase change that
already answered it is a documentation defect, not a harmless leftover.

## What This Skill Does Not Do

- It does not replace `graph-lens`'s dependency mapping or `scan-sys`'s structural/syntactic
  checks — Step 5's semantic duplication is explicitly the gap those tools cannot see, not a
  replacement for what they already do well.
- It does not replace `architecture-mode`'s design process — it produces the grounded
  understanding that process needs, it does not make the design decision itself.
- It does not automate the census, classification, or duplication passes as scripts. These rely on
  the investigating agent's own reading and judgment, not deterministic tooling.
- It is not a mandatory gate on every ticket — invoke it for entry-point-heavy unfamiliar-territory
  work, not for routine changes in a well-understood area.
- It does not retroactively require re-running itself over every existing project the moment it
  ships — apply it going forward, on new unfamiliar-legacy-module work.

## Relationship to Other Skills

- `architecture-mode` — this pass runs before or alongside `architecture-mode` on unfamiliar
  legacy-module tickets; see the dedicated section above.
- `assumptions-audit` — a different scope and timing: `assumptions-audit` runs over a *finished*
  plan/ticket/ADR to surface unstated assumptions in that plan. This skill runs *earlier*, directly
  over the legacy codebase, before a plan exists to audit.
- `scan-sys` — covers structural/syntactic file organisation and module boundaries; this skill's
  entry-point census and semantic-duplication detection complement it by finding runtime entry
  paths and business-logic overlap that structural analysis alone does not surface.
- `graph-lens` — covers real dependency-graph mapping; use it for "what depends on what," and use
  this skill for "what does this code actually do, and who else relies on its current behavior."
- `documentation-and-adrs` — the Open Questions artifact reuses this skill's document-store
  conventions (`create-document`, collection naming) rather than inventing a new storage
  convention.
- `skill-quality-review` — applies when editing this skill.
