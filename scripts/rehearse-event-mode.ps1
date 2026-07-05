# rehearse-event-mode.ps1 -- scripted dry-run of the wedding-day freeze (#220).
#
# Builds a SCRATCH git repo in TEMP with the real hooks and tools installed,
# then walks the whole freeze lifecycle end to end:
#   1. arm event mode with a near-future expiry (tools/set-event-mode.ps1)
#   2. a 'hotfix: ' commit with NO review evidence goes through
#   3. a non-hotfix commit is still blocked
#   4. after expiry the 'hotfix: ' prefix grants nothing
#   5. -Clear refuses while a freeze commit lacks a retro-review record
#   6. -Clear succeeds once the retro-review PASS is on file, flag removed
#
# Run it before the wedding (and after any change to the hooks or tools):
#   powershell -File scripts/rehearse-event-mode.ps1
# Exits 0 only when every step behaved; prints [PASS]/[FAIL] per step.
# Never touches the real repo's state -- everything happens in the scratch repo.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [switch]$KeepScratch
)

# 'Continue', not 'Stop': PowerShell 5.1 turns redirected native stderr (the
# hooks' block messages, which the steps below deliberately capture) into
# terminating NativeCommandErrors under 'Stop'. Every step checks exit codes
# explicitly instead.
$ErrorActionPreference = 'Continue'

$repoTop = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
if (-not $repoTop) { [Console]::Error.WriteLine('rehearse-event-mode: run from inside the repo'); exit 1 }

