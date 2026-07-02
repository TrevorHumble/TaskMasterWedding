# check-issue-reviewed.ps1 — reader/gate for issue-review evidence.
# Exits 0 iff the issue has the required number of distinct PASS reviewers (and
# no FAIL). Reason written to stderr, mirroring validate-verdict.ps1.
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [int]$IssueNumber = 0,
  [string]$Message = '',
  [string]$Branch = '',
  [int]$Required = 1,
  [string]$IssueReviewsRoot = ''
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'verdict-core.ps1')
. (Join-Path $scriptDir 'issue-core.ps1')

if ($IssueNumber -eq 0) {
  $IssueNumber = Resolve-IssueNumber -Message $Message -Branch $Branch
}

if ($IssueNumber -eq 0) {
  [Console]::Error.WriteLine('check-issue-reviewed: could not resolve an issue number from Message/Branch')
  exit 1
}

$top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
if (-not $top) { [Console]::Error.WriteLine('check-issue-reviewed: not inside a git repo'); exit 1 }

if (-not $IssueReviewsRoot) {
  $IssueReviewsRoot = Join-Path $top (Join-Path '.review_state' 'issue-reviews')
}

$r = Test-IssueReviewed -N $IssueNumber -Required $Required -Root $IssueReviewsRoot
[Console]::Error.WriteLine($r.reason)
if ($r.ok) { exit 0 } else { exit 1 }
