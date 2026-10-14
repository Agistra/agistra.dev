#!/usr/bin/env bash
# memory-check-core.sh — platform-neutral WAL memory-check logic.
#
# "Work happened this session" is decided by a session marker, not by git:
# a SessionStart hook (memory-session-start.sh / .js) writes a timestamp file
# at .claude/.session-start (gitignored, outside the memory root). This check
# reports "dirty" when no *.md file under the tier's memory root (recursive,
# excluding archive/) has an mtime newer than that marker. When the marker is
# missing it falls back to a 240-minute window. No git calls, so it works on
# hubs that are not git repos and on hubs whose own tree stays clean because
# agents work in other repos. memory-check-core.js implements the same logic;
# both are exercised by the same shared test cases.
#
# Work marker: every adapter's post-tool hook runs
# memory-work-marker.sh/.js, which touches .claude/.session-work when a tool
# changed something. When that marker exists the check is: dirty only if it is
# newer than the session marker AND no memory *.md is newer than it. A work
# marker older than the session marker is left over from an earlier session:
# clean. "Newer" allows a 30-second tolerance (MEMORY_WRITE_TOLERANCE_MS in
# memory-check-core.js) because the post-tool hook touches the work marker just
# after the memory write itself. Without a work marker the marker-only behaviour above applies.
#
# Once per stop: with the --stamp argument, a "dirty" result also writes
# .claude/.session-reminded. A stamp not older than the work marker (or, with
# no work marker, the session marker) makes the check report "clean", so the
# same work is reminded once.
#
# The live memory directory is tier-aware: free-tier hubs (dev, dev:graph)
# store memory under memory/; vault-backed hubs (dev:sub, ops) store it under
# vault/Memory/ (see pipelines/deploy/lib/memory-root.js's
# resolveMemoryRootForHub() — the single source of truth every other
# tier-aware consumer already uses). This script shells out to Node to call
# that function directly rather than reimplementing the vault-tier list a
# third time. If Node is unavailable or the call fails for any reason, it
# falls back to the free-tier default ("memory").
#
# Contract (consumed by platform adapters — no platform-specific formatting here):
#   stdout: "clean" or "dirty"
#   exit code: always 0 (the core never fails the calling shell; adapters
#              decide how to surface "dirty" to their platform)
#
# Adapters get the shared, tier-aware reminder text from
# memory-check-message.sh (same directory as this script) rather than
# duplicating the message.

set -euo pipefail

# Resolve to the hub root before any check, regardless of the session shell's
# cwd. A session that has cd'd into a foreign repo (e.g. another project
# working dir) must not have its dirty/no-memory state misreported as the
# hub's.
#
#   1. CLAUDE_PROJECT_DIR, when set (Claude Code always sets it) — trust it.
#   2. Otherwise this script's own location: the parent of the tools/
#      directory it ships in (or its own directory when not inside tools/).
#      Adapter-agnostic (Copilot/Codex/Cursor have no CLAUDE_PROJECT_DIR), no git.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  hub_root="$CLAUDE_PROJECT_DIR"
elif [ "$(basename "$script_dir")" = "tools" ]; then
  hub_root="$(dirname "$script_dir")"
else
  hub_root="$script_dir"
fi

cd "$hub_root" 2>/dev/null || true

# Resolve the tier-aware memory root segment ("memory" or "vault/Memory") by
# shelling out to Node to call resolveMemoryRootForHub() directly — the same
# function pipelines/deploy/lib/session-cli.js already uses for this exact
# "hubRoot only, no pre-parsed config" case. Any failure (node missing,
# workspace.config.json absent/unreadable, memory-root.js missing) falls
# back to "memory".
memory_root_segment="memory"
if command -v node > /dev/null 2>&1; then
  resolved_segment="$(node -e '
    const path = require("node:path");
    const url = require("node:url");
    (async () => {
      try {
        const modPath = path.resolve(process.cwd(), "pipelines/deploy/lib/memory-root.js");
        const { resolveMemoryRootForHub } = await import(url.pathToFileURL(modPath).href);
        const absRoot = resolveMemoryRootForHub(process.cwd());
        process.stdout.write(path.relative(process.cwd(), absRoot).split(path.sep).join("/"));
      } catch {
        process.stdout.write("memory");
      }
    })();
  ' 2>/dev/null || true)"
  if [ -n "$resolved_segment" ]; then
    memory_root_segment="$resolved_segment"
  fi
