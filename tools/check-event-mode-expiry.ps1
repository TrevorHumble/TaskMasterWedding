# check-event-mode-expiry.ps1 -- CI backstop for event mode (#220 AC4).
#
# An expired governance/event-mode.json enables nothing locally
# (.githooks/gate-core.sh collapses it to INACTIVE), but leaving it in the
# tree means the freeze window ended without cleanup -- and cleanup is where
# the retro-review obligation is enforced (tools/set-event-mode.ps1 -Clear
# refuses until every freeze commit has its retro-review PASS). So CI goes
# red while an expired (or invalid) flag is present -- once
# `-RequireEventModeExpiry` is run (#233) that red forces the cleanup commit
# and, through it, the retro reviews; until then it is advisory signal.
#
# Thin wrapper over the ONE flag reader (tools/event-mode-core.ps1) so the
# validity rules live in exactly one place. CI runs it under pwsh
# (ubuntu-latest ships pwsh, not powershell); never hard-code a shell name in
# here -- the workflow chooses the launcher.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [string]$FlagPath = ''
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'event-mode-core.ps1')

if (-not $FlagPath) {
  $top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
  if (-not $top) { $top = (Get-Location).Path }
  $FlagPath = Join-Path $top (Join-Path 'governance' 'event-mode.json')
}

$state = Get-EventModeState -FlagPath $FlagPath

if ($state -eq 'NONE') {
  Write-Output 'check-event-mode-expiry: no event-mode flag present'
  exit 0
}
if ($state -eq 'ACTIVE') {
  $flag = Read-EventModeFlag -FlagPath $FlagPath
  Write-Output "check-event-mode-expiry: event-mode flag active until $($flag.expires)"
  exit 0
}
if ($state -eq 'EXPIRED') {
  $flag = Read-EventModeFlag -FlagPath $FlagPath
  Write-Output "check-event-mode-expiry: event-mode flag EXPIRED at $($flag.expires) -- run tools/set-event-mode.ps1 -Clear (it enforces the retro reviews) and commit the removal"
  exit 1
}
# INVALID (or anything unrecognized): fail closed. The flag cannot arm the
# bypass, but it is a lie in the tree.
Write-Output 'check-event-mode-expiry: event-mode flag is NOT a valid em1 flag -- rewrite it via tools/set-event-mode.ps1 or remove it via -Clear'
exit 1
