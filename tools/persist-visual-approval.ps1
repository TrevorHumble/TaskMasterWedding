# persist-visual-approval.ps1 — records ONE visual-approval evidence file
# after the owner has explicitly approved a screen in the phase-1 live-preview
# loop (issue #378, agents/orchestrator.md § "Visual-approval loop").
#
# Honest residual (stated, not hidden): this script is run by the orchestrator
# on the owner's go-ahead, so a determined hand could call it directly with no
# real approval behind it. That is made tamper-EVIDENT, not impossible — the
# owner's bar is tamper-evident, not tamper-proof.
#
# Why the record lives under .review_state/, not inside the visual surface
# itself: .review_state/ is gitignored and entirely OUTSIDE src/views/**,
# src/public/** — the exact surface tools/visual-surface.ps1 hashes — so
# writing this record can never itself change the hash it just recorded
# (AC3: "the approval record must live outside the hashed set so recording
# it does not void itself").
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [Parameter(Mandatory = $true)][string]$Approver,
  [string]$RepoRoot = ''
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'visual-surface.ps1')

if (-not $RepoRoot) {
  $RepoRoot = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
}
if (-not $RepoRoot) {
  [Console]::Error.WriteLine('persist-visual-approval: not inside a git repo')
  exit 1
}

$pairs = Get-VisualSurfaceFileHashes -RepoRoot $RepoRoot
$combinedHash = Get-VisualSurfaceHash -RepoRoot $RepoRoot

# files: an ordered map of path -> hash, persisted alongside the combined
# hash so a later drift check (tools/check-visual-approval.ps1) can name the
# SPECIFIC file(s) that changed rather than only reporting "something moved".
$filesMap = [ordered]@{}
foreach ($p in $pairs) {
  $filesMap[$p.Path] = $p.Hash
}

$record = [ordered]@{
  schema       = 'va1'
  surface_hash = $combinedHash
  approver     = $Approver
  ts           = (Get-Date -Format o)
  files        = $filesMap
}

$recordPath = Get-VisualApprovalRecordPath -RepoRoot $RepoRoot
$dir = Split-Path -Parent $recordPath
New-Item -ItemType Directory -Force -Path $dir | Out-Null

[IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Compress -Depth 5))
Write-Output "visual approval recorded: hash $combinedHash by $Approver ($($pairs.Count) files)"
