# validate-verdict.ps1 — reads evidence files and exits non-zero if the verdict
# is not satisfied for the given tree.
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [string]$Tree,
  [string]$ReviewsRoot,
  [int]$Required = 0
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'verdict-core.ps1')

if (-not $Tree) {
  $Tree = "$(& git write-tree 2>$null)".Trim()
  if (-not $Tree) { [Console]::Error.WriteLine('validate-verdict: git write-tree failed (nothing staged?)'); exit 1 }
}

if (-not $ReviewsRoot) {
  $top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
  if (-not $top) { [Console]::Error.WriteLine('validate-verdict: not inside a git repo'); exit 1 }
  $ReviewsRoot = Join-Path $top (Join-Path '.review_state' 'reviews')
}

if ($Required -eq 0) {
  # core.quotepath=false + -z: a non-ASCII staged path must NOT be returned wrapped in
  # quotes, or the leading quote would defeat the ^tools/ etc. anchors and silently drop
  # a system-level change to the 1-reviewer bar. NUL-split so embedded chars are safe.
  $z = "$(& git -c core.quotepath=false diff --cached --name-only -z 2>$null)"
  $stagedPaths = @($z -split "`0" | Where-Object { $_ })
  $Required = Get-RequiredBar -StagedPaths $stagedPaths
}

$r = Test-VerdictSatisfied -Tree $Tree -Required $Required -ReviewsRoot $ReviewsRoot
[Console]::Error.WriteLine($r.reason)
if ($r.ok) { exit 0 } else { exit 1 }
