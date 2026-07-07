# governance-report.ps1 - read-only aggregator over governance/ledger.ndjson (#219).
# Pure function of the ledger file: no network, no writes, no git.
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
#
# Output: per-role review totals (reviews, PASS/FAIL, defects by severity),
# rounds per issue, and the reversal count. Prints the literal line
# 'no ledger rows' when the file is absent or holds no parseable rows
# (tools/snapshot-governance.ps1 captures this output as stats.txt).
param(
  [string]$Ledger = 'governance/ledger.ndjson'
)

$ErrorActionPreference = 'Stop'

$rows = @()
$badLines = 0
if (Test-Path -LiteralPath $Ledger) {
  $lines = @(Get-Content -LiteralPath $Ledger -ErrorAction Stop)
  foreach ($line in $lines) {
    if (-not $line) { continue }
    if (-not $line.Trim()) { continue }
    try {
      $rows += ($line | ConvertFrom-Json)
    } catch {
      $badLines++
    }
  }
}

if (@($rows).Count -eq 0) {
  Write-Output 'no ledger rows'
  if ($badLines -gt 0) {
    [Console]::Error.WriteLine("governance-report: $badLines unparseable line(s) skipped")
  }
  exit 0
}

# --- aggregate ---
$roles = @{}
$issues = @{}
$reversals = 0
$glRows = 0

foreach ($row in $rows) {
  if ($row.schema -eq 'gl1-reversal') {
    $reversals++
    continue
  }
  if ($row.schema -ne 'gl1') { continue }
  $glRows++
  foreach ($rev in @($row.reviews)) {
    if ($null -eq $rev) { continue }
    $role = [string]$rev.role
    if (-not $roles.ContainsKey($role)) {
      $roles[$role] = @{
        total = 0; pass = 0; fail = 0
        blocker = 0; major = 0; minor = 0; nit = 0
      }
    }
    $r = $roles[$role]
    $r.total++
    if ($rev.verdict -eq 'PASS') { $r.pass++ }
    if ($rev.verdict -eq 'FAIL') { $r.fail++ }
    if ($rev.defects) {
      foreach ($sev in @('blocker', 'major', 'minor', 'nit')) {
        $v = $rev.defects.$sev
        if ($null -ne $v) { $r[$sev] += [int]$v }
      }
    }
    if ($null -ne $row.issue) {
      $key = [string]$row.issue
      if (-not $issues.ContainsKey($key)) {
        $issues[$key] = @{ reviews = 0; maxRound = 0 }
      }
      $issues[$key].reviews++
      if ($null -ne $rev.round) {
        $round = [int]$rev.round
        if ($round -gt $issues[$key].maxRound) { $issues[$key].maxRound = $round }
      }
    }
  }
}

Write-Output "governance ledger report - $Ledger"
Write-Output "gl1 rows: $glRows"
if ($badLines -gt 0) {
  [Console]::Error.WriteLine("governance-report: $badLines unparseable line(s) skipped")
}

Write-Output ''
Write-Output 'role totals:'
foreach ($role in ($roles.Keys | Sort-Object)) {
  $r = $roles[$role]
  Write-Output ("  {0}: total {1}, PASS {2}, FAIL {3}, defects: blocker {4}, major {5}, minor {6}, nit {7}" -f `
      $role, $r.total, $r.pass, $r.fail, $r.blocker, $r.major, $r.minor, $r.nit)
}

Write-Output ''
Write-Output 'rounds per issue:'
if ($issues.Keys.Count -eq 0) {
  Write-Output '  (none attributable - no gl1 row carried both an issue and reviews)'
} else {
  foreach ($key in ($issues.Keys | Sort-Object { [int]$_ })) {
    $i = $issues[$key]
    Write-Output ("  issue {0}: reviews {1}, max round {2}" -f $key, $i.reviews, $i.maxRound)
  }
}

Write-Output ''
Write-Output "reversals: $reversals"
exit 0
