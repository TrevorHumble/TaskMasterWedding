# session-greeting: a SessionStart hook. Two jobs, both fast, local, and idempotent
# (NO network calls -- a SessionStart hook is on the critical path of opening the
# project, so it must always return in well under a second):
#   1. SELF-ARMS the commit-msg hook if it's dormant (a clone doesn't carry
#      core.hooksPath; this `git config` is what makes "clone and it just works"
#      true -- the hook arms the moment you open the project in Claude Code).
#   2. GREETS with the honest current state, so the owner sees positive evidence
#      they're protected -- and is told if their git identity still needs setting.
# Fail-safe: any error -> no action, no greeting.
try {
  $top = (& git rev-parse --show-toplevel 2>$null)
  if (-not $top) { exit 0 }

  # 1. Arm the commit-msg hook if dormant (local git config, idempotent).
  $hookFile = Join-Path $top '.githooks/commit-msg'
  $hp = "$(& git -C $top config --get core.hooksPath)".Trim()
  if ($hp -ne '.githooks' -and (Test-Path $hookFile)) {
    & git -C $top config core.hooksPath .githooks 2>$null
    $hp = '.githooks'
  }
  $hookOn = ($hp -eq '.githooks' -and (Test-Path $hookFile))

  # 2. Greet (honest state). Local identity check only -- no network.
  $haveEmail = "$(& git -C $top config user.email)".Trim()
  $idNote = if ($haveEmail) { '' } else { ' Set your git name/email before your first commit.' }

  if ($hookOn) {
    $msg = "Gates armed: the issue-reference commit-msg hook is active, goal gate + loop gate loaded. You're protected -- direct away.$idNote"
  } else {
    $msg = "Goal gate + loop gate loaded, but the commit-msg hook file is missing -- check .githooks/commit-msg, or run: powershell -ExecutionPolicy Bypass -File tools/setup-hooks.ps1"
  }
  Write-Output (@{ systemMessage = $msg } | ConvertTo-Json -Compress)
} catch {
  exit 0
}
