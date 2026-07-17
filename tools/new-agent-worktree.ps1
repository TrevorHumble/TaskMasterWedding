# new-agent-worktree: give one file-mutating agent its own working directory on
# its own branch, sharing this repo's history via `git worktree add`. Two agent
# sessions sharing a single folder can stash, revert, or switch-branch-under each
# other's uncommitted work -- the exact failure this repo hit on 2026-07-02 when a
# Dependabot session and a refactor session shared one folder. One working tree,
# one driver. The commit gate is live in the new worktree with zero extra config:
# core.hooksPath=.githooks is a relative path in shared git config, and .githooks/
# is a tracked directory, so it resolves to <worktree>/.githooks automatically --
# this script asserts that rather than assuming it.
#
# Fetch-fresh, always (#357). #357's incident: a worktree was cut from local
# `main` at a commit 76 behind `origin/main` -- nobody ever ran `git fetch`
# first, so the branch inherited a local `main` that had simply never been
# pulled, and a full adversarial review certified work against a base
# `origin/main` had already abandoned. A NEW branch is therefore based on
# `origin/main` explicitly, never on local HEAD: `git fetch` fails loud (never
# a silent fall-back to whatever HEAD happens to be), and `git worktree add -b`
# names `origin/main` as the start point so the new branch is 0 commits behind
# at birth regardless of how stale the primary checkout's local `main` is. An
# EXISTING branch (the resume path) still fetches -- so a later freshness
# check has a true remote view to compare against -- but is checked out as-is,
# with no rebase/merge/reset: resuming a session must never silently rewrite
# history out from under it.
param(
  [Parameter(Mandatory = $true)]
  [string]$Branch
)

$top = (& git rev-parse --show-toplevel 2>$null)
if (-not $top) { [Console]::Error.WriteLine('new-agent-worktree: not inside a git repo'); exit 1 }

# Fetch first, unconditionally, before any branch decision. On failure, exit
# loud and create nothing -- a confident worktree built on a possibly-stale
# view is exactly the failure #357 exists to prevent.
& git fetch --quiet origin 2>$null
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine('new-agent-worktree: git fetch origin failed (offline?) -- refusing to create a worktree from a possibly-stale base. Reconnect and re-run.')
  exit 1
}

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
  # Resume path: check out the existing branch exactly as it is. No rebase,
  # merge, or reset -- the fetch above only updated remote-tracking refs, so a
  # later `tools/check-freshness.ps1` run has a true `origin/main` to compare
  # against, but this branch's own history is untouched.
  & git worktree add $path $Branch
} else {
  # New-branch path: base it on `origin/main`, not local HEAD, so it is 0
  # commits behind at birth (AC1) even when the primary checkout's local
  # `main` is stale (AC2).
  & git worktree add -b $Branch $path origin/main
}
$addExit = $LASTEXITCODE

if ($addExit -ne 0) {
  [Console]::Error.WriteLine("new-agent-worktree: 'git worktree add' failed (exit $addExit) -- see git's message above for the reason (e.g. branch already checked out elsewhere, or path in use). No worktree was created.")
  exit 1
}

$absPath = (Resolve-Path $path).Path
Write-Output "worktree ready: $absPath (branch '$Branch'). cd into it to work."
