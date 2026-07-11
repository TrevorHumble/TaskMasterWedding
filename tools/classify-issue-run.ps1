# tools/classify-issue-run.ps1
# Classifies an issue's run tier into one of two values:
#   sonnet-only - safe to run the whole pipeline (orchestrator, implementer,
#                 reviewers) on Sonnet
#   opus        - must use the standard Opus policy
#
# Precedence (evaluated top-down, first match wins):
#   1. Touches path matches the system-level governing-artifact surface -> opus
#   2. security-flagged                                                 -> opus
#   3. orchestrator-escalated                                           -> opus
#   4. Touches path matches a wedding-critical guest surface            -> opus
#   5. schema or data migration                                        -> opus
#   6. everything else                                                  -> sonnet-only
#
# Gate (a) reuses $SYSTEM_PATH_REGEX from tools/verdict-core.ps1 verbatim -- the raw
# system-level surface, not the $EXPERIMENTAL_PATH_REGEX reviewer-count carve-out
# Get-RequiredBar applies. That carve-out answers a different question (how many
# reviewers) than run-tier eligibility (which model): a reviewer-charter edit
# (agents/reviewer-*.md) is a governance change and must classify opus, so this
# script applies $SYSTEM_PATH_REGEX directly and never calls Get-RequiredBar.
#
# Compatible with Windows PowerShell 5.1 and pwsh 7+ on Linux/macOS.
# No ternary, no &&/||, no null-coalescing -- WinPS 5.1 constraints.

[CmdletBinding()]
param(
    [string[]]$TouchesPaths = @(),

    [switch]$SecurityFlagged,

    [switch]$Escalated,

    [switch]$SchemaOrDataMigration
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'verdict-core.ps1')

# Wedding-critical guest-path surface -- a change here touches join/auth, upload,
# moderation, or gallery/export core, the four guest paths the North Star goals
# (docs/north-star.md) treat as core-guest-experience. This is the sibling of the
# security-lens dispatch row "Upload/intake, auth, file-serving, admin routes" in
# standards/adversarial-review-protocol.md § "Which reviews does this change need?" --
# when a guest-critical surface moves, update both in the same change. CLAUDE.md
# § "Sonnet-only run tier" mirrors every concrete path below, and a drift-guard
# test (tests/classify-issue-run.test.js) fails CI unless each path here also
# appears in that CLAUDE.md list -- so adding a new path here forces the doc update.
$GuestCriticalPaths = @(
    # join/auth
    'src/routes/auth\.js',
    'src/middleware/session\.js',
    'src/services/identity\.js',
    'src/services/qr\.js',
    # upload
    'src/services/photos\.js',
    'src/services/heic-worker\.js',
    'src/services/submissions\.js',
    # moderation
    'src/routes/admin\.js',
    # gallery/export core
    'src/services/export\.js',
    'src/services/feed\.js'
)
$GuestCriticalPathRegex = '^(' + ($GuestCriticalPaths -join '|') + ')$'

$touchesSystem = $false
foreach ($p in $TouchesPaths) {
    if ($p -match $SYSTEM_PATH_REGEX) {
        $touchesSystem = $true
        break
    }
}

$touchesGuestCritical = $false
foreach ($p in $TouchesPaths) {
    if ($p -match $GuestCriticalPathRegex) {
        $touchesGuestCritical = $true
        break
    }
}

if ($touchesSystem) {
    Write-Output 'opus'
}
elseif ($SecurityFlagged) {
    Write-Output 'opus'
}
elseif ($Escalated) {
    Write-Output 'opus'
}
elseif ($touchesGuestCritical) {
    Write-Output 'opus'
}
elseif ($SchemaOrDataMigration) {
    Write-Output 'opus'
}
else {
    Write-Output 'sonnet-only'
}

exit 0