fi

session_marker=".claude/.session-start"
work_marker=".claude/.session-work"
reminded_stamp=".claude/.session-reminded"

# Any *.md under the memory root (recursive, archive/ excluded) newer than the
# given file counts as a memory update.
memory_newer_than() {
  [ -d "$memory_root_segment" ] && \
    find "$memory_root_segment" -type d -name archive -prune -o -type f -name "*.md" -newer "$1" -print 2>/dev/null | grep -q .
}

# Work marker shifted back by the 30-second tolerance (MEMORY_WRITE_TOLERANCE_MS
# in memory-check-core.js), as a reference file for find -newer. Prints its path,
# or nothing when it cannot be built (the caller then compares to the marker).
tolerance_ref() {
  local ref mtime shifted
  ref="$(mktemp 2>/dev/null)" || return 0
  mtime="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)" || { rm -f "$ref"; return 0; }
  shifted=$(( mtime - 30 ))
  if touch -d "@$shifted" "$ref" 2>/dev/null ||      touch -t "$(date -r "$shifted" +%Y%m%d%H%M.%S 2>/dev/null)" "$ref" 2>/dev/null; then
    echo "$ref"
  else
    rm -f "$ref"
  fi
}

# Same files modified within the last 240 minutes (no-marker fallback).
memory_recent() {
  [ -d "$memory_root_segment" ] && \
    find "$memory_root_segment" -type d -name archive -prune -o -type f -name "*.md" -mmin -240 -print 2>/dev/null | grep -q .
}

# File the reminded stamp is compared with: the work marker when it counts,
# else the session marker (empty when neither exists).
baseline=""

if [ -f "$work_marker" ]; then
  # Work marker present: it only counts when it postdates the session start
  # (or, without a session marker, when it is within the 240-minute window).
  if [ -f "$session_marker" ]; then
    if ! [ "$work_marker" -nt "$session_marker" ]; then
      echo "clean"
      exit 0
    fi
  elif [ -z "$(find "$work_marker" -mmin -240 2>/dev/null)" ]; then
    echo "clean"
    exit 0
  fi
  tol_ref="$(tolerance_ref "$work_marker")"
  if memory_newer_than "${tol_ref:-$work_marker}"; then
    [ -z "$tol_ref" ] || rm -f "$tol_ref"
    echo "clean"
    exit 0
  fi
  [ -z "$tol_ref" ] || rm -f "$tol_ref"
  baseline="$work_marker"
else
  # No work marker: marker-only fallback.
  if [ -f "$session_marker" ]; then
    if memory_newer_than "$session_marker"; then
      echo "clean"
      exit 0
    fi
    baseline="$session_marker"
  elif memory_recent; then
    echo "clean"
    exit 0
  fi
fi

# Already reminded for this work: the stamp is not older than the baseline.
if [ -f "$reminded_stamp" ]; then
  if [ -z "$baseline" ]; then
    if [ -n "$(find "$reminded_stamp" -mmin -240 2>/dev/null)" ]; then
      echo "clean"
      exit 0
    fi
  elif ! [ "$baseline" -nt "$reminded_stamp" ]; then
    echo "clean"
    exit 0
  fi
fi

# Memory was not updated this session. With --stamp, record that the reminder
# is being given so the same work is not reminded twice.
if [ "${1:-}" = "--stamp" ]; then
  { mkdir -p .claude && date -u +"%Y-%m-%dT%H:%M:%SZ" > "$reminded_stamp"; } 2>/dev/null || true
fi
echo "dirty"
exit 0
