---
name: bug-triage
description: "Use when drafting a bug or defect ticket, reviewing one someone else wrote, or deciding whether a reported problem is ready to file. Keeps what the reporter actually saw separate from what the agent later found out, so a reader can tell which lines are testimony and which are collected proof. Trigger phrases: 'file a bug', 'write up this defect', 'triage this report', 'is this ticket ready to file', 'what did the reporter actually see'."
argument-hint: "Bug report, defect to file, reporter's description, or ticket-readiness check"
---

# Bug Triage

A bug ticket mixes two different kinds of content: what someone reported seeing, and what an
agent went and checked afterward. Once those two get written into the same paragraph, a later
reader (Builder, the verifier, Architect re-checking the ticket weeks on) can no longer tell
which line is testimony and which line is proof — and a wrong guess buried in the middle reads
exactly as confident as a confirmed fact next to it. This skill keeps them in two named blocks
so neither one borrows the other's certainty.

## Before writing anything: check for duplicates

Search the tracker's open and closed issues for the same symptom before drafting a new ticket.
A duplicate filed fresh costs more than the few minutes a search takes, and a reporter's
exact wording is often the fastest way to find the earlier thread.

## Block 1: Observation

The reporter's own account, unedited in meaning. Capture:

- who saw it, and in what environment (version, URL, role, data state)
- what they expected versus what actually happened
- how often it occurs (always, intermittently, once) and whether they tried to reproduce it
- their own words for severity or impact, if they gave one

**Never add to this block:** reproduction steps the reporter didn't give, a guessed cause, a
proposed fix, or an impact statement the reporter didn't make. If the reporter couldn't
reproduce it, the Observation block says so plainly — "reporter could not reproduce on retry" is
a complete, filable observation. No evidence beats padded evidence: inventing steps to make the
report look more complete is worse than leaving a gap marked as a gap.

## Block 2: Evidence

Everything the agent checked afterward, as a list of dated, sourced findings — never folded back
into Block 1. Each entry records:

- the exact command or read-only query run (never a mutating command, to avoid changing the
  state under investigation)
- when it was run, and against which commit or deployed version
- the output excerpt that was actually read
- what that output does and does not support — stated as its own line, not left implied

A guess about cause still belongs here, but only labelled as a hypothesis, never stated as
settled. "Hypothesis: the retry loop in X is the likely cause, not yet confirmed by Y" is a valid
entry; "the retry loop in X causes this" without a label is not.

## Asking the reporter questions

Ask only questions whose answer would change the ticket's content or its priority. Batch every
pre-flight question into one message rather than trickling them out one at a time, and do not
re-ask something already answered earlier in the same thread.

## Worked example

```markdown
## Observation
Reported by: alex (Slack), staging environment, admin role.
Expected: clicking "export" downloads a CSV within a few seconds.
Actual: the button spins indefinitely; no file ever appears.
Frequency: happened twice today; alex did not try to reproduce further.

## Evidence
- `grep -n "export" src/routes/admin.ts` (2026-10-09, commit a1b2c3d) — the export route
  calls `generateCsv()` with no timeout and no error handling; output excerpt shows the call
  is awaited with nothing downstream to catch a rejection. Supports a stuck-promise theory;
  does not confirm `generateCsv()` itself is the failing call.
- Hypothesis (unconfirmed): `generateCsv()` hangs on large result sets — not yet checked
  against a reproduction with a known-large dataset.
```

## Relationship to other skills

- `debugging-and-error-recovery` root-causes a defect once someone has to fix it — reproduce,
  localize, reduce, fix, guard, verify. This skill only shapes how the report leading into that
  process is written; it does not reproduce, diagnose, or fix anything itself.
- `ticket-lifecycle-mode` / Root Before Repair in `agent-foundations` still govern when a fix may
  be proposed and how the ticket moves through states. This skill does not change either — a
  well-shaped Observation/Evidence ticket still needs a confirmed root cause before any fix is
  proposed.

## Out of scope

Rewriting existing tickets into this shape, GitHub issue template changes, and automated
evidence-collection tooling are not covered here — apply this shape going forward, by hand, when
drafting or reviewing a bug ticket.
