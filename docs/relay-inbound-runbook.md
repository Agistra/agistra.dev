# Relay Inbound Runbook

Manual E2E verification for Telegram → daemon inbox → Router dispatch.

---

## Prerequisites

- Relay daemon running: `npm.cmd run relay -- --hub <hub-path>`
- `workspace.config.json` has valid `telegram` block
- Optional: `relay.allowedSenders[]` lists Max bot user ID and team-lead Telegram user ID
- Router session with relay MCP tools (`relay_inbox_peek`, `relay_inbox_ack`, `relay_send`)

---

## Steps

### 1. Start the daemon

```powershell
cd D:\dev\setchin-agent-profiles
npm.cmd run relay -- --hub D:/dev/agistra.dev
```

### 2. Send a structured message in the relay group

Example from Max (remote agent) — must address Router by configured display name (`Atlas` in this hub) or `Router` when unset:

```text
Atlas, PR #<N> ready for review — issue #<N>, branch feat/issue-<N>-example-feature
```

Messages without the Router salutation are ignored by the daemon (not enqueued).

### 3. Verify job landed in inbox

```powershell
Invoke-RestMethod http://127.0.0.1:17391/inbox/stats
Invoke-RestMethod http://127.0.0.1:17391/inbox/next
```

Expect `workflow_state: review_requested`, parsed `issue` / `pr` / `branch` fields.

### 4. Router processes the job

In Claude Code or Cursor (`@router`):

```text
Process next relay inbox job — classify, dispatch if needed, compose reply, ack when done.
```

Router flow:

1. `relay_inbox_peek` → structured job
2. Classify per `telegram-relay` / `internal-relay` skills
3. Spawn subagent or compose ack
4. `relay_send` if reply warranted
5. `relay_inbox_ack({ job_id })`

### 5. Unknown sender check

Message from a Telegram user **not** in `relay.allowedSenders`:

- No outbound Telegram reply from Router/daemon for that message
- Escalation line appended to `memory/router.md` HOT

---

## Auto-dispatch

When `relay.autoDispatch: true` is set in `workspace.config.json`, the daemon spawns a headless Claude Code Router session automatically on each new inbox job. No open chat session required.

**How it works:**

1. Telegram message → daemon parses and enqueues job
2. `afterEnqueue` fires → `dispatchRouter()` spawns `claude -p "<router prompt>" --model claude-haiku-4-5-20251001`
3. Claude process runs from hub root (loads CLAUDE.md, agent profiles, MCP)
4. Router: `relay_inbox_peek` → classify → `relay_send` (if needed) → `relay_inbox_ack`
5. Lock at `relay/dispatch.lock` prevents concurrent spawns
6. Recovery poll (default 60s) resets stale `processing` jobs

**Enable auto-dispatch:**

```json
"relay": {
  "primaryRuntime": "claude-code",
  "autoDispatch": true
}
```

`npm run doctor` validates prerequisites: `claude` on PATH, router profile deployed, relay MCP wired.

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| No job after group message | Confirm chat ID matches `relay_group_id`; restart daemon |
| `job: null` on peek | Message may be from wrong chat or unknown sender escalated |
| Router lacks peek/ack | Redeploy hub with the latest relay tooling |
