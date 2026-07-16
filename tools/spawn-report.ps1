# tools/spawn-report.ps1
# Spawn-accountability metric (#517): tabulates every `spawned-in-run` issue's
# `## Spawn justification` block so spawned technical debt is visible and
# justified instead of accumulating silently.
#
# Two read modes:
#   default        - reads the live board:
#                    gh issue list --label spawned-in-run --state all --json number,title,body,createdAt
#   -FixturePath   - reads the same-shape issue JSON from a file instead, so
#                    the parse-and-tabulate logic is testable with NO network
#                    call (tests/spawn-report.test.js).
#
# The body-parsing logic lives in its own function, Get-SpawnJustification,
# kept distinct from the read/render logic below it so its behavior is easy
# to reason about and to unit-exercise independently.
#
# An issue carrying the label but no parseable `## Spawn justification` block
# (or a block missing a field) is never dropped and never fabricated a field
# (AC5): it is printed with an explicit `MISSING justification` marker naming
# what is missing.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
[CmdletBinding()]
param(
    [string]$FixturePath = '',
    [string]$Repo = 'TrevorHumble/TaskMasterWedding'
)

$ErrorActionPreference = 'Stop'

# --- pure parse function: one issue body in, structured justification out ---
# Never throws on a malformed body -- it reports what's missing via .Missing
# so the caller can render an honest MISSING marker instead of fabricating a
# field or silently dropping the issue.
function Get-SpawnJustification {
    param(
        [AllowEmptyString()]
        [string]$Body
    )

    $result = [ordered]@{
        Found        = $false
        SpawnedBy    = $null
        Why          = $null
        WhySeparable = $null
        WhyNotSolved = $null
        Missing      = @()
    }

    if ([string]::IsNullOrEmpty($Body)) {
        $result.Missing = @('## Spawn justification block')
        return $result
    }

    # Section runs from the '## Spawn justification' heading to the next
    # '## ' heading (or end of body).
    $sectionMatch = [regex]::Match($Body, '(?ms)^##\s*Spawn justification\s*\r?\n(.*?)(?:\r?\n##\s|\z)')
    if (-not $sectionMatch.Success) {
        $result.Missing = @('## Spawn justification block')
        return $result
    }

    $result.Found = $true
    $section = $sectionMatch.Groups[1].Value

    $result.SpawnedBy = Get-SpawnField -Section $section -Label 'Spawned by'
    $result.Why = Get-SpawnField -Section $section -Label 'Why'
    $result.WhySeparable = Get-SpawnField -Section $section -Label 'Why separable'
    $result.WhyNotSolved = Get-SpawnField -Section $section -Label 'Why not solved in the spawning session'

    if ([string]::IsNullOrWhiteSpace($result.SpawnedBy)) { $result.Missing += 'Spawned by' }
    if ([string]::IsNullOrWhiteSpace($result.Why)) { $result.Missing += 'Why' }
    if ([string]::IsNullOrWhiteSpace($result.WhySeparable)) { $result.Missing += 'Why separable' }
    if ([string]::IsNullOrWhiteSpace($result.WhyNotSolved)) { $result.Missing += 'Why not solved in the spawning session' }

    return $result
}

# Extracts one `- **Label:** value` (leading dash optional) line's value from
# a Spawn justification section. Returns $null if the label isn't present.
function Get-SpawnField {
    param(
        [string]$Section,
        [string]$Label
    )

    # [ \t]* (not \s*) immediately around the value capture: \s* would match
    # newlines, so a blank value on the label's own line would let the
    # capture bleed into the FOLLOWING line and fabricate that line's text as
    # this field's value. Restricting to horizontal whitespace means a blank
    # value matches nothing on its own line, the label is reported absent,
    # and the field lands in .Missing instead of being fabricated (AC5).
    $pattern = '(?im)^\s*-?\s*\*\*' + [regex]::Escape($Label) + ':\*\*[ \t]*(.+?)[ \t]*$'
    $m = [regex]::Match($Section, $pattern)
    if ($m.Success) {
        return $m.Groups[1].Value.Trim()
    }
    return $null
}

