// tests/trivial-dep-bump-docs.test.js
// Vitest tests for #448 AC10/AC11/AC17: the trivial dep-bump path is
// documented in CLAUDE.md and standards/adversarial-review-protocol.md, and
// the four self-description surfaces are reconciled (no unqualified
// absolute "no bypass" claim survives).
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

describe('CLAUDE.md documents the trivial dep-bump path (#448 AC10)', () => {
  const doc = read('CLAUDE.md');

  it('names the hand-built trivial path and Dependabot as preferred author', () => {
    expect(doc).toMatch(/[Tt]rivial dep-bump path/);
    expect(doc).toContain('Dependabot remains the preferred author');
  });

  it('states all three eligibility conditions', () => {
    expect(doc).toContain('package.json, package-lock.json');
    expect(doc).toMatch(/classifies `auto`/);
    expect(doc).toContain('chore(deps): ');
  });
});

describe('adversarial-review-protocol.md documents the base-tier waiver (#448 AC11)', () => {
  const doc = read(path.join('standards', 'adversarial-review-protocol.md'));

  it('has a subsection titled as a base-tier waiver, not a dispatch-table row', () => {
    expect(doc).toMatch(/## Trivial dep-bump path \(base-tier waiver\)/);
    expect(doc).toMatch(/[Nn]ot a dispatch-table row/);
  });

  // Headers matched as line-anchored (^## ...) so an inline backtick
  // cross-reference to the same title elsewhere in the doc (e.g. "see the
  // `## Trivial dep-bump path (base-tier waiver)` above") can't be mistaken
  // for the real section boundary.
  function sectionBetween(startTitle, endTitle) {
    const startMatch = doc.match(
      new RegExp(`^${startTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm')
    );
    if (!startMatch) throw new Error(`start header not found: ${startTitle}`);
    const startIdx = startMatch.index + startMatch[0].length;
    const rest = doc.slice(startIdx);
    const endMatch = rest.match(
      new RegExp(`^${endTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm')
    );
    return endMatch ? rest.slice(0, endMatch.index) : rest;
  }

  it('states the three eligibility conditions and that green CI alone gates the merge', () => {
    const section = sectionBetween(
      '## Trivial dep-bump path (base-tier waiver)',
      '## Which reviews does this change need?'
    );
    expect(section).toContain('package.json, package-lock.json');
    expect(section).toMatch(/classifies `auto`/);
    expect(section).toContain('chore(deps): ');
    expect(section).toMatch(/green CI alone gates the merge/);
  });

  it('"Which reviews does this change need?" cross-references the waiver section', () => {
    const idx = doc.search(/^## Which reviews does this change need\?$/m);
    const dispatchSection = doc.slice(idx, idx + 2000);
    expect(dispatchSection).toMatch(/Trivial dep-bump path \(base-tier waiver\)/);
  });
});

describe('four self-description surfaces reconciled, not left absolute (#448 AC17)', () => {
  it('(a) .githooks/commit-msg header does not contain the unqualified absolute sentence', () => {
    const doc = read(path.join('.githooks', 'commit-msg'));
    expect(doc).not.toContain('There is NO [no-issue] bypass for code.');
    expect(doc).toMatch(/trivial dep-bump path \(#448/);
  });

  it('(b) .githooks/pre-commit "Guarantee (scoped honestly)" block names the trivial dep-bump exemption', () => {
    const doc = read(path.join('.githooks', 'pre-commit'));
    const guaranteeBlock = doc.split('Guarantee (scoped honestly)')[1].split('set -e')[0];
    expect(guaranteeBlock).toMatch(
      /trivial\s*\n?# dep-bump path \(#448|trivial dep-bump path \(#448/
    );
  });

  it('(c) DESIGN.md "Commit gate" honest-bar section carries a scoped note naming the trivial dep-bump exemption', () => {
    const doc = read('DESIGN.md');
    const idx = doc.indexOf('### Commit gate: review evidence bound to the staged tree');
    const nextSection = doc.indexOf('### Bias-gate and adjudication evidence artifacts');
    const section = doc.slice(idx, nextSection);
    expect(section).toMatch(/Scoped exemption note.*#448/);
    expect(section).toMatch(/[Tt]rivial dep-bump/);
  });

  it('(d) DESIGN.md "Issue-review gate" carries the reconciled enumeration, not the absolute sentence', () => {
    const doc = read('DESIGN.md');
    expect(doc).not.toContain('There is no `[no-issue]` bypass for code.');
    const idx = doc.indexOf(
      '### Issue-review gate: every code commit names a reviewed issue (#46)'
    );
    const nextSection = doc.indexOf('### Issue-creation review marker');
    const section = doc.slice(idx, nextSection);
    expect(section).toMatch(/Reconciled.*#448/);
    expect(section).toMatch(/ledger appender \(#219/);
    expect(section).toMatch(/event-mode hotfix \(#220/);
    expect(section).toMatch(/trivial dep-bump path \(#448/);
  });

  it('DESIGN.md records the "Trivial dep-bump gate (#448)" ADR', () => {
    const doc = read('DESIGN.md');
    expect(doc).toMatch(/### Trivial dep-bump gate \(#448\): recomputed, not attested/);
  });
});
