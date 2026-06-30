# verdict-core.ps1 — shared evidence schema, reader, and count/dedup logic.
# Dot-source this file; do not run it directly.
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.

# System-level path regex: if any staged path matches, required = 2.
$SYSTEM_PATH_REGEX = '^(\.githooks/|tools/|standards/|agents/|skills/|\.github/|\.claude/|docs/north-star\.md|DESIGN\.md|CLAUDE\.md|AGENTS\.md)'

function Get-RequiredBar {
  param(
    [string[]]$StagedPaths
  )
  $paths = @($StagedPaths)
  foreach ($p in $paths) {
    if ($p -match $SYSTEM_PATH_REGEX) {
      return 2
    }
  }
  return 1
}

function Read-Evidence {
  param(
    [string]$Tree,
    [string]$ReviewsRoot
  )
  $dir = Join-Path $ReviewsRoot $Tree
  if (-not (Test-Path $dir)) {
    return @()
  }
  $files = @(Get-ChildItem -Path $dir -Filter '*.json' -File -ErrorAction SilentlyContinue)
  $result = @()
  foreach ($f in $files) {
    try {
      $raw = Get-Content -Raw -Path $f.FullName -ErrorAction Stop
      $obj = $raw | ConvertFrom-Json
      if ($obj.tree_oid -eq $Tree) {
        $result += $obj
      }
    } catch { }
  }
  return $result
}

function Test-VerdictSatisfied {
  param(
    [string]$Tree,
    [int]$Required = 1,
    [string]$ReviewsRoot
  )
  $evidence = @(Read-Evidence -Tree $Tree -ReviewsRoot $ReviewsRoot)

  # Zero valid (tree_oid-matched) files -> no evidence
  if ($evidence.Count -eq 0) {
    return [pscustomobject]@{
      ok     = $false
      n      = 0
      reason = "blocked: no review evidence for tree $Tree"
    }
  }

  # Group by reviewer_id. Per-reviewer FAIL-wins: if any file for a reviewer_id
  # is FAIL, that reviewer is a FAIL regardless of other files for that id.
  $groups = @{}
  foreach ($e in $evidence) {
    $id = $e.reviewer_id
    if ([string]::IsNullOrWhiteSpace($id)) {
      return [pscustomobject]@{
        ok     = $false
        n      = 0
        reason = "blocked: malformed evidence (empty reviewer_id) for tree $Tree"
      }
    }
    if (-not $groups.ContainsKey($id)) {
      $groups[$id] = @()
    }
    $groups[$id] += $e
  }

  # Check each group: if any file in the group is FAIL -> reviewer is FAIL
  $hasAnyFail = $false
  $passCount = 0
  foreach ($id in $groups.Keys) {
    $groupFiles = @($groups[$id])
    $groupHasFail = $false
    foreach ($gf in $groupFiles) {
      if ($gf.verdict -eq 'FAIL') {
        $groupHasFail = $true
        break
      }
    }
    if ($groupHasFail) {
      $hasAnyFail = $true
    } else {
      # Check if group has at least one PASS
      $groupHasPass = $false
      foreach ($gf in $groupFiles) {
        if ($gf.verdict -eq 'PASS') {
          $groupHasPass = $true
          break
        }
      }
      if ($groupHasPass) {
        $passCount++
      }
    }
  }

  if ($hasAnyFail) {
    return [pscustomobject]@{
      ok     = $false
      n      = 0
      reason = "blocked: a FAIL review is present for tree $Tree"
    }
  }

  if ($passCount -ge $Required) {
    return [pscustomobject]@{
      ok     = $true
      n      = $passCount
      reason = "ok: $passCount distinct PASS reviewer(s) for tree $Tree"
    }
  }

  return [pscustomobject]@{
    ok     = $false
    n      = $passCount
    reason = "blocked: $passCount/$Required distinct PASS reviewers for tree $Tree"
  }
}
