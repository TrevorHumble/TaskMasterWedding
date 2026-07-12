# persist-review.ps1 — write ONE review-evidence file for a real reviewer's return.
#
# This is the SINGLE writer of review evidence. tools/review_verdict.ps1 must never
# write evidence files: if the same script that records a PASS also fabricates the
# evidence the gate reads, the self-attestation bypass survives (a free-text
# -Reviewers "a,b" would manufacture its own proof). The honest path is: the runner
# (a committed runner skill, built in a later slice — see issue #128) spawns each
# reviewer as a real Task subagent, then pipes that subagent's actual returned verdict
# + its real agent id into THIS script, once per reviewer. tools/validate-verdict.ps1
# then reads what real reviews produced.
#
# Honest residual (stated, not hidden): this script is still run by the orchestrator,
# so a determined hand can call it directly with invented values. That is made
# tamper-EVIDENT by the committed ledger + CI audit (S4), not impossible — the
# owner's bar is tamper-evident, not tamper-proof.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [Parameter(Mandatory = $true)][string]$TreeOid,
  [Parameter(Mandatory = $true)][string]$ReviewerId,
  [string]$Model = 'opus',
  [Parameter(Mandatory = $true)][ValidateSet('PASS', 'FAIL')][string]$Verdict,
  [ValidateSet('issue', 'pr')][string]$Role = 'pr',
  [int]$FindingsCount = 0,
  [int]$Blocker = 0,
  [int]$Major = 0,
  [int]$Minor = 0,
  [int]$Nit = 0,
  [int]$Round = 1,
  [string]$ReviewsRoot = ''
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'verdict-core.ps1')

$top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
if (-not $top) { [Console]::Error.WriteLine('persist-review: not inside a git repo'); exit 1 }

if (-not $ReviewsRoot) {
  $ReviewsRoot = Join-Path $top (Join-Path '.review_state' 'reviews')
}

$dir = Join-Path $ReviewsRoot $TreeOid
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# findings_count (#417): when -FindingsCount is explicitly supplied (the
# runner always supplies it), use that value as-is -- this keeps an
# unknown-severity defect counted toward the total even though it lands in
# no severity bucket (AC2). When omitted (the direct-call case, e.g. AC3),
# derive it from the four severity buckets so a caller that only passes
# -Blocker/-Major/-Minor/-Nit still gets a correct total.
$findingsCount = $FindingsCount
if (-not $PSBoundParameters.ContainsKey('FindingsCount')) {
  $findingsCount = $Blocker + $Major + $Minor + $Nit
}

# Schema $SCHEMA_REV1 (declared in tools/verdict-core.ps1) — must match
# tools/verdict-core.ps1 Read-Evidence (which keeps only files whose inner
# tree_oid equals the directory/tree it is validating).
$ev = [ordered]@{
  schema         = $SCHEMA_REV1
  reviewer_id    = $ReviewerId
  model          = $Model
  role           = $Role
  verdict        = $Verdict
  findings_count = $findingsCount
  defects        = [ordered]@{ blocker = $Blocker; major = $Major; minor = $Minor; nit = $Nit }
  round          = $Round
  tree_oid       = $TreeOid
  ts             = (Get-Date -Format o)
}

$evPath = Join-Path $dir "$ReviewerId.json"
[IO.File]::WriteAllText($evPath, ($ev | ConvertTo-Json -Compress))
Write-Output "evidence written: $Role $Verdict by $ReviewerId for tree $($TreeOid.Substring(0, 12))"
