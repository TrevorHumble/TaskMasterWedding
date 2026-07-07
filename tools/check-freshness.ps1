# check-freshness: read-only staleness check for the primary checkout. Build
# sessions work in isolated worktrees, push branches, and merge on GitHub;
# nothing ever pulls those merges back into C:\wedding-scavenger-hunt, so the
# owner's checkout silently rots (#200: on 2026-07-03 local main was 32 commits
# behind origin/main and the owner unknowingly reviewed stale code). This script
# is the missing signal. Pure check, no side effects on the working tree --
# mirrors the shape of tools/assert-worktree.ps1.
#
# It runs exactly two git commands: `git fetch` (updates remote-tracking refs
# only; never touches the working tree) and `git rev-list --left-right --count`
# (a read-only count). It never runs pull, merge, or checkout -- auto-pulling
# into a checkout the owner may be mid-edit in is not safe; surfacing drift is.

# Fail closed on fetch failure: without a fresh fetch the script cannot know
# the true remote state, and a confident "up to date" while offline is exactly
# the false signal #200 exists to prevent.
& git fetch --quiet origin 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Output 'could not verify freshness: git fetch failed (offline?). This checkout may be stale -- reconnect and re-run before reviewing.'
  exit 1
}

$counts = "$(& git rev-list --left-right --count origin/main...HEAD 2>$null)".Trim()
if (-not $counts) {
  [Console]::Error.WriteLine('check-freshness: could not compare against origin/main. Run this inside the repo; if it has never fetched, run: git fetch origin')
  exit 1
}

# rev-list --left-right --count origin/main...HEAD prints "<behind> <ahead>":
# left = commits only on origin/main (you are behind by these), right = commits
# only on HEAD (you are ahead by these). HEAD (not the local main ref) is
# intentional: in the primary checkout on main they are the same thing, and on
# any other checked-out branch drift against origin/main is still the signal
# the reader needs before trusting what they see running.
$parts = $counts -split '\s+'
$behind = [int]$parts[0]
$ahead = [int]$parts[1]

if ($behind -gt 0) {
  # Always "commits behind", even for 1: AC1 of #200 pins that literal phrase,
  # so conditional pluralization would break the contract exactly when N=1.
  Write-Output "Your local copy is $behind commits behind GitHub -- run 'git pull' to catch up before reviewing."
  if ($ahead -gt 0) {
    Write-Output "(It also has $ahead local commit(s) GitHub does not have -- pulling will merge, not overwrite.)"
  }
  exit 1
}

Write-Output 'up to date: your local copy matches GitHub.'
exit 0
