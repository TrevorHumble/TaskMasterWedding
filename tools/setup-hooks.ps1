# setup-hooks: activate the repo's committed git hooks. core.hooksPath is local
# config (not carried by a clone), so this must run once per working copy. The
# orchestrator's machine runs it; a fresh clone runs it before first commit.
$top = (& git rev-parse --show-toplevel 2>$null)
if (-not $top) { Write-Error 'setup-hooks: not inside a git repo'; exit 1 }
& git config core.hooksPath .githooks
Write-Output "core.hooksPath -> .githooks (pre-commit gate active)"
