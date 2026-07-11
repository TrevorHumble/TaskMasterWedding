# persist-issue-review.ps1 — write ONE issue-review evidence file for a real
# reviewer's return.
#
# This is the SINGLE writer of issue-review evidence. It is a DISTINCT file from
# persist-review.ps1 (which writes PR/tree evidence) so the self-attest surface is
# not widened: the script that records a PASS cannot also fabricate the evidence the
# issue gate reads.
#
# Honest residual (stated, not hidden): this script is still run by the orchestrator,
# so a determined hand can call it directly with invented values. That is made
# tamper-EVIDENT, not impossible -- the owner's bar is tamper-evident, not
# tamper-proof. The durable committed record is the CI-written role:"issue" entry in
# the gl1 row of governance/ledger.ndjson (#219, #359): this script emits the
# {role,model,verdict,round} object the orchestrator carries into the pre-merge
# governance-ledger PR comment, but this script itself NEVER writes
# governance/ledger.ndjson -- CI is the only writer of that file (DESIGN.md
# "Governance ledger (#219)").
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [Parameter(Mandatory = $true)][int]$IssueNumber,
  [Parameter(Mandatory = $true)][string]$ReviewerId,
  [string]$Model = 'opus',
  [Parameter(Mandatory = $true)][ValidateSet('PASS', 'FAIL')][string]$Verdict,
  [int]$FindingsCount = 0,
  [int]$Round = 1,
  [string]$IssueReviewsRoot = ''
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'verdict-core.ps1')

$top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
if (-not $top) { [Console]::Error.WriteLine('persist-issue-review: not inside a git repo'); exit 1 }

if (-not $IssueReviewsRoot) {
  $IssueReviewsRoot = Join-Path $top (Join-Path '.review_state' 'issue-reviews')
}

$dir = Join-Path $IssueReviewsRoot ([string]$IssueNumber)
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Schema $SCHEMA_IREV1 (declared in tools/verdict-core.ps1) -- must match
# tools/issue-core.ps1 Read-IssueEvidence (which keeps only files whose inner
# issue_number equals the directory/issue it is validating).
$ev = [ordered]@{
  schema         = $SCHEMA_IREV1
  issue_number   = $IssueNumber
  reviewer_id    = $ReviewerId
  model          = $Model
  role           = 'issue'
  verdict        = $Verdict
  findings_count = $FindingsCount
  ts             = (Get-Date -Format o)
}

$evPath = Join-Path $dir "$ReviewerId.json"
[IO.File]::WriteAllText($evPath, ($ev | ConvertTo-Json -Compress))
Write-Output "evidence written: issue $Verdict by $ReviewerId for issue $IssueNumber"

# Ledger bridge (#359, #412): the ephemeral evidence file above never survives worktree
# cleanup, so it cannot be the durable record. Emit the same verdict as the
# {role,model,verdict,round} object the orchestrator carries verbatim into the
# pre-merge governance-ledger PR comment (agents/orchestrator.md) -- CI's
# scripts/ledger-harvest.js then copies that comment's reviews array, unchanged,
# into the committed gl1 row. [ordered] + -Compress fixes the key order to exactly
# role,model,verdict,round so the emitted line matches byte-for-byte across runs.
# The durable record stays the CI-written role:"issue" entry in the gl1 row of
# governance/ledger.ndjson -- this sibling file is a scratch relay to the
# orchestrator, not evidence in its own right. Its extension is .ledger-entry.txt
# (not .json) so tools/issue-core.ps1 Read-IssueEvidence's *.json glob can never
# match it -- the file is unscannable by the commit-msg issue gate by construction,
# not merely by the no-issue_number check below. No issue_number field either, as
# defence-in-depth: even if a future glob change widened the extension filter, this
# sibling still could not inflate the issue gate's evidence count.
$ledgerEntry = [ordered]@{
  role    = 'issue'
  model   = $Model
  verdict = $Verdict
  round   = $Round
}
$ledgerEntryJson = $ledgerEntry | ConvertTo-Json -Compress
$ledgerEntryPath = Join-Path $dir "$ReviewerId.ledger-entry.txt"
[IO.File]::WriteAllText($ledgerEntryPath, $ledgerEntryJson)
Write-Output "ledger-review-entry: $ledgerEntryJson"
