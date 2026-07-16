# emit-ledger-comment.ps1 — assemble the pre-merge governance-ledger PR
# comment body verbatim from the evidence files the pipeline already writes,
# so the JSON is never hand-transcribed a second time (#449).
#
# Pure read-validate-emit: no network, no writes. Reads every PR-review
# evidence file for -TreeOid (tools/persist-review.ps1's *.json evidence,
# the same shape tools/verdict-core.ps1 Read-Evidence reads -- reused here
# directly, tree_oid self-binding and all) and every *.ledger-entry.txt for
# -IssueNumber (tools/persist-issue-review.ps1's ledger-bridge sibling file
# -- deliberately NOT *.json; see that script's comments and
# tools/issue-core.ps1 Read-IssueEvidence's *.json glob guard. This tool
# globs *.ledger-entry.txt only and never adds a *.json sibling under the
# issue-reviews directory, which would reintroduce the double-count that
# guard exists to prevent).
#
# Fail-loud PER CLASS, not per total (#449 AC3): either required class --
# the PR-review evidence for -TreeOid, or the issue ledger entries for
# -IssueNumber -- having zero valid entries blocks (non-zero exit, message
# naming the empty class) and emits no comment body. This is deliberate: PR
# evidence is keyed by the exact tree oid, and a rebase between review and
# posting realistically leaves that directory empty while issue evidence
# still exists -- the tool must not silently emit a comment missing every PR
# review.
#
# Field whitelist projected onto stdout (evidence-file bookkeeping field `ts`
# is still deliberately dropped -- it has no reader; #48 widened the
# whitelist below to add tree_oid/reviewer_id/issue_number because
# scripts/check-review-artifact.js DOES read them, to bind this comment's
# evidence to the exact PR head tree and issue it is posted against):
#   PR entries:    {role, model, verdict, tree_oid, reviewer_id, defects:{blocker,major,minor,nit}, categories:{...7 category buckets...}, round}
#   Issue entries: {role, model, verdict, issue_number, round}
#
# `categories` (#517) rides the same rail as `defects` but is NOT required:
# an evidence file written before this change carries no `categories` key at
# all, and Test-PrEntryValid tolerates that (absent is not invalid) -- the
# entry still emits, simply without a `categories` sub-object, exactly how a
# `role:"issue"` entry has always emitted without a `defects` sub-object. A
# missing `categories` object means "treat as all-zero"; it is never
# fabricated into the output.
#
# Deterministic order: issue entries first, then PR entries by round then
# reviewer id -- so re-running against the same evidence always emits the
# same bytes.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [Parameter(Mandatory = $true)][string]$TreeOid,
  [Parameter(Mandatory = $true)][int]$IssueNumber,
  [string]$ReviewsRoot = '',
  [string]$IssueReviewsRoot = ''
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'verdict-core.ps1')

if (-not $ReviewsRoot -or -not $IssueReviewsRoot) {
  $top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
  if (-not $top) {
    [Console]::Error.WriteLine('emit-ledger-comment: not inside a git repo, and -ReviewsRoot/-IssueReviewsRoot were not both supplied.')
    exit 1
  }
  if (-not $ReviewsRoot) { $ReviewsRoot = Join-Path $top (Join-Path '.review_state' 'reviews') }
  if (-not $IssueReviewsRoot) { $IssueReviewsRoot = Join-Path $top (Join-Path '.review_state' 'issue-reviews') }
}

# --- PR-review evidence: reuse Read-Evidence verbatim (tree_oid self-binding). ---
function Test-PrEntryValid {
  param($e)
  if (-not $e.role) { return $false }
  if (-not $e.model) { return $false }
  if ($e.verdict -ne 'PASS' -and $e.verdict -ne 'FAIL') { return $false }
  if ($null -eq $e.defects) { return $false }
  foreach ($sev in @('blocker', 'major', 'minor', 'nit')) {
    if ($null -eq $e.defects.$sev) { return $false }
  }
  # `categories` (#517) is deliberately NOT checked here -- unlike `defects`,
  # a missing `categories` object does not invalidate the entry (back-compat
  # with evidence written before this change). See the projection below.
  if ($null -eq $e.round) { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$e.reviewer_id)) { return $false }
  return $true
}

