# verdict-core.ps1 — shared evidence schema, reader, and count/dedup logic.
# Dot-source this file; do not run it directly.
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.

# System-level path regex: if any staged path matches (and is not carved out by
# $EXPERIMENTAL_PATH_REGEX below), required = 2.
$SYSTEM_PATH_REGEX = '^(\.githooks/|tools/|standards/|agents/|skills/|\.github/|\.claude/|docs/north-star\.md|DESIGN\.md|CLAUDE\.md|AGENTS\.md)'

# Experimental governance surface (#218): reviewer charters (agents/reviewer-*.md,
# including new lens charters) take the routine bar (1). Everything else the system
# regex matches stays kernel (2) — including the rest of agents/ (orchestrator,
# implementation-agent, severity-adjudicator) and all bar-definitions, which fail
# silently when weakened. See DESIGN.md "System-level change (definition)".
$EXPERIMENTAL_PATH_REGEX = '^agents/reviewer-[^/]+\.md$'

# Evidence schema labels — single declared source for the persist-*.ps1 writer
# family (persist-issue-review.ps1, persist-review.ps1, persist-self-certification.ps1)
# so the 'schema' field literal is not hand-duplicated per writer. Readers
# (Read-Evidence below, tools/issue-core.ps1 Read-IssueEvidence) only compare the
# parsed JSON's schema field as a value at runtime — they do not reference these
# PowerShell constants — so this is purely a writer-side dedup, not a reader contract.
$SCHEMA_IREV1 = 'irev1'
$SCHEMA_REV1 = 'rev1'

function Get-RequiredBar {
  param(
    [string[]]$StagedPaths
  )
  $paths = @($StagedPaths)
  foreach ($p in $paths) {
    if ($p -match $EXPERIMENTAL_PATH_REGEX) {
      continue
    }
    if ($p -match $SYSTEM_PATH_REGEX) {
      return 2
    }
  }
  return 1
}

function Read-Evidence {
  param(
    [string]$Tree,
    [string]$EvidenceRoot
  )
  $dir = Join-Path $EvidenceRoot $Tree
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

# Reduce-Verdicts — shared counting kernel used by BOTH the tree-based PR gate
# (Test-VerdictSatisfied) and the issue-number-based issue gate (Test-IssueReviewed
# in tools/issue-core.ps1). Single source of truth: change this once, both gates
# move together.
#
# $evidence  — array of parsed JSON objects; each must have .reviewer_id and .verdict.
# $Required  — minimum distinct PASS reviewer_ids needed for ok=true.
# $Label     — human-readable label for error messages (e.g. "tree abc123" or "issue 46").
#
# Returns a pscustomobject: { ok=[bool], n=[int], reason=[string] }
function Reduce-Verdicts {
  param(
    [object[]]$evidence,
    [int]$Required,
    [string]$Label
  )
  $evidence = @($evidence)

  if ($evidence.Count -eq 0) {
    return [pscustomobject]@{
      ok     = $false
      n      = 0
      reason = "blocked: no review evidence for $Label"
    }
  }

  # Group by reviewer_id. Per-reviewer FAIL-wins: if any file for a reviewer_id
  # is FAIL, that reviewer is FAIL regardless of other files for that id.
  $groups = @{}
  foreach ($e in $evidence) {
    $id = $e.reviewer_id
    if ([string]::IsNullOrWhiteSpace($id)) {
      return [pscustomobject]@{
        ok     = $false
        n      = 0
        reason = "blocked: malformed evidence (empty reviewer_id) for $Label"
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
      reason = "blocked: a FAIL review is present for $Label"
    }
  }

  if ($passCount -ge $Required) {
    return [pscustomobject]@{
      ok     = $true
      n      = $passCount
      reason = "ok: $passCount distinct PASS reviewer(s) for $Label"
    }
  }

  return [pscustomobject]@{
    ok     = $false
    n      = $passCount
    reason = "blocked: $passCount/$Required distinct PASS reviewers for $Label"
  }
}

function Test-VerdictSatisfied {
  param(
    [string]$Tree,
    [int]$Required = 1,
    [string]$ReviewsRoot
  )
  $evidence = @(Read-Evidence -Tree $Tree -EvidenceRoot $ReviewsRoot)
  return Reduce-Verdicts -evidence $evidence -Required $Required -Label "tree $Tree"
}

# Test-BiasGateSatisfied — a system-level tree fails closed unless at least one
# bias-gate artifact for the tree is PASS and none is FAIL (fail-wins, mirroring
# the per-reviewer FAIL-wins rule in Reduce-Verdicts). The reason string always
# contains the literal token "bias-gate" so the caller can surface a stable,
# greppable failure message.
# Returns a pscustomobject: { ok=[bool]; reason=[string] }
function Test-BiasGateSatisfied {
  param(
    [string]$Tree,
    [string]$Root
  )
  $evidence = @(Read-Evidence -Tree $Tree -EvidenceRoot $Root)

  if ($evidence.Count -eq 0) {
    return [pscustomobject]@{
      ok     = $false
      reason = "blocked: no bias-gate evidence for tree $Tree"
    }
  }

  $hasFail = $false
  $hasPass = $false
  foreach ($e in $evidence) {
    if ($e.verdict -eq 'FAIL') { $hasFail = $true }
    if ($e.verdict -eq 'PASS') { $hasPass = $true }
  }

  if ($hasFail) {
    return [pscustomobject]@{
      ok     = $false
      reason = "blocked: a FAIL bias-gate artifact is present for tree $Tree"
    }
  }

  if ($hasPass) {
    return [pscustomobject]@{
      ok     = $true
      reason = "ok: bias-gate satisfied for tree $Tree"
    }
  }

  return [pscustomobject]@{
    ok     = $false
    reason = "blocked: no PASS bias-gate artifact for tree $Tree"
  }
}
