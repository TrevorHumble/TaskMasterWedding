# audit-issue-markers.ps1 -- board-wide skip audit.
# Lists open issues carrying 'needs-issue-review' so skipped reviews are visible.
# Advisory by default; exits 1 with -Strict when any are found.
#
# Test seam: pass -IssueListJson '<json>' (array of {number, title} objects)
# to override the default gh query.
# Example: -IssueListJson '[{"number":10,"title":"foo"}]'
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [switch]$Strict,
  [string]$Repo = 'TrevorHumble/TaskMasterWedding',
  [string]$IssueListJson = ''
)

# Resolve the issue-list source.
# -IssueListJson overrides for offline tests.
if ($IssueListJson) {
  $parsed = $IssueListJson | ConvertFrom-Json
} else {
  $raw = & 'C:\Program Files\GitHub CLI\gh.exe' issue list `
    --label needs-issue-review `
    --state open `
    --json number,title `
    -R $Repo
  $parsed = $raw | ConvertFrom-Json
}

# Normalize: a single JSON object comes back as a PSCustomObject (not an array),
# so $parsed.Count is $null and a 1-issue list would be silently missed.
# Wrap the result so both a scalar and an array are handled uniformly.
$issues = @()
if ($null -ne $parsed) {
  $issues = @($parsed) | Where-Object { $null -ne $_ -and $null -ne $_.number }
  $issues = @($issues)
}

foreach ($issue in $issues) {
  Write-Output "#$($issue.number) $($issue.title)"
}

if ($Strict -and $issues.Count -gt 0) {
  exit 1
}

exit 0
