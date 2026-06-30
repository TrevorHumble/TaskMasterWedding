# persist-issue-review.ps1 — write ONE issue-review evidence file for a real
# reviewer's return.
#
# This is the SINGLE writer of issue-review evidence. It is a DISTINCT file from
# persist-review.ps1 (which writes PR/tree evidence) so the self-attest surface is
# not widened: the script that records a PASS cannot also fabricate the evidence the
# issue gate reads.
#
# Honest residual (stated, not hidden): this script is still run by the orchestrator,
# so a determined hand can call it directly with invented values. That is made
# tamper-EVIDENT by the committed ledger + CI audit (a later slice), not impossible --
# the owner's bar is tamper-evident, not tamper-proof.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [Parameter(Mandatory = $true)][int]$IssueNumber,
  [Parameter(Mandatory = $true)][string]$ReviewerId,
  [string]$Model = 'opus',
  [Parameter(Mandatory = $true)][ValidateSet('PASS', 'FAIL')][string]$Verdict,
  [int]$FindingsCount = 0,
  [string]$IssueReviewsRoot = ''
)

$top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
if (-not $top) { [Console]::Error.WriteLine('persist-issue-review: not inside a git repo'); exit 1 }

if (-not $IssueReviewsRoot) {
  $IssueReviewsRoot = Join-Path $top (Join-Path '.review_state' 'issue-reviews')
}

$dir = Join-Path $IssueReviewsRoot ([string]$IssueNumber)
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Schema 'irev1' -- must match tools/issue-core.ps1 Read-IssueEvidence (which keeps
# only files whose inner issue_number equals the directory/issue it is validating).
$ev = [ordered]@{
  schema         = 'irev1'
  issue_number   = $IssueNumber
  reviewer_id    = $ReviewerId
  model          = $Model
  role           = 'issue'
  verdict        = $Verdict
  findings_count = $FindingsCount
  ts             = (Get-Date -Format o)
}

$evPath = Join-Path $dir "$ReviewerId.json"
[IO.File]::WriteAllText($evPath, ($ev | ConvertTo-Json -Compress))
Write-Output "evidence written: issue $Verdict by $ReviewerId for issue $IssueNumber"
