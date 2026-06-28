# review_verdict: records the verdict the pre-commit gate reads. Run ONLY after
# the adversarial reviewers have actually returned their result -- this records
# their verdict, it does not decide it. It binds the verdict to the EXACT staged
# tree (git write-tree, the same key .githooks/pre-commit recomputes), so any
# later change to what is staged invalidates it and the gate blocks again.
# Usage:
#   powershell -File tools/review_verdict.ps1 -Verdict PASS -Reviewers "reviewer-pr,reviewer-design-philosophy"
#   powershell -File tools/review_verdict.ps1 -Verdict FAIL
param(
  [Parameter(Mandatory=$true)][ValidateSet('PASS','FAIL')][string]$Verdict,
  [string]$Reviewers = ''
)
$top = (& git rev-parse --show-toplevel 2>$null)
if (-not $top) { Write-Error 'review_verdict: not inside a git repo'; exit 1 }

# Commit identity = the staged tree oid. Pure git plumbing -> identical on every
# shell, no hash drift. Captures staged content exactly (incl. newly added files).
# Records the FULL staged index tree. A partial/pathspec commit (`git commit -- f`,
# `commit -p`) commits a different tree and will NOT match -> the gate blocks it.
# The orchestrator's flow is stage-everything-then-commit, so this is intended.
$tree = "$(& git write-tree 2>$null)".Trim()
if (-not $tree) { Write-Error 'review_verdict: git write-tree failed (nothing staged?)'; exit 1 }

$dir = Join-Path $top '.review_state'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$obj = [ordered]@{
  verdict   = $Verdict
  tree_oid  = $tree
  reviewers = @($Reviewers -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  ts        = (Get-Date -Format o)
}
[IO.File]::WriteAllText((Join-Path $dir 'verdict.json'), ($obj | ConvertTo-Json -Compress))

# Append to a gitignored history log so the discretionary pipeline can be audited
# later (reviewer counts over time) -- groundwork for the self-audit (issue #15).
# Isolated and fail-safe: it runs AFTER the verdict.json the gate reads (unchanged
# above) and swallows any error, so it can never affect commit-gate behavior.
try { Add-Content -Path (Join-Path $dir 'verdict-history.jsonl') -Value ($obj | ConvertTo-Json -Compress) -Encoding utf8 } catch { }

Write-Output "verdict $Verdict recorded for tree $($tree.Substring(0,12)) ($($obj.reviewers.Count) reviewer(s))"
