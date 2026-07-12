# tools/classify-trivial-commit.ps1 — recompute (never attest) whether the
# STAGED tree is a manifest-only dependency bump cheap enough to skip the
# hand-built review ceremony, matching the policy Dependabot's own PRs
# already merge under with no review at all (#448).
#
# No params: reads the staged git state directly, mirroring the other
# hook-invoked classifiers (tools/issue-core.ps1 Test-StagedHasCode). Emits
# exactly one token to stdout -- `trivial` or `standard` -- and always exits 0
# (a classification is never itself a hook failure; the HOOKS decide what a
# `standard` result means).
#
# Eligibility (`trivial` iff ALL of):
#   1. Staged paths are exactly a non-empty subset of {package.json,
#      package-lock.json}, and package.json is among them. A lockfile-only
#      diff (transitive-only changes) is `standard`, fail closed.
#   2. The package.json diff is CONFINED to dependency-version changes: every
#      top-level key OTHER than the `dependencies`/`devDependencies` objects
#      is structurally identical between HEAD:package.json and the staged
#      package.json (so a bump smuggling a `scripts.postinstall`, `bin`,
#      `main`, `engines`, ... change alongside is `standard`), and the KEY
#      SETS of both dep objects are identical (a dep added to or removed from
#      either object is `standard`). A Dependabot version bump never carries
#      any of those, so allowing them here would break the waiver's
#      "indistinguishable from a Dependabot auto-merge of the same class"
#      safety rationale (DESIGN.md § "Trivial dep-bump gate (#448)").
#   3. Every direct dependency whose declared version DIFFERS between the two
#      sides classifies 'auto' under Get-DepPrTier (tools/classify-dep-pr-core.ps1,
#      dot-sourced -- NOT copied, see tests/classify-trivial-commit.test.js's
#      drift guard). Wedding-critical deps and prod majors therefore can never
#      qualify. Only CHANGED versions are normalized/classified: a dep whose
#      version string is byte-identical on both sides is not touched, so an
#      UNCHANGED dep carrying a non-normalizable range (e.g. a git URL) does
#      not force `standard`.
#
# The subject-prefix eligibility condition -- the commit subject must start
# 'chore(deps): ' -- is checked by the hooks themselves at commit-msg time
# (this tool runs before a commit message necessarily exists, and pre-commit
# is never given the message by git), not by this tool. See
# .githooks/gate-core.sh classifier_says_trivial / the pre-commit and
# commit-msg trivial-dep-bump blocks, and DESIGN.md "Trivial dep-bump gate
# (#448)".
#
# Version adapter (fail closed on every non-conforming shape -- see Design in
# issue #448): strip exactly one leading '^' or '~'; the remainder must match
# MAJOR.MINOR.PATCH (three dot-separated non-negative integers, nothing
# else). Any other range syntax, any pre-release/build suffix, or any
# non-conforming shape on either side of a CHANGED dep -> `standard`. Both
# sides identical after normalization (a prefix-only change) -> `standard`
# for that dependency (not a bump this path understands).
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'classify-dep-pr-core.ps1')

function Write-Standard {
  param([string]$Reason)
  if ($Reason) {
    [Console]::Error.WriteLine("classify-trivial-commit: standard ($Reason)")
  }
  Write-Output 'standard'
  exit 0
}

# --- condition 1: staged path shape ---
$top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
if (-not $top) { Write-Standard 'not inside a git repo' }

$z = "$(& git -c core.quotepath=false diff --cached --name-only -z 2>$null)"
$stagedPaths = @($z -split "`0" | Where-Object { $_ })
if (@($stagedPaths).Count -eq 0) { Write-Standard 'no staged changes' }

$allowed = @('package.json', 'package-lock.json')
foreach ($p in $stagedPaths) {
  if ($allowed -notcontains $p) { Write-Standard "staged path outside the allowed set: $p" }
}
if ($stagedPaths -notcontains 'package.json') { Write-Standard 'package.json not staged (lockfile-only diff)' }

