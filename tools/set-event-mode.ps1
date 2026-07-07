# set-event-mode.ps1 -- the SINGLE writer of governance/event-mode.json (#220).
#
# Create: powershell -File tools/set-event-mode.ps1 -ExpiresUtc <ISO date> -Reason <text>
# Clear:  powershell -File tools/set-event-mode.ps1 -Clear
#
# The flag enables the wedding-day freeze: while it is valid and unexpired, the
# hooks let a commit whose subject starts 'hotfix: ' through without review
# evidence or a reviewed issue (see .githooks/gate-core.sh). The flag file is
# never hand-edited; committing its creation/removal is a CODE commit that takes
# the normal gate, so entering and leaving event mode is itself reviewed.
#
# -Clear is the retro-review obligation's mechanical consumer: it REFUSES to
# remove the flag while any freeze:true ledger row recorded since the flag's
# creation lacks a review PASS bound to that commit's tree (written via the
# existing tools/persist-review.ps1 path). Nothing permanently escapes review.
#
# Honest residual (stated, not hidden): the same actor could delete the flag by
# hand or hand-write retro evidence. That is made tamper-EVIDENT by the
# committed flag lifecycle + the ledger, not impossible -- the owner's bar is
# tamper-evident, not tamper-proof.
#
# -FlagPath / -LedgerPath / -ReviewsRoot / -NowUtc are test/rehearsal hooks;
# production callers pass only -ExpiresUtc/-Reason or -Clear. When -LedgerPath
# is not given, -Clear refreshes the ledger from origin/ledger first (the rows
# live on the dedicated ledger branch, #228) and warns if it cannot.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [string]$ExpiresUtc = '',
  [string]$Reason = '',
  [switch]$Clear,
  [string]$FlagPath = '',
  [string]$LedgerPath = '',
  [string]$ReviewsRoot = '',
  [string]$NowUtc = ''
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'verdict-core.ps1')
. (Join-Path $scriptDir 'event-mode-core.ps1')

$top = "$(& git rev-parse --show-toplevel 2>$null)".Trim()
if (-not $top) { [Console]::Error.WriteLine('set-event-mode: not inside a git repo'); exit 1 }

if (-not $FlagPath) {
  $FlagPath = Join-Path $top (Join-Path 'governance' 'event-mode.json')
}
if (-not $ReviewsRoot) {
  $ReviewsRoot = Join-Path $top (Join-Path '.review_state' 'reviews')
}

