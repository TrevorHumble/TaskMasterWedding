# review-runner.ps1 — program-driven review runner (issue #128).
#
# Ingests each reviewer's structured verdict JSON from -RunDir (schema:
# tools/review-verdict.schema.md), mechanically rejects any out-of-range or
# nonexistent file:line citation, aggregates the verdicts per -Mode, and only
# on a fully clean pass calls the EXISTING writers -- tools/persist-review.ps1
# (once per reviewer) and tools/review_verdict.ps1 (to bind the tree-level
# verdict). This script does not reimplement evidence writing; it is a caller
# of the two scripts above, kept consistent with tools/verdict-core.ps1.
#
# Fail-closed: on ANY invalid citation, ANY FAIL verdict, or an incomplete
# panel, this script prints the specific reason(s) to stderr and exits 1,
# writing NO persist-review evidence and NO verdict.json.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [Parameter(Mandatory = $true)][string]$RunDir,
  [Parameter(Mandatory = $true)][string]$TreeOid,
  # both-pass = system-level bar (standards/adversarial-review-protocol.md):
  #   >= 2 distinct reviewer verdicts required, all must be PASS.
  # unanimous = routine rounds-2+ bar: >= 1 reviewer verdict is sufficient,
  #   provided it is PASS with valid citations.
  [Parameter(Mandatory = $true)][ValidateSet('both-pass', 'unanimous')][string]$Mode,
  # Optional override so callers (tests) can isolate evidence writes from the
  # real repo's .review_state -- passed straight through to persist-review.ps1.
  [string]$ReviewsRoot = ''
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Cross-platform PowerShell executable detection: Windows PowerShell 5.1
# ("Desktop" edition) ships as `powershell`; PowerShell 7+ ("Core" edition,
# used on Linux CI) ships as `pwsh`. The literal 'powershell' does not exist
# on Linux, so sub-script calls must resolve to the executable actually
# running this script.
$psExe = 'powershell'
if ($PSVersionTable.PSEdition -eq 'Core') { $psExe = 'pwsh' }

$top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
if (-not $top) { [Console]::Error.WriteLine('review-runner: not inside a git repo'); exit 1 }

# Guard: the tree we validate against must be the SAME tree review_verdict.ps1
# will independently bind (it computes its own `git write-tree` of cwd). If
# -TreeOid doesn't match the live staged tree, evidence and verdict.json could
# end up bound to different trees. Fail closed before any writer runs.
$liveTreeOid = "$(& git write-tree 2>$null)".Trim()
if ($liveTreeOid -ne $TreeOid) {
  [Console]::Error.WriteLine("review-runner: tree-mismatch: -TreeOid '$TreeOid' does not match live staged tree '$liveTreeOid'")
  [Console]::Error.WriteLine('review-runner: blocked, no PASS recorded')
  exit 1
}

if (-not (Test-Path $RunDir)) {
  [Console]::Error.WriteLine("review-runner: run dir not found: $RunDir")
  exit 1
}

$verdictFiles = @(Get-ChildItem -Path $RunDir -Filter '*.json' -File -ErrorAction SilentlyContinue)

if ($verdictFiles.Count -eq 0) {
  [Console]::Error.WriteLine("review-runner: blocked: no verdict files found in $RunDir")
  exit 1
}

# Cache file line counts so a file cited by multiple defects is only read once.
$lineCountCache = @{}
function Get-LineCount {
  param([string]$RelPath)
  if ($lineCountCache.ContainsKey($RelPath)) {
    return $lineCountCache[$RelPath]
  }
  # Resolve strictly under the repo root -- refuse a path that escapes it
  # (e.g. "../../secrets.txt") by comparing the resolved full path's prefix.
  $full = Join-Path $top $RelPath
  $resolved = $null
  try {
    $resolved = (Resolve-Path -Path $full -ErrorAction Stop).Path
  } catch {
    $lineCountCache[$RelPath] = -1
    return -1
  }
  $rootFull = (Resolve-Path -Path $top -ErrorAction Stop).Path
  # Require the boundary to land on a directory separator, not just a string
  # prefix -- otherwise a sibling directory like "C:\repo-evil" would satisfy
  # a bare StartsWith("C:\repo") check and be wrongly admitted as "inside"
  # the repo. Append the separator to the root only if it isn't already
  # there (root may or may not have a trailing separator depending on how
  # Resolve-Path returned it).
  $rootPrefix = $rootFull
  if (-not $rootPrefix.EndsWith([IO.Path]::DirectorySeparatorChar)) {
    $rootPrefix += [IO.Path]::DirectorySeparatorChar
  }
  if (-not $resolved.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    $lineCountCache[$RelPath] = -1
    return -1
  }
  if (-not (Test-Path -Path $resolved -PathType Leaf)) {
    $lineCountCache[$RelPath] = -1
    return -1
  }
  $count = @(Get-Content -Path $resolved -ErrorAction SilentlyContinue).Count
  $lineCountCache[$RelPath] = $count
  return $count
}

$reasons = @()
$reviewers = @()   # [pscustomobject]{ reviewerId, verdict, findingsCount }
$seenIds = @{}

