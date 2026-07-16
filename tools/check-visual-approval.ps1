# check-visual-approval.ps1 — AC3's freeze check (issue #378). Exits non-zero
# and NAMES the changed file(s) if the visual surface has drifted since the
# recorded approval; exits 0 when nothing has changed.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [string]$RepoRoot = ''
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'visual-surface.ps1')

if (-not $RepoRoot) {
  $RepoRoot = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
}
if (-not $RepoRoot) {
  [Console]::Error.WriteLine('check-visual-approval: not inside a git repo')
  exit 1
}

$recordPath = Get-VisualApprovalRecordPath -RepoRoot $RepoRoot
if (-not (Test-Path $recordPath)) {
  [Console]::Error.WriteLine(
    "check-visual-approval: no recorded approval at $recordPath -- " +
      'run tools/persist-visual-approval.ps1 after the owner approves the screen'
  )
  exit 1
}

$record = Get-Content -Raw -Path $recordPath | ConvertFrom-Json
$approvedHash = $record.surface_hash

$currentHash = Get-VisualSurfaceHash -RepoRoot $RepoRoot

if ($currentHash -eq $approvedHash) {
  Write-Output "check-visual-approval: OK -- visual surface unchanged since approval ($approvedHash)"
  exit 0
}

# Drift detected -- diff the recorded per-file map against the current one so
# every changed/added/removed file is named individually, not just the
# mismatched combined token.
$recordedFiles = @{}
if ($record.files) {
  foreach ($prop in $record.files.PSObject.Properties) {
    $recordedFiles[$prop.Name] = $prop.Value
  }
}

$currentPairs = Get-VisualSurfaceFileHashes -RepoRoot $RepoRoot
$currentFiles = @{}
foreach ($p in $currentPairs) {
  $currentFiles[$p.Path] = $p.Hash
}

$changed = New-Object System.Collections.Generic.List[string]

foreach ($path in $currentFiles.Keys) {
  if (-not $recordedFiles.ContainsKey($path)) {
    $changed.Add("added: $path")
  } elseif ($recordedFiles[$path] -ne $currentFiles[$path]) {
    $changed.Add("modified: $path")
  }
}
foreach ($path in $recordedFiles.Keys) {
  if (-not $currentFiles.ContainsKey($path)) {
    $changed.Add("removed: $path")
  }
}

[Console]::Error.WriteLine(
  "check-visual-approval: FAIL -- visual surface changed since approval " +
    "(approved $approvedHash, now $currentHash):"
)
foreach ($line in ($changed | Sort-Object)) {
  [Console]::Error.WriteLine("  $line")
}
exit 1
