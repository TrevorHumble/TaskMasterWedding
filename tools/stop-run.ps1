# stop-run: end the timed run -- normal completion or emergency brake. Drops the
# STOP sentinel (so the loop-gate releases the very next stop) and clears run.json.
$top = (& git rev-parse --show-toplevel 2>$null)
if (-not $top) { Write-Error 'stop-run: not inside a git repo'; exit 1 }
$rs = Join-Path $top '.run_state'
if (Test-Path $rs) {
  Set-Content -Path (Join-Path $rs 'STOP') -Value 'stop' -Encoding ascii
  $runf = Join-Path $rs 'run.json'
  if (Test-Path $runf) { Remove-Item $runf -Force }
}
Write-Output 'run stopped: loop-gate will allow the next stop.'