foreach ($f in $verdictFiles) {
  $raw = $null
  try {
    $raw = Get-Content -Raw -Path $f.FullName -ErrorAction Stop
  } catch {
    $reasons += "malformed: could not read $($f.Name)"
    continue
  }

  $obj = $null
  try {
    $obj = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $reasons += "malformed-json: $($f.Name)"
    continue
  }

  $reviewerId = $obj.reviewerId
  if ([string]::IsNullOrWhiteSpace($reviewerId)) {
    $reasons += "malformed: $($f.Name) missing reviewerId"
    continue
  }
  if ($seenIds.ContainsKey($reviewerId)) {
    $reasons += "malformed: duplicate reviewerId '$reviewerId' in $($f.Name)"
    continue
  }
  $seenIds[$reviewerId] = $true

  $verdict = $obj.verdict
  if ($verdict -ne 'PASS' -and $verdict -ne 'FAIL') {
    $reasons += "malformed: $($f.Name) has invalid verdict '$verdict'"
    continue
  }

  # Filter out $null entries: @($obj.defects) alone yields @($null) (Count 1)
  # when the JSON omits `defects` entirely, which would inflate findingsCount
  # to 1 for a defect-less reviewer. An omitted/empty `defects` must count 0.
  $defects = @($obj.defects | Where-Object { $_ })
  $findingsCount = $defects.Count

  # Severity tally (#417): only the four recognized values increment a
  # bucket. `severity` is NOT validated (per tools/review-verdict.schema.md)
  # -- an unrecognized value (e.g. "typo") still counts toward the total
  # findingsCount above but lands in no bucket, so blocker+major+minor+nit
  # can be less than findingsCount but never more.
  $sevCounts = @{ blocker = 0; major = 0; minor = 0; nit = 0 }

  # Category tally (#517): a second, independent histogram riding the same
  # rail as severity above -- only the seven recognized values increment a
  # bucket. `category` is NOT validated either -- an unrecognized value
  # still counts toward findingsCount but lands in no bucket, same honesty
  # posture as severity.
  $catCounts = @{
    correctness     = 0
    security        = 0
    'test-coverage' = 0
    docs            = 0
    design          = 0
    simplification  = 0
    style           = 0
  }

  foreach ($d in $defects) {
    if (-not $d) { continue }
    $sev = [string]$d.severity
    if ($sevCounts.ContainsKey($sev)) {
      $sevCounts[$sev]++
    }
    $cat = [string]$d.category
    if ($catCounts.ContainsKey($cat)) {
      $catCounts[$cat]++
    }
    $file = $d.file
    if ([string]::IsNullOrWhiteSpace($file)) {
      # No citation to validate.
      continue
    }
    $line = $d.line

    $count = Get-LineCount -RelPath $file
    if ($count -eq -1) {
      $reasons += "file-not-found: '$file' cited by $reviewerId"
      continue
    }
    if ($null -ne $line -and "$line".Trim() -ne '') {
      $lineNum = 0
      $parsed = [int]::TryParse([string]$line, [ref]$lineNum)
      if (-not $parsed -or $lineNum -lt 1 -or $lineNum -gt $count) {
        $reasons += "out-of-range: '$file`:$line' cited by $reviewerId (file has $count lines)"
        continue
      }
    }
  }

  if ($verdict -eq 'FAIL') {
    $reasons += "fail-verdict: $reviewerId reported FAIL"
  }

  $reviewers += [pscustomobject]@{
    reviewerId     = $reviewerId
    verdict        = $verdict
    findingsCount  = $findingsCount
    blocker        = $sevCounts.blocker
    major          = $sevCounts.major
    minor          = $sevCounts.minor
    nit            = $sevCounts.nit
    correctness    = $catCounts.correctness
    security       = $catCounts.security
    testCoverage   = $catCounts.'test-coverage'
    docs           = $catCounts.docs
    design         = $catCounts.design
    simplification = $catCounts.simplification
    style          = $catCounts.style
  }
}

# Panel-completeness requirement, branched on -Mode. The AC5 "insufficient
# panel" case is exactly "only one verdict file present" under 'both-pass'.
# Any FAIL or invalid citation still blocks either mode regardless of count.
# Minimum distinct reviewers required per mode (see -Mode param doc above
# and standards/adversarial-review-protocol.md).
$minReviewersByMode = @{ 'both-pass' = 2; 'unanimous' = 1 }
$requiredCount = $minReviewersByMode[$Mode]
if ($reviewers.Count -lt $requiredCount) {
  $reasons += "insufficient-panel: $($reviewers.Count)/$requiredCount reviewer verdict(s) present for mode '$Mode'"
}

if ($reasons.Count -gt 0) {
  foreach ($r in $reasons) {
    [Console]::Error.WriteLine("review-runner: $r")
  }
  [Console]::Error.WriteLine('review-runner: blocked, no PASS recorded')
  exit 1
}

# Clean pass: every reviewer PASS, every citation valid, panel complete.
foreach ($rv in $reviewers) {
  $persistArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $scriptDir 'persist-review.ps1'),
    '-TreeOid', $TreeOid, '-ReviewerId', $rv.reviewerId, '-Verdict', $rv.verdict,
    '-FindingsCount', $rv.findingsCount,
    '-Blocker', $rv.blocker, '-Major', $rv.major, '-Minor', $rv.minor, '-Nit', $rv.nit,
    '-Correctness', $rv.correctness, '-Security', $rv.security, '-TestCoverage', $rv.testCoverage,
    '-Docs', $rv.docs, '-Design', $rv.design, '-Simplification', $rv.simplification, '-Style', $rv.style
  )
  if ($ReviewsRoot) { $persistArgs += @('-ReviewsRoot', $ReviewsRoot) }
  & $psExe @persistArgs
  if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine("review-runner: persist-review.ps1 failed for $($rv.reviewerId)")
    exit 1
  }
}

$reviewerIdList = ($reviewers | ForEach-Object { $_.reviewerId }) -join ','
& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir 'review_verdict.ps1') `
  -Verdict PASS -Reviewers $reviewerIdList
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine('review-runner: review_verdict.ps1 failed to bind PASS')
  exit 1
}

Write-Output "review-runner: PASS recorded for tree $($TreeOid.Substring(0, [Math]::Min(12, $TreeOid.Length))) ($($reviewers.Count) reviewer(s))"
exit 0
