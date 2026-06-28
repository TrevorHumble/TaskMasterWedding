# check-enforcement: confirm you're protected. Run this anytime to verify all
# three gates. It checks the COMMIT gate is active in this clone right now, and
# that the GOAL and LOOP gates are wired (those load when you open the folder in
# Claude Code). Plain-language output; exit 0 = all good.
$top = (& git rev-parse --show-toplevel 2>$null)
if (-not $top) { Write-Host "Not inside a git repo." -ForegroundColor Red; exit 1 }
Set-Location $top
$ok = $true

# 1. Commit gate — active right now (needs core.hooksPath set by setup.ps1).
$hp = "$(& git config --get core.hooksPath)".Trim()
if (($hp -eq '.githooks') -and (Test-Path '.githooks/pre-commit')) {
  Write-Host "[ON]  Commit gate - no commit lands without a passing review." -ForegroundColor Green
} else {
  Write-Host "[OFF] Commit gate - not active. Reopen in Claude Code, or run setup.ps1." -ForegroundColor Red; $ok = $false
}

# 2 & 3. Goal + loop gates — wired in settings; load when Claude Code opens the folder.
$settings = ''
if (Test-Path '.claude/settings.json') { $settings = Get-Content '.claude/settings.json' -Raw }
if ((Test-Path '.claude/hooks/goal-gate.ps1') -and ($settings -match 'goal-gate')) {
  Write-Host "[ON]  Goal gate   - wired (loads when you open this folder in Claude Code)." -ForegroundColor Green
} else {
  Write-Host "[OFF] Goal gate   - missing or not wired in .claude/settings.json." -ForegroundColor Red; $ok = $false
}
if ((Test-Path '.claude/hooks/loop-gate.ps1') -and ($settings -match 'loop-gate')) {
  Write-Host "[ON]  Loop gate   - wired (loads when you open this folder in Claude Code)." -ForegroundColor Green
} else {
  Write-Host "[OFF] Loop gate   - missing or not wired in .claude/settings.json." -ForegroundColor Red; $ok = $false
}

Write-Host ""
if ($ok) {
  Write-Host "You're protected. The goal & loop gates go live once you open this folder in Claude Code and accept its trust prompt." -ForegroundColor Green
  exit 0
} else {
  Write-Host "Something above is OFF - reopen this folder in Claude Code (arms the commit gate), or run:  powershell -ExecutionPolicy Bypass -File setup.ps1" -ForegroundColor Yellow
  exit 1
}
