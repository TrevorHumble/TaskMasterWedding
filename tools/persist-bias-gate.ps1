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
# -SelfCertify (issue #203): writes a passing bias-gate artifact attributed to
# fable-self. Dormant mechanism, retained on disk per DESIGN.md § "Fable:
# available, owner-signal only (#453)" — not active policy until the owner
# signals Fable use for a given tree. When active, a Fable-certified
# system-level tree does not additionally require an independent bias-gate
# agent run. The gate_id is fixed to 'fable-self' (not free-text) so the
# record is honestly distinguishable from an independent gate agent's run in
# the audit trail. -SelfCertify is mutually exclusive with -GateId /
# -Verdict — it always writes GateId='fable-self', Verdict='PASS'.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [Parameter(Mandatory = $true)][string]$TreeOid,
  [string]$GateId,
  [ValidateSet('PASS', 'FAIL')][string]$Verdict,
  [switch]$SelfCertify,
  [string]$BiasGateRoot = ''
)

if ($SelfCertify) {
  if ($GateId -or $Verdict) {
    [Console]::Error.WriteLine('persist-bias-gate: -SelfCertify is mutually exclusive with -GateId / -Verdict')
    exit 1
  }
  $GateId = 'fable-self'
  $Verdict = 'PASS'
} else {
  if (-not $GateId) {
    [Console]::Error.WriteLine('persist-bias-gate: -GateId is required unless -SelfCertify is passed')
    exit 1
  }
  if (-not $Verdict) {
    [Console]::Error.WriteLine('persist-bias-gate: -Verdict is required unless -SelfCertify is passed')
    exit 1
  }
}

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
