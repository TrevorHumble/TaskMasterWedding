// tests/buildlog-harvest-docs.test.js
// Vitest tests for #447 AC6/AC7/AC8/AC9/AC11/AC12: the documentation and
// workflow-wiring acceptance criteria that aren't exercised by
// tests/buildlog-harvest.test.js's pure-function fixtures.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

describe('.claude/commands/build.md (#447 AC6)', () => {
  const doc = read(path.join('.claude', 'commands', 'build.md'));

  it('does not contain the retired phrase "Append one line to"', () => {
    expect(doc).not.toContain('Append one line to');
  });

  it('names the buildlog-entry marker in a pre-merge instruction', () => {
    const idx = doc.search(/pre-merge/i);
    expect(idx).toBeGreaterThan(-1);
    expect(doc.slice(idx, idx + 500)).toContain('buildlog-entry');
  });
});

describe('agents/orchestrator.md (#447 AC7)', () => {
  const doc = read(path.join('agents', 'orchestrator.md'));

  it('step-7 commit instruction does not contain the retired phrase', () => {
    expect(doc).not.toContain('Append a one-line entry to');
  });

  it('pre-merge comment instructions name both markers', () => {
    expect(doc).toContain('<!-- governance-ledger -->');
    expect(doc).toContain('<!-- buildlog-entry -->');
  });

  it('periodic-audit section states the post-cutover count source is the harvested rows', () => {
    const idx = doc.indexOf('Periodic full-system architectural audit');
    const section = doc.slice(idx, idx + 1500);
    expect(section).toMatch(/harvested `?gl1`? rows/);
    expect(section).toContain('#447');
  });

  it('halt/wave-completion/[AUDIT] instructions still name BUILDLOG.md', () => {
    const stopIdx = doc.indexOf('## Stop condition');
    const stopSection = doc.slice(stopIdx);
    expect(stopSection).toContain('BUILDLOG.md');
    const waveIdx = doc.indexOf('## Wave boundary');
    const waveSection = doc.slice(waveIdx, waveIdx + 800);
    expect(waveSection).toContain('BUILDLOG.md');
    const auditIdx = doc.indexOf('Periodic full-system architectural audit');
    const auditSection = doc.slice(auditIdx, auditIdx + 1500);
    expect(auditSection).toMatch(/\[AUDIT\].*BUILDLOG\.md|BUILDLOG\.md.*\[AUDIT\]/s);
  });
});

describe('BUILDLOG.md cutover header (#447 AC8)', () => {
  const doc = read('BUILDLOG.md');

  it('contains a dated cutover note naming the rendered file, the retained entry types, and the offline fallback', () => {
    expect(doc).toMatch(/Cutover \(2026-07-11, #447\)/);
    const idx = doc.indexOf('Cutover (2026-07-11, #447)');
    const note = doc.slice(idx, idx + 900);
    expect(note).toContain('ledger` branch');
    expect(note).toContain('[HALT]');
    expect(note).toContain('[AUDIT]');
    expect(note).toMatch(/wave-completion/);
    expect(note).toContain('scripts/buildlog-render.js');
  });

  it('every pre-existing entry line is preserved (frozen history matches git-normalized content)', () => {
    const history = read(path.join('governance', 'buildlog-history.md'));
    const idx = doc.search(/^## 2026-07-11$/m);
    const tail = doc.slice(idx);
    // Compare content ignoring the working-tree CRLF/LF representation
    // (core.autocrlf) -- the git-tracked (LF-normalized) bytes are what
    // "byte-identical" is judged against; see the implementer trace for
    // this AC (git diff confirmed only the header note as an insertion).
    expect(tail.replace(/\r\n/g, '\n')).toBe(history.replace(/\r\n/g, '\n'));
  });
});

describe('DESIGN.md (#447 AC9/AC12)', () => {
  const doc = read('DESIGN.md');

  it('AC9: records the decision with every required element', () => {
    const idx = doc.indexOf('### BUILDLOG comment harvest (#447)');
    expect(idx).toBeGreaterThan(-1);
    const nextIdx = doc.indexOf('### Governance snapshots');
    const section = doc.slice(idx, nextIdx);
    expect(section).toMatch(/pre-merge PR comment/);
    expect(section).toMatch(/stamped by CI/);
    expect(section).toMatch(/never parses a SHA/);
    expect(section).toMatch(/`buildlog` field/);
    expect(section).toMatch(/`ledger` branch/);
    expect(section).toContain('null');
    expect(section).toMatch(/rendered `BUILDLOG\.md`/);
    expect(section).toMatch(/exceptional non-merge entries/);
    expect(section).toMatch(/`BUILDLOG\.md` on `main`/);
    expect(section).toContain('scripts/buildlog-render.js');
  });

  it('AC12: the #357 carve-out paragraph carries a dated "narrowed" note citing #447, original text preserved', () => {
    const idx = doc.indexOf('The append-only carve-out list is, in this slice, exactly one path');
    expect(idx).toBeGreaterThan(-1);
    const section = doc.slice(idx, idx + 900);
    expect(section).toMatch(/[Nn]arrowed/);
    expect(section).toContain('#447');
    // original sentence preserved as history
    expect(section).toContain(
      'two writers appending distinct lines to it cannot corrupt each other'
    );
  });
});

describe('EXTRA: DESIGN.md "Row schema (v1)" lists the optional buildlog field', () => {
  it('the row-schema paragraph mentions buildlog', () => {
    const doc = read('DESIGN.md');
    const idx = doc.indexOf('**Row schema (v1).**');
    const section = doc.slice(idx, idx + 2200);
    expect(section).toContain('buildlog');
    expect(section).toMatch(/optional/);
  });
});
