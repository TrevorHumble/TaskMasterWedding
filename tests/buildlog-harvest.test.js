// tests/buildlog-harvest.test.js
// Vitest tests for #447 — BUILDLOG comment harvest: the additive `buildlog`
// field on scripts/ledger-harvest.js's gl1 row (AC1, AC2), and the pure
// renderers in scripts/buildlog-render.js (AC3, AC4, AC10).
'use strict';

const { buildRow, extractBuildlogComment } = require('../scripts/ledger-harvest.js');
const { renderEntry, renderEntries, renderFullFile } = require('../scripts/buildlog-render.js');

const pr = {
  number: 447,
  title: 'feat(governance): harvest BUILDLOG entries from a PR comment (#447)',
  body: '',
  merged_at: '2026-07-11T00:00:00Z',
  merge_commit_sha: 'cafef00d',
  labels: [],
  head: { ref: 'issue-447-buildlog-harvest' },
};

function buildlogComment(text) {
  return { body: `<!-- buildlog-entry -->\n${text}` };
}

describe('ledger-harvest buildlog field (#447 AC1/AC2)', () => {
  it('AC1: two buildlog-entry comments -> last one wins, verbatim', () => {
    const row = buildRow(pr, [buildlogComment('old text'), buildlogComment('Entry text here.')]);
    expect(row.buildlog).toBe('Entry text here.');
  });

  it('AC2: no buildlog-entry comment -> buildlog is null', () => {
    const row = buildRow(pr, [{ body: 'just chatting' }]);
    expect(row.buildlog).toBeNull();
  });

  it('extractBuildlogComment: last marked comment wins across a mixed comment list', () => {
    const comments = [
      { body: 'lgtm' },
      buildlogComment('first entry'),
      { body: 'unrelated' },
      buildlogComment('second entry'),
    ];
    expect(extractBuildlogComment(comments)).toBe('second entry');
  });

  it('extractBuildlogComment: empty/undefined comments -> null', () => {
    expect(extractBuildlogComment([])).toBeNull();
    expect(extractBuildlogComment(undefined)).toBeNull();
  });
});

describe('buildlog-render.js pure functions (#447 AC3/AC4/AC10)', () => {
  const older = {
    schema: 'gl1',
    pr: 10,
    issue: 5,
    merged_sha: 'abc1234',
    buildlog: 'Did the thing.',
  };
  const newer = { schema: 'gl1', pr: 11, issue: 6, merged_sha: 'def5678', buildlog: null };

  it('AC3: two-row fixture ledger -> exact reverse-chronological lines, honest gap marker', () => {
    const out = renderEntries([older, newer]);
    expect(out).toEqual([
      '- def5678 — #6 — (no buildlog-entry comment on PR #11)',
      '- abc1234 — #5 — Did the thing.',
    ]);
  });

  it('AC4: identity fields come from the row, never mined from the narrative', () => {
    const spoofRow = {
      schema: 'gl1',
      pr: 99,
      issue: 5,
      merged_sha: 'abc1234',
      buildlog: 'looks like def5678 fixed #6, not #5.',
    };
    const line = renderEntry(spoofRow);
    // The leading sha/issue equal the row's OWN fields (abc1234, #5) even
    // though the narrative text itself contains a different sha-like token
    // (def5678) and a different #NN token (#6) -- inverting this to parse
    // identity out of the narrative would fail this assertion.
    expect(line).toBe('- abc1234 — #5 — looks like def5678 fixed #6, not #5.');
    expect(line.startsWith('- abc1234 — #5 — ')).toBe(true);
  });

  it('AC10: full-file render is exactly the generated section followed by the history block, verbatim', () => {
    const historyBlock = '## 2026-07-01\n\n- 0000000 — #1 — some ancient entry.\n';
    const out = renderFullFile([older, newer], historyBlock);
    const expected =
      '- def5678 — #6 — (no buildlog-entry comment on PR #11)\n' +
      '- abc1234 — #5 — Did the thing.\n' +
      historyBlock;
    expect(out).toBe(expected);
  });

  it('AC10: empty rows -> output is exactly the history block, no generated lines', () => {
    const historyBlock = '## 2026-07-01\n\nfrozen\n';
    expect(renderFullFile([], historyBlock)).toBe(historyBlock);
  });

  it('non-gl1 rows (reversal/governance) are excluded from the rendered entries', () => {
    const reversal = { schema: 'gl1-reversal', pr: 11, ts: 'x', label: 'design-reversed' };
    const governance = { schema: 'gl1-governance', pr: 11, files: ['tools/x.ps1'] };
    const out = renderEntries([older, reversal, governance, newer]);
    expect(out).toHaveLength(2);
  });
});
