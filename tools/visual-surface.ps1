# visual-surface.ps1 — the single definition of the "visual surface" glob set
# (issue #378), plus a hash of the sorted content of every git-tracked file
# that matches it. Dot-source this file; do not run it directly.
#
# Mirrors the "Views/CSS/badge assets/guest-or-admin-facing copy" row of
# standards/adversarial-review-protocol.md § "Which reviews does this change
# need?" — the same visual-change surface agents/orchestrator.md § "Visual-
# approval loop" triggers on. tests/visual-approval.test.js drift-guards this
# file's glob list against that row so the two definitions cannot silently
# diverge.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.

# Directory-level, not a literal '**' glob: git ls-files already lists every
# file under a directory pathspec recursively, and today src/views/ holds
# nothing but .ejs files, so a directory pathspec and a '*.ejs' glob select
# the same set. src/public/ is CSS + client JS + badge art + fonts — the
# whole "Views/CSS/badge assets" surface in one directory.
$VISUAL_SURFACE_GLOBS = @(
  'src/views',
  'src/public'
)

# Get-VisualSurfaceFiles — every git-TRACKED file under $VISUAL_SURFACE_GLOBS,
# sorted for a deterministic hash order. Tracked-only (via `git ls-files`) so
# an untracked scratch/editor-temp file can never perturb the freeze.
function Get-VisualSurfaceFiles {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)

  $prevLoc = Get-Location
  try {
    Set-Location $RepoRoot
    $tracked = @(& git ls-files -- $VISUAL_SURFACE_GLOBS)
  } finally {
    Set-Location $prevLoc
  }
  return @($tracked | Sort-Object)
}

# Get-VisualSurfaceFileHashes — [pscustomobject]@{Path; Hash} for every file
# Get-VisualSurfaceFiles returns, SHA256 over each file's raw bytes. Returned
# sorted by Path (Get-VisualSurfaceFiles already sorts, but re-asserted here
# so this function's contract does not depend on the caller's).
function Get-VisualSurfaceFileHashes {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $files = Get-VisualSurfaceFiles -RepoRoot $RepoRoot | Sort-Object
    $result = @()
    foreach ($f in $files) {
      $full = Join-Path $RepoRoot $f
      $bytes = [IO.File]::ReadAllBytes($full)
      $hashBytes = $sha.ComputeHash($bytes)
      $hex = ([BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
      $result += [pscustomobject]@{ Path = $f; Hash = $hex }
    }
    return $result
  } finally {
    $sha.Dispose()
  }
}

# Get-VisualSurfaceHash — one combined SHA256 token over the sorted
# {path,hash} pairs Get-VisualSurfaceFileHashes returns. Any content change,
# addition, removal, or rename inside the visual surface changes this token.
function Get-VisualSurfaceHash {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)

  $pairs = Get-VisualSurfaceFileHashes -RepoRoot $RepoRoot
  $sb = New-Object System.Text.StringBuilder
  foreach ($p in $pairs) {
    [void]$sb.Append("$($p.Path)=$($p.Hash)`n")
  }

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $combinedBytes = [Text.Encoding]::UTF8.GetBytes($sb.ToString())
    $hashBytes = $sha.ComputeHash($combinedBytes)
    return ([BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

# Get-VisualApprovalRecordPath — the one authoritative path to the
# visual-approval evidence record (issue #378 AC3). Lives outside
# $VISUAL_SURFACE_GLOBS so writing the record can never itself perturb the
# hash it just recorded. tools/persist-visual-approval.ps1 (writer) and
# tools/check-visual-approval.ps1 (reader) both call this instead of
# constructing the path locally, so relocating the record cannot silently
# desync writer and reader into "no recorded approval".
function Get-VisualApprovalRecordPath {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)

  return Join-Path $RepoRoot (Join-Path '.review_state' (Join-Path 'visual-approval' 'approval.json'))
}
