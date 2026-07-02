# persist-bias-gate.ps1 — write ONE bias-gate evidence file for a real bias-gate
# agent's return (see standards/adversarial-review-protocol.md "## Bias gate").
#
# This is the SINGLE writer of bias-gate evidence. It is a DISTINCT file from
# persist-review.ps1 / persist-issue-review.ps1 so the self-attest surface is not
# widened: the script that records a PASS cannot also fabricate the evidence the
# gate reads.
#
# Honest residual (stated, not hidden): this script is still run by the orchestrator,
# so a determined hand can call it directly with invented values. That is made
# tamper-EVIDENT by the committed ledger + CI audit (a later slice), not impossible --
# the owner's bar is tamper-evident, not tamper-proof.
#
# The structural duplication across the persist-*.ps1 writers (this file,
# persist-adjudication.ps1, persist-review.ps1, etc.) is intentional: each evidence
# kind gets its own single-writer to keep the self-attestation surface isolated — a
# shared writer would let one script fabricate another's evidence.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [Parameter(Mandatory = $true)][string]$TreeOid,
  [Parameter(Mandatory = $true)][string]$GateId,
  [Parameter(Mandatory = $true)][ValidateSet('PASS', 'FAIL')][string]$Verdict,
  [string]$BiasGateRoot = ''
)

$top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
if (-not $top) { [Console]::Error.WriteLine('persist-bias-gate: not inside a git repo'); exit 1 }

if (-not $BiasGateRoot) {
  $BiasGateRoot = Join-Path $top (Join-Path '.review_state' 'bias-gate')
}

$dir = Join-Path $BiasGateRoot $TreeOid
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Schema 'bg1' — the reader is the shared tools/verdict-core.ps1 Read-Evidence
# (same function used for review evidence), which keys only on the inner
# tree_oid equaling the directory/tree it is validating; the 'schema' field
# here is a human-readable label and is not itself enforced by the reader.
$ev = [ordered]@{
  schema   = 'bg1'
  gate_id  = $GateId
  verdict  = $Verdict
  tree_oid = $TreeOid
  ts       = (Get-Date -Format o)
}

$evPath = Join-Path $dir "$GateId.json"
[IO.File]::WriteAllText($evPath, ($ev | ConvertTo-Json -Compress))
Write-Output "evidence written: bias-gate $Verdict by $GateId for tree $($TreeOid.Substring(0, 12))"
