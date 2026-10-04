#!/usr/bin/env bash
# memory-check-cursor.sh — Stop hook adapter for Cursor (1.7+).
# Called automatically after every agent session via .cursor/hooks.json.
#
# Cursor's stop hook contract: read JSON on stdin (status, workspace_roots, etc.
# — unused here), emit JSON on stdout, exit 0. To re-prompt the agent with a
# reminder, emit {"followup_message": "<text>"}; emit {} when clean.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Drain stdin (Cursor sends hook payload JSON) — unused by the core check.
cat > /dev/null || true

status=$("$script_dir/memory-check-core.sh")

if [ "$status" != "dirty" ]; then
  echo "{}"
  exit 0
fi

message=$("$script_dir/memory-check-message.sh")
# Strip any CR (the message may carry CRLF line endings on
# Windows), escape for JSON (backslashes, double quotes), then convert literal
# newlines to \n.
escaped=$(printf '%s' "$message" | tr -d '\r' | sed 's/\\/\\\\/g; s/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')

printf '{"followup_message": "%s"}\n' "$escaped"
exit 0
