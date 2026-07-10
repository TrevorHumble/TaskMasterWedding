# check-gate: assert the commit gates are actually ACTIVE in this working copy.
# A local hook enforces nothing if core.hooksPath isn't pointed at it
# (fresh clone, reset config). The orchestrator runs this before the first commit
# of a run and refuses to proceed if the gates are not live -- so a gate can never
# be silently off while the loop assumes it is on. Exit 1 = not active.
$top = (& git rev-parse --show-toplevel 2>$null)
if (-not $top) { Write-Error 'check-gate: not inside a git repo'; exit 1 }
. (Join-Path $PSScriptRoot 'commit-gate-status.ps1')
$hp = "$(& git config --get core.hooksPath)".Trim()
$hook = Join-Path $top '.githooks/pre-commit'
$hookOk = Test-Path $hook
$msgHook = Join-Path $top '.githooks/commit-msg'
$msgHookOk = Test-Path $msgHook
if (-not (Test-CommitGateActive $top)) {
  Write-Error "check-gate: commit gates NOT active (core.hooksPath='$hp', pre-commit present=$hookOk, commit-msg present=$msgHookOk). Reopen the folder in Claude Code, or run: powershell -File tools/setup-hooks.ps1"
  exit 1
}
Write-Output 'commit gates ACTIVE (core.hooksPath=.githooks, .githooks/pre-commit and .githooks/commit-msg present)'
