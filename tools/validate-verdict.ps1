# validate-verdict.ps1 — reads evidence files and exits non-zero if the verdict
# is not satisfied for the given tree.
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [string]$Tree,
  [string]$ReviewsRoot,
  [string]$BiasGateRoot,
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

if (-not $BiasGateRoot) {
  # $ReviewsRoot is always set by this point (defaulted above if the caller didn't
  # pass one). Derive the sibling ".../bias-gate" next to it -- this mirrors the
  # ".review_state/reviews" + ".review_state/bias-gate" convention whether
  # $ReviewsRoot came from the real repo's git toplevel or from a caller pointing
  # at an isolated temp dir (e.g. a test), so an isolated caller never falls back
  # to consulting the real repo's unrelated bias-gate state.
  $BiasGateRoot = Join-Path (Split-Path -Parent $ReviewsRoot) 'bias-gate'
}

# The bias-gate check must only ever be driven by the REAL ambient staged tree --
# never by an explicit -Required override. Two distinct callers use this script:
#   1. The real pre-commit hook: no -Tree/-Required passed. This is "auto-bar" mode --
#      $Required is 0 at entry (the sentinel), so we read `git diff --cached` for the
#      CURRENT process cwd (the real repo mid-commit) and derive both the bar and the
#      bias-gate requirement from it. This is the only mode where ambient git state is
#      a valid signal, because -Tree is unset and therefore implicitly IS the ambient
#      staged tree.
#   2. A trusted caller (e.g. a test) passing an explicit -Tree and -Required > 0. Here
#      the caller is asserting the bar directly for a tree that may have nothing to do
#      with whatever happens to be staged in the ambient process cwd (which could even
#      be the real repo, mid-development, with unrelated system-level files staged).
#      Reading `git diff --cached` in this mode would let ambient noise from a totally
#      unrelated tree silently force the bias-gate on. So: skip the ambient read
#      entirely and never enforce the bias-gate on this path.
if ($Required -eq 0) {
  # core.quotepath=false + -z: a non-ASCII staged path must NOT be returned wrapped in
  # quotes, or the leading quote would defeat the ^tools/ etc. anchors and silently
  # drop a system-level change to the 1-reviewer bar. NUL-split so embedded chars are
  # safe.
  $z = "$(& git -c core.quotepath=false diff --cached --name-only -z 2>$null)"
  $stagedPaths = @($z -split "`0" | Where-Object { $_ })
  $actualBar = Get-RequiredBar -StagedPaths $stagedPaths
  $Required = $actualBar
  $enforceBiasGate = ($actualBar -ge 2)
} else {
  $enforceBiasGate = $false
}

$r = Test-VerdictSatisfied -Tree $Tree -Required $Required -ReviewsRoot $ReviewsRoot
[Console]::Error.WriteLine($r.reason)
if (-not $r.ok) { exit 1 }

# System-level trees (Get-RequiredBar >= 2, i.e. a system-level path is actually
# staged) additionally need a PASS bias-gate artifact, fail-closed. The routine
# path is unchanged -- no bias-gate check. Only ever set on the auto-bar path above;
# an explicit -Required override never enforces this (see comment above).
if ($enforceBiasGate) {
  $bg = Test-BiasGateSatisfied -Tree $Tree -Root $BiasGateRoot
  [Console]::Error.WriteLine($bg.reason)
  if (-not $bg.ok) { exit 1 }
}

exit 0
