#!/usr/bin/env bash
# memory-check-copilot.sh — agentStop hook adapter for GitHub Copilot.
# Called automatically after every agent session via .github/hooks/agent-stop.json.
#
# Copilot's agentStop contract: read JSON on stdin (sessionId, cwd,
# transcriptPath, stopReason, stop_hook_active), emit JSON on stdout, exit 0.
# To force another turn, emit {"decision": "block", "reason": "<text>"}; emit
# {"decision": "allow"} when clean. stop_hook_active is true when the turn was
# already forced to continue: never block then. memory-check-core.sh --stamp
# records the reminder so the same work is blocked on once.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

input="$(cat 2>/dev/null || true)"

# Vendor re-entry guard (camelCase or snake_case spelling).
if printf '%s' "$input" | tr -d '\r\n' | grep -qE '"(stop_hook_active|stopHookActive)"[[:space:]]*:[[:space:]]*true'; then
  echo '{"decision": "allow"}'
  exit 0
fi

if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  hub_root="$CLAUDE_PROJECT_DIR"
elif [ "$(basename "$script_dir")" = "tools" ]; then
  hub_root="$(dirname "$script_dir")"
else
  hub_root="$script_dir"
fi

status=$("$script_dir/memory-check-core.sh" --stamp)

if [ "$status" != "dirty" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Without a work marker we cannot claim files were changed: neutral wording.
message_args=()
if [ ! -f "$hub_root/.claude/.session-work" ]; then
  message_args=(--neutral)
fi
message=$("$script_dir/memory-check-message.sh" ${message_args[@]+"${message_args[@]}"})
# Strip any CR (the message may carry CRLF line endings on
# Windows), escape for JSON (backslashes, double quotes), then convert literal
# newlines to \n.
escaped=$(printf '%s' "$message" | tr -d '\r' | sed 's/\\/\\\\/g; s/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')

printf '{"decision": "block", "reason": "%s"}\n' "$escaped"
exit 0
