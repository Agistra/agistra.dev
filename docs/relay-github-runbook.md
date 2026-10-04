# Relay GitHub Runbook

GitHub Copilot can use the same **relay MCP** as Claude/Cursor once wired in repo or user settings. Until then, this adapter uses a **tracking issue** for inbound and an optional **labeled issue + Action** for outbound — both talk to the same local relay daemon.

---

## Prerequisites

- Relay daemon running: `npm run relay -- --hub <hub-path>`
- `workspace.config.json` configured via setup wizard:
  - `relay.github.trackingIssue`: `owner/repo#N`
  - `relay.primaryRuntime`: `github` (when GitHub is the only agent platform)
- `GITHUB_TOKEN` in environment when daemon posts inbound comments
- Copy `pipelines/deploy/relay/adapters/github-action.yml` → `.github/workflows/relay-notify.yml`

---

## Inbound — Telegram → GitHub tracking issue

When `relay.primaryRuntime` is `github`, each new inbox job triggers a comment on the tracking issue:

```markdown
@router INBOUND from remote team
- job_id: `<uuid>`
- workflow_state: `review_requested`
- issue: #42
- pr: ...
- raw: ...
```

**Router on GitHub:** open the tracking issue in Copilot, read the `@router INBOUND` comment, classify, and respond (manual agent session until GitHub supports triggers).

Claude/Cursor hubs (`primaryRuntime` not `github`) use `relay_inbox_peek` instead — no GitHub comment is posted.

---

## Outbound — GitHub issue → Telegram

1. Create or edit a GitHub issue with body:

```markdown
## relay:outbound

Ticket #58 in state:ready-for-qa, please pick up first-pass QA.
```

2. Add label **`relay:notify`**

3. Workflow `.github/workflows/relay-notify.yml` POSTs to `RELAY_DAEMON_URL/outbound` (repository variable, default `http://127.0.0.1:17391`)

4. Daemon prefixes `remoteTeam.agentName` and sends to Telegram.

**Alternative:** Router in Copilot documents `curl`:

```powershell
Invoke-RestMethod http://127.0.0.1:17391/outbound -Method Post `
  -ContentType "application/json" `
  -Body '{"text":"Ticket #58 in state:ready-for-qa"}'
```

---

## Setup wizard

When `.github/agents/` is detected and remote team is enabled:

```bash
npm run setup -- --output <hub-path>
```

Prompts for `Relay tracking issue (owner/repo#N)` and writes `relay.github.trackingIssue`.

---

## Supersedes

Replaces a prior standalone GitHub poller's inbound half with the unified relay daemon design.

---

## Copilot MCP vs GitHub Action — keep or remove?

**Recommendation: do not remove the Action template yet.**

| Path | Use when |
| ---- | -------- |
| **Relay MCP** (`relay_send`) | Copilot agent session — Router sends outbound during work (preferred once wired) |
| **`relay:notify` Action** | Label-driven automation **without** an open agent session (CI, manual issue triage, mobile) |
| **curl / runbook** | One-off manual probes |

Once Copilot repo MCP points at `pipelines/deploy/relay/mcp/server.js --hub <hub>`, agent-driven outbound **does not need** the Action. The workflow remains useful as an optional fallback — it is low maintenance and does not conflict with MCP (same `/outbound` API).

**Cleanup guidance (future):**

- Once Copilot MCP is verified on your hub, you may **skip installing** `.github/workflows/relay-notify.yml` — no requirement to delete the template from `setchin-agent-profiles`.
- Remove the installed workflow from a hub repo only if you confirm nobody uses label-triggered outbound and you rely entirely on MCP + daemon.
- Do **not** remove `github.js` tracking-issue inbound until `relay_inbox_peek` fully replaces that path for GitHub-primary hubs.

Track optional cleanup in a follow-up ticket after Copilot MCP E2E passes.
