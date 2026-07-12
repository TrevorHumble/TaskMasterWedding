# tools/classify-dep-pr.ps1
# Classifies a Dependabot PR into one of two tiers:
#   auto   - safe to merge on green CI with no additional review
#   review - held for a tracked decision before merge
#
# Thin CLI over the shared classification core in tools/classify-dep-pr-core.ps1
# (#448) — tools/classify-trivial-commit.ps1 dot-sources that same core, so the
# tier rules have exactly one copy. This file's CLI contract (path, params,
# stdout, exit code) is unchanged by the refactor.
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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'classify-dep-pr-core.ps1')

Write-Output (Get-DepPrTier -Ecosystem $Ecosystem -DepName $DepName -SemverBump $SemverBump -DepType $DepType)

exit 0
