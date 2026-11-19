#!/usr/bin/env pwsh
# Claude Code status line (Windows PowerShell port): model name, context
# window usage (with bar), tokens consumed, 5h and 7d (weekly) rate-limit
# usage, session cost, and repo:branch last (hidden when not in a repo).
#
# Windows-native counterpart to statusline-command.sh (Mac/Linux, invoked via
# bash). Claude Code's statusLine setting has no exec form (unlike hooks) — it
# always runs the configured command through a shell — and on this hub's
# Windows target that shell is native PowerShell, which cannot resolve `bash`
# on its own child-process PATH even when Git Bash is installed (see
# skills/agent-foundations/SKILL.md, "Windows + PowerShell": status-line
# scripts must be .ps1, never .sh masquerading as one). Field extraction here
# uses PowerShell's native ConvertFrom-Json instead of the bash script's
# hand-rolled grep/sed parsing (that approach existed only to avoid a jq
# dependency, which PowerShell's JSON support makes unnecessary).
#
# Output shape (field order, labels, severity thresholds, defaults) mirrors
# statusline-command.sh exactly — keep both in sync if the format changes.

$ErrorActionPreference = 'Stop'

function ConvertTo-SafeInt {
	param($Value, [int]$Default = 0)
	if ($null -eq $Value) { return $Default }
	try { return [int][math]::Round([double]$Value) } catch { return $Default }
}

function Clamp-Percent {
	param([int]$Value)
	if ($Value -lt 0) { return 0 }
	if ($Value -gt 100) { return 100 }
	return $Value
}

function Get-SeverityColor {
	param([int]$Percent, [string]$Esc)
	if ($Percent -ge 85) { return "$Esc[31m" }   # red: nearly full
	if ($Percent -ge 60) { return "$Esc[33m" }   # yellow: getting full
	return "$Esc[32m"                             # green: plenty of headroom
}

$esc = [char]27
$reset = "$esc[0m"
$dim = "$esc[2m"
$modelColor = "$esc[36m"
$repoColor = "$esc[34m"

$raw = [Console]::In.ReadToEnd()
$data = $null
if ($raw) {
	try { $data = $raw | ConvertFrom-Json -ErrorAction Stop } catch { $data = $null }
}

$model = $data.model.display_name
if ([string]::IsNullOrEmpty($model)) { $model = 'unknown' }

$pct = Clamp-Percent (ConvertTo-SafeInt $data.context_window.used_percentage)

$barWidth = 10
$filled = [math]::Floor($pct * $barWidth / 100)
if ($filled -gt $barWidth) { $filled = $barWidth }
$empty = $barWidth - $filled
$bar = ('#' * $filled) + ('-' * $empty)

$inTok = ConvertTo-SafeInt $data.context_window.total_input_tokens
$outTok = ConvertTo-SafeInt $data.context_window.total_output_tokens
$totalTokens = $inTok + $outTok
$fmtTokens = $totalTokens.ToString('N0', [System.Globalization.CultureInfo]::InvariantCulture)

# Claude Code sends the repo under workspace.repo; the old top-level repo
# field is the fallback.
$repoName = $data.workspace.repo.name
if ([string]::IsNullOrEmpty($repoName)) { $repoName = $data.repo.name }

$cwdVal = $data.cwd
if ([string]::IsNullOrEmpty($cwdVal)) { $cwdVal = '.' }

$branch = ''
if (Get-Command git -ErrorAction SilentlyContinue) {
	try {
		$branch = (& git --no-optional-locks -C $cwdVal rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1)
	} catch {
		$branch = ''
	}
}
if ($branch -eq 'HEAD') { $branch = 'detached' }
if ([string]::IsNullOrEmpty($branch)) { $branch = 'no-branch' }

$fiveHourPct = Clamp-Percent (ConvertTo-SafeInt $data.rate_limits.five_hour.used_percentage)
$sevenDayPct = Clamp-Percent (ConvertTo-SafeInt $data.rate_limits.seven_day.used_percentage)

# Claude Code sends the session cost under cost.total_cost_usd; the old
# top-level total_cost_usd is the fallback.
$costRaw = $data.cost.total_cost_usd
if ($null -eq $costRaw) { $costRaw = $data.total_cost_usd }
if ($null -eq $costRaw) { $costRaw = 0 }
$fmtCost = ([double]$costRaw).ToString('F2', [System.Globalization.CultureInfo]::InvariantCulture)
$costDisplay = "`$$fmtCost"

$usageColor = Get-SeverityColor $pct $esc
$fiveHourColor = Get-SeverityColor $fiveHourPct $esc
$sevenDayColor = Get-SeverityColor $sevenDayPct $esc

# Repo and branch go last and long branch names are shortened, so a narrow
# terminal (or the mobile app) cuts off the location, not the usage numbers.
$maxBranch = 30
if ($branch.Length -gt $maxBranch) { $branch = $branch.Substring(0, $maxBranch - 1) + [char]0x2026 }

$line = "$modelColor$model$reset $dim|$reset $usageColor[$bar] $pct%$reset $dim|$reset $dim$fmtTokens tok$reset $dim|$reset ${fiveHourColor}5h: $fiveHourPct%$reset $dim|$reset ${sevenDayColor}7d: $sevenDayPct%$reset $dim|$reset $dim$costDisplay$reset"
# Only show the location when the folder is a repo: hidden otherwise.
if (-not [string]::IsNullOrEmpty($repoName)) {
	$location = $repoName
	if ($branch -ne 'no-branch') { $location = "${repoName}:${branch}" }
	$line += " $dim|$reset $repoColor$location$reset"
}

# Emit UTF-8 so the ellipsis in a shortened branch name survives a piped stdout.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
[Console]::Out.Write($line)
