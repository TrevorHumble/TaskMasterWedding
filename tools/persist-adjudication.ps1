# persist-adjudication.ps1 — write ONE severity-adjudication evidence file for a
# real severity-adjudicator agent's return (see standards/adversarial-review-protocol.md
# "## Stop condition — soft cap and severity gate").
#
# This is the SINGLE writer of adjudication evidence. It is a DISTINCT file from
# persist-review.ps1 / persist-issue-review.ps1 / persist-bias-gate.ps1 so the
# self-attest surface is not widened: the script that records an exit cannot also
# fabricate the evidence a future consumer would read.
#
# Durable record only (see issue #47): no gate consumes this artifact yet. It exists
# so an auditor reading .review_state/ later can see the severity-adjudicator step
# actually produced an artifact. Enforcement, if ever added, is a separate issue.
#
# Honest residual (stated, not hidden): this script is still run by the orchestrator,
# so a determined hand can call it directly with invented values. That is made
# tamper-EVIDENT by the committed ledger + CI audit (a later slice), not impossible --
# the owner's bar is tamper-evident, not tamper-proof.
#
# The structural duplication across the persist-*.ps1 writers (this file,
# persist-bias-gate.ps1, persist-review.ps1, etc.) is intentional: each evidence
# kind gets its own single-writer to keep the self-attestation surface isolated — a
# shared writer would let one script fabricate another's evidence.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [Parameter(Mandatory = $true)][string]$TreeOid,
  [Parameter(Mandatory = $true)][string]$AdjudicatorId,
  [Parameter(Mandatory = $true)][ValidateSet('authorized', 'continue')][string]$Exit,
  [string]$AdjudicationRoot = ''
)

$top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
if (-not $top) { [Console]::Error.WriteLine('persist-adjudication: not inside a git repo'); exit 1 }

if (-not $AdjudicationRoot) {
  $AdjudicationRoot = Join-Path $top (Join-Path '.review_state' 'adjudication')
}

$dir = Join-Path $AdjudicationRoot $TreeOid
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Schema 'adj1'.
$ev = [ordered]@{
  schema         = 'adj1'
  adjudicator_id = $AdjudicatorId
  exit           = $Exit
  tree_oid       = $TreeOid
  ts             = (Get-Date -Format o)
}

$evPath = Join-Path $dir "$AdjudicatorId.json"
[IO.File]::WriteAllText($evPath, ($ev | ConvertTo-Json -Compress))
Write-Output "evidence written: adjudication $Exit by $AdjudicatorId for tree $($TreeOid.Substring(0, 12))"
