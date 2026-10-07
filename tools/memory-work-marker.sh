#!/usr/bin/env bash
# memory-work-marker.sh — post-tool-use hook adapter for Cursor and Copilot.
# Bash twin of memory-work-marker.js: reads the hook JSON on stdin, and when
# the tool changed something (edit/write/shell, not read/search) touches the
# work marker .claude/.session-work in the hub root. A shell call whose command
# text is made only of allowlisted read-only verbs is not a change; unknown,
# unparseable or missing command text counts as a change (fail safe). Missing
# or invalid input writes nothing. Always exits 0 and emits {} so it satisfies
# hook contracts that expect JSON on stdout.

set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

input="$(cat 2>/dev/null || true)"

if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  hub_root="$CLAUDE_PROJECT_DIR"
elif [ "$(basename "$script_dir")" = "tools" ]; then
  hub_root="$(dirname "$script_dir")"
else
  hub_root="$script_dir"
fi

bs="$(printf '\134')"   # a single backslash, kept out of patterns for readability
ph="$(printf '\001')"   # placeholder for an escaped backslash while decoding

# extract_command <flat json> -> decoded command text on stdout; exit 1 when the
# payload carries no (decodable) command string. JSON escapes other than
# quote, backslash and slash make the text undecodable; callers treat that as "work".
extract_command() {
  extract_string "$1" 'command'
}

# is_read_only_segment <segment> -> 0 when the segment starts with an allowlisted read-only verb.
is_read_only_segment() {
  local -a w
  local verb a
  read -ra w <<< "$1"
  [ "${#w[@]}" -gt 0 ] || return 1
  verb="$(printf '%s' "${w[0]}" | tr 'A-Z' 'a-z')"
  case "$verb" in
    git)
      for a in "${w[@]}"; do
        case "$(printf '%s' "$a" | tr 'A-Z' 'a-z')" in --output*) return 1 ;; esac
      done
      case "$(printf '%s' "${w[1]:-}" | tr 'A-Z' 'a-z')" in
        status|log|diff|show|rev-parse|merge-base) return 0 ;;
        branch) [ "${w[2]:-}" = "--list" ] && return 0 ;;
      esac
      return 1
      ;;
    gh)
      local area action
      area="$(printf '%s' "${w[1]:-}" | tr 'A-Z' 'a-z')"
      action="$(printf '%s' "${w[2]:-}" | tr 'A-Z' 'a-z')"
      case "$area" in
        pr|issue|run) case "$action" in view|list|checks) return 0 ;; esac ;;
        repo) [ "$action" = "view" ] && return 0 ;;
      esac
      return 1
      ;;
    find)
      for a in "${w[@]:1}"; do
        case "$(printf '%s' "$a" | tr 'A-Z' 'a-z')" in
          -delete|-exec|-execdir|-ok|-okdir|-fprint|-fprint0|-fprintf|-fls) return 1 ;;
        esac
      done
      return 0
      ;;
    date)
      for a in "${w[@]:1}"; do
        case "$(printf '%s' "$a" | tr 'A-Z' 'a-z')" in -s|--set*) return 1 ;; esac
      done
      return 0
      ;;
    rg)
      for a in "${w[@]:1}"; do
        case "$(printf '%s' "$a" | tr 'A-Z' 'a-z')" in --pre|--pre=*) return 1 ;; esac
      done
      return 0
      ;;
    ls|dir|cat|head|tail|grep|pwd|stat|wc|get-content|get-childitem|get-date|select-string|test-path)
      return 0
      ;;
  esac
  return 1
}

# is_read_only_command <text> -> 0 only when every pipeline segment is read-only.
is_read_only_command() {
  local cmd="$1" rest seg lower
  [ -n "${cmd//[[:space:]]/}" ] || return 1
  case "$cmd" in
    *'>'*|*';'*|*'&'*|*'<'*|*'`'*|*'$('*|*$'\n'*|*$'\r'*) return 1 ;;
  esac
  lower="$(printf '%s' "$cmd" | tr 'A-Z' 'a-z')"
  if printf '%s' "$lower" | grep -qE '(^|[^a-z0-9_-])(tee|out-file|set-content|add-content)($|[^a-z0-9_-])'; then
    return 1
  fi
  rest="$cmd"
  while :; do
    seg="${rest%%|*}"
    is_read_only_segment "$seg" || return 1
    case "$rest" in
      *'|'*) rest="${rest#*|}" ;;
      *) break ;;
    esac
  done
  return 0
}

