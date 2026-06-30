# issue-core.ps1 — issue-number-keyed helpers for the commit-msg gate.
# Dot-source this file; do not run it directly.
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
#
# Depends on: tools/verdict-core.ps1 (Reduce-Verdicts must be dot-sourced first).

# Resolve-IssueNumber — deterministic, two-source resolution.
#
# 1. Message first: match (#\d+) or Closes/Fixes/Resolves #\d+ (case-insensitive).
#    This is the GitHub auto-close carrier and the per-commit artifact the committer
#    controls.
# 2. Branch fallback: ONLY an anchored mandatory-prefix token
#    (?i)(?:^|[-/])issue[-/](\d+)(?:$|[-/]) so that a branch like
#    enforce/v4-s1-gate-core does NOT resolve (no issue[-/] prefix), and
#    feat/issue-46 DOES resolve to 46. Bare numerals in version strings are
#    never captured.
#
# Returns an int > 0, or 0 if unresolvable.
function Resolve-IssueNumber {
  param(
    [string]$Message,
    [string]$Branch
  )

  # --- message-first ---
  if ($Message) {
    # GitHub auto-close keywords: Closes/Fixes/Resolves #N (case-insensitive)
    if ($Message -match '(?i)(?:closes|fixes|resolves)\s+#(\d+)') {
      return [int]$Matches[1]
    }
    # Inline reference: (#N)
    if ($Message -match '\(#(\d+)\)') {
      return [int]$Matches[1]
    }
  }

  # --- branch fallback ---
  if ($Branch) {
    # Mandatory anchored prefix: issue[-/] must appear, preceded by start or [-/].
    # This rejects 'enforce/v4-s1-gate-core' (no issue token) and accepts
    # 'feat/issue-46' -> 46, 'issue-46-foo' -> 46, 'fix/issue/46' -> 46.
    if ($Branch -match '(?i)(?:^|[-/])issue[-/](\d+)(?:$|[-/])') {
      return [int]$Matches[1]
    }
  }

  return 0
}

# Read-IssueEvidence — reads all *.json files under $Root/<N>/ and keeps only
# those whose inner issue_number field equals $N.  Mirrors verdict-core's
# Read-Evidence tree_oid self-binding guard: a file in the wrong directory or
# with a tampered issue_number is silently dropped.
function Read-IssueEvidence {
  param(
    [int]$N,
    [string]$Root
  )
  $dir = Join-Path $Root ([string]$N)
  if (-not (Test-Path $dir)) {
    return @()
  }
  $files = @(Get-ChildItem -Path $dir -Filter '*.json' -File -ErrorAction SilentlyContinue)
  $result = @()
  foreach ($f in $files) {
    try {
      $raw = Get-Content -Raw -Path $f.FullName -ErrorAction Stop
      $obj = $raw | ConvertFrom-Json
      if ($obj.issue_number -eq $N) {
        $result += $obj
      }
    } catch { }
  }
  return $result
}

# Test-IssueReviewed — calls the shared Reduce-Verdicts from verdict-core.ps1.
# Returns a pscustomobject: { ok=[bool], n=[int], reason=[string] }
function Test-IssueReviewed {
  param(
    [int]$N,
    [int]$Required = 1,
    [string]$Root
  )
  $evidence = @(Read-IssueEvidence -N $N -Root $Root)
  return Reduce-Verdicts -evidence $evidence -Required $Required -Label "issue $N"
}

# Test-StagedHasCode — returns $true if any staged path is CODE.
# Doc = path ends in .md or .markdown (case-insensitive). Everything else is CODE.
# Folder location (e.g. docs/) does NOT exempt a path — a code file under docs/
# is still CODE. Only the file extension determines the classification.
# Deletions are INCLUDED (no --diff-filter) and classified by their path, so a
# commit that only deletes code files (e.g. git rm app.js) is still CODE and
# cannot bypass the gate. Mirrors the diff invocation in tools/validate-verdict.ps1.
# Self-contained: no verdict-core dependency. NUL-safe path handling mirrors
# tools/validate-verdict.ps1 so a non-ASCII or space-containing path cannot be
# misclassified.
function Test-StagedHasCode {
  $z = "$(& git -c core.quotepath=false diff --cached --name-only -z 2>$null)"
  $paths = @($z -split "`0" | Where-Object { $_ })
  if (@($paths).Count -eq 0) { return $false }
  foreach ($p in $paths) {
    if ($p -notmatch '(?i)\.(md|markdown)$') { return $true }
  }
  return $false
}
