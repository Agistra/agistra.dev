#!/usr/bin/env bash
# Claude Code status line: model name, context window usage (with bar),
# tokens consumed, repo:branch, 5h and 7d (weekly) rate-limit usage, and
# session cost. Parses the stdin JSON payload without jq (grep/sed only) -
# jq is not guaranteed to be installed in the Git Bash environment Claude
# Code uses to run status line commands on Windows.

input=$(cat)
flat=$(printf '%s' "$input" | tr -d '\n\r')

# Only look at the part of the payload before "rate_limits" for the
# context-window fields below: that object has its own "used_percentage"
# fields (five_hour/seven_day/spend_limit) that would otherwise collide
# with context_window's used_percentage.
scope="${flat%%\"rate_limits\"*}"

extract_str() {
  # extract_str <key> <source> - pulls "<key>":"value" out of <source>
  printf '%s' "$2" | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n1 \
    | sed -E "s/\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"/\1/"
}

extract_num() {
  # extract_num <key> <source> - pulls "<key>":<number|null> out of <source>
  printf '%s' "$2" | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*(-?[0-9]+(\.[0-9]+)?|null)" | head -n1 \
    | sed -E "s/\"$1\"[[:space:]]*:[[:space:]]*//"
}

severity_color() {
  local p="$1"
  if [ "$p" -ge 85 ]; then
    printf '%s' '\033[31m'   # red: nearly full
  elif [ "$p" -ge 60 ]; then
    printf '%s' '\033[33m'   # yellow: getting full
  else
    printf '%s' '\033[32m'   # green: plenty of headroom
  fi
}

model=$(extract_str display_name "$scope")
[ -z "$model" ] && model="unknown"

used_pct_raw=$(extract_num used_percentage "$scope")
{ [ -z "$used_pct_raw" ] || [ "$used_pct_raw" = "null" ]; } && used_pct_raw=0

in_tok_raw=$(extract_num total_input_tokens "$scope")
{ [ -z "$in_tok_raw" ] || [ "$in_tok_raw" = "null" ]; } && in_tok_raw=0

out_tok_raw=$(extract_num total_output_tokens "$scope")
{ [ -z "$out_tok_raw" ] || [ "$out_tok_raw" = "null" ]; } && out_tok_raw=0

pct=$(printf '%.0f' "$used_pct_raw" 2>/dev/null)
[ -z "$pct" ] && pct=0
[ "$pct" -lt 0 ] && pct=0
[ "$pct" -gt 100 ] && pct=100

bar_width=10
filled=$(( pct * bar_width / 100 ))
[ "$filled" -gt "$bar_width" ] && filled=$bar_width
empty=$(( bar_width - filled ))

bar=""
i=0
while [ "$i" -lt "$filled" ]; do bar="${bar}#"; i=$((i + 1)); done
i=0
while [ "$i" -lt "$empty" ]; do bar="${bar}-"; i=$((i + 1)); done

in_tok=$(printf '%.0f' "$in_tok_raw" 2>/dev/null); [ -z "$in_tok" ] && in_tok=0
out_tok=$(printf '%.0f' "$out_tok_raw" 2>/dev/null); [ -z "$out_tok" ] && out_tok=0
total_tokens=$(( in_tok + out_tok ))
fmt_tokens=$(printf "%'d" "$total_tokens" 2>/dev/null)
[ -z "$fmt_tokens" ] && fmt_tokens="$total_tokens"

repo_block=$(printf '%s' "$scope" | grep -oE '"repo"[[:space:]]*:[[:space:]]*\{[^}]*\}')
repo_name=$(extract_str name "$repo_block")
[ -z "$repo_name" ] && repo_name="no-repo"

cwd_val=$(extract_str cwd "$scope")
cwd_val=$(printf '%s' "$cwd_val" | sed 's/\\\\/\\/g')
[ -z "$cwd_val" ] && cwd_val="."
branch=""
if command -v git >/dev/null 2>&1; then
  branch=$(git --no-optional-locks -C "$cwd_val" rev-parse --abbrev-ref HEAD 2>/dev/null)
fi
[ "$branch" = "HEAD" ] && branch="detached"
[ -z "$branch" ] && branch="no-branch"

if printf '%s' "$flat" | grep -q '"five_hour"'; then
  after_five_hour="${flat#*\"five_hour\"}"
  five_hour_scope="${after_five_hour%%\"seven_day\"*}"
  five_hour_scope="${five_hour_scope%%\"prompt_cache\"*}"
  five_hour_pct_raw=$(extract_num used_percentage "$five_hour_scope")
else
  five_hour_pct_raw=""
fi
{ [ -z "$five_hour_pct_raw" ] || [ "$five_hour_pct_raw" = "null" ]; } && five_hour_pct_raw=0
five_hour_pct=$(printf '%.0f' "$five_hour_pct_raw" 2>/dev/null)
[ -z "$five_hour_pct" ] && five_hour_pct=0
[ "$five_hour_pct" -lt 0 ] && five_hour_pct=0
[ "$five_hour_pct" -gt 100 ] && five_hour_pct=100

# 7d (weekly) rate-limit usage - same extraction shape as five_hour above,
# scoped to the "seven_day" object and bounded by whichever key follows it
# in the payload (prompt_cache or spend_limit) so it doesn't spill into a
# later object's own used_percentage. This is the counter that actually
# caused a background agent to fail outright mid-session (2026-09-17) -
# five_hour alone gave no warning since that window wasn't the one that
# ran out.
if printf '%s' "$flat" | grep -q '"seven_day"'; then
  after_seven_day="${flat#*\"seven_day\"}"
  seven_day_scope="${after_seven_day%%\"prompt_cache\"*}"
  seven_day_scope="${seven_day_scope%%\"spend_limit\"*}"
  seven_day_pct_raw=$(extract_num used_percentage "$seven_day_scope")
else
  seven_day_pct_raw=""
fi
{ [ -z "$seven_day_pct_raw" ] || [ "$seven_day_pct_raw" = "null" ]; } && seven_day_pct_raw=0
seven_day_pct=$(printf '%.0f' "$seven_day_pct_raw" 2>/dev/null)
[ -z "$seven_day_pct" ] && seven_day_pct=0
[ "$seven_day_pct" -lt 0 ] && seven_day_pct=0
[ "$seven_day_pct" -gt 100 ] && seven_day_pct=100

cost_raw=$(extract_num total_cost_usd "$flat")
{ [ -z "$cost_raw" ] || [ "$cost_raw" = "null" ]; } && cost_raw=0
fmt_cost=$(printf '%.2f' "$cost_raw" 2>/dev/null)
[ -z "$fmt_cost" ] && fmt_cost="0.00"
cost_display="\$${fmt_cost}"

reset='\033[0m'
dim='\033[2m'
model_color='\033[36m'
repo_color='\033[34m'
usage_color=$(severity_color "$pct")
five_hour_color=$(severity_color "$five_hour_pct")
seven_day_color=$(severity_color "$seven_day_pct")

printf "${model_color}%s${reset} ${dim}|${reset} ${usage_color}[%s] %d%%${reset} ${dim}|${reset} ${dim}%s tok${reset} ${dim}|${reset} ${repo_color}%s:%s${reset} ${dim}|${reset} ${five_hour_color}5h: %d%%${reset} ${dim}|${reset} ${seven_day_color}7d: %d%%${reset} ${dim}|${reset} ${dim}%s${reset}" \
  "$model" "$bar" "$pct" "$fmt_tokens" "$repo_name" "$branch" "$five_hour_pct" "$seven_day_pct" "$cost_display"
