---
name: token-economics
description: "Token budgeting discipline for all agents. Treats tokens as a resource from session start — not just when the buffer hits 60%. Covers prompt compression, context hygiene, handoff packing, and HOT memory pruning."
argument-hint: "Context management, token budgeting, session handoff, or prompt efficiency question"
---

# Token Economics

Tokens are a resource. Treat them as a budget from the first message, not a crisis to manage when the buffer alarm fires.

Inspired by the [Caveman](https://getcaveman.dev) token compression philosophy (MIT License): tighter semantic frames improve both cost and model reasoning quality. The working buffer protocol in `proactive-agent` is the crisis backstop — this skill is the upstream discipline that delays or avoids that crisis.

---

## Budget-First Mindset

Before every response, ask: is this response as compact as it can be while still being useful?

- Prefer a file reference over re-pasting file content into chat.
- Prefer a symbol name + line number over quoting a block of code.
- Prefer a one-sentence decision summary over re-explaining the context.
- If a question can be answered with one sentence, use one sentence.

---

## Read Hygiene

- Check for existing pre-computed artifacts before a multi-file Grep sweep — pre-computed graphs answer caller/callee/hotspot questions for free; paying for repeated Grep passes over source or memory that's already indexed is a budget leak. Two such artifacts, both presence-gated (check the file exists before assuming it's shipped, per the Optional Skill Presence Check pattern in `agent-foundations`): an optional codebase-intelligence lens skill for source-code queries, and — on `dev`/`dev:graph` tiers only, if `pipelines/deploy/lib/memory-index.js` is present — `npm run memory-index -- find <keyword>` for cross-entry memory lookups.
- Don't re-read a file you already read in the same session unless its content may have changed.
- Don't re-read a skill or profile already loaded this session.
- When a tool result is large, extract only the relevant fragment and discard the rest mentally.
- If a read returns more than needed, work from the relevant part — don't quote the whole result back.

---

## Working Buffer Compression

When writing to `memory/working-buffer.md` or `memory/<agent>.md` (or the active storage plugin's memory store on vault-backed tiers — see the storage-plugin note below):

- Write the **decision or outcome**, not the conversation.
- Write the **current state**, not how you got there.
- If a fact is derivable from the code or git history, don't store it in memory — read it when needed.
- HOT memory is for things that will vanish on compaction. If it survives a `grep`, it doesn't need to be in HOT.

---

## Handoff Packing

When handing off between agents or sessions:

- Pass: the decision made, constraints it created, and the next concrete action.
- Don't pass: the full conversation, the reasoning path, or the context already in the ticket.
- If handing off to Builder, the ticket IS the context — don't duplicate it in the dispatch message.
- If handing off at session end, update `memory/<agent>.md` HOT section (or the active storage plugin's memory store on vault-backed tiers — see the storage-plugin note below) and stop. The next session reads memory, not chat history.

---

## HOT Memory Pruning

Aggressively retire HOT items:

- If a decision is confirmed and has no open action, move it to WARM.
- If an item has been in HOT for more than 48 hours with no reference, move it to WARM.
- If an item is recoverable from a git log, ticket, or file read, remove it from HOT entirely.
- A long HOT section is a signal that decisions aren't being closed — not a sign of thoroughness.

---

## Prompt Construction

When invoking a subagent or spawning a task:

- Include only the context the subagent cannot derive itself.
- Name the exact file, line, or artifact — don't describe it in prose.
- State the question or task in one sentence before any supporting context.
- Remove the supporting context if the subagent can read it directly.

---

## Storage-plugin note

**Storage-plugin note (`memory/<agent>.md` references above, in Working Buffer Compression and Handoff Packing):** before writing to `memory/<agent>.md`, check for an active storage plugin file at `agents/skills/agent-foundations/storage/*.md` — the same presence-gated check `agent-foundations`'s Memory Path Resolution protocol uses. If no plugin file is present, the literal `memory/<agent>.md` path is correct as-is (free-tier default). If a plugin file is present (vault-backed hub type, e.g. `dev:sub`/`ops`/`publish`), the literal repo-relative path is wrong — write instead via that plugin's `write-memory-entry(agent, tier, content)` operation (see `agent-foundations`'s Memory Path Resolution protocol and the active plugin file, e.g. `storage/obsidian.md`, for the authoritative procedure). Writing to the literal path on a vault-backed tier creates a stray file outside the vault, bypassing the knowledge index.
