# session-greeting: a SessionStart hook. Two jobs, both fast, local, and idempotent
# (NO network calls -- a SessionStart hook is on the critical path of opening the
# project, so it must always return in well under a second):
#   1. SELF-ARMS the commit gate if it's dormant (a clone doesn't carry
#      core.hooksPath; this `git config` is what makes "clone and it just works"
#      true -- the gate arms the moment you open the project in Claude Code).
#   2. GREETS with the honest current state, so the owner sees positive evidence
#      they're protected -- and is told if their git identity still needs setting.
# Identity auto-fill and the full verify live in setup.ps1 (run explicitly, where a
# slow network is fine). Fail-safe: any error -> no action, no greeting.
try {
  $top = (& git rev-parse --show-toplevel 2>$null)
  if (-not $top) { exit 0 }

  # 1. Arm the commit gate if dormant (local git config, idempotent).
  $hp = "$(& git -C $top config --get core.hooksPath)".Trim()
  if ($hp -ne '.githooks' -and (Test-Path (Join-Path $top '.githooks/pre-commit'))) {
    & git -C $top config core.hooksPath .githooks 2>$null
    $hp = '.githooks'
  }
  $commitOn = ($hp -eq '.githooks') -and (Test-Path (Join-Path $top '.githooks/pre-commit'))

  # 2. Greet (honest state). Local identity check only -- no network.
  $haveEmail = "$(& git -C $top config user.email)".Trim()
  $idNote = if ($haveEmail) { '' } else { ' Set your git name/email (or run setup.ps1) before your first commit.' }

  if ($commitOn) {
    $msg = "Gates armed: commit gate active, goal gate + loop gate loaded. You're protected -- direct away.$idNote (Re-check anytime: tools/check-enforcement.ps1)"
  } else {
    $msg = "Goal gate + loop gate loaded, but the commit gate file is missing -- check .githooks/pre-commit, or run: powershell -ExecutionPolicy Bypass -File setup.ps1"
  }
  Write-Output (@{ systemMessage = $msg } | ConvertTo-Json -Compress)
} catch {
  exit 0
}
