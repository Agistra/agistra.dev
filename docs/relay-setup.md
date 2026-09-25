# Relay setup guide

Unified inter-team relay: Telegram group I/O via a local daemon, agent tools via **relay MCP** — not the Claude official Telegram plugin.

---

## Prerequisites

- Telegram bot from [@BotFather](https://t.me/BotFather) (token + handle)
- Bot added as **admin** to your relay group
- Node.js 20+ (same as hub)
- `setchin-agent-profiles` repo cloned (daemon runs from profiles; hub holds config + inbox queue)

---

## 1. Hub setup wizard

From the hub directory:

```bash
npm run setup
# or: node cli/setup.js --output <hub-path>
```

When prompted:

- **Enable remote team:** Yes
- **Telegram bot handle / token / relay group ID:** your values
- **Router display name** (e.g. `Atlas`) — inbound salutation filter
- **Remote agent name** (e.g. `Max`) — outbound prefix

The wizard writes:

- `workspace.config.json` (gitignored) — credentials + relay settings
- `mcpServers.relay` in `~/.claude/settings.json` and/or `<hub>/.cursor/mcp.json`

Re-run setup after changing tokens or MCP targets.

---

## 2. Auto-dispatch (Claude Code hubs)

When `relay.primaryRuntime: "claude-code"` and `relay.autoDispatch: true` are set, the daemon spawns a headless Router session for each new inbox job automatically — no `@router` required.

**Setup writes `primaryRuntime: "claude-code"` automatically** when `.claude/agents/` is detected during `npm run setup`. Enable auto-dispatch manually after verifying the hub:

```json
"relay": {
  "primaryRuntime": "claude-code",
  "autoDispatch": true,
  "dispatchTimeoutSec": 300,
  "recoveryPollSec": 60,
  "processingTimeoutSec": 600
}
```

`autoDispatch` defaults to `false` to avoid unexpected API spend. Enable explicitly after `npm run doctor` passes checks 10–12.

**Doctor checks when autoDispatch enabled:**

| Check | Level |
| ----- | ----- |
| `claude` on PATH | FAIL if missing |
| `.claude/agents/router.md` deployed | FAIL if missing |
| relay MCP wired | FAIL if missing (check 7) |
| daemon reachable | WARN if down (check 6) |
| router model = economy tier | WARN if mismatch |

---

## 3. Start the relay daemon (manual / Cursor)

**Claude Code (automatic):** when `remoteTeam` + `telegram` are enabled, opening the hub in Claude runs a **SessionStart** hook — exec form: `{"type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/tools/ensure-relay-daemon.js"]}` — that starts the daemon if it is not already listening on port 17391. Exec form bypasses shell interpretation entirely, so this runs identically regardless of which shell Claude Code selects to spawn hooks — this is what makes the hook work correctly on native Windows PowerShell, which does not expand a bare `$VAR` the way a shell-form command would need it to. Re-deploy or re-run setup to install the hook on an existing hub.

**Manual start** (Cursor, troubleshooting, or before hook is installed):

```bash
npm run relay -- --hub D:/path/to/your/hub
```

From a **deployed hub** (after the deploy pipeline copies `cli/relay/`):

```bash
npm run relay
# health: npm run relay:status
```

Daemon listens on `relay.daemonPort` (default **17391**). Inbox jobs persist at `<hub>/relay/inbox/`.

For **Cursor** or if autostart fails, keep the daemon running in a terminal during relay sessions.

---

## 4. Verify with doctor

```bash
npm run doctor
```

When `remoteTeam.enabled`, doctor checks:

| Check | Expect |
| ----- | ------ |
| relay daemon | WARN if daemon not running |
| relay MCP | PASS when `mcpServers.relay` wired (Claude and/or Cursor) |
| telegram config | PASS when `telegram.enabled`, token, and group id set |

---

## 5. Platform paths

### Claude Code

- MCP: `~/.claude/settings.json` → `mcpServers.relay`
- Router tools: `relay_send`, `relay_status`, `relay_inbox_peek`, `relay_inbox_ack`
- Inbound: invoke `@router`, then `relay_inbox_peek` → classify → `relay_inbox_ack`

### Cursor

- MCP: `<hub>/.cursor/mcp.json` → `mcpServers.relay`
- Same Router tools as Claude

### GitHub Copilot (no MCP session)

- Inbound: tracking issue comments when `relay.primaryRuntime === 'github'`
- Outbound: prefer **relay MCP** once wired in repo/user settings; optional **`relay:notify`** Action as label-driven fallback — see [relay-github-runbook.md](./relay-github-runbook.md)

---

## 6. Runbooks

| Flow | Doc |
| ---- | --- |
| Outbound (Router → Telegram) | [relay-outbound-runbook.md](./relay-outbound-runbook.md) |
| Inbound (Telegram → inbox → Router) | [relay-inbound-runbook.md](./relay-inbound-runbook.md) |
| GitHub adapter | [relay-github-runbook.md](./relay-github-runbook.md) |

Module reference: `cli/relay/README.md` in setchin-agent-profiles.

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `relay MCP` doctor FAIL | Re-run `npm run setup`; confirm `mcpServers.relay` in Claude settings or `.cursor/mcp.json` |
| `relay daemon` doctor WARN | Start `npm run relay -- --hub <hub>` |
| MCP tools missing in session | Restart Claude/Cursor after setup |
| Outbound works, inbound silent | Message must address Router (`Atlas, …` or `@bot`); see inbound runbook |
| `cli/relay/mcp/server.js` not found on hub | Rerun the tier-specific deploy command to copy `cli/relay/` |
