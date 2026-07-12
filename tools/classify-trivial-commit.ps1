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
#   4. package-lock.json's CONTENT, not just its path, is bounded to the same
#      dep set condition 3 already proved safe (#467). Every key
#      added/removed/changed in the lockfile's top-level `packages` object
#      must be `node_modules/<name>` (or nested under it) for a `<name>` that
#      actually changed in package.json, or the root `""` entry, whose own
#      diff must in turn be confined to non-dependency-field equality plus
#      changed-dep-only version strings in its dependency stanzas. Anything
#      else -- a repin of an untouched package, a swapped `resolved`/
#      `integrity`, a new transitive package -- is `standard`, fail closed.
#      A `packages` object missing on either side, or JSON that fails to
#      parse, is `standard` (unrecognized/unreadable lockfile shape). This
#      deliberately REJECTS transitive-dependency drift: a bump that moves a
#      transitive pin routes to the ordinary reviewed path or Dependabot, not
#      this waiver.
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

# --- read HEAD's and the staged package.json (and, for condition 4,
# package-lock.json) -- one generic git-show+parse helper, reused for both
# files rather than duplicated per file.
function Get-GitJson {
  param([string]$Ref)
  try {
    $raw = & git show $Ref 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    return (($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    return $null
  }
}

$headManifest = Get-GitJson -Ref 'HEAD:package.json'
$stagedManifest = Get-GitJson -Ref ':package.json'
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

# --- condition 4: package-lock.json content must be confined to the
# manifest-changed dep set (#467). Conditions 1-3 only ever looked at
# package.json; the lockfile's path was allowed but its content was never
# examined, so a staged lockfile could carry an unrelated repin, a swapped
# resolved/integrity, or a new package while the manifest showed one auto-tier
# bump. Recompute the changed-dep set directly from the manifest maps already
# validated above (key sets are proven identical by Assert-SameKeySet).
$changedNames = New-Object System.Collections.Generic.List[string]
foreach ($k in $headProd.Keys) {
  if ([string]$headProd[$k] -ne [string]$stagedProd[$k]) { $changedNames.Add($k) }
}
foreach ($k in $headDev.Keys) {
  if ([string]$headDev[$k] -ne [string]$stagedDev[$k]) { $changedNames.Add($k) }
}
$changedNames = @($changedNames | Sort-Object -Unique)

# A real npm `packages` object keys its root project entry "" -- and this
# runs on TWO PowerShell editions with different JSON limitations, so the
# lockfile parser is edition-aware:
#
#   * Windows PowerShell 5.1 (Desktop, the wedding event laptop): its
#     ConvertFrom-Json THROWS on any JSON object carrying an empty-string
#     property name, so every real lockfile would fail to parse and force
#     `standard` via the fail-closed path below -- neutering this condition
#     for every legitimate trivial bump, not just the malicious ones. The
#     .NET Framework JavaScriptSerializer has no such restriction and returns
#     Dictionary<string,object> objects; it is used only here.
#   * PowerShell 7 Core (the Linux CI runner, `pwsh`): JavaScriptSerializer /
#     System.Web.Extensions is a .NET Framework API that does NOT exist on
#     .NET Core, so the Desktop path would throw -> caught -> $null -> every
#     lockfile wrongly `standard`. But PS7's ConvertFrom-Json does NOT have
#     the empty-key limitation, and `-AsHashtable` returns objects with the
#     same .ContainsKey()/.Keys/indexer interface the condition-4 code below
#     already uses. (Plain ConvertFrom-Json without -AsHashtable returns a
#     PSCustomObject that has no .ContainsKey and whose "" property is
#     unreachable, so -AsHashtable is required, not optional.)
#
# Both branches return an object exposing .ContainsKey(), .Keys, $x[$key]
# indexing, and round-trips through `| ConvertTo-Json -Depth 100 -Compress`.
# Head vs. staged are always parsed within the SAME edition inside one run, so
# any key-ordering difference between editions is irrelevant to the diff.
#
# Get-GitJson (used for package.json, which never has an empty key) stays on
# ConvertFrom-Json unchanged.
$IsCoreEdition = ($PSVersionTable.PSEdition -eq 'Core')
if (-not $IsCoreEdition) {
  # Desktop-only .NET Framework assembly; never load it on Core (it would error).
  Add-Type -AssemblyName System.Web.Extensions
}
function Get-GitJsonDict {
  param([string]$Ref)
  try {
    $raw = & git show $Ref 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    $text = $raw -join "`n"
    if ($IsCoreEdition) {
      $parsed = ($text | ConvertFrom-Json -AsHashtable -ErrorAction Stop)
    } else {
      $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
      $ser.MaxJsonLength = [int]::MaxValue
      $ser.RecursionLimit = 1000
      $parsed = $ser.DeserializeObject($text)
    }
    # A valid lockfile's top level is a JSON object -> IDictionary on both
    # editions (Dictionary<string,object> on Desktop, Hashtable/OrderedHashtable
    # on Core). A top-level array/scalar parses without error but is not a
    # lockfile; treat it as unreadable (fail closed) rather than letting the
    # caller's .ContainsKey() throw on a non-dictionary.
    if ($null -eq $parsed -or -not ($parsed -is [System.Collections.IDictionary])) { return $null }
    return $parsed
  } catch {
    return $null
  }
}

$headLock = Get-GitJsonDict -Ref 'HEAD:package-lock.json'
$stagedLock = Get-GitJsonDict -Ref ':package-lock.json'
if ($null -eq $headLock -or $null -eq $stagedLock) {
  Write-Standard 'package-lock.json unreadable at HEAD or in the staged index'
}
if (-not $headLock.ContainsKey('packages') -or -not $stagedLock.ContainsKey('packages')) {
  Write-Standard "package-lock.json has no top-level 'packages' object (unrecognized lockfile shape)"
}
$headPackages = $headLock['packages']
$stagedPackages = $stagedLock['packages']

# Non-dependency fields of a `packages` entry (name, version, resolved,
# integrity, bin, ...), sorted for a deterministic canonical string -- same
# technique as Get-NonDepCanonical above, applied per lockfile entry.
function Get-EntryNonDepCanonical {
  param($Entry)
  $rest = [ordered]@{}
  if ($null -ne $Entry) {
    $names = @($Entry.Keys |
        Where-Object { $_ -ne 'dependencies' -and $_ -ne 'devDependencies' } |
        Sort-Object)
    foreach ($n in $names) { $rest[$n] = $Entry[$n] }
  }
  return ($rest | ConvertTo-Json -Depth 100 -Compress)
}

# The lockfile root ("") entry mirrors package.json's dependencies /
# devDependencies -- but is a SEPARATE copy the manifest check above never
# looked at, so it must pass the same two rules on its own: no non-dependency
# field may differ, and every changed dependency-stanza version must belong
# to $changedNames.
function Test-RootLockEntryConfined {
  param($HeadEntry, $StagedEntry, [string[]]$ChangedNames)

  if ((Get-EntryNonDepCanonical -Entry $HeadEntry) -ne (Get-EntryNonDepCanonical -Entry $StagedEntry)) {
    Write-Standard "package-lock.json root entry changes a non-dependency field"
  }

  foreach ($section in @('dependencies', 'devDependencies')) {
    $headMap = @{}
    if ($HeadEntry -and $HeadEntry.ContainsKey($section)) {
      foreach ($k in $HeadEntry[$section].Keys) { $headMap[$k] = [string]$HeadEntry[$section][$k] }
    }
    $stagedMap = @{}
    if ($StagedEntry -and $StagedEntry.ContainsKey($section)) {
      foreach ($k in $StagedEntry[$section].Keys) { $stagedMap[$k] = [string]$StagedEntry[$section][$k] }
    }
    $allNames = @(@($headMap.Keys) + @($stagedMap.Keys) | Sort-Object -Unique)
    foreach ($name in $allNames) {
      $h = $null
      if ($headMap.ContainsKey($name)) { $h = $headMap[$name] }
      $s = $null
      if ($stagedMap.ContainsKey($name)) { $s = $stagedMap[$name] }
      if ($h -eq $s) { continue }
      if ($ChangedNames -notcontains $name) {
        Write-Standard "package-lock.json root $section changes '$name', outside the manifest-changed dependency set"
      }
    }
  }
}

$allLockKeys = @(@($headPackages.Keys) + @($stagedPackages.Keys) | Sort-Object -Unique)
foreach ($key in $allLockKeys) {
  $headEntry = $null
  if ($headPackages.ContainsKey($key)) { $headEntry = $headPackages[$key] }
  $stagedEntry = $null
  if ($stagedPackages.ContainsKey($key)) { $stagedEntry = $stagedPackages[$key] }

  $headCanon = ($headEntry | ConvertTo-Json -Depth 100 -Compress)
  $stagedCanon = ($stagedEntry | ConvertTo-Json -Depth 100 -Compress)
  if ($headCanon -eq $stagedCanon) { continue }

  if ($key -eq '') {
    Test-RootLockEntryConfined -HeadEntry $headEntry -StagedEntry $stagedEntry -ChangedNames $changedNames
    continue
  }

  $matched = $false
  foreach ($name in $changedNames) {
    $prefix = "node_modules/$name"
    if ($key -eq $prefix -or $key.StartsWith("$prefix/")) { $matched = $true; break }
  }
  if (-not $matched) {
    Write-Standard "package-lock.json changes '$key', outside the manifest-changed dependency set"
  }
}

Write-Output 'trivial'
exit 0
