# tools/classify-dep-pr.ps1
# Classifies a Dependabot PR into one of two tiers:
#   auto   - safe to merge on green CI with no additional review
#   review - held for a tracked decision before merge
#
# Precedence (evaluated top-down, first match wins):
#   1. github-actions bumps -> auto
#   2. dev-dependency bumps -> auto (CI catches a broken build)
#   3. wedding-critical prod dep (any semver) -> review
#   4. prod major bump -> review
#   5. everything else -> auto
#
# Compatible with Windows PowerShell 5.1 and pwsh 7+ on Linux/macOS.
# No ternary, no &&/||, no null-coalescing -- WinPS 5.1 constraints.

# [CmdletBinding()] + [Parameter(Mandatory)] + [ValidateSet] are deliberate: invalid ecosystem/bump/type
# inputs are unrepresentable, so the classifier body needs no input-guard branches.
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('github-actions', 'npm')]
    [string]$Ecosystem,

    [Parameter(Mandatory)]
    [string]$DepName,

    [Parameter(Mandatory)]
    [ValidateSet('patch', 'minor', 'major')]
    [string]$SemverBump,

    [Parameter(Mandatory)]
    [ValidateSet('prod', 'dev')]
    [string]$DepType
)

# Wedding-critical prod dependencies — a bad bump breaks a core guest path.
# Single source of truth: do not duplicate this list; CLAUDE.md mirrors it.
$WeddingCritical = @('multer', 'sharp', 'ejs', 'better-sqlite3', 'bcryptjs', 'archiver')

if ($Ecosystem -eq 'github-actions') {
    Write-Output 'auto'
}
elseif ($DepType -eq 'dev') {
    Write-Output 'auto'
}
elseif ($WeddingCritical -contains $DepName) {
    Write-Output 'review'
}
elseif ($SemverBump -eq 'major') {
    Write-Output 'review'
}
else {
    Write-Output 'auto'
}

exit 0
