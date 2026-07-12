# tools/capture-reviewer-verdict.ps1 -- mechanical bridge (#455): extracts a
# PR-path reviewer's own emitted verdict JSON block from its raw agent-return
# text and drops it, VERBATIM, into a run directory for tools/review-runner.ps1
# (#128) to consume.
#
# Per #474, reviewer-pr.md / reviewer-design-philosophy.md now instruct the
# reviewer to emit a complete tools/review-verdict.schema.md object in a
# trailing fenced json code block after its prose review. This script is the
# mechanical capture step: it does not re-derive or re-interpret any field --
# it locates the LAST such fenced block in the raw return (a return may
# legitimately contain an earlier fenced json block quoting the schema
# example, so "last" is "trailing," per #455's spec), parses it only far
# enough to confirm it is well-formed JSON carrying a non-empty reviewerId,
# and writes the block's own text unchanged to <RunDir>/<reviewerId>.json.
# tools/review-runner.ps1 remains the sole validator of verdict/defects/
# citations; this script's only judgment is "does a well-formed trailing
# block exist" -- fail closed if not.
#
# Fails closed (exits non-zero, writes nothing) when:
#   - -RawReturnFile does not exist or is unreadable
#   - no fenced json block is found anywhere in the raw text
#   - the last such block does not parse as JSON
#   - the parsed object's reviewerId is missing or blank
#
# Windows PowerShell 5.1-compatible (no ternary/??/&&/||) AND Core-safe: uses
# only ConvertFrom-Json (correct for both editions here -- a verdict block has
# no empty-string key, so PS 5.1's empty-key ConvertFrom-Json throw,
# documented in tools/classify-trivial-commit.ps1, does not apply here) and
# System.IO.File / System.Text.RegularExpressions, both present on Desktop and
# Core.
param(
  [Parameter(Mandatory = $true)][string]$RawReturnFile,
  [Parameter(Mandatory = $true)][string]$RunDir
)

function Fail {
  param([string]$Reason)
  [Console]::Error.WriteLine("capture-reviewer-verdict: $Reason")
  exit 1
}

if (-not (Test-Path -Path $RawReturnFile -PathType Leaf)) {
  Fail "raw return file not found: $RawReturnFile"
}

$raw = $null
try {
  $raw = [System.IO.File]::ReadAllText($RawReturnFile)
} catch {
  Fail "could not read raw return file: $RawReturnFile"
}

if ([string]::IsNullOrEmpty($raw)) {
  Fail "raw return file is empty: $RawReturnFile"
}

# Match every fenced ```json ... ``` block. [\s\S]*? (non-greedy, dot-matches-
# newline via the character class rather than RegexOptions.Singleline) so an
# early block can never swallow a later one. Plain .NET regex -- identical
# behavior on both PowerShell editions. The newline after the "json" tag is
# optional so a same-line opener still matches.
$pattern = '```json[ \t]*\r?\n?([\s\S]*?)```'
$fenceMatches = [regex]::Matches($raw, $pattern)

if ($fenceMatches.Count -eq 0) {
  Fail "no fenced json block found in $RawReturnFile"
}

# Trailing verdict = the LAST match, per spec (an earlier fence may just be
# quoting the schema example in prose).
$blockText = $fenceMatches[$fenceMatches.Count - 1].Groups[1].Value.Trim()

if ([string]::IsNullOrWhiteSpace($blockText)) {
  Fail "trailing fenced json block is empty"
}

$obj = $null
try {
  $obj = $blockText | ConvertFrom-Json -ErrorAction Stop
} catch {
  Fail "trailing fenced json block does not parse as JSON"
}

$reviewerId = $obj.reviewerId
if ([string]::IsNullOrWhiteSpace([string]$reviewerId)) {
  Fail "parsed block is missing a non-empty reviewerId"
}

# reviewerId becomes a filename component below (<RunDir>/<reviewerId>.json).
# A reviewer return is untrusted input the same way a cited file path is
# (see the sibling-escape guard in tools/review-runner.ps1) -- a reviewerId
# of e.g. "../evil" would otherwise let Join-Path write outside -RunDir.
# Restrict to a safe slug charset rather than trying to escape/normalize a
# traversal sequence; fail closed on anything else.
if ("$reviewerId" -notmatch '^[A-Za-z0-9_.-]+$') {
  Fail "reviewerId contains characters unsafe for a filename: '$reviewerId'"
}

if (-not (Test-Path -Path $RunDir)) {
  New-Item -ItemType Directory -Path $RunDir -Force | Out-Null
}

# Write the captured block's text UNCHANGED -- provenance is the reviewer's
# own emitted bytes, not a PowerShell re-serialization of them. UTF8 with no
# BOM so the runner's plain Get-Content/ConvertFrom-Json reads it cleanly on
# either edition.
$outPath = Join-Path $RunDir "$reviewerId.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($outPath, $blockText, $utf8NoBom)

Write-Output "capture-reviewer-verdict: wrote $outPath"
exit 0
