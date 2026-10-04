# Relay module (`pipelines/deploy/relay/`)

Hub-owned inter-team messaging infrastructure. Router (`skills/telegram-relay`) owns classification and policy; this module owns channel I/O and platform adapters.

## Layout

```
pipelines/deploy/relay/
  README.md                 ← you are here
  core/                     ← config loader, job queue, adapter interface
  telegram-relay/           ← Telegram Bot API (poll + send) — first channel
  mcp/                      ← MCP server exposing relay_* tools to Claude/Cursor
  adapters/
    github.js               ← GitHub issue/label adapter (no MCP)
```

Future channels (e.g. Slack) add `pipelines/deploy/relay/slack-relay/` implementing the same `core/` adapter contract.

## Quick start

1. **Setup:** `npm run setup` in hub — wires `mcpServers.relay` + `workspace.config.json`
2. **Daemon:** from profiles repo `npm run relay -- --hub <hub>` — or from deployed hub `npm run relay`
3. **Verify:** `npm run doctor` — relay MCP + telegram config; WARN if daemon not running
4. **Docs:** `docs/relay-setup.md` in hub after deploy

## Commands

| Command | Where | Purpose |
| ------- | ----- | ------- |
| `npm run relay -- --hub <hub>` | setchin-agent-profiles | Start telegram-relay daemon |
| `npm run relay` | deployed hub | Start daemon (`--hub .`) |
| `npm run relay:status` | either | GET `/health` on daemon port |
| `npm run doctor` | hub | Config checks including relay MCP |

Default daemon port: **17391** (`relay.daemonPort` in `workspace.config.json`).

## MCP tools

| Tool | Purpose |
| ---- | ------- |
| `relay_send` | Post validated outbound message |
| `relay_inbox_peek` | Fetch next parsed inbound job |
| `relay_inbox_ack` | Mark job processed |
| `relay_status` | Daemon health + queue depth |

MCP server entry point: `pipelines/deploy/relay/mcp/server.js --hub <hub-root>`

Setup wizard writes this into `~/.claude/settings.json` and/or `<hub>/.cursor/mcp.json`.

## Configuration

Reads hub `workspace.config.json`:

```json
{
  "remoteTeam": { "enabled": true, "agentName": "Max" },
  "agents": { "router": { "displayName": "Atlas" } },
  "telegram": {
    "enabled": true,
    "bot_token": "...",
    "relay_group_id": "-100..."
  },
  "relay": {
    "primaryRuntime": "cursor",
    "daemonPort": 17391
  }
}
```

## Runtime flows

### Inbound

Telegram group → daemon poll → parse → `<hub>/relay/inbox/` → Router `relay_inbox_peek` → classify → `relay_inbox_ack`

### Outbound

State transition → Router `relay_send` → daemon `/outbound` → Telegram (prefixed with `remoteTeam.agentName`)

## Runbooks

- Outbound: `docs/relay-outbound-runbook.md`
- Inbound: `docs/relay-inbound-runbook.md`
- GitHub: `docs/relay-github-runbook.md`

## Design authority

A single unified relay daemon handles inbound/outbound/GitHub relay traffic rather than
one daemon per channel, per this project's internal architecture record for the relay
system (not shipped in this hub).

Supported setup is relay MCP + daemon only.
