// tests/emit-ledger-comment.test.js
// Vitest tests for tools/emit-ledger-comment.ps1 (#449): assembles the
// pre-merge governance-ledger PR comment body verbatim from the evidence
// files the pipeline already writes, so the JSON is never hand-transcribed.
// Windows PowerShell 5.1 is the launcher on win32; pwsh elsewhere.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractLedgerComment } = require('../scripts/ledger-harvest.js');

const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';

let launcherMissing = false;
try {
  execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0']);
} catch (e) {
  if (e.code === 'ENOENT') {
    launcherMissing = true;
  }
}

const REPO_ROOT = path.resolve(__dirname, '..');
const EMIT = path.join(REPO_ROOT, 'tools', 'emit-ledger-comment.ps1');
const PERSIST_REVIEW = path.join(REPO_ROOT, 'tools', 'persist-review.ps1');

function scratchRoots() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-ledger-'));
  return {
    reviewsRoot: path.join(tmp, '.review_state', 'reviews'),
    issueReviewsRoot: path.join(tmp, '.review_state', 'issue-reviews'),
  };
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj));
}

function runEmit(treeOid, issueNumber, reviewsRoot, issueReviewsRoot) {
  const r = spawnSync(
    PS,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      EMIT,
      '-TreeOid',
      treeOid,
      '-IssueNumber',
      String(issueNumber),
      '-ReviewsRoot',
      reviewsRoot,
      '-IssueReviewsRoot',
      issueReviewsRoot,
    ],
    { encoding: 'utf8' }
  );
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping emit-ledger-comment tests`)
  : describe;

maybeDescribe('emit-ledger-comment.ps1 (#449)', () => {
  it('AC1: fixture evidence -> exact marker + fenced json, issue entry then two PR entries by round then reviewer id', () => {
    const { reviewsRoot, issueReviewsRoot } = scratchRoots();
    writeJson(path.join(reviewsRoot, 'T', 'reviewer-pr-opus.json'), {
      schema: 'rev1',
      reviewer_id: 'reviewer-pr-opus',
      model: 'opus',
      role: 'pr',
      verdict: 'PASS',
      findings_count: 1,
      defects: { blocker: 0, major: 0, minor: 1, nit: 0 },
      round: 1,
      tree_oid: 'T',
      ts: '2026-07-11T00:00:00Z',
    });
    writeJson(path.join(reviewsRoot, 'T', 'reviewer-design-philosophy-opus.json'), {
      schema: 'rev1',
      reviewer_id: 'reviewer-design-philosophy-opus',
      model: 'opus',
      role: 'design-philosophy',
      verdict: 'PASS',
      findings_count: 0,
      defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
      round: 1,
      tree_oid: 'T',
      ts: '2026-07-11T00:00:00Z',
    });
    fs.mkdirSync(path.join(issueReviewsRoot, '9'), { recursive: true });
    fs.writeFileSync(
      path.join(issueReviewsRoot, '9', 'reviewer-issue-opus.ledger-entry.txt'),
      '{"role":"issue","model":"opus","verdict":"PASS","round":1}'
    );

    const r = runEmit('T', 9, reviewsRoot, issueReviewsRoot);
    expect(r.status).toBe(0);

    // Exact expected text, pinned (normalizing CRLF/LF line endings -- the
    // Windows PowerShell launcher emits CRLF via Write-Output, pwsh on other
    // platforms emits LF; the marker/fence/json content itself is what this
    // test pins, not the launcher's line-ending convention). The tool's
    // ordered-hashtable + -Compress serialization is otherwise deterministic
    // (same pattern already relied on by tools/persist-issue-review.ps1's
    // ledger-review-entry line).
    const expected =
      '<!-- governance-ledger -->\n' +
      '```json\n' +
      '{"reviews":[' +
      '{"role":"issue","model":"opus","verdict":"PASS","round":1},' +
      '{"role":"design-philosophy","model":"opus","verdict":"PASS","defects":{"blocker":0,"major":0,"minor":0,"nit":0},"round":1},' +
      '{"role":"pr","model":"opus","verdict":"PASS","defects":{"blocker":0,"major":0,"minor":1,"nit":0},"round":1}' +
      ']}\n' +
      '```\n';
    expect(r.stdout.replace(/\r\n/g, '\n')).toBe(expected);
  });

  it('AC2: emitted body round-trips losslessly through the real extractLedgerComment parser', () => {
    const { reviewsRoot, issueReviewsRoot } = scratchRoots();
    writeJson(path.join(reviewsRoot, 'T2', 'reviewer-pr-opus.json'), {
      schema: 'rev1',
      reviewer_id: 'reviewer-pr-opus',
      model: 'opus',
      role: 'pr',
      verdict: 'PASS',
      findings_count: 0,
      defects: { blocker: 0, major: 1, minor: 0, nit: 3 },
      round: 2,
      tree_oid: 'T2',
      ts: '2026-07-11T00:00:00Z',
    });
    fs.mkdirSync(path.join(issueReviewsRoot, '10'), { recursive: true });
    fs.writeFileSync(
      path.join(issueReviewsRoot, '10', 'reviewer-issue-opus.ledger-entry.txt'),
      '{"role":"issue","model":"opus","verdict":"PASS","round":1}'
    );

    const r = runEmit('T2', 10, reviewsRoot, issueReviewsRoot);
    expect(r.status).toBe(0);

    const parsed = extractLedgerComment([{ body: r.stdout }]);
    expect(parsed.reviews).toEqual([
      { role: 'issue', model: 'opus', verdict: 'PASS', round: 1 },
      {
        role: 'pr',
        model: 'opus',
        verdict: 'PASS',
        defects: { blocker: 0, major: 1, minor: 0, nit: 3 },
        round: 2,
      },
    ]);
  });

  it('AC3: PR-review class empty (issue evidence present) -> exit non-zero, names PR-review, emits nothing', () => {
    const { reviewsRoot, issueReviewsRoot } = scratchRoots();
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(path.join(issueReviewsRoot, '11'), { recursive: true });
    fs.writeFileSync(
      path.join(issueReviewsRoot, '11', 'reviewer-issue-opus.ledger-entry.txt'),
      '{"role":"issue","model":"opus","verdict":"PASS","round":1}'
    );

    const r = runEmit('T3', 11, reviewsRoot, issueReviewsRoot);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/PR-review/);
    expect(r.stdout.trim()).toBe('');
  });

  it('AC3: issue class empty (PR evidence present) -> exit non-zero, names issue, emits nothing', () => {
    const { reviewsRoot, issueReviewsRoot } = scratchRoots();
    writeJson(path.join(reviewsRoot, 'T4', 'reviewer-pr-opus.json'), {
      schema: 'rev1',
      reviewer_id: 'reviewer-pr-opus',
      model: 'opus',
      role: 'pr',
      verdict: 'PASS',
      findings_count: 0,
      defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
      round: 1,
      tree_oid: 'T4',
      ts: '2026-07-11T00:00:00Z',
    });
    fs.mkdirSync(issueReviewsRoot, { recursive: true });

    const r = runEmit('T4', 12, reviewsRoot, issueReviewsRoot);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/issue/);
    expect(r.stdout.trim()).toBe('');
  });

  it('AC3: both classes empty -> exit non-zero, emits nothing', () => {
    const { reviewsRoot, issueReviewsRoot } = scratchRoots();
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(issueReviewsRoot, { recursive: true });

    const r = runEmit('T5', 13, reviewsRoot, issueReviewsRoot);
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('AC4: persist-review.ps1 -Round 2 writes round:2 alongside the existing defects object', () => {
    const { reviewsRoot } = scratchRoots();
    const r = spawnSync(
      PS,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        PERSIST_REVIEW,
        '-TreeOid',
        'T6',
        '-ReviewerId',
        'r1',
        '-Verdict',
        'PASS',
        '-Round',
        '2',
        '-Minor',
        '1',
        '-ReviewsRoot',
        reviewsRoot,
      ],
      { encoding: 'utf8' }
    );
    expect(r.status).toBe(0);
    const evPath = path.join(reviewsRoot, 'T6', 'r1.json');
    const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
    expect(ev.round).toBe(2);
    expect(ev.defects).toEqual({ blocker: 0, major: 0, minor: 1, nit: 0 });
    expect(ev.verdict).toBe('PASS');
    expect(ev.reviewer_id).toBe('r1');
    expect(ev.tree_oid).toBe('T6');
  });

  it('AC4: persist-review.ps1 without -Round defaults to round:1, every pre-existing field unchanged', () => {
    const { reviewsRoot } = scratchRoots();
    const r = spawnSync(
      PS,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        PERSIST_REVIEW,
        '-TreeOid',
        'T7',
        '-ReviewerId',
        'r2',
        '-Verdict',
        'PASS',
        '-Blocker',
        '1',
        '-ReviewsRoot',
        reviewsRoot,
      ],
      { encoding: 'utf8' }
    );
    expect(r.status).toBe(0);
    const evPath = path.join(reviewsRoot, 'T7', 'r2.json');
    const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
    expect(ev.round).toBe(1);
    expect(ev).toMatchObject({
      schema: 'rev1',
      reviewer_id: 'r2',
      model: 'opus',
      role: 'pr',
      verdict: 'PASS',
      findings_count: 1,
      defects: { blocker: 1, major: 0, minor: 0, nit: 0 },
      round: 1,
      tree_oid: 'T7',
    });
  });

  // AC-Cat3 (#517): evidence carrying a populated `categories` object is
  // projected into the PR entry, alongside the existing `defects` histogram.
  it('AC-Cat3: evidence with categories -> categories object projected into PR entry', () => {
    const { reviewsRoot, issueReviewsRoot } = scratchRoots();
    writeJson(path.join(reviewsRoot, 'T8', 'reviewer-pr-opus.json'), {
      schema: 'rev1',
      reviewer_id: 'reviewer-pr-opus',
      model: 'opus',
      role: 'pr',
      verdict: 'FAIL',
      findings_count: 2,
      defects: { blocker: 1, major: 1, minor: 0, nit: 0 },
      categories: {
        correctness: 1,
        security: 1,
        'test-coverage': 0,
        docs: 0,
        design: 0,
        simplification: 0,
        style: 0,
      },
      round: 1,
      tree_oid: 'T8',
      ts: '2026-07-14T00:00:00Z',
    });
    fs.mkdirSync(path.join(issueReviewsRoot, '14'), { recursive: true });
    fs.writeFileSync(
      path.join(issueReviewsRoot, '14', 'reviewer-issue-opus.ledger-entry.txt'),
      '{"role":"issue","model":"opus","verdict":"PASS","round":1}'
    );

    const r = runEmit('T8', 14, reviewsRoot, issueReviewsRoot);
    expect(r.status).toBe(0);

    const parsed = extractLedgerComment([{ body: r.stdout }]);
    const prEntry = parsed.reviews.find((rv) => rv.role === 'pr');
    expect(prEntry.categories).toEqual({
      correctness: 1,
      security: 1,
      'test-coverage': 0,
      docs: 0,
      design: 0,
      simplification: 0,
      style: 0,
    });
  });

  // AC-Cat3 (#517): back-compat -- an evidence file with NO `categories`
  // object (a pre-category merge) still emits, treating the missing object
  // as all-zero (i.e. omitted entirely), never invalid. Mirrors the
  // pinned AC1 fixture above, which also carries no `categories` key.
  it('AC-Cat3: evidence with NO categories object -> still emits, no categories key (back-compat)', () => {
    const { reviewsRoot, issueReviewsRoot } = scratchRoots();
    writeJson(path.join(reviewsRoot, 'T9', 'reviewer-pr-opus.json'), {
      schema: 'rev1',
      reviewer_id: 'reviewer-pr-opus',
      model: 'opus',
      role: 'pr',
      verdict: 'PASS',
      findings_count: 0,
      defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
      round: 1,
      tree_oid: 'T9',
      ts: '2026-07-11T00:00:00Z',
    });
    fs.mkdirSync(path.join(issueReviewsRoot, '15'), { recursive: true });
    fs.writeFileSync(
      path.join(issueReviewsRoot, '15', 'reviewer-issue-opus.ledger-entry.txt'),
      '{"role":"issue","model":"opus","verdict":"PASS","round":1}'
    );

    const r = runEmit('T9', 15, reviewsRoot, issueReviewsRoot);
    expect(r.status).toBe(0);

    const parsed = extractLedgerComment([{ body: r.stdout }]);
    const prEntry = parsed.reviews.find((rv) => rv.role === 'pr');
    expect(prEntry).toBeDefined();
    expect(prEntry.categories).toBeUndefined();
    expect(prEntry.defects).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0 });
  });
});