$scratch = Join-Path ([IO.Path]::GetTempPath()) ("event-mode-rehearsal-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null

$script:failures = 0
function Step {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  if ($Ok) {
    Write-Output "[PASS] $Name"
  } else {
    $script:failures++
    Write-Output "[FAIL] $Name"
    if ($Detail) { Write-Output "       $Detail" }
  }
}

function InScratch {
  param([scriptblock]$Body)
  Push-Location $scratch
  try { & $Body } finally { Pop-Location }
}

try {
  # --- scratch repo scaffold: real hooks + real tools, throwaway everything else
  New-Item -ItemType Directory -Force -Path (Join-Path $scratch '.githooks') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $scratch 'tools') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $scratch 'governance') | Out-Null
  Copy-Item (Join-Path $repoTop '.githooks\*') (Join-Path $scratch '.githooks') -Force
  Copy-Item (Join-Path $repoTop 'tools\*.ps1') (Join-Path $scratch 'tools') -Force

  InScratch {
    & git init -q 2>$null | Out-Null
    & git config user.name 'rehearsal' | Out-Null
    & git config user.email 'rehearsal@example.invalid' | Out-Null
    # Baseline commit BEFORE arming the hooks, so scaffolding needs no evidence.
    & git add -A 2>$null | Out-Null
    & git commit -q -m 'baseline: rehearsal scaffold' 2>$null | Out-Null
    & git config core.hooksPath .githooks | Out-Null
  }

  $flagPath = Join-Path $scratch 'governance\event-mode.json'
  $ledgerPath = Join-Path $scratch 'rehearsal-ledger.ndjson'
  $setTool = Join-Path $scratch 'tools\set-event-mode.ps1'
  $persistTool = Join-Path $scratch 'tools\persist-review.ps1'

  # --- step 1: arm event mode with a near-future expiry
  . (Join-Path $scratch 'tools\event-mode-core.ps1')
  $expires = Format-EventModeUtc -Time ([DateTimeOffset]::UtcNow.AddMinutes(30))
  InScratch { & powershell -NoProfile -ExecutionPolicy Bypass -File $setTool -ExpiresUtc $expires -Reason 'rehearsal' | Out-Null }
  Step 'arm: set-event-mode creates the flag' (($LASTEXITCODE -eq 0) -and (Test-Path $flagPath))
  $armedFlagJson = Get-Content -Raw $flagPath

  # --- step 2: a 'hotfix: ' commit with NO review evidence goes through
  Set-Content -Path (Join-Path $scratch 'fix1.js') -Value '// mid-event hotfix' -Encoding utf8
  $hotfixOut = InScratch {
    & git add -A 2>$null | Out-Null
    & git commit -m 'hotfix: rehearsal mid-event fix' 2>&1 | Out-String
  }
  $hotfixOk = ($LASTEXITCODE -eq 0)
  Step "freeze window: 'hotfix: ' commit passes with no review evidence" $hotfixOk $hotfixOut
  $hotfixSha = InScratch { "$(& git rev-parse HEAD)".Trim() }

  # --- step 3: a non-hotfix commit is still blocked
  Set-Content -Path (Join-Path $scratch 'fix2.js') -Value '// not a hotfix' -Encoding utf8
  $blockedOut = InScratch {
    & git add fix2.js 2>$null | Out-Null
    & git commit -m 'fix: sneaking past the gate' 2>&1 | Out-String
  }
  Step 'freeze window: non-hotfix commit is still BLOCKED' ($LASTEXITCODE -ne 0) $blockedOut

  # --- step 4: an expired flag enables nothing (simulate the clock running out)
  # Written directly because the single-writer tool refuses to create an
  # already-expired flag -- the rehearsal fakes time passing, nothing else.
  $expired = $armedFlagJson -replace '"expires":"[^"]*"', '"expires":"2000-01-01T00:00:00Z"'
  [IO.File]::WriteAllText($flagPath, $expired)
  $expiredOut = InScratch { & git commit -m 'hotfix: after the window closed' 2>&1 | Out-String }
  Step "expiry: 'hotfix: ' commit is BLOCKED once the flag expires" ($LASTEXITCODE -ne 0) $expiredOut
  [IO.File]::WriteAllText($flagPath, $armedFlagJson)

  # --- step 5: -Clear refuses while the freeze commit lacks a retro-review
  $rowTs = Format-EventModeUtc -Time ([DateTimeOffset]::UtcNow)
  $row = '{"schema":"gl1","pr":999,"issue":null,"merged_sha":"' + $hotfixSha + '","ts":"' + $rowTs + '","reviews":[],"labels":[],"freeze":true}'
  [IO.File]::WriteAllText($ledgerPath, $row + "`n")
  $clearOut = InScratch { & powershell -NoProfile -ExecutionPolicy Bypass -File $setTool -Clear -LedgerPath $ledgerPath 2>&1 | Out-String }
  $refused = ($LASTEXITCODE -ne 0) -and ($clearOut -match [regex]::Escape($hotfixSha))
  Step "-Clear REFUSES while the freeze commit lacks a retro-review (names $($hotfixSha.Substring(0,12)))" $refused $clearOut

  # --- step 6: record the retro-review PASS, then -Clear succeeds
  $hotfixTree = InScratch { "$(& git rev-parse "$hotfixSha^{tree}")".Trim() }
  InScratch { & powershell -NoProfile -ExecutionPolicy Bypass -File $persistTool -TreeOid $hotfixTree -ReviewerId 'retro-reviewer-1' -Verdict PASS | Out-Null }
  $clearOut2 = InScratch { & powershell -NoProfile -ExecutionPolicy Bypass -File $setTool -Clear -LedgerPath $ledgerPath 2>&1 | Out-String }
  Step '-Clear succeeds after the retro-review PASS; flag removed' (($LASTEXITCODE -eq 0) -and (-not (Test-Path $flagPath))) $clearOut2
} finally {
  if ($KeepScratch) {
    Write-Output "scratch repo kept at $scratch"
  } else {
    try { Remove-Item -Recurse -Force $scratch -ErrorAction Stop } catch { }
  }
}

if ($script:failures -gt 0) {
  Write-Output "rehearsal: $script:failures step(s) FAILED -- do NOT rely on event mode until this passes"
  exit 1
}
Write-Output 'rehearsal: all 6 steps behaved -- event mode is ready for the wedding weekend'
exit 0
