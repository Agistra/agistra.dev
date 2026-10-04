#!/usr/bin/env bash
# memory-check-message.sh — prints the shared WAL reminder text.
#
# The text lives in memory-check-message.txt with a {{MEMORY_ROOT}}
# placeholder. memory-check-message.js fills it with the tier-resolved memory
# root (the same resolution memory-check-core.js uses). If Node is unavailable
# or fails, fall back to the free-tier root ("memory"), matching what
# memory-check-core.sh does when it cannot resolve the tier.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

message=""
if command -v node > /dev/null 2>&1; then
  message="$(node "$script_dir/memory-check-message.js" 2>/dev/null || true)"
fi

if [ -z "$message" ]; then
  message="$(sed 's|{{MEMORY_ROOT}}|memory|g' "$script_dir/memory-check-message.txt")"
fi

printf '%s\n' "$message"
