#!/usr/bin/env bash
# memory-session-start.sh — SessionStart hook adapter for Cursor and Copilot.
# Writes the session-start marker (.claude/.session-start) that the WAL
# memory-check Stop hook compares memory writes against. Bash twin of
# memory-session-start.js. Always exits 0 and emits {} so it satisfies hook
# contracts that expect JSON on stdout.

set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Drain stdin (the platform sends hook payload JSON) — unused.
cat > /dev/null || true

if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  hub_root="$CLAUDE_PROJECT_DIR"
elif [ "$(basename "$script_dir")" = "tools" ]; then
  hub_root="$(dirname "$script_dir")"
else
  hub_root="$script_dir"
fi

{ mkdir -p "$hub_root/.claude" && date -u +"%Y-%m-%dT%H:%M:%SZ" > "$hub_root/.claude/.session-start"; } 2>/dev/null || true

# Initialise the work marker at the Unix epoch when absent: "present but older
# than the session marker" means no work yet (silent), whereas an absent marker
# means the adapter has no post-tool hook (marker-only fallback).
work_marker="$hub_root/.claude/.session-work"
if [ -d "$hub_root/.claude" ] && [ ! -e "$work_marker" ]; then
  { : > "$work_marker" && { touch -d @0 "$work_marker" 2>/dev/null || touch -t 197001010000 "$work_marker"; }; } 2>/dev/null || true
fi

echo "{}"
exit 0
