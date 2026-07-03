# assert-worktree: fail-closed check that the current session is running inside a
# linked git worktree, not the shared primary checkout. Two file-mutating sessions
# sharing one working directory can stash, revert, or switch-branch under each
# other's uncommitted work -- the exact collision #113 documented on 2026-07-02.
# #113 shipped the fix (tools/new-agent-worktree.ps1) but nothing in the pipeline
# asserted it was actually used; this script is that assertion. Pure check, no
# side effects -- mirrors the shape of tools/check-gate.ps1.
#
# `git rev-parse --absolute-git-dir` returns a forward-slash path that ends in
# `/.git` in the primary checkout and contains `/worktrees/<name>` in a linked
# worktree (verified 2026-07-02: primary -> C:/wedding-scavenger-hunt/.git;
# linked -> C:/wedding-scavenger-hunt/.git/worktrees/<name>).
$gitDir = "$(& git rev-parse --absolute-git-dir 2>$null)".Trim()

if (-not $gitDir) {
  [Console]::Error.WriteLine('assert-worktree: not inside a git repo. Run: powershell -File tools/new-agent-worktree.ps1 -Branch <name>')
  exit 1
}

if ($gitDir -notmatch '/worktrees/') {
  [Console]::Error.WriteLine("assert-worktree: running in the primary checkout ($gitDir), not an isolated worktree. Create one and continue there: powershell -File tools/new-agent-worktree.ps1 -Branch <name>")
  exit 1
}

exit 0
