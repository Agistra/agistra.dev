#!/usr/bin/env bash
# memory-check-cursor.sh — Stop hook adapter for Cursor (1.7+).
# Called automatically after every agent session via .cursor/hooks.json.
#
# Cursor's stop hook contract: read JSON on stdin (status, loop_count,
# conversation_id, ...), emit JSON on stdout, exit 0. To re-prompt the agent
# with a reminder, emit {"followup_message": "<text>"}; emit {} when clean.
# Cursor submits followup_message as the next user message, so a reminder that
# fired every time would loop: it is only given when loop_count is 0 (or
# absent), and memory-check-core.sh --stamp records it so the same work is
# reminded once.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

input="$(cat 2>/dev/null || true)"

# Vendor loop guard: this stop is already the result of a followup_message.
loop_count="$(printf '%s' "$input" | tr -d '\r\n' | grep -oE '"loop_count"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)"
if [ -n "$loop_count" ] && [ "$loop_count" -gt 0 ]; then
  echo "{}"
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
  echo "{}"
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

printf '{"followup_message": "%s"}\n' "$escaped"
exit 0
