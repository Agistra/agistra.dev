#!/usr/bin/env bash
# memory-check-copilot.sh — agentStop hook adapter for GitHub Copilot.
# Called automatically after every agent session via .github/hooks/agent-stop.json.
#
# Copilot's agentStop contract: read JSON on stdin (sessionId, cwd, transcriptPath,
# stopReason — unused here), emit JSON on stdout, exit 0. To force another turn,
# emit {"decision": "block", "reason": "<text>"}; emit {"decision": "allow"} when clean.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Drain stdin (Copilot sends hook payload JSON) — unused by the core check.
cat > /dev/null || true

status=$("$script_dir/memory-check-core.sh")

if [ "$status" != "dirty" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

message=$("$script_dir/memory-check-message.sh")
# Strip any CR (the message may carry CRLF line endings on
# Windows), escape for JSON (backslashes, double quotes), then convert literal
# newlines to \n.
escaped=$(printf '%s' "$message" | tr -d '\r' | sed 's/\\/\\\\/g; s/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')

printf '{"decision": "block", "reason": "%s"}\n' "$escaped"
exit 0