$now = [DateTimeOffset]::UtcNow
if ($NowUtc) {
  $now = [DateTimeOffset]::Parse($NowUtc,
    [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::AssumeUniversal)
}

if ($Clear) {
  if (-not (Test-Path -LiteralPath $FlagPath)) {
    [Console]::Error.WriteLine("set-event-mode: no flag at $FlagPath to clear")
    exit 1
  }

  # 'Since the flag's creation': rows at/after the flag's created timestamp form
  # the retro worklist. An unreadable flag or created field widens the window to
  # ALL freeze rows (fail closed) rather than silently narrowing it.
  $sinceUtc = [DateTimeOffset]::MinValue
  $flag = Read-EventModeFlag -FlagPath $FlagPath
  if ($null -ne $flag) {
    $parsedCreated = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$flag.created,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AssumeUniversal,
        [ref]$parsedCreated)) {
      $sinceUtc = $parsedCreated
    }
  }

  # Ledger text: rows live on the ledger branch (#228), so the checked-out copy
  # can be stale. Default path: fetch origin/ledger and read the branch copy;
  # fall back to the local file with a loud warning. An explicit -LedgerPath
  # (tests, rehearsal) is read as-is.
  $ledgerText = ''
  if ($LedgerPath) {
    if (Test-Path -LiteralPath $LedgerPath) {
      $ledgerText = Get-Content -Raw -LiteralPath $LedgerPath
    }
  } else {
    $localLedger = Join-Path $top (Join-Path 'governance' 'ledger.ndjson')
    $fetched = $false
    & git fetch origin 'ledger:refs/remotes/origin/ledger' --force 2>$null
    if ($LASTEXITCODE -eq 0) {
      $branchCopy = & git show 'refs/remotes/origin/ledger:governance/ledger.ndjson' 2>$null
      if ($LASTEXITCODE -eq 0) {
        $ledgerText = ($branchCopy | Out-String)
        $fetched = $true
      }
    }
    if (-not $fetched) {
      [Console]::Error.WriteLine('set-event-mode: WARNING could not read origin/ledger; falling back to the checked-out governance/ledger.ndjson, which may be stale')
      if (Test-Path -LiteralPath $localLedger) {
        $ledgerText = Get-Content -Raw -LiteralPath $localLedger
      }
    }
  }

  # Collect freeze rows since flag creation; each needs a review PASS bound to
  # its commit's tree. A row whose ts cannot be parsed, or whose commit cannot
  # be resolved locally, counts as unreviewed (fail closed, named in output).
  $unreviewed = @()
  $checked = 0
  foreach ($line in ($ledgerText -split "`n")) {
    $line = $line.Trim()
    if (-not $line) { continue }
    try { $row = $line | ConvertFrom-Json } catch { continue }
    if ($row.schema -ne 'gl1') { continue }
    if (-not $row.freeze) { continue }
    $rowTs = [DateTimeOffset]::MinValue
    $tsOk = [DateTimeOffset]::TryParse([string]$row.ts,
      [System.Globalization.CultureInfo]::InvariantCulture,
      [System.Globalization.DateTimeStyles]::AssumeUniversal,
      [ref]$rowTs)
    if ($tsOk -and ($rowTs -lt $sinceUtc)) { continue }
    $checked++
    $sha = [string]$row.merged_sha
    $tree = "$(& git rev-parse --verify --quiet "$sha^{tree}" 2>$null)".Trim()
    if (-not $tree) {
      $unreviewed += "  $sha (PR #$($row.pr)): commit not found locally -- fetch it, retro-review its tree, then re-run -Clear"
      continue
    }
    $r = Test-VerdictSatisfied -Tree $tree -Required 1 -ReviewsRoot $ReviewsRoot
    if (-not $r.ok) {
      $unreviewed += "  $sha (PR #$($row.pr), tree $($tree.Substring(0, 12))): no retro-review PASS -- record one via tools/persist-review.ps1 -TreeOid $tree ..."
    }
  }

  if ($unreviewed.Count -gt 0) {
    [Console]::Error.WriteLine("set-event-mode: REFUSING to clear -- $($unreviewed.Count) freeze commit(s) since flag creation lack a retro-review PASS:")
    foreach ($u in $unreviewed) { [Console]::Error.WriteLine($u) }
    exit 1
  }

  Remove-Item -LiteralPath $FlagPath -Force
  Write-Output "event-mode flag cleared ($checked freeze commit(s) verified retro-reviewed). Commit the removal through the normal gate."
  exit 0
}

# Create mode.
if (-not $ExpiresUtc) {
  [Console]::Error.WriteLine('set-event-mode: -ExpiresUtc is required (or pass -Clear)')
  exit 1
}
if (-not $Reason) {
  [Console]::Error.WriteLine('set-event-mode: -Reason is required')
  exit 1
}
if (Test-Path -LiteralPath $FlagPath) {
  [Console]::Error.WriteLine("set-event-mode: flag already exists at $FlagPath -- clear it first (single-writer discipline)")
  exit 1
}
$expires = [DateTimeOffset]::MinValue
if (-not [DateTimeOffset]::TryParse($ExpiresUtc,
    [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::AssumeUniversal,
    [ref]$expires)) {
  [Console]::Error.WriteLine("set-event-mode: cannot parse -ExpiresUtc '$ExpiresUtc' as a date")
  exit 1
}
if ($expires -le $now) {
  [Console]::Error.WriteLine("set-event-mode: refusing to create an already-expired flag (expires $ExpiresUtc, now $($now.UtcDateTime.ToString('o')))")
  exit 1
}

$dir = Split-Path -Parent $FlagPath
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$obj = [ordered]@{
  schema  = 'em1'
  expires = Format-EventModeUtc -Time $expires
  reason  = $Reason
  created = Format-EventModeUtc -Time $now
}
[IO.File]::WriteAllText($FlagPath, ($obj | ConvertTo-Json -Compress))
Write-Output "event-mode flag created: expires $($obj.expires) -- commit it through the normal gate to arm the freeze"
exit 0
