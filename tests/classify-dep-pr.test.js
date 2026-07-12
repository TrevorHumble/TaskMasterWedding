// tests/classify-dep-pr.test.js
// Vitest tests for classify-dep-pr.ps1: ACs 3-7, extra edge cases, and drift guards
// (script ↔ CLAUDE.md and script ↔ .github/dependabot.yml).
// Windows PowerShell 5.1 is the launcher on win32; pwsh on other platforms.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';

// One-time guard: if the launcher doesn't exist, skip all tests.
let launcherMissing = false;
try {
  execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0']);
} catch (e) {
  if (e.code === 'ENOENT') {
    launcherMissing = true;
  }
}

const SCRIPT = path.join(__dirname, '..', 'tools', 'classify-dep-pr.ps1');

function run(ecosystem, depName, semverBump, depType) {
  return spawnSync(
    PS,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Ecosystem',
      ecosystem,
      '-DepName',
      depName,
      '-SemverBump',
      semverBump,
      '-DepType',
      depType,
    ],
    { encoding: 'utf8' }
  );
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping classify-dep-pr tests`)
  : describe;

maybeDescribe('classify-dep-pr', () => {
  // AC3: github-actions bumps are always auto, regardless of semver or dep type.
  it('AC3: github-actions / actions/checkout / major / prod -> auto, exit 0', () => {
    const r = run('github-actions', 'actions/checkout', 'major', 'prod');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('auto');
  });

  // AC4: wedding-critical prod dep is held even on major.
  it('AC4: npm / multer / major / prod -> review, exit 0', () => {
    const r = run('npm', 'multer', 'major', 'prod');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('review');
  });

  // AC5: dev bumps are always auto (CI catches a broken build tool).
  it('AC5: npm / eslint / major / dev -> auto, exit 0', () => {
    const r = run('npm', 'eslint', 'major', 'dev');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('auto');
  });

  // AC6: wedding-critical prod dep is held even on minor.
  it('AC6: npm / better-sqlite3 / minor / prod -> review, exit 0', () => {
    const r = run('npm', 'better-sqlite3', 'minor', 'prod');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('review');
  });

  // AC7: non-critical prod patch is safe to auto-merge.
  it('AC7: npm / lodash / patch / prod -> auto, exit 0', () => {
    const r = run('npm', 'lodash', 'patch', 'prod');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('auto');
  });

  // Extra edge: wedding-critical dep is held even on patch.
  it('edge: npm / sharp / patch / prod -> review', () => {
    const r = run('npm', 'sharp', 'patch', 'prod');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('review');
  });

  // Extra edge: dev minor is auto regardless of package name.
  it('edge: npm / globals / minor / dev -> auto', () => {
    const r = run('npm', 'globals', 'minor', 'dev');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('auto');
  });

  // Mutation-coverage: non-critical prod MAJOR is held (isolates the major branch
  // independently — multer short-circuits at the critical check and never reaches it).
  it('edge: npm / express / major / prod -> review', () => {
    const r = run('npm', 'express', 'major', 'prod');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('review');
  });

  // Mutation-coverage: dev precedence beats the wedding-critical check — a mutant
  // that reordered critical-before-dev would pass the other tests but fail here.
  it('edge: npm / ejs / major / dev -> auto', () => {
    const r = run('npm', 'ejs', 'major', 'dev');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('auto');
  });
});

// Drift-guard: tools/classify-dep-pr.ps1 is the single source of truth for the
// wedding-critical list. CLAUDE.md and .github/dependabot.yml must mirror it exactly.
describe('wedding-critical drift guard', () => {
  // #448: the $WeddingCritical array literal moved into the dot-sourceable
  // core (tools/classify-dep-pr-core.ps1) so tools/classify-trivial-commit.ps1
  // can share it without a second copy. classify-dep-pr.ps1's CLI contract
  // (path, params, stdout, exit code) is unchanged.
  const scriptPath = path.join(__dirname, '..', 'tools', 'classify-dep-pr-core.ps1');
  const claudePath = path.join(__dirname, '..', 'CLAUDE.md');
  const dependabotPath = path.join(__dirname, '..', '.github', 'dependabot.yml');

  // Parse the $WeddingCritical array literal from the script.
  function parseScriptNames() {
    const src = fs.readFileSync(scriptPath, 'utf8');
    // Match the array literal: $WeddingCritical = @( ... )
    const arrayMatch = src.match(/\$WeddingCritical\s*=\s*@\(([^)]+)\)/);
    if (!arrayMatch)
      throw new Error('Could not locate $WeddingCritical array in classify-dep-pr-core.ps1');
    const arrayLiteral = arrayMatch[1];
    // Extract each single-quoted token.
    const names = [];
    const tokenRe = /'([^']+)'/g;
    let m;
    while ((m = tokenRe.exec(arrayLiteral)) !== null) {
      names.push(m[1]);
    }
    return names;
  }

  it('script $WeddingCritical array is parseable and has six entries', () => {
    const names = parseScriptNames();
    expect(names).toHaveLength(6);
  });

  // Parse the backtick-wrapped wedding-critical list from the CLAUDE.md line
  // that enumerates the deps (the line containing both `multer` and `archiver`).
  function parseClaudeNames() {
    const doc = fs.readFileSync(claudePath, 'utf8');
    const line = doc.split('\n').find((l) => l.includes('`multer`') && l.includes('`archiver`'));
    if (!line) throw new Error('Could not locate wedding-critical list line in CLAUDE.md');
    const names = [];
    const tokenRe = /`([^`]+)`/g;
    let m;
    while ((m = tokenRe.exec(line)) !== null) names.push(m[1]);
    return names;
  }

  it('CLAUDE.md wedding-critical list matches $WeddingCritical exactly (both directions)', () => {
    const scriptNames = parseScriptNames();
    const claudeNames = parseClaudeNames();
    expect(claudeNames.slice().sort()).toEqual(scriptNames.slice().sort());
  });

  // Parse the exclude-patterns list from the prod-deps group in dependabot.yml.
  function parseDependabotExcludes() {
    const src = fs.readFileSync(dependabotPath, 'utf8');
    // Find the exclude-patterns block under prod-deps.
    const blockMatch = src.match(/exclude-patterns:([\s\S]*?)(?:\n\s{6}\S|\n\s{4}\S|$)/);
    if (!blockMatch) throw new Error('Could not locate exclude-patterns block in dependabot.yml');
    const block = blockMatch[1];
    const names = [];
    const tokenRe = /-\s+'([^']+)'/g;
    let m;
    while ((m = tokenRe.exec(block)) !== null) {
      names.push(m[1]);
    }
    return names;
  }

  it('dependabot.yml prod-deps exclude-patterns is parseable and has six entries', () => {
    const excludes = parseDependabotExcludes();
    expect(excludes).toHaveLength(6);
  });

  it('dependabot.yml prod-deps exclude-patterns matches $WeddingCritical exactly', () => {
    const scriptNames = parseScriptNames();
    const excludes = parseDependabotExcludes();
    expect(excludes.slice().sort()).toEqual(scriptNames.slice().sort());
  });
});