# norm_path <path> -> canonical comparison form on stdout: forward slashes, no
# duplicate slashes, a Windows drive "C:/x" becomes "/c/x" (as Git Bash writes
# it), no trailing slash. Exit 1 when the path has "." or ".." segments.
norm_path() {
  local p="${1//"$bs"//}" drive rest
  while :; do
    case "$p" in
      *//*) p="${p//\/\//\/}" ;;
      *) break ;;
    esac
  done
  case "$p" in
    [A-Za-z]:/*)
      drive="$(printf '%s' "${p%%:*}" | tr 'A-Z' 'a-z')"
      rest="${p#*:}"
      p="/${drive}${rest}"
      ;;
  esac
  case "/$p/" in
    */./*|*/../*) return 1 ;;
  esac
  printf '%s' "${p%/}"
}

# memory_root_abs -> absolute tier memory root of the hub (memory/ or vault/Memory/),
# resolved by resolveMemoryRootForHub() like memory-check-core.sh; falls back to memory/.
memory_root_abs() {
  local segment="memory" resolved
  if command -v node > /dev/null 2>&1; then
    resolved="$(node -e '
      const path = require("node:path");
      const url = require("node:url");
      const hub = process.argv[1];
      (async () => {
        try {
          const modPath = path.resolve(hub, "pipelines/deploy/lib/memory-root.js");
          const { resolveMemoryRootForHub } = await import(url.pathToFileURL(modPath).href);
          process.stdout.write(path.relative(hub, resolveMemoryRootForHub(hub)).split(path.sep).join("/"));
        } catch {
          process.stdout.write("memory");
        }
      })();
    ' "$hub_root" 2>/dev/null || true)"
    [ -n "$resolved" ] && segment="$resolved"
  fi
  printf '%s/%s' "$hub_root" "$segment"
}

# is_memory_note <file path> -> 0 when it is a live memory note: *.md under the
# memory root, not inside archive/.
is_memory_note() {
  local file root rel
  file="$(norm_path "$1")" || return 1
  root="$(norm_path "$(memory_root_abs)")" || return 1
  [ -n "$file" ] && [ -n "$root" ] || return 1
  case "$file" in "$root"/*) ;; *) return 1 ;; esac
  rel="${file#"$root"/}"
  case "$rel" in *.md) ;; *) return 1 ;; esac
  case "/$rel" in */archive/*) return 1 ;; esac
  return 0
}

# extract_string <flat json> <key regex> -> decoded string value of the first matching key.
extract_string() {
  local raw v
  raw="$(printf '%s' "$1" | grep -oE "\"($2)\"[[:space:]]*:[[:space:]]*\"([^\"\\\\]|\\\\.)*\"" | head -1)"
  [ -n "$raw" ] || return 1
  v="${raw#*:}"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v#\"}"
  v="${v%\"}"
  v="${v//"$bs$bs"/$ph}"
  v="${v//"${bs}t"/ }"
  case "$v" in
    *"$bs"[!\"/]*) return 1 ;;
  esac
  v="${v//"$bs\""/\"}"
  v="${v//"$bs/"/\/}"
  v="${v//"$ph"/$bs}"
  printf '%s' "$v"
}

flat="$(printf '%s' "$input" | tr -d '\r\n')"
work=0

# Only a JSON object counts; anything else (empty, garbage, truncated) is ignored.
if printf '%s' "$flat" | grep -qE '^[[:space:]]*\{.*\}[[:space:]]*$'; then
  tool_name="$(printf '%s' "$flat" | grep -oE '"(tool_name|toolName)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"
  if [ -n "$tool_name" ]; then
    # Lowercase alphanumeric form, same matching as memory-work-marker.js.
    name="$(printf '%s' "$tool_name" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')"
    if [ -n "$name" ] \
      && ! printf '%s' "$name" | grep -qE 'read|view|grep|glob|search|list|fetch|todo|think|output|^get' \
      && printf '%s' "$name" | grep -qE 'edit|write|create|replace|patch|delete|remove|insert|move|rename|bash|shell|powershell|terminal|exec|command|run|apply'; then
      work=1
      # A shell call is not work only when its command text is provably read-only.
      if printf '%s' "$name" | grep -qE 'bash|shell|powershell|terminal|exec|command|run'; then
        if command_text="$(extract_command "$flat")" && is_read_only_command "$command_text"; then
          work=0
        fi
      else
        # An edit of a live memory note is the memory write itself, not other work.
        if edited="$(extract_string "$flat" 'file_path|filePath|path')" && is_memory_note "$edited"; then
          work=0
        fi
      fi
    fi
  elif printf '%s' "$flat" | grep -qE '"(file_path|filePath)"[[:space:]]*:[[:space:]]*"'; then
    # Cursor afterFileEdit carries no tool name.
    work=1
    if edited="$(extract_string "$flat" 'file_path|filePath')" && is_memory_note "$edited"; then
      work=0
    fi
  elif printf '%s' "$flat" | grep -qE '"command"[[:space:]]*:[[:space:]]*"'; then
    # Cursor afterShellExecution carries no tool name: classify its command.
    work=1
    if command_text="$(extract_command "$flat")" && is_read_only_command "$command_text"; then
      work=0
    fi
  fi
fi

if [ "$work" = "1" ]; then
  { mkdir -p "$hub_root/.claude" && date -u +"%Y-%m-%dT%H:%M:%SZ" > "$hub_root/.claude/.session-work"; } 2>/dev/null || true
fi

echo "{}"
exit 0
