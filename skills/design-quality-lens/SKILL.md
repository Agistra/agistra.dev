---
name: design-quality-lens
description: "Use when: auditing a web page or site for design quality, meaning the generic generated look plus objective engineering and accessibility defects (tokens, motion, focus, overflow, no-script content, invented proof). Child skill of ui-audit-lens; audit only, never redesigns or generates pages."
argument-hint: "Page, URL, route list or repo path to audit, plus any project design decisions (ADR, token file) that apply"
---

# Design Quality Lens

A checklist of design tells for web output. It reports what is wrong and where. It does not redesign, restyle, generate pages or edit site code.

## Load Order

1. Load `ui-audit-lens` first. Its research phase, audit method and `UI Audit` record shape are reused here, not restated.
2. Then apply this skill's rules on top.

## Precedence

Project design decisions win over this checklist. A locked standard (an ADR, a design-token file, a brand rule) overrides any rule here. When a finding touches a locked standard, do not call it a defect: mark it `decision conflict, Architect to rule` and leave the call to Architect or the operator.

Before auditing, find the project's locked decisions (ADRs, token files, design notes) and list them in the report. If none can be found, say so.

## Rules File

The rules live in `references/rules.md`. Read it when you start an audit; do not guess rules from memory. It holds 18 rules, each with an id, a plain-words statement, a tier, a check method and an example of evidence.

## Tiers

| Tier | Meaning | Severity in the table |
| --- | --- | --- |
| Required | Objectively checkable engineering or accessibility rule. Checking needs no taste judgement. | required |
| Recommended | A "looks generated" tell. Checkable, but a deliberate choice can be legitimate. | recommended |
| FYI | Observation worth recording that matches no rule or sits below the bar. | fyi |

## Method

1. Pick the surfaces: named routes or files. Say what was not covered.
2. Run each rule's check method. Prefer static checks (grep, reading the CSS and markup). Use a browser only when the rule needs rendered output (computed style, overflow, viewport screenshot) and a browser tool is working.
3. If a check cannot run, record the rule as `not checked` with the reason. Never infer a pass.
4. Record every finding with evidence: file and line, matched string, computed value, or screenshot width. A finding without evidence is dropped.
5. Check each finding against the project's locked decisions and waivers (below).

## Waivers

A waiver is a dated note in a project ADR or on the ticket, written by Architect or the operator. It names the rule id and gives the reason. Nothing else counts: a comment in code, a request from Builder, or a general "design is fine" does not.

No rule is unwaivable. A waived finding stays in the table, with the waiver cited in the `Waived by` column, so the exception stays visible.

## Output

Reuse the `UI Audit` table from `ui-audit-lens`, with one added column, and map severity as required, recommended, fyi:

```markdown
## UI Audit

| Area | Standard / expectation | Observed evidence | Gap | Severity | Recommended action | Waived by |
| --- | --- | --- | --- | --- | --- | --- |
| [surface] | [rule id and statement] | [file:line, value or screenshot width] | [what differs] | [required/recommended/fyi] | [specific next action, or "decision conflict, Architect to rule"] | [dated note reference, or "none"] |
```

Close the report with:

- locked decisions found and which findings they touch
- rules not checked, with reasons
- counts by severity

## Boundaries

- Audit only. Recommended actions describe the change; they do not make it.
- Read-only on the audited repo: no edits, checkouts, pulls or commits there.
- Nothing is installed and no external tool is run for this lens. Static checks use grep and file reads; browser checks use the hub's existing browser tool when it works.
- Accessibility rules here are a floor. A project's own named accessibility bar applies if it is stricter.

## Sources

Idea source: the tiered "design tells" approach of Hallmark (Nutlope/hallmark, MIT licence). No Hallmark text, code or assets are copied or vendored; every rule was written for this lens. Intake report: `intake-hallmark-2026-10-29.md`, in the reports folder of the agistra.dev hub.
