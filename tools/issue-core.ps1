# issue-core.ps1 — issue-number-keyed helpers for the commit-msg gate.
# Dot-source this file; do not run it directly.
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
# Self-contained: no dependency on any other tools/*.ps1 file.

# Resolve-IssueNumber — deterministic, two-source resolution.
#
# 1. Message first: match (#\d+) or any of GitHub's 9 auto-close keywords
#    (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved)
#    followed by #\d+ (case-insensitive). This is the GitHub auto-close
#    carrier and the per-commit artifact the committer controls.
# 2. Branch fallback: ONLY an anchored mandatory-prefix token
#    (?i)(?:^|[-/])issue[-/](\d+)(?:$|[-/]) so that a branch like
#    enforce/v4-s1-audit-core does NOT resolve (no issue[-/] prefix), and
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
    # GitHub auto-close keywords, all 9: close/closes/closed, fix/fixes/fixed,
    # resolve/resolves/resolved #N (case-insensitive). See #585.
    if ($Message -match '(?i)(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)') {
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
    # This rejects 'enforce/v4-s1-audit-core' (no issue token) and accepts
    # 'feat/issue-46' -> 46, 'issue-46-foo' -> 46, 'fix/issue/46' -> 46.
    if ($Branch -match '(?i)(?:^|[-/])issue[-/](\d+)(?:$|[-/])') {
      return [int]$Matches[1]
    }
  }

  return 0
}

# Test-StagedHasCode — returns $true if any staged path is CODE.
# Doc = path ends in .md or .markdown (case-insensitive). Everything else is CODE.
# Folder location (e.g. docs/) does NOT exempt a path — a code file under docs/
# is still CODE. Only the file extension determines the classification.
# Deletions are INCLUDED (no --diff-filter) and classified by their path, so a
# commit that only deletes code files (e.g. git rm app.js) is still CODE and
# cannot bypass the gate. NUL-safe path handling guards against a non-ASCII or
# space-containing path being misclassified.
function Test-StagedHasCode {
  $z = "$(& git -c core.quotepath=false diff --cached --name-only -z 2>$null)"
  $paths = @($z -split "`0" | Where-Object { $_ })
  if (@($paths).Count -eq 0) { return $false }
  foreach ($p in $paths) {
    if ($p -notmatch '(?i)\.(md|markdown)$') { return $true }
  }
  return $false
}
