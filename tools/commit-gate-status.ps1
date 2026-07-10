# commit-gate-status.ps1 — single owner of the "is the commit gate active?" rule.
# Dot-source this file; do not run it directly.
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
#
# The commit gate is active only when core.hooksPath = .githooks AND BOTH
# .githooks/pre-commit AND .githooks/commit-msg exist. Both session-greeting.ps1
# and check-enforcement.ps1 delegate here instead of composing this condition
# themselves (#376 -- the two had drifted, with the greeting checking pre-commit
# only and falsely reporting "protected" when commit-msg was missing).
function Test-CommitGateActive {
  param(
    [string]$Top
  )
  $hp = "$(& git -C $Top config --get core.hooksPath)".Trim()
  return ($hp -eq '.githooks') `
    -and (Test-Path (Join-Path $Top '.githooks/pre-commit')) `
    -and (Test-Path (Join-Path $Top '.githooks/commit-msg'))
}
