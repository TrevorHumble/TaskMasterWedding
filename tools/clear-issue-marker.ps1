# clear-issue-marker.ps1 -- reader-gated board mutator.
# Removes the 'needs-issue-review' label from a GitHub issue ONLY after
# confirming a recorded PASS in .review_state/issue-reviews/<N>/.
#
# This is SEPARATE from tools/persist-issue-review.ps1 (the evidence writer).
# The evidence writer never touches the board; this script never writes evidence.
# That separation is load-bearing: the script that records a PASS cannot clear
# the marker, and this script cannot fabricate the evidence it reads.
#
# Test seam: pass -LabelRemoverScript <path> to a .ps1 file that accepts
# -IssueNumber <int>. When provided, that script is invoked instead of the
# default gh command. The script is run as a child process via the currently-
# running PowerShell host so it works on both Windows (powershell.exe) and
# Linux CI (pwsh). Exit code is captured cleanly.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [Parameter(Mandatory = $true)][int]$IssueNumber,
  [string]$IssueReviewsRoot = '',
  [string]$Repo = 'TrevorHumble/TaskMasterWedding',
  [string]$LabelRemoverScript = '',
  [string]$Label = 'needs-issue-review'
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'verdict-core.ps1')
. (Join-Path $scriptDir 'issue-core.ps1')

if (-not $IssueReviewsRoot) {
  $top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
  if (-not $top) {
    [Console]::Error.WriteLine('clear-issue-marker: not inside a git repo')
    exit 1
  }
  $IssueReviewsRoot = Join-Path $top (Join-Path '.review_state' 'issue-reviews')
}

$r = Test-IssueReviewed -N $IssueNumber -Required 1 -Root $IssueReviewsRoot
if (-not $r.ok) {
  [Console]::Error.WriteLine("clear-issue-marker: $($r.reason)")
  exit 1
}

# Resolve the PowerShell host executable by name rather than by inspecting the
# running process, which has a documented null-risk on some hosts.
# In Windows PowerShell 5.1 $IsWindows is $null and Major is 5 -> 'powershell'.
# In pwsh 7 on Linux Major is 7 and $IsWindows is $false -> 'pwsh'.
if ($IsWindows -or $PSVersionTable.PSVersion.Major -le 5) {
  $hostExe = 'powershell'
} else {
  $hostExe = 'pwsh'
}

# Invoke the label-removal command and capture its exit code.
# Test seam: -LabelRemoverScript path overrides the real gh call.
if ($LabelRemoverScript) {
  & $hostExe -NoProfile -ExecutionPolicy Bypass -File $LabelRemoverScript -IssueNumber $IssueNumber -Label $Label
  $rc = $LASTEXITCODE
} else {
  & 'C:\Program Files\GitHub CLI\gh.exe' issue edit $IssueNumber --remove-label $Label -R $Repo
  $rc = $LASTEXITCODE
}

if ($rc -ne 0) {
  [Console]::Error.WriteLine("clear-issue-marker: label-remover exited $rc -- label may still be set")
  exit $rc
}

exit 0
