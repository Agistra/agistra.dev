#!/usr/bin/env bash
# memory-check-core.sh — platform-neutral WAL memory-check logic.
#
# Checks whether files were changed this session (git status --porcelain)
# without a corresponding update to the hub's live memory directory (git
# status, falling back to filesystem mtime within the last 240 minutes since
# that directory may be gitignored in some hubs).
#
# The live memory directory is tier-aware: free-tier hubs (dev, dev:graph)
# store memory at memory/*.md; vault-backed hubs (dev:sub, ops, publish)
# store it at vault/Memory/*.md instead (see
# pipelines/deploy/lib/memory-root.js's resolveMemoryRootForHub() — the
# single source of truth every other tier-aware consumer already uses). This
# script shells out to Node to call that function directly rather than
# reimplementing the vault-tier list a third time. If Node is unavailable or
# the call fails for any reason, it falls back to the free-tier default
# ("memory") — the pre-existing behaviour this script has always had.
#
# Contract (consumed by platform adapters — no platform-specific formatting here):
#   stdout: "clean" or "dirty"
#   exit code: always 0 (the core never fails the calling shell; adapters
#              decide how to surface "dirty" to their platform)
#
# Adapters source the shared reminder text from memory-check-message.txt
# (same directory as this script) rather than duplicating the message.

set -euo pipefail

# Resolve to the hub root before any check, regardless of the session shell's
# cwd. A session that has cd'd into a foreign repo (e.g. another project
# working dir) must not have its dirty/no-memory state misreported as the
# hub's.
#
#   1. CLAUDE_PROJECT_DIR, when set (Claude Code always sets it) — trust it.
#   2. Otherwise fall back to this script's own repo root, discovered via
#      `git rev-parse --show-toplevel` from the script's directory. This
#      keeps the fallback adapter-agnostic (Copilot/Codex/Cursor have no
#      CLAUDE_PROJECT_DIR) with no hard Claude dependency in the core.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  hub_root="$CLAUDE_PROJECT_DIR"
else
  hub_root="$(cd "$script_dir" && git rev-parse --show-toplevel 2>/dev/null || true)"
  hub_root="${hub_root:-$script_dir}"
fi

cd "$hub_root" 2>/dev/null || true

# Nothing to check if this isn't a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "clean"
  exit 0
fi

# Collect tracked changes relative to HEAD
status=$(git status --porcelain 2>/dev/null || true)

if [ -z "$status" ]; then
  # No changes — nothing to remember
  echo "clean"
  exit 0
fi

# Resolve the tier-aware memory root segment ("memory" or "vault/Memory") by
# shelling out to Node to call resolveMemoryRootForHub() directly — the same
# function pipelines/deploy/lib/session-cli.js already uses for this exact
# "hubRoot only, no pre-parsed config" case. Any failure (node missing,
# workspace.config.json absent/unreadable, memory-root.js missing) falls
# back to "memory", matching this script's pre-existing free-tier-only
# behaviour.
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

# The resolved memory root may be excluded from git tracking — check
# filesystem mtime instead. Any *.md modified in the last 4 hours counts as
# updated this session.
if find "$memory_root_segment/" -maxdepth 1 -name "*.md" -mmin -240 2>/dev/null | grep -q .; then
  echo "clean"
  exit 0
fi

# Work happened but memory was not updated
echo "dirty"
exit 0
