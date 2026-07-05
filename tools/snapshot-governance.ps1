# snapshot-governance.ps1 - tag a governance state and export its surface (#224).
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
# Deliberately keeps $ErrorActionPreference at 'Continue': under PS 5.1 a
# native command's redirected stderr becomes a terminating NativeCommandError
# when the preference is 'Stop', which would kill the legitimate
# absent-ledger path below. Every git call is checked via $LASTEXITCODE.
#
# Creates annotated tag governance-v<N> at HEAD (refusing on a dirty tree or an
# existing tag), then exports the governance surface plus stats.txt (the output
# of tools/governance-report.ps1 against governance/ledger.ndjson at HEAD, or
# the literal line 'no ledger rows' when the ledger is absent). Copying the
# export into the scaffold-project template repo remains a manual owner step -
# this tool never pushes anywhere. See DESIGN.md "Governance snapshots (#224)".
param(
  [Parameter(Mandatory = $true)][int]$Version,
  [string]$ExportDir = 'data/governance-snapshots'
)

$tag = "governance-v$Version"

# The governance surface exported per snapshot (#224).
$surfacePaths = @(
  'standards',
  'agents',
  '.githooks',
  'tools',
  'skills',
  'CLAUDE.md',
  'DESIGN.md',
  'docs/north-star.md',
  '.github/workflows'
)

# --- preconditions: inside a repo, clean tree, tag free ---------------------
& git rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine('snapshot-governance: not inside a git working tree.')
  exit 1
}

$dirty = @(& git status --porcelain)
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine('snapshot-governance: git status failed.')
  exit 1
}
if (@($dirty | Where-Object { $_ }).Count -gt 0) {
  [Console]::Error.WriteLine('snapshot-governance: working tree is dirty; commit or stash before snapshotting. No tag created.')
  exit 1
}

$existing = & git tag -l $tag
if ($existing) {
  [Console]::Error.WriteLine("snapshot-governance: tag $tag already exists - pick a new -Version. No tag created.")
  exit 1
}

# --- tag ---------------------------------------------------------------------
& git tag -a $tag -m "governance snapshot v$Version"
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine("snapshot-governance: git tag failed for $tag.")
  exit 1
}

# --- export ------------------------------------------------------------------
$dest = Join-Path $ExportDir $tag
New-Item -ItemType Directory -Force -Path $dest | Out-Null

foreach ($p in $surfacePaths) {
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $target = Join-Path $dest ($p -replace '/', [IO.Path]::DirectorySeparatorChar)
  $parent = Split-Path -Parent $target
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item -LiteralPath $p -Destination $target -Recurse -Force
}

# stats.txt - the ledger's report at this commit. The tree is clean (checked
# above), so HEAD's ledger content is read via git show rather than trusting
# the working copy; an absent ledger writes the literal 'no ledger rows'.
$statsPath = Join-Path $dest 'stats.txt'
$ledgerContent = & git show 'HEAD:governance/ledger.ndjson' 2>$null
if ($LASTEXITCODE -eq 0) {
  $ledgerTmp = Join-Path ([IO.Path]::GetTempPath()) ('gov-ledger-' + [Guid]::NewGuid().ToString('N') + '.ndjson')
  if ($null -eq $ledgerContent) { $ledgerContent = @() }
  Set-Content -LiteralPath $ledgerTmp -Value $ledgerContent -Encoding UTF8
  $reportScript = Join-Path $PSScriptRoot 'governance-report.ps1'
  # In-process call (not a powershell.exe child): the launcher name differs
  # across platforms (powershell vs pwsh) and the report script is side-effect
  # free; its `exit` only ends the child script scope.
  $stats = & $reportScript -Ledger $ledgerTmp
  if ($null -eq $stats) { $stats = @() }
  Set-Content -LiteralPath $statsPath -Value $stats -Encoding UTF8
  Remove-Item -LiteralPath $ledgerTmp -Force -ErrorAction SilentlyContinue
} else {
  Set-Content -LiteralPath $statsPath -Value 'no ledger rows' -Encoding UTF8
}

Write-Output "tag: $tag"
Write-Output "export: $dest"
exit 0
