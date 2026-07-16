// tests/spawn-report.test.js
// Vitest tests for tools/spawn-report.ps1 (#517): shells out to the script with a
// fixture JSON file it writes to a temp path (same shape as
// `gh issue list --json number,title,body,createdAt`), so no network call is
// needed. Asserts the OUTPUT VALUES for AC4 (two well-formed spawned-in-run
// issues tabulate correctly) and AC5 (a malformed issue is flagged, never
// dropped or fabricated).
// Windows PowerShell 5.1 is the launcher on win32; pwsh on other platforms.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
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

const SCRIPT = path.join(__dirname, '..', 'tools', 'spawn-report.ps1');

function run(fixturePath) {
  return spawnSync(
    PS,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-FixturePath', fixturePath],
    { encoding: 'utf8' }
  );
}

function writeFixture(dir, name, issues) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(issues, null, 2));
  return p;
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping spawn-report tests`)
  : describe;

maybeDescribe('spawn-report', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-report-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // AC4: two spawned-in-run issues, each with a complete Spawn justification
  // block -- one "pre-existing defect in untouched code", one "a different
  // feature". Output must have both rows populated (all four fields present),
  // `total spawned: 2`, and each category count == 1.
  it('AC4: two well-formed issues -> both rows populated, total spawned: 2, one per category', () => {
    const issues = [
      {
        number: 601,
        title: 'pre-existing tie-break defect in scoring.js',
        createdAt: '2026-07-10T12:00:00Z',
        body:
          '## Context\n\nFound while reviewing #514.\n\n' +
          '## Spawn justification\n\n' +
          '- **Spawned by:** #514\n' +
          '- **Why:** scoring.js mis-ranks entries sharing a timestamp\n' +
          '- **Why separable:** pre-existing defect in untouched code\n' +
          "- **Why not solved in the spawning session:** scoring.js is outside #514's touched files\n",
      },
      {
        number: 602,
        title: 'add CSV export of badge standings',
        createdAt: '2026-07-11T09:30:00Z',
        body:
          '## Spawn justification\n\n' +
          '- **Spawned by:** #515\n' +
          '- **Why:** planners asked for an offline copy of standings\n' +
          '- **Why separable:** a different feature\n' +
          '- **Why not solved in the spawning session:** needs an owner design decision on export format\n',
      },
    ];
    const fixturePath = writeFixture(tmpDir, 'ac4.json', issues);

    const r = run(fixturePath);
    expect(r.status).toBe(0);
    const out = r.stdout;

    // Both rows present, all four fields populated per row.
    expect(out).toMatch(
      /#601 \| spawned-by: #514 \| why: scoring\.js mis-ranks entries sharing a timestamp \| why-separable: pre-existing defect in untouched code \| why-not-solved: scoring\.js is outside #514's touched files \| created: 2026-07-10T12:00:00Z/
    );
    expect(out).toMatch(
      /#602 \| spawned-by: #515 \| why: planners asked for an offline copy of standings \| why-separable: a different feature \| why-not-solved: needs an owner design decision on export format \| created: 2026-07-11T09:30:00Z/
    );

    // Summary line.
    expect(out).toMatch(/total spawned: 2/);

    // Per-verbatim-value breakdown: each of the two exact "Why separable"
    // strings as written in the fixture, counted once each. The tool does
    // not bucket these into a hard-coded taxonomy -- it tallies exactly what
    // was written (trimmed, case-insensitive grouping).
    expect(out).toMatch(/by 'Why separable' value:/);
    expect(out).toMatch(/pre-existing defect in untouched code: 1/);
    expect(out).toMatch(/a different feature: 1/);

    // Neither issue is flagged MISSING (both are well-formed).
    expect(out).not.toMatch(/MISSING justification/);
  });

  // AC5: an issue carrying the label but whose body has no
  // `## Spawn justification` block at all must be listed with an explicit
  // `MISSING justification` marker -- never silently dropped, never a
  // fabricated field.
  it('AC5: issue with no Spawn justification block -> MISSING justification, not dropped', () => {
    const issues = [
      {
        number: 603,
        title: 'malformed spawn issue, no block',
        createdAt: '2026-07-12T08:00:00Z',
        body: '## Context\n\nThis issue was spawned but the author forgot the justification block entirely.\n',
      },
    ];
    const fixturePath = writeFixture(tmpDir, 'ac5.json', issues);

    const r = run(fixturePath);
    expect(r.status).toBe(0);
    const out = r.stdout;

    expect(out).toMatch(/#603 .* MISSING justification/);
    // Still counted in the total -- honestly visible, not dropped.
    expect(out).toMatch(/total spawned: 1/);
    // No fabricated field values for the malformed issue.
    expect(out).not.toMatch(/spawned-by:/);
  });

  // Edge: a block present but missing one required field (why-not-solved) is
  // also flagged MISSING and names the specific missing field, not silently
  // treated as complete.
  it('edge: block missing one field -> MISSING justification names that field', () => {
    const issues = [
      {
        number: 604,
        title: 'partial block, missing why-not-solved',
        createdAt: '2026-07-12T08:00:00Z',
        body:
          '## Spawn justification\n\n' +
          '- **Spawned by:** #514\n' +
          '- **Why:** something broke\n' +
          '- **Why separable:** a large or risky refactor\n',
      },
    ];
    const fixturePath = writeFixture(tmpDir, 'partial.json', issues);

    const r = run(fixturePath);
    expect(r.status).toBe(0);
    const out = r.stdout;

    expect(out).toMatch(/#604 .* MISSING justification/);
    expect(out).toMatch(/Why not solved in the spawning session/);
    expect(out).toMatch(/total spawned: 1/);
  });

  // Edge: a block where the label is present but its value is BLANK (e.g.
  // `- **Spawned by:** ` with nothing after it) must not let the value
  // capture bleed across the newline and fabricate the following line's
  // text as this field's value. It must be treated the same as an absent
  // field: named in the MISSING marker, and the issue still counted.
  it('edge: label present with blank value -> MISSING justification names field, no fabrication', () => {
    const issues = [
      {
        number: 605,
        title: 'spawned-in-run issue with blank Spawned by value',
        createdAt: '2026-07-13T10:00:00Z',
        body:
          '## Spawn justification\n\n' +
          '- **Spawned by:** \n' +
          '- **Why:** real need here\n' +
          '- **Why separable:** a different feature\n' +
          '- **Why not solved in the spawning session:** blocked\n',
      },
    ];
    const fixturePath = writeFixture(tmpDir, 'blank-field.json', issues);

    const r = run(fixturePath);
    expect(r.status).toBe(0);
    const out = r.stdout;

    expect(out).toMatch(/#605 .* MISSING justification \(missing: Spawned by\)/);
    // Still counted in the total -- honestly visible, not dropped.
    expect(out).toMatch(/total spawned: 1/);
    // No fabricated spawned-by value bled in from the next line (e.g. the
    // "real need here" text from the Why field must never appear as a
    // spawned-by value).
    expect(out).not.toMatch(/spawned-by:/);
  });

  // Mutation-coverage: a nonexistent fixture path fails loud (exit non-zero)
  // rather than silently reporting zero issues -- catches a mutant that
  // swallowed the Test-Path check.
  it('edge: missing fixture file -> non-zero exit, no fabricated empty report', () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.json');
    const r = run(missingPath);
    expect(r.status).not.toBe(0);
  });
});