$prRaw = @(Read-Evidence -Tree $TreeOid -EvidenceRoot $ReviewsRoot)
$prValid = @($prRaw | Where-Object { Test-PrEntryValid $_ })

if (@($prValid).Count -eq 0) {
  [Console]::Error.WriteLine("emit-ledger-comment (BLOCKED): no PR-review evidence for tree $TreeOid.")
  exit 1
}

# --- Issue ledger entries: *.ledger-entry.txt only -- never *.json (see header). ---
function Test-IssueEntryValid {
  param($e)
  if (-not $e.role) { return $false }
  if (-not $e.model) { return $false }
  if ($e.verdict -ne 'PASS' -and $e.verdict -ne 'FAIL') { return $false }
  if ($null -eq $e.round) { return $false }
  # issue_number (#48): required, not optional -- tools/persist-issue-review.ps1
  # is the single writer of this sibling file and always supplies it (the
  # directory layout itself is keyed by issue number), so a ledger-entry.txt
  # missing it is malformed, not merely an old-shape file. This is what lets
  # scripts/check-review-artifact.js bind an emitted entry to the exact issue
  # a PR claims to close.
  if ($null -eq $e.issue_number) { return $false }
  return $true
}

$issueDir = Join-Path $IssueReviewsRoot ([string]$IssueNumber)
$issueValid = @()
if (Test-Path $issueDir) {
  $issueFiles = @(Get-ChildItem -Path $issueDir -Filter '*.ledger-entry.txt' -File -ErrorAction SilentlyContinue)
  foreach ($f in $issueFiles) {
    try {
      $raw = Get-Content -Raw -Path $f.FullName -ErrorAction Stop
      $obj = $raw | ConvertFrom-Json
      if (Test-IssueEntryValid $obj) {
        $reviewerId = $f.Name -replace '\.ledger-entry\.txt$', ''
        $obj | Add-Member -NotePropertyName '_reviewerId' -NotePropertyValue $reviewerId -Force
        $issueValid += $obj
      }
    } catch {
      # Unparseable ledger-entry file: skip it silently, same posture as
      # Read-Evidence's malformed-file handling above.
    }
  }
}

if (@($issueValid).Count -eq 0) {
  [Console]::Error.WriteLine("emit-ledger-comment (BLOCKED): no issue-review ledger entries for issue $IssueNumber.")
  exit 1
}

$issueSorted = @($issueValid | Sort-Object @{Expression = { [int]$_.round } }, @{Expression = { [string]$_._reviewerId } })
$prSorted = @($prValid | Sort-Object @{Expression = { [int]$_.round } }, @{Expression = { [string]$_.reviewer_id } })

$reviews = @()
foreach ($e in $issueSorted) {
  $reviews += [ordered]@{
    role         = $e.role
    model        = $e.model
    verdict      = $e.verdict
    issue_number = [int]$e.issue_number
    round        = [int]$e.round
  }
}
$CATEGORY_LIST = @('correctness', 'security', 'test-coverage', 'docs', 'design', 'simplification', 'style')

foreach ($e in $prSorted) {
  $entry = [ordered]@{
    role        = $e.role
    model       = $e.model
    verdict     = $e.verdict
    tree_oid    = $e.tree_oid
    reviewer_id = $e.reviewer_id
    defects     = [ordered]@{
      blocker = [int]$e.defects.blocker
      major   = [int]$e.defects.major
      minor   = [int]$e.defects.minor
      nit     = [int]$e.defects.nit
    }
  }
  # Project `categories` only when the evidence carries it (#517). Absent ->
  # omit the key entirely, the same back-compat posture a `role:"issue"`
  # entry has always used for a missing `defects` sub-object -- a consumer
  # must treat an omitted `categories` key as all-zero, never invalid.
  if ($null -ne $e.categories) {
    $catObj = [ordered]@{}
    foreach ($cat in $CATEGORY_LIST) {
      $v = $e.categories.$cat
      if ($null -eq $v) { $v = 0 }
      $catObj[$cat] = [int]$v
    }
    $entry['categories'] = $catObj
  }
  $entry['round'] = [int]$e.round
  $reviews += $entry
}

$body = [ordered]@{ reviews = $reviews }
$json = $body | ConvertTo-Json -Depth 10 -Compress

Write-Output '<!-- governance-ledger -->'
Write-Output '```json'
Write-Output $json
Write-Output '```'
exit 0
