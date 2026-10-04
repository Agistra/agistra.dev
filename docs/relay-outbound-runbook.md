# Relay Outbound Runbook

Manual E2E verification for Router → relay daemon → Telegram group.

---

## Prerequisites

- `workspace.config.json` has `remoteTeam.enabled`, `telegram.enabled`, `bot_token`, and `relay_group_id`
- Relay MCP wired in `~/.claude/settings.json` or `.cursor/mcp.json` (run `npm run setup` from hub, or see `docs/relay-setup.md`)
- Relay daemon code available (`setchin-agent-profiles` repo; the deploy pipeline copies it to `pipelines/deploy/relay/` on every hub)

---

## Steps

### 1. Start the relay daemon

From the profiles repo (reads config from the hub):

```powershell
cd D:\dev\setchin-agent-profiles
npm run relay -- --hub D:/dev/agistra.dev
```

Verify health:

```powershell
Invoke-RestMethod http://127.0.0.1:17391/health
```

### 2. Open a Router session

Claude Code or Cursor in the hub workspace (`agistra.dev`). Confirm relay MCP tools appear:

- `mcp__relay__relay_status`
- `mcp__relay__relay_send`

Redeploy agents after these relay tools land so Router's manifest includes them:

```bash
# Use your hub's tier-specific deploy command
npm run deploy:ops -- --output <hub-path>
# or npm run deploy:dev:sub -- --output <hub-path>
```

### 3. Dispatch Router with a valid state transition

Free-form messages are refused. Use the dispatch format from `skills/telegram-relay/SKILL.md`:

```text
Router, notify Max:
  Ticket: #58
  State: state:ready-for-qa
  Action: please pick up first-pass QA
  Context: relay outbound E2E probe
```

### 4. Router validates and calls relay_send

Router should:

1. Confirm the transition is on the outbound trigger table
2. Run the information-classification check
3. Call `relay_status` (optional)
4. Call `relay_send` with the templated message body

### 5. Confirm in Telegram

Check the relay group for the outbound message from your bot.

---

## Direct HTTP probe (bypass Router)

Useful to verify daemon + Telegram wiring without Router:

```powershell
Invoke-RestMethod http://127.0.0.1:17391/outbound -Method Post `
  -ContentType "application/json" `
  -Body '{"text":"relay outbound HTTP probe"}'
```

---

## GitHub Copilot path

GitHub Router has no relay MCP yet. Post outbound via daemon HTTP (see `profiles/router-workspace/ROUTING.md` curl example) until the GitHub adapter lands.

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `relay daemon not reachable` | Start daemon (step 1) |
| Router refuses free-form send | Use state-transition dispatch (step 3) |
| Router has no `relay_send` tool | Redeploy hub with the latest relay tooling |
| MCP path missing | Relay MCP server is at `pipelines/deploy/relay/mcp/server.js`; re-run the deploy if it is missing |