# Renders createdAt identically on Windows PowerShell 5.1 and pwsh 7+.
# ConvertFrom-Json on PS 5.1 leaves an ISO-8601 date string as a string; on
# pwsh 7+ it auto-coerces the same string into a [datetime]. Left to a plain
# `-f` interpolation, the [datetime] case renders culture- and
# timezone-dependently (e.g. US M/d/yyyy on a Linux CI runner) instead of the
# canonical UTC ISO-8601 the string case already carries. This normalizes
# both cases to the same 'yyyy-MM-ddTHH:mm:ssZ' UTC string regardless of
# edition or runner culture/timezone.
function Format-CreatedAt {
    param($Value)
    if ($Value -is [datetime]) {
        $dt = $Value
        if ($dt.Kind -eq [System.DateTimeKind]::Local) { $dt = $dt.ToUniversalTime() }
        return $dt.ToString('yyyy-MM-ddTHH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture) + 'Z'
    }
    return [string]$Value
}

# --- read: fixture file (offline, testable) or the live board ---
if ($FixturePath) {
    if (-not (Test-Path -LiteralPath $FixturePath)) {
        Write-Error "spawn-report: fixture file not found: $FixturePath"
        exit 1
    }
    $raw = Get-Content -LiteralPath $FixturePath -Raw
}
else {
    $raw = & 'C:\Program Files\GitHub CLI\gh.exe' issue list `
        --label spawned-in-run `
        --state all `
        --json number,title,body,createdAt `
        -R $Repo
    if ($LASTEXITCODE -ne 0) {
        Write-Error "spawn-report: gh issue list failed with exit code $LASTEXITCODE"
        exit 1
    }
}

$parsed = $raw | ConvertFrom-Json

# Normalize: a single-issue result comes back as a scalar PSCustomObject, not
# an array -- wrap so a 1-issue board/fixture isn't silently dropped.
$issues = @()
if ($null -ne $parsed) {
    $issues = @($parsed) | Where-Object { $null -ne $_ -and $null -ne $_.number }
    $issues = @($issues)
}

# --- render ---
# The per-"Why separable" breakdown below tallies the VERBATIM field value as
# written in each issue's justification block (trimmed, grouped
# case-insensitively) -- it makes no claim about which of the canonical defer
# categories in `standards/adversarial-review-protocol.md` § "Finding
# disposition" a value "is". There is deliberately no hard-coded set of
# allowed category names here: judging whether a value names a real category
# is `agents/reviewer-issue.md`'s job, not this tool's.
$totalSpawned = 0
$whySeparableCounts = [ordered]@{}
$whySeparableDisplay = [ordered]@{}

foreach ($issue in $issues) {
    $totalSpawned++
    $sj = Get-SpawnJustification -Body $issue.body

    if ($sj.Missing.Count -gt 0) {
        $missingList = $sj.Missing -join ', '
        Write-Output ("#{0} | created {1} | MISSING justification (missing: {2})" -f `
                $issue.number, (Format-CreatedAt $issue.createdAt), $missingList)
        continue
    }

    $verbatim = $sj.WhySeparable.Trim()
    $key = $verbatim.ToLowerInvariant()
    if (-not $whySeparableCounts.Contains($key)) {
        $whySeparableCounts[$key] = 0
        $whySeparableDisplay[$key] = $verbatim
    }
    $whySeparableCounts[$key] = $whySeparableCounts[$key] + 1

    Write-Output ("#{0} | spawned-by: {1} | why: {2} | why-separable: {3} | why-not-solved: {4} | created: {5}" -f `
            $issue.number, $sj.SpawnedBy, $sj.Why, $sj.WhySeparable, $sj.WhyNotSolved, (Format-CreatedAt $issue.createdAt))
}

Write-Output ''
Write-Output "total spawned: $totalSpawned"
Write-Output "by 'Why separable' value:"
if ($whySeparableCounts.Count -eq 0) {
    Write-Output '  (none)'
}
else {
    foreach ($key in $whySeparableCounts.Keys) {
        Write-Output ("  {0}: {1}" -f $whySeparableDisplay[$key], $whySeparableCounts[$key])
    }
}

exit 0
