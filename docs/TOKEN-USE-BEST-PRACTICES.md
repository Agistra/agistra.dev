# Token Use Best Practices

How to keep token spend down when working with Architect, Builder and the other agents. This applies to **every hub tier and every provider** — on per-token billing (a metered cloud model-hosting provider, direct API keys) it is money; on a subscription it is rate-limit headroom.

**Which tool are you using?** Agistra hubs support Claude Code, Cursor, Codex and GitHub Copilot. The habits and ticket practices below apply to all of them. Anything marked **(Claude Code)** is specific to Claude Code (its slash commands, its cloud-hosted model-provider setup, its agent resume). Other tools have equivalent controls under their own names, such as a "new chat" action and a model picker; look for those.

## Where tokens go

Four things drive the bill. Everything below is aimed at one of them.

| Driver | What happens |
| --- | --- |
| **Dispatch overhead** | Every agent dispatch starts cold: it loads its profile, memory and skills before doing any work. Ten tiny dispatches pay that cost ten times. |
| **Context re-sent every turn** | The whole conversation so far is sent to the model on every turn. Long sessions get more expensive per message, not just in total. |
| **Model tier** | A lighter model costs a fraction of a heavier one per token. |
| **Session length** | The longer a session runs, the larger the context that is re-sent (see above). |

## What the agents do for you

- **Batch small tickets.** Architect is meant to bundle small, independent fixes into one ticket and one Builder dispatch instead of one dispatch each. Bundling is only for work that is *small and independent* — large or interdependent work keeps its own ticket.
- **Late additions join the existing ticket.** If a ticket exists and you decide to fix two more small things, they are added to that ticket rather than becoming new ones.
- **One tracker issue per bundle.** A bundled ticket is tracked as a single issue, not one per item.
- **The model is chosen per ticket.** Architect picks the model for each Builder ticket: the lighter model for small mechanical changes, the heavier model for anything with side effects or judgment.
- **Verification is never reduced to save tokens.** Independent review and QA run at full depth regardless of cost. If a change is too risky to verify properly, it is not cheap — it is unfinished.

## What you can do

These are operator habits. Agents cannot enforce them for you.

1. **Start sessions on the lighter model.** Opening a session ("Hi Architect") is mechanical — reading a profile and memory files — and does not need a heavy model. Switch models when the work needs judgment: scoping, design decisions, reviewing a hard change (**Claude Code:** `/model`). **(Claude Code)** Some cloud-hosted model-provider configurations already default to a lighter model.
   - **New hub, first session:** the Bootstrap Self-Check (identity, skills catalogue, protocols, workspace signals, readiness verdict, plus the fan-out to the other agents) is mechanical and fine to run on the lighter model. Skim the combined report for overclaims: a "doctor passes" that is really just a field check, or a flat "setup has not run" on a fresh vault-tier hub. If it looks wrong, re-run it on the heavier model. Then switch up for the first real work, such as setup issues or scoping.
2. **Start a fresh conversation and say "Hi Architect" before each new task or a different project** (**Claude Code:** `/clear`). One goal per session. Carrying the old conversation into unrelated work means every new message re-sends context it does not need. A fresh conversation drops it; the agent's memory files carry over what matters, so nothing is lost.
3. **Compact when you must continue** (**Claude Code:** `/compact`). If the same task has grown a long conversation and you still need its thread, compact it instead of starting fresh. Start fresh whenever the next piece of work is separate.
4. **Say what you want in one go.** Several small requests in one message cost less than a back-and-forth of one request per turn.
5. **Point at files instead of pasting them.** Give the agent a path and let it read what it needs.

## Which model for which task

Start on the lighter model. Switch up once, early, when the work needs judgment, and stay there — caches are per model, so each switch makes the next turn re-send the whole context uncached. Do the light work first as a batch instead of hopping back and forth.

| Task | Model |
| --- | --- |
| Session start ("Hi Architect"), bootstrap on a new hub | Lighter |
| Start-of-day "Good morning Team" briefing (read-only; collects and pastes each agent's bullets) | Lighter |
| Mechanical ticket and status bookkeeping: transitions, syncing stale notes, closing merged work | Lighter |
| Discussing the project, grilling, scoping, design decisions | Heavier |
| Reviewing a PR or verifying Builder's work, including deciding whether it passes | Heavier |
| End-of-day "Good night Team" (dreaming): promoting what memory carries forward, compacting it, checking for contradictions | Heavier |
| Anything else needing deep reasoning | Heavier |

If you are unsure, use the heavier model. A wrong answer from a light model costs more than the tokens it saved.

## Spawning agents

- **Do small non-code jobs inline.** Every fresh dispatch pays the full cold-start cost (profile, memory, skills, and the context you have to re-explain). Reading a file, checking a ticket, searching, or drafting a document is cheaper done in the current session than handed to a new agent.
- **Code changes stay with Builder, however small.** Role separation is not a cost lever. For small code fixes the saving comes from bundling them into one ticket (see above), not from letting Architect edit.
- **(Claude Code) Resume instead of restarting.** When an agent hits a rate limit or stalls, continuing it is cheaper than launching a new one and re-explaining everything. An agent you stopped yourself cannot be resumed, so stop only when you mean it.
- **Watch long-running dispatches.** If an agent has been running far longer than the ticket's size suggests, check on it early rather than paying for another hour. Small, tightly scoped tickets are the best protection.

## Measure it

Without numbers this is guesswork. Check spend in your provider's billing view (for example your cloud provider's cost-explorer tooling, if you run a metered cloud model-hosting setup) before and after changing habits, and judge by what a finished task cost, not by a single request.

## Prompt caching

This section is about Claude models. Anthropic prompt caching is supported on metered cloud model-hosting providers as well as on the direct API, with the same proportional discount on repeated content. (That cloud-hosted model-provider setup in these hubs is **Claude Code** only.) If your tool runs a different provider's model, check that provider's caching rules. There is nothing to configure in this hub. We have not measured hit rates, so do not assume savings from it — the habits above are what reliably move the bill.

## What we deliberately do not do

We do not trade quality for cost. Batching, lighter models for mechanical work and shorter sessions save tokens without weakening verification. Skipping review, thinning acceptance criteria or using a light model for judgment-heavy decisions saves tokens by making the output worse, and that is not offered as a saving.
