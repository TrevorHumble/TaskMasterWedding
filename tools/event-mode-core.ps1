# event-mode-core.ps1 -- shared reader for the event-mode flag (#220).
# Dot-source this file; do not run it directly.
#
# The flag file (governance/event-mode.json, written ONLY by
# tools/set-event-mode.ps1) is single-line JSON:
#   {"schema":"em1","expires":"<ISO-8601 UTC>","reason":"<text>","created":"<ISO-8601 UTC>"}
# Readers: .githooks/gate-core.sh event_mode_state (via Get-EventModeState),
# tools/set-event-mode.ps1 (-Clear), and tools/check-event-mode-expiry.ps1
# (the CI backstop, a thin wrapper over this same reader) -- the validity
# rules live HERE and nowhere else.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.

# Read-EventModeFlag -- parse the flag file. Returns the parsed object only when
# it is valid (parseable JSON, schema em1, parseable expires); $null otherwise.
# $null means "no valid flag", which every consumer must treat as
# enables-nothing.
function Read-EventModeFlag {
  param(
    [Parameter(Mandatory = $true)][string]$FlagPath
  )
  if (-not (Test-Path -LiteralPath $FlagPath)) {
    return $null
  }
  try {
    $raw = Get-Content -Raw -LiteralPath $FlagPath -ErrorAction Stop
    $obj = $raw | ConvertFrom-Json
  } catch {
    return $null
  }
  if ($null -eq $obj) { return $null }
  if ($obj.schema -ne 'em1') { return $null }
  $parsed = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$obj.expires,
      [System.Globalization.CultureInfo]::InvariantCulture,
      [System.Globalization.DateTimeStyles]::AssumeUniversal,
      [ref]$parsed)) {
    return $null
  }
  return $obj
}

# Get-EventModeState -- single word on stdout, consumed by the sh hooks:
#   NONE     no flag file
#   INVALID  file exists but is not a valid em1 flag (fail closed: enables nothing)
#   ACTIVE   valid flag, now < expires (the ONLY state that enables the bypass)
#   EXPIRED  valid flag, now >= expires (enables nothing; CI forces cleanup)
# -NowUtc is a test hook; production callers pass only -FlagPath.
function Get-EventModeState {
  param(
    [Parameter(Mandatory = $true)][string]$FlagPath,
    [string]$NowUtc = ''
  )
  if (-not (Test-Path -LiteralPath $FlagPath)) {
    return 'NONE'
  }
  $flag = Read-EventModeFlag -FlagPath $FlagPath
  if ($null -eq $flag) {
    return 'INVALID'
  }
  $now = [DateTimeOffset]::UtcNow
  if ($NowUtc) {
    $now = [DateTimeOffset]::Parse($NowUtc,
      [System.Globalization.CultureInfo]::InvariantCulture,
      [System.Globalization.DateTimeStyles]::AssumeUniversal)
  }
  $expires = [DateTimeOffset]::Parse([string]$flag.expires,
    [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::AssumeUniversal)
  if ($now -lt $expires) {
    return 'ACTIVE'
  }
  return 'EXPIRED'
}

# Format-EventModeUtc -- the one place the flag's ISO-8601 UTC timestamp
# format lives (writers: set-event-mode.ps1; rehearsal script).
function Format-EventModeUtc {
  param(
    [Parameter(Mandatory = $true)][DateTimeOffset]$Time
  )
  return $Time.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
}
