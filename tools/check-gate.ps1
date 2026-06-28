# check-gate: assert the commit gate is actually ACTIVE in this working copy.
# A local pre-commit hook enforces nothing if core.hooksPath isn't pointed at it
# (fresh clone, reset config). The orchestrator runs this before the first commit
# of a run and refuses to proceed if the gate is not live -- so the gate can never
# be silently off while the loop assumes it is on. Exit 1 = not active.
$top = (& git rev-parse --show-toplevel 2>$null)
if (-not $top) { Write-Error 'check-gate: not inside a git repo'; exit 1 }
$hp = "$(& git config --get core.hooksPath)".Trim()
$hook = Join-Path $top '.githooks/pre-commit'
$hookOk = Test-Path $hook
if ($hp -ne '.githooks' -or -not $hookOk) {
  Write-Error "check-gate: commit gate NOT active (core.hooksPath='$hp', pre-commit present=$hookOk). Reopen the folder in Claude Code, or run: powershell -File setup.ps1"
  exit 1
}
Write-Output 'commit gate ACTIVE (core.hooksPath=.githooks, .githooks/pre-commit present)'