# --- read HEAD's and the staged package.json ---
function Get-ManifestJson {
  param([string]$Ref)
  try {
    $raw = & git show $Ref 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    return (($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    return $null
  }
}

$headManifest = Get-ManifestJson -Ref 'HEAD:package.json'
$stagedManifest = Get-ManifestJson -Ref ':package.json'
if ($null -eq $headManifest -or $null -eq $stagedManifest) {
  Write-Standard 'package.json unreadable at HEAD or in the staged index'
}

function Get-DepMap {
  param($Manifest, [string]$Section)
  $map = @{}
  if ($Manifest.$Section) {
    foreach ($prop in $Manifest.$Section.PSObject.Properties) {
      $map[$prop.Name] = [string]$prop.Value
    }
  }
  return $map
}

# --- condition 2a: every top-level key OTHER than the two dep objects must
# be structurally identical. Compare via canonical JSON of the whole manifest
# with `dependencies`/`devDependencies` removed -- ConvertTo-Json is
# deterministic in key order for a given object shape, so a byte-equal
# canonical string means the rest of the manifest is unchanged. Any edit to
# scripts/bin/main/engines/version/files/exports/config/... (fields a
# Dependabot version bump never carries) makes the two strings differ ->
# `standard`, fail closed.
function Get-NonDepCanonical {
  param($Manifest)
  # Copy every property except the two dependency objects into an ordered map,
  # sorted by name so key ordering can never cause a false mismatch.
  $rest = [ordered]@{}
  $names = @($Manifest.PSObject.Properties |
      Where-Object { $_.Name -ne 'dependencies' -and $_.Name -ne 'devDependencies' } |
      ForEach-Object { $_.Name } | Sort-Object)
  foreach ($n in $names) {
    $rest[$n] = $Manifest.$n
  }
  return ($rest | ConvertTo-Json -Depth 100 -Compress)
}

if ((Get-NonDepCanonical -Manifest $headManifest) -ne (Get-NonDepCanonical -Manifest $stagedManifest)) {
  Write-Standard 'package.json changes a top-level field other than dependency versions'
}

$headProd = Get-DepMap -Manifest $headManifest -Section 'dependencies'
$headDev = Get-DepMap -Manifest $headManifest -Section 'devDependencies'
$stagedProd = Get-DepMap -Manifest $stagedManifest -Section 'dependencies'
$stagedDev = Get-DepMap -Manifest $stagedManifest -Section 'devDependencies'

# --- condition 2b: the key SETS of each dep object must be identical (a dep
# added to or removed from either object is `standard`, not a bump).
function Assert-SameKeySet {
  param([hashtable]$Head, [hashtable]$Staged, [string]$Section)
  foreach ($k in $Head.Keys) {
    if (-not $Staged.ContainsKey($k)) { Write-Standard "dependency '$k' removed from $Section" }
  }
  foreach ($k in $Staged.Keys) {
    if (-not $Head.ContainsKey($k)) { Write-Standard "dependency '$k' added to $Section" }
  }
}
Assert-SameKeySet -Head $headProd -Staged $stagedProd -Section 'dependencies'
Assert-SameKeySet -Head $headDev -Staged $stagedDev -Section 'devDependencies'

# Version adapter: strip one leading ^/~, require an exact MAJOR.MINOR.PATCH
# shape. Returns $null (fail closed) on anything else.
function Get-NormalizedVersion {
  param([string]$Raw)
  if ($null -eq $Raw) { return $null }
  $v = $Raw
  if ($v.Length -gt 0 -and ($v.Substring(0, 1) -eq '^' -or $v.Substring(0, 1) -eq '~')) {
    $v = $v.Substring(1)
  }
  if ($v -match '^(\d+)\.(\d+)\.(\d+)$') {
    return [pscustomobject]@{ major = [int]$Matches[1]; minor = [int]$Matches[2]; patch = [int]$Matches[3] }
  }
  return $null
}

# --- condition 3: classify only the deps whose version string actually
# CHANGED. Key sets are already proven identical above, so iterating HEAD's
# keys covers every dep; an unchanged version string is skipped untouched
# (so a non-normalizable but unchanged range never forces `standard`).
function Test-ChangedDepsAllAuto {
  param([hashtable]$Head, [hashtable]$Staged, [string]$DepType, [ref]$AnyBump)
  foreach ($name in $Head.Keys) {
    $headVerRaw = $Head[$name]
    $stagedVerRaw = $Staged[$name]
    if ([string]$headVerRaw -eq [string]$stagedVerRaw) {
      # Version string byte-identical -> not a change; leave it untouched.
      continue
    }

    $headNorm = Get-NormalizedVersion -Raw $headVerRaw
    $stagedNorm = Get-NormalizedVersion -Raw $stagedVerRaw
    if ($null -eq $headNorm -or $null -eq $stagedNorm) {
      Write-Standard "dependency '$name' has an unparsable version range"
    }

    if ($headNorm.major -eq $stagedNorm.major -and $headNorm.minor -eq $stagedNorm.minor -and $headNorm.patch -eq $stagedNorm.patch) {
      # A prefix-only change (e.g. ^4.21.2 -> 4.21.2): the raw strings differ
      # but the parsed version does not -- not a bump this path understands.
      Write-Standard "dependency '$name' has a prefix-only version change, not a bump"
    }

    $AnyBump.Value = $true

    $bump = 'patch'
    if ($headNorm.major -ne $stagedNorm.major) {
      $bump = 'major'
    } elseif ($headNorm.minor -ne $stagedNorm.minor) {
      $bump = 'minor'
    }

    $tier = Get-DepPrTier -Ecosystem 'npm' -DepName $name -SemverBump $bump -DepType $DepType
    if ($tier -ne 'auto') {
      Write-Standard "dependency '$name' classifies '$tier', not 'auto'"
    }
  }
}

$anyBumpSeen = $false
$anyBumpRef = [ref]$anyBumpSeen
# A dep present in BOTH dependencies and devDependencies is prod-typed
# (conservative). The key sets match head<->staged per Assert-SameKeySet, so
# classifying by the head object's section is sufficient; the prod pass wins
# for any name that also appears in dev.
$devOnly = @{}
foreach ($k in $headDev.Keys) {
  if (-not $headProd.ContainsKey($k)) { $devOnly[$k] = $headDev[$k] }
}
$stagedDevOnly = @{}
foreach ($k in $stagedDev.Keys) {
  if (-not $stagedProd.ContainsKey($k)) { $stagedDevOnly[$k] = $stagedDev[$k] }
}
Test-ChangedDepsAllAuto -Head $headProd -Staged $stagedProd -DepType 'prod' -AnyBump $anyBumpRef
Test-ChangedDepsAllAuto -Head $devOnly -Staged $stagedDevOnly -DepType 'dev' -AnyBump $anyBumpRef

if (-not $anyBumpSeen) {
  Write-Standard 'no dependency version actually changed'
}

Write-Output 'trivial'
exit 0
