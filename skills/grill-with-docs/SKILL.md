---
name: grill-with-docs
description: "One-question-at-a-time design interrogation. Use when: 'grill me', 'interrogate this', 'one question at a time', 'brainstorm', 'let's brainstorm', 'let's discuss', or design review start. Produces ADRs and glossary as decisions settle. Do not use for settled designs — load architecture-mode instead."
argument-hint: "Design question, plan, topic, or decision under interrogation"
---

# grill-with-docs

> Adapted from https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs (MIT License). Vendored as a core workspace skill.

A relentless, docs-aware interview that sharpens a plan or design one question at a time — and writes durable documentation (ADRs, glossary) as the answers settle.

## When to load

- **Architect:** load before any design interrogation, brainstorm session, scoping session, or ADR work where the design is not yet settled
- **Publishing Lead (future):** load before any topic approval, editorial review, or release gating decision

## Protocol

1. **One question at a time.** Never ask multiple questions in a single turn. Identify the most important open question, ask it, and wait for the answer before moving on.
2. **Evidence first.** When an answer is ambiguous or abstract, ask for a concrete example before accepting it.
3. **State a recommendation once you have a basis for one.** When enough context has been established to form a real view, state a concrete recommendation with reasoning before presenting alternatives — do not default to a neutral menu of options when there is enough information to have an opinion. Early in a session, when little is settled yet, open questions without a stated opinion remain appropriate. The user disagreeing with a stated recommendation is a fine, expected outcome; offering no recommendation at all when one could have been formed is the failure mode to avoid.
4. **Name load-bearing assumptions.** When an answer closes a design option, state the assumption explicitly before moving to the next question.
5. **Write as you go.** After each settled decision, immediately update the WAL — write the decision to the HOT section of `memory/<agent>.md` (or the active storage plugin's memory store on vault-backed tiers — see the storage-plugin note below) — then draft the corresponding ADR entry or glossary term inline. Do not batch documentation for after the session. Do not advance to the next question before the WAL/memory entry is written.
6. **Close with docs (VBR required).** When the session concludes:
   - Produce one ADR per settled decision, a glossary of key terms introduced, and any scope exclusions made explicit.
   - Optionally load `ui-audit-lens` when the interrogation is about UI standards, a design system, or a concrete UI surface — worthwhile when the settled decision needs a research snapshot, structured audit findings, or a pre-handoff UI state coverage gate before the docs are written.
   - Optionally load `assumptions-audit` for a structured pass over the settled decision before writing the ADRs — worthwhile when the interrogation surfaced enough edge cases or scope ambiguity to warrant a second, structured look. Not required for every session.
   - **Verify Before Reporting:** confirm each ADR file exists under `docs/decisions/` with the decision and rationale documented before declaring the session closed.

## Session flow

```
Start   → State the design question, plan, or topic under interrogation (one sentence)
Grill   → One question → answer → assumption check → WAL update → document → next question
Close   → ADR per decision + glossary + explicit exclusions
```

## Do not

- Ask compound questions ("and also, what about…")
- Accept vague answers without requesting a concrete example
- Advance to the next question before the current answer is settled and documented
- Advance to the next question before the WAL/memory entry is written (do not outrun the WAL)
- Defer documentation to after the session ends
- Default to a neutral A/B/C-style menu of options once enough context exists to state a real recommendation — lead with the recommendation and reasoning, note alternatives only if useful

## Storage-plugin note

**Storage-plugin note (`memory/<agent>.md` reference in the WAL step above):** before writing to `memory/<agent>.md`, check for an active storage plugin file at `agents/skills/agent-foundations/storage/*.md` — the same presence-gated check `agent-foundations`'s Memory Path Resolution protocol uses. If no plugin file is present, the literal `memory/<agent>.md` path is correct as-is (free-tier default). If a plugin file is present (vault-backed hub type, e.g. `dev:sub`/`ops`/`publish`), the literal repo-relative path is wrong — write instead via that plugin's `write-memory-entry(agent, 'HOT', content)` operation (see `agent-foundations`'s Memory Path Resolution protocol and the active plugin file, e.g. `storage/obsidian.md`, for the authoritative procedure). Writing to the literal path on a vault-backed tier creates a stray file outside the vault, bypassing the knowledge index.
