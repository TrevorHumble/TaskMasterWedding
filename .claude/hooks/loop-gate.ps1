# loop-gate: a Stop hook. During an explicit timed autonomous run it BLOCKS the
# model from ending its turn until the clock budget is spent -- mechanically
# enforcing the never-stop loop (you cannot quit early). This is the tooling-
# enforced loop continuation DESIGN.md said to build "fresh against the clock-
# driven never-stop model" if ever wanted. The release condition is TIME, not a
# verdict file -- the deleted review-gate.ps1's fatal flaw (it gated on a file
# nothing wrote, so it only ever hit its fail-open MAX_ITERS backstop).
#
# SAFETY (it must never trap a session, and must never burn tokens in a tight loop):
#   - Only active while .run_state/run.json exists (an explicit run). No run file
#     -> a normal session stops normally.
#   - Releases automatically once now >= end_epoch (the budget IS the hard ceiling);
#     only this true-budget-spent path clears run.json (disarms the run).
#   - An emergency .run_state/STOP sentinel releases immediately.
#   - Tight-loop guard: when the model is already continuing from this hook
#     (stop_hook_active) and stops AGAIN within MIN_TURN seconds (no real work),
#     that is counted as churn; after CHURN_MAX such empty turns the gate RELEASES
#     (lets the session end) -- bounding token burn. Real work between stops
#     (>= MIN_TURN) resets the churn count and the gate keeps forcing.
#   - A high absolute turn cap is an ultimate runaway breaker that RELEASES (never
#     traps) if tripped. Neither breaker deletes run.json -- time still governs.
#   - ANY error / unreadable state FAILS OPEN (allows the stop). A dead gate that
#     blocks nothing beats a live gate that wedges a run.
# Project-scoped: fires only for sessions rooted in this repo (where the
# orchestrator actually runs). NOTE: the counters assume a single session per run;
# the time bound is concurrency-safe, the turn/churn counts are not.
$ErrorActionPreference = 'SilentlyContinue'
$MIN_TURN  = 25   # seconds; a stop sooner than this after a block = no real work
$CHURN_MAX = 6    # consecutive empty turns tolerated before releasing
try {
  $raw = [Console]::In.ReadToEnd()
  try { $j = $raw | ConvertFrom-Json } catch { exit 0 }   # bad stdin -> fail open

  $top = (& git rev-parse --show-toplevel 2>$null)
  if (-not $top) { exit 0 }
  $rs   = Join-Path $top '.run_state'
  $runf = Join-Path $rs 'run.json'
  if (-not (Test-Path $runf)) { exit 0 }                  # no active run -> allow
  if (Test-Path (Join-Path $rs 'STOP')) { exit 0 }        # emergency brake -> allow

  $run = Get-Content $runf -Raw | ConvertFrom-Json
  $now = [long][double]::Parse((Get-Date -UFormat %s))
  $end = [long]$run.end_epoch
  if ($now -ge $end) { Remove-Item $runf -Force; exit 0 }  # budget spent -> allow + disarm

  # Tight-loop / runaway protection (release without disarming; time still governs).
  $last  = [long]$run.last_block
  $churn = [int]$run.churn
  if ($j.stop_hook_active) {
    if ($last -gt 0 -and ($now - $last) -lt $MIN_TURN) {
      $churn++
      if ($churn -ge $CHURN_MAX) { exit 0 }               # empty churn -> release
    } else {
      $churn = 0                                           # real work happened -> keep forcing
    }
  } else {
    $churn = 0
  }
  $iters = [int]$run.iters + 1
  $max   = [int]$run.max_iters
  if ($max -gt 0 -and $iters -gt $max) { exit 0 }          # ultimate breaker -> release (no disarm)

  # Persist counters, then block the stop.
  $run.iters      = $iters
  $run.churn      = $churn
  $run.last_block = $now
  [IO.File]::WriteAllText($runf, ($run | ConvertTo-Json -Compress))
  $left = [long][math]::Round(($end - $now) / 60)
  $reason = "loop-gate (forced never-stop): ~$left min remain in the autonomous run budget (turn $iters of $max). Do NOT stop. Continue the loop -- pick the next highest-value action from the goals, or run the Done-Early Cascade (holistic review -> revisit blockers -> deep research -> raise the bar -> file issues). Genuine emergency stop only: create .run_state/STOP or run tools/stop-run.ps1."
  Write-Output (@{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress)
  exit 0
} catch {
  exit 0   # fail OPEN: never trap on an error
}
