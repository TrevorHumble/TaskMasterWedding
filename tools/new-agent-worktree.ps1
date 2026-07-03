# new-agent-worktree: give one file-mutating agent its own working directory on
# its own branch, sharing this repo's history via `git worktree add`. Two agent
# sessions sharing a single folder can stash, revert, or switch-branch-under each
# other's uncommitted work -- the exact failure this repo hit on 2026-07-02 when a
# Dependabot session and a refactor session shared one folder. One working tree,
# one driver. The commit gate is live in the new worktree with zero extra config:
# core.hooksPath=.githooks is a relative path in shared git config, and .githooks/
# is a tracked directory, so it resolves to <worktree>/.githooks automatically --
# this script asserts that rather than assuming it.
param(
  [Parameter(Mandatory = $true)]
  [string]$Branch
)

$top = (& git rev-parse --show-toplevel 2>$null)
if (-not $top) { [Console]::Error.WriteLine('new-agent-worktree: not inside a git repo'); exit 1 }

$repoName = Split-Path $top -Leaf
$parent = Split-Path $top -Parent
$slug = $Branch -replace '[\\/]', '-' -replace '[^A-Za-z0-9._-]', '-'
$path = Join-Path $parent "$repoName-$slug"

if (Test-Path $path) {
  [Console]::Error.WriteLine("new-agent-worktree: target path already exists: $path")
  exit 1
}

& git show-ref --verify --quiet "refs/heads/$Branch"
$branchExists = ($LASTEXITCODE -eq 0)

if ($branchExists) {
  & git worktree add $path $Branch
} else {
  & git worktree add -b $Branch $path
}
$addExit = $LASTEXITCODE

if ($addExit -ne 0) {
  [Console]::Error.WriteLine("new-agent-worktree: 'git worktree add' failed (exit $addExit) -- see git's message above for the reason (e.g. branch already checked out elsewhere, or path in use). No worktree was created.")
  exit 1
}

# Assert the gate is live INSIDE the new worktree -- don't just assume the shared
# hooksPath config resolves the way this comment says it does.
Push-Location $path
try {
  $gateOut = (& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $path 'tools/check-gate.ps1'))
  $gateOk = ($LASTEXITCODE -eq 0)
} finally {
  Pop-Location
}

if (-not $gateOk) {
  [Console]::Error.WriteLine("new-agent-worktree: worktree created at $path but its commit gate is not live. Run: powershell -File tools/setup-hooks.ps1")
  exit 1
}

$absPath = (Resolve-Path $path).Path
Write-Output $gateOut
Write-Output "worktree ready: $absPath (branch '$Branch'). cd into it to work."
