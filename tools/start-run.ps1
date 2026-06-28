# start-run: begin an explicit timed autonomous run. Writes .run_state/run.json,
# which arms the loop-gate Stop hook to block early stops until the budget is
# spent. Clears any stale STOP sentinel. The run self-clears at the budget; abort
# early with tools/stop-run.ps1.
param(
  [int]$Minutes = 120,
  [string]$Label = 'autonomous-run',
  [int]$MaxIters = 120
)
$top = (& git rev-parse --show-toplevel 2>$null)
if (-not $top) { Write-Error 'start-run: not inside a git repo'; exit 1 }
$rs = Join-Path $top '.run_state'
New-Item -ItemType Directory -Force -Path $rs | Out-Null
$stop = Join-Path $rs 'STOP'
if (Test-Path $stop) { Remove-Item $stop -Force }

# Re-running while a run is active simply resets it (new clock, counters zeroed).
$start = [long][double]::Parse((Get-Date -UFormat %s))
$end   = $start + ($Minutes * 60)
$run = [ordered]@{
  label          = $Label
  start_epoch    = $start
  end_epoch      = $end
  budget_seconds = ($Minutes * 60)
  iters          = 0
  max_iters      = $MaxIters
  churn          = 0
  last_block     = 0
}
[IO.File]::WriteAllText((Join-Path $rs 'run.json'), ($run | ConvertTo-Json -Compress))
Write-Output "run '$Label' started: $Minutes min (ends epoch $end). loop-gate now blocks early stops until then. Abort: tools/stop-run.ps1 (or create .run_state/STOP)."
