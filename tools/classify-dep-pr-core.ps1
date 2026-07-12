# tools/classify-dep-pr-core.ps1 — shared tier-classification logic for
# Dependabot-shaped dependency bumps. Dot-source this file; do not run it
# directly (mirrors the -core.ps1 convention of tools/verdict-core.ps1,
# tools/issue-core.ps1, tools/event-mode-core.ps1).
#
# Single source of truth for the auto/review precedence rules (#448), reused by:
#   - tools/classify-dep-pr.ps1 (thin CLI: classifies one real Dependabot PR)
#   - tools/classify-trivial-commit.ps1 (classifies a staged hand-built bump)
# See CLAUDE.md § "Dependency updates (Dependabot)" and DESIGN.md for the policy.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.

# Wedding-critical prod dependencies — a bad bump breaks a core guest path.
# Single source of truth: do not duplicate this list; CLAUDE.md mirrors it,
# and .github/dependabot.yml's exclude-patterns mirrors it a second time
# (both drift-guarded by tests/classify-dep-pr.test.js).
$WeddingCritical = @('multer', 'sharp', 'ejs', 'better-sqlite3', 'bcryptjs', 'archiver')

# Get-DepPrTier — classifies a single dependency bump into 'auto' or 'review'.
# Precedence (evaluated top-down, first match wins):
#   1. github-actions bumps -> auto
#   2. dev-dependency bumps -> auto (CI catches a broken build)
#   3. wedding-critical prod dep (any semver) -> review
#   4. prod major bump -> review
#   5. everything else -> auto
function Get-DepPrTier {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('github-actions', 'npm')][string]$Ecosystem,
    [Parameter(Mandatory = $true)][string]$DepName,
    [Parameter(Mandatory = $true)][ValidateSet('patch', 'minor', 'major')][string]$SemverBump,
    [Parameter(Mandatory = $true)][ValidateSet('prod', 'dev')][string]$DepType
  )

  if ($Ecosystem -eq 'github-actions') {
    return 'auto'
  }
  if ($DepType -eq 'dev') {
    return 'auto'
  }
  if ($WeddingCritical -contains $DepName) {
    return 'review'
  }
  if ($SemverBump -eq 'major') {
    return 'review'
  }
  return 'auto'
}
