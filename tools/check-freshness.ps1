# check-freshness: read-only staleness + overlap check, shared by the owner-review
# path (skills/session-brief.md, README.md) and the build-session path
# (.claude/commands/build.md step 0, tools/check-wave-alignment.ps1,
# .claude/commands/realign.md). Build sessions work in isolated worktrees, push
# branches, and merge on GitHub; nothing ever pulls those merges back into
# C:\wedding-scavenger-hunt, so drift can accumulate silently on either side of
# that boundary (#200: the owner's local main was 32 commits behind and nobody
# noticed; #357: a build worktree was cut from a local main 76 commits behind
# origin/main, and a sibling issue had already rewritten a file the session
# also edited -- every review passed, and the review had certified work
# against an abandoned base). This script is the missing signal for both
# holes. Pure check, no side effects on the working tree -- mirrors the shape
# of tools/assert-worktree.ps1. It runs read-only git commands only: `fetch`
# (updates remote-tracking refs, never the working tree), `rev-list --count`,
# `merge-base`, and `diff --name-only`. It never runs pull, merge, checkout,
# or reset.
#
# Single-homed constants and helpers (#357 architecture-review finding 1): the
# carve-out list and MAX_DRIFT_COMMITS threshold are defined ONCE, in this
# file, and both tools/check-wave-alignment.ps1 and .claude/commands/realign.md
# consume them from here (the wave-alignment tool dot-sources this file; the
# realign command invokes this file's own CLI rather than reimplementing the
# list) -- so the two tools can never quietly disagree about what counts as a
# hard collision. Do not copy $CARVE_OUT_PATHS, $MAX_DRIFT_COMMITS,
# Test-CarvedOut, or Get-OverlapFiles into another file; extend them here.
param(
  # Explicit file list to check for overlap against the drift range (an
  # issue's Touches list, or a wave's combined Touches), as one
  # comma-separated string -- e.g. -Touches "src/app.js,src/views/feed.ejs".
  # A single CLI token, not a PowerShell array literal: `powershell -File`
  # passes -File arguments through as literal strings and does not
  # re-tokenize a comma-joined value into an array the way the language
  # parser does inside a script, so an [string[]] param here would silently
  # bind the whole "a,b,c" token as ONE element. Split it ourselves below.
  # When omitted, the branch's own changes since its fork point from
  # origin/main are used instead (git diff --name-only <merge-base>) -- so a
  # bare `check-freshness.ps1` with no arguments still gives a meaningful
  # overlap answer for "what has THIS session changed."
  [string]$Touches
)

# ---- Single-homed constants -------------------------------------------------

# MAX_DRIFT_COMMITS: the single source of truth for "how many commits behind
# origin/main is tolerable before the sheer commit count becomes a hard
# resync trigger on its own, even with no detected file overlap." Documented
# HERE ONLY -- config.js must not also define this (AC7: a single-owned fact
# has exactly one owner).
$MAX_DRIFT_COMMITS = 10

# CARVE_OUT_PATHS (append-only): paths whose overlap with the drift range
# never counts as a hard resync/collision trigger, because they are
# append-only bookkeeping, not code whose behavior a stale review could get
# wrong -- two writers both touching them in the same drift window cannot
# corrupt each other's entries; a merge conflict there is a formatting
# nuisance, not a behavioral collision.
#
# Membership in THIS SLICE is exactly one path:
#   - BUILDLOG.md (append-only changelog; every entry is a distinct line
#     appended at the end).
# Explicitly OUT of scope for this slice: "governance files" broadly
# (standards/, agents/, DESIGN.md, skills/, .claude/, etc.) are NOT carved
# out here -- they can carry real behavioral drift (e.g. a reviewer-bar
# change), so an overlap there must still raise the flag. A future issue can
# widen this list; until then this is the whole list.
$CARVE_OUT_PATHS = @('BUILDLOG.md')

# Test-CarvedOut -- true when $RelativePath is on the append-only carve-out
# list above (exact match; paths are compared as git reports them, i.e.
# repo-root-relative with forward slashes).
function Test-CarvedOut {
  param([string]$RelativePath)
  return ($CARVE_OUT_PATHS -contains $RelativePath)
}

# Get-OverlapFiles -- the paths present in BOTH $DriftFiles and $TouchFiles,
# excluding anything Test-CarvedOut accepts. Both inputs may contain blanks,
# duplicates, or be empty arrays/$null; all are handled (AC6's array/collection
# edges: empty list, duplicates).
function Get-OverlapFiles {
  param(
    [string[]]$DriftFiles,
    [string[]]$TouchFiles
  )
  $drift = @($DriftFiles | Where-Object { $_ })
  $touch = @($TouchFiles | Where-Object { $_ } | Select-Object -Unique)
  $overlap = @()
  foreach ($t in $touch) {
    if (($drift -contains $t) -and (-not (Test-CarvedOut $t))) {
      $overlap += $t
    }
  }
  return $overlap
}

