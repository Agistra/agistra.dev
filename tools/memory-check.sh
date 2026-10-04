#!/usr/bin/env bash
# memory-check.sh — Stop hook for Claude Code.
# Called automatically after every agent session.
#
# Delegates the platform-neutral check to memory-check-core.sh, then
# applies the Claude Code Stop-hook contract: stderr text + exit 2 feeds
# a reminder back into the model before it closes; exit 0 on clean. The
# reminder text comes from memory-check-message.sh (tier-aware memory root).

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

status=$("$script_dir/memory-check-core.sh")

if [ "$status" != "dirty" ]; then
  exit 0
fi

message=$("$script_dir/memory-check-message.sh")

echo "" >&2
first=1
while IFS= read -r line; do
  line="${line%$'\r'}"
  if [ "$first" = "1" ]; then
    echo "⚠️  $line" >&2
    first=0
  else
    echo "   $line" >&2
  fi
done <<< "$message"
echo "" >&2
exit 2
