# check-wave-alignment: pre-wave collision check (#357 Component B). A wave
# launches 3-10 issues in parallel; each was reviewed alone, so nothing ever
# checked whether two issues in the SAME wave declare overlapping `Touches`
# lists -- if #A and #B both rewrite src/views/feed.ejs, whichever merges
# second reconciles by text + CI only (the merge gate never re-runs the
# review), so the interaction nobody looked at can still land. This is the
# same overlap principle as tools/check-freshness.ps1 (one shared file
# matters more than any number of unrelated commits), applied across issues
# in a wave instead of across time against origin/main.
#
# Read-only: reads issue text (a local draft under data/wip-issues/, falling
# back to `gh issue view`) and does no git or filesystem mutation.
#
# Single-homed carve-out list (#357 architecture-review finding 1): this file
# does NOT keep its own copy of the append-only carve-out list (BUILDLOG.md).
# It dot-sources tools/check-freshness.ps1 to reuse $CARVE_OUT_PATHS /
# Test-CarvedOut -- the ONE place that list is defined -- so this tool and
# check-freshness.ps1 cannot drift apart on what counts as a real collision.
# check-freshness.ps1 guards its own fetch/exit body behind
# `$MyInvocation.InvocationName -ne '.'`, so dot-sourcing it here only defines
# the shared constants/functions and runs no git command.
[CmdletBinding()]
param(
  # Comma-separated issue numbers, e.g. -IssueNumbers "42,43,44". One CLI
  # token, not an array literal -- see check-freshness.ps1's -Touches param
  # comment for why `powershell -File` requires this shape rather than
  # [int[]] (a raw "1,2,3" argv token binds as a single unsplit element).
  [Parameter(Mandatory)]
  [string]$IssueNumbers
)

$freshnessScript = Join-Path $PSScriptRoot 'check-freshness.ps1'
. $freshnessScript

$parsedIssueNumbers = @($IssueNumbers -split ',\s*' | Where-Object { $_ } | ForEach-Object { [int]$_.Trim() })

# Get-IssueTouches -- reads issue $N's `Touches:` line from its local draft
# (data/wip-issues/<N>-*.md, the pre-merge source of truth while an issue is
# still in flight) or, if no draft is on disk, from `gh issue view` (the
# post-creation source of truth). Strips " (new)" annotations. Returns an
# empty array (not an error) when the issue cannot be found or has no
# `Touches:` line -- a missing/malformed issue can never collide with
# anything, which is the safe default for a pre-launch gate.
function Get-IssueTouches {
  param([int]$N)

  $repoRoot = Split-Path $PSScriptRoot -Parent
  $draftGlob = Join-Path $repoRoot "data/wip-issues/$N-*.md"
  $draft = Get-ChildItem -Path $draftGlob -File -ErrorAction SilentlyContinue | Select-Object -First 1

  $body = $null
  if ($draft) {
    $body = Get-Content -Raw -Path $draft.FullName -ErrorAction SilentlyContinue
  }
  if (-not $body) {
    $body = "$(& gh issue view $N --json body -q .body 2>$null)"
  }
  if (-not $body) {
    return @()
  }

  $m = [regex]::Match($body, '(?m)^Touches:\s*(.+)$')
  if (-not $m.Success) {
    return @()
  }

  $raw = $m.Groups[1].Value
  $paths = @($raw -split ',\s*' | ForEach-Object {
      ($_ -replace '\s*\(new\)\s*$', '').Trim()
    } | Where-Object { $_ } | Select-Object -Unique)
  return $paths
}

$issueTouches = @{}
foreach ($n in ($parsedIssueNumbers | Select-Object -Unique)) {
  $issueTouches[$n] = @(Get-IssueTouches -N $n)
}
$uniqueIssues = @($issueTouches.Keys | Sort-Object)

# Pairwise comparison: for every pair of distinct issues in the wave, the
# shared, non-carved-out files are a collision -- reported by path AND by the
# colliding issue numbers (AC8 requires both). The intersection-minus-carveout
# is Get-OverlapFiles from check-freshness.ps1 (dot-sourced above), reused
# rather than reimplemented so the "shared files, carve-outs excluded"
# computation is single-homed too, not just the carve-out list -- one issue's
# two `Touches` lists are just another pair of file lists to intersect.
$collisionFiles = @()
for ($i = 0; $i -lt $uniqueIssues.Count; $i++) {
  for ($j = $i + 1; $j -lt $uniqueIssues.Count; $j++) {
    $a = $uniqueIssues[$i]
    $b = $uniqueIssues[$j]
    $shared = @(Get-OverlapFiles -DriftFiles $issueTouches[$a] -TouchFiles $issueTouches[$b])
    foreach ($f in $shared) {
      Write-Output "COLLISION: $f is touched by both issue #$a and issue #$b -- these cannot both be built in the same wave without a resync check after whichever merges first."
      $collisionFiles += $f
    }
  }
}

if ($collisionFiles.Count -gt 0) {
  exit 1
}

Write-Output "clear: no non-carve-out Touches overlap across issues $($uniqueIssues -join ', ')."
exit 0