# ---- Executable body --------------------------------------------------------
# Runs only when this file is invoked directly (`-File tools/check-freshness.ps1`
# or `& tools/check-freshness.ps1`), never when another script dot-sources it
# just to reuse the constants/functions above ($MyInvocation.InvocationName is
# literally '.' during a dot-source).
if ($MyInvocation.InvocationName -ne '.') {
  # Fail closed on fetch failure: without a fresh fetch the script cannot know
  # the true remote state, and a confident "up to date" while offline is
  # exactly the false signal #200 and #357 both exist to prevent.
  & git fetch --quiet origin 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Output 'could not verify freshness: git fetch failed (offline?). This checkout may be stale -- reconnect and re-run before trusting it.'
    exit 1
  }

  $counts = "$(& git rev-list --left-right --count origin/main...HEAD 2>$null)".Trim()
  if (-not $counts) {
    [Console]::Error.WriteLine('check-freshness: could not compare against origin/main. Run this inside the repo; if it has never fetched, run: git fetch origin')
    exit 1
  }

  # rev-list --left-right --count origin/main...HEAD prints "<behind> <ahead>":
  # left = commits only on origin/main (you are behind by these), right =
  # commits only on HEAD (you are ahead by these). HEAD (not the local main
  # ref) is intentional: in the primary checkout on main they are the same
  # thing, and on any other checked-out branch (a build worktree) drift
  # against origin/main is still the signal the reader needs.
  $parts = $counts -split '\s+'
  $behind = [int]$parts[0]
  $ahead = [int]$parts[1]

  # Determine the touch-file list: explicit -Touches wins; otherwise fall back
  # to this branch's own changes since it forked from origin/main (covers
  # committed AND uncommitted changes on the branch -- a session mid-run may
  # not have committed yet).
  $mergeBase = "$(& git merge-base origin/main HEAD 2>$null)".Trim()
  $explicitTouches = @()
  if ($Touches) {
    $explicitTouches = @($Touches -split ',\s*' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  }
  # NOTE: capture git's line-per-file output directly as an array (no
  # "$(...)" string-interpolation wrapper) -- wrapping a multi-line command
  # substitution in a double-quoted string joins its lines with $OFS (a
  # single space) before any -split runs, silently collapsing e.g.
  # "a.js" + "b.js" into one "a.js b.js" element. Assigning `& git ...`
  # directly keeps each output line as its own array element.
  if ($explicitTouches.Count -gt 0) {
    $touchFiles = $explicitTouches
  } elseif ($mergeBase) {
    $touchFiles = @(& git diff --name-only $mergeBase 2>$null | Where-Object { $_ })
  } else {
    $touchFiles = @()
  }

  # Drift files: everything origin/main changed since this branch's fork
  # point -- the "branch-point..origin/main" range the issue names.
  $driftFiles = @()
  if ($mergeBase) {
    $driftFiles = @(& git diff --name-only $mergeBase origin/main 2>$null | Where-Object { $_ })
  }

  $overlap = @(Get-OverlapFiles -DriftFiles $driftFiles -TouchFiles $touchFiles)

  # Overlap is the load-bearing signal: one touched file that origin/main also
  # rewrote matters more than any number of unrelated commits, so it is a hard
  # trigger regardless of commit count (AC6) -- unless every overlapping path
  # is carve-out-only, in which case Get-OverlapFiles already excluded it.
  if ($overlap.Count -gt 0) {
    foreach ($f in $overlap) {
      Write-Output "OVERLAP: $f changed on origin/main since this branch forked, AND is in the touched-file list -- resync required regardless of commit count."
    }
    exit 1
  }

  if ($behind -gt 0) {
    # Always "commits behind", even for 1: AC1 of #200 pins that literal
    # phrase (still honored here -- README.md and skills/session-brief.md
    # already depend on ANY behind-count exiting non-zero, so that contract
    # is preserved unconditionally), and #357's AC5 depends on the same
    # literal phrase appearing whenever behind > 0.
    Write-Output "$behind commits behind origin/main -- resync (git pull, or re-fetch this worktree's base) before trusting this checkout."
    if ($ahead -gt 0) {
      Write-Output "(Also $ahead local commit(s) origin/main does not have.)"
    }
    if ($behind -gt $MAX_DRIFT_COMMITS) {
      Write-Output "$behind exceeds MAX_DRIFT_COMMITS ($MAX_DRIFT_COMMITS) -- the commit count alone is now a hard trigger, independent of the overlap check above."
    }
    exit 1
  }

  Write-Output 'up to date: 0 commits behind origin/main.'
  exit 0
}
