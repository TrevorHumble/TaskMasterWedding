# persist-self-certification.ps1 — write Fable's full self-certification evidence,
# per standards/adversarial-review-protocol.md "## Fable self-certification (full
# exception)".
#
# Dual-mode writer: exactly one of -IssueNumber (issue-review evidence, schema
# irev1) or -TreeOid (tree/PR evidence, schema rev1) must be given. `-Model` is
# locked to 'fable' via ValidateSet — this script exists ONLY to record Fable's own
# exception, not a general-purpose self-attest path for any actor. `reviewer_id` is
# never free-text here: it is generated deterministically as fable-self-1 ..
# fable-self-<Count> so the audit trail cannot be confused with an independent
# reviewer's id. `role` is fixed to 'self-cert' (distinct from 'issue'/'pr'/'reviewer')
# so a self-cert record is honestly distinguishable from a real reviewer's in the
# evidence itself, not just by who happened to run the script. `verdict` is fixed to
# 'PASS' — self-certification only ever asserts PASS; a self-cert FAIL has no purpose
# since the same actor would just fix and re-certify rather than record a FAIL.
#
# This is a DISTINCT file from persist-issue-review.ps1 / persist-review.ps1 so the
# self-attest surface is not widened: the scripts that record an independent
# reviewer's PASS remain unable to also mint Fable's self-cert evidence, and vice
# versa.
#
# Honest residual (stated, not hidden): this script is still run by the orchestrator,
# so a determined hand can call it directly with invented values. That is made
# tamper-EVIDENT by the committed ledger + CI audit, not impossible — the owner's
# bar is tamper-evident, not tamper-proof.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [int]$IssueNumber = 0,
  [string]$TreeOid = '',
  [ValidateSet('fable')][string]$Model = 'fable',
  [int]$Count = 1,
  [string]$IssueReviewsRoot = '',
  [string]$ReviewsRoot = ''
)

$haveIssue = ($IssueNumber -ne 0)
$haveTree = ($TreeOid -ne '')

if ($haveIssue -and $haveTree) {
  [Console]::Error.WriteLine('persist-self-certification: pass exactly one of -IssueNumber or -TreeOid, not both')
  exit 1
}
if (-not $haveIssue -and -not $haveTree) {
  [Console]::Error.WriteLine('persist-self-certification: pass exactly one of -IssueNumber or -TreeOid')
  exit 1
}
if ($Count -lt 1) {
  [Console]::Error.WriteLine('persist-self-certification: -Count must be >= 1')
  exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'verdict-core.ps1')

$top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
if (-not $top) { [Console]::Error.WriteLine('persist-self-certification: not inside a git repo'); exit 1 }

if ($haveIssue) {
  if (-not $IssueReviewsRoot) {
    $IssueReviewsRoot = Join-Path $top (Join-Path '.review_state' 'issue-reviews')
  }
  $dir = Join-Path $IssueReviewsRoot ([string]$IssueNumber)
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  for ($i = 1; $i -le $Count; $i++) {
    $reviewerId = "fable-self-$i"
    # Schema $SCHEMA_IREV1 (declared in tools/verdict-core.ps1) — must match
    # tools/issue-core.ps1 Read-IssueEvidence (which keeps only files whose inner
    # issue_number equals the directory/issue it is validating).
    $ev = [ordered]@{
      schema         = $SCHEMA_IREV1
      issue_number   = $IssueNumber
      reviewer_id    = $reviewerId
      model          = $Model
      role           = 'self-cert'
      verdict        = 'PASS'
      findings_count = 0
      ts             = (Get-Date -Format o)
    }
    $evPath = Join-Path $dir "$reviewerId.json"
    [IO.File]::WriteAllText($evPath, ($ev | ConvertTo-Json -Compress))
    Write-Output "evidence written: issue self-cert PASS by $reviewerId for issue $IssueNumber"
  }
  exit 0
}

# Tree mode
if (-not $ReviewsRoot) {
  $ReviewsRoot = Join-Path $top (Join-Path '.review_state' 'reviews')
}
$dir = Join-Path $ReviewsRoot $TreeOid
New-Item -ItemType Directory -Force -Path $dir | Out-Null

for ($i = 1; $i -le $Count; $i++) {
  $reviewerId = "fable-self-$i"
  # Schema $SCHEMA_REV1 (declared in tools/verdict-core.ps1) — must match
  # tools/verdict-core.ps1 Read-Evidence (which keeps only files whose inner
  # tree_oid equals the directory/tree it is validating).
  $ev = [ordered]@{
    schema         = $SCHEMA_REV1
    reviewer_id    = $reviewerId
    model          = $Model
    role           = 'self-cert'
    verdict        = 'PASS'
    findings_count = 0
    tree_oid       = $TreeOid
    ts             = (Get-Date -Format o)
  }
  $evPath = Join-Path $dir "$reviewerId.json"
  [IO.File]::WriteAllText($evPath, ($ev | ConvertTo-Json -Compress))
  Write-Output "evidence written: tree self-cert PASS by $reviewerId for tree $($TreeOid.Substring(0, [Math]::Min(12, $TreeOid.Length)))"
}
exit 0
