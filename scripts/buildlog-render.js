// scripts/buildlog-render.js — pure renderer for the harvested per-merge
// BUILDLOG entries (#447).
//
// The per-merge changelog moved off hand-appended edits to BUILDLOG.md and
// onto a pre-merge `<!-- buildlog-entry -->` PR comment, harvested by
// scripts/ledger-harvest.js into an additive `buildlog` field on the gl1
// row. This module renders those rows into the browsable log: a reverse-
// chronological line per merge, followed by the frozen pre-cutover history,
// verbatim. See DESIGN.md "Governance ledger (#219)" / "BUILDLOG comment
// harvest (#447)".
//
// Pure functions (exported, unit-tested on fixtures): renderEntry,
// renderEntries, renderFullFile. main() is a thin CLI shell that reads
// governance/ledger.ndjson and governance/buildlog-history.md from the
// working copy and writes the rendered file to disk; it runs only from the
// CLI (the ledger workflow), never imported for its side effects.
'use strict';

const fs = require('fs');
const path = require('path');

// The `<!-- buildlog-entry -->` protocol marker is owned solely by
// scripts/ledger-harvest.js (BUILDLOG_MARKER) — the harvester is the only
// code that reads it off a PR comment. This renderer never touches the
// marker: it builds every line from committed gl1 row fields, so it does not
// declare or import it.

const LEDGER_FILE = path.join('governance', 'ledger.ndjson');
const HISTORY_FILE = path.join('governance', 'buildlog-history.md');
const OUTPUT_FILE = 'BUILDLOG.md';

const HEADER =
  '# Build Log\n' +
  '\n' +
  'Reverse-chronological record of notable changes to the repo.\n' +
  '\n' +
  '## Entry conventions\n' +
  '\n' +
  'Generated per-merge section: one line per merged PR, rendered from\n' +
  '`governance/ledger.ndjson` by `scripts/buildlog-render.js` — never hand-\n' +
  'edited. Format: `<sha> — #<issue> — <narrative>`, or\n' +
  '`(no buildlog-entry comment on PR #<pr>)` when the PR carried no\n' +
  '`<!-- buildlog-entry -->` comment (an honest gap, never fabricated).\n' +
  '\n' +
  'Frozen history below: every entry that predates the #447 cutover,\n' +
  'preserved byte-for-byte from the pre-cutover `BUILDLOG.md` on `main`.\n' +
  '\n';

// Render one gl1 row into its BUILDLOG line. Identity fields (sha, issue)
// come ONLY from the row's own merged_sha/issue fields, never parsed out of
// the narrative — so a buildlog narrative containing a SHA-like or #NN-like
// token can never spoof the entry's identity (#447 AC3/AC4).
function renderEntry(row) {
  const sha = row && row.merged_sha ? row.merged_sha : '(unknown-sha)';
  const issue = row && row.issue !== null && row.issue !== undefined ? row.issue : '?';
  const narrative =
    row && typeof row.buildlog === 'string' && row.buildlog.length > 0
      ? row.buildlog
      : `(no buildlog-entry comment on PR #${row && row.pr})`;
  return `- ${sha} — #${issue} — ${narrative}`;
}

// Reverse-chronological generated section: every gl1 row, most-recently-
// appended first. The ledger is append-only (oldest first), so reversing
// the input array yields display order.
function renderEntries(rows) {
  const gl1Rows = (rows || []).filter((r) => r && r.schema === 'gl1');
  return gl1Rows.slice().reverse().map(renderEntry);
}

// Full-file render (#447 AC10): the generated per-merge section followed by
// the frozen pre-cutover history block, verbatim. historyBlock is carried
// through byte-for-byte, never re-parsed or mutated, so the browsable
// ledger-branch file cannot silently drop prior history.
function renderFullFile(rows, historyBlock) {
  const lines = renderEntries(rows);
  const generated = lines.length > 0 ? lines.join('\n') + '\n' : '';
  return generated + (historyBlock || '');
}

function parseLedgerRows(text) {
  const rows = [];
  for (const line of (text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Unparseable line: governance-report.ps1 already surfaces this
      // count; the renderer just skips it rather than crashing the job.
    }
  }
  return rows;
}

function main() {
  const repoRoot = process.cwd();
  const ledgerPath = path.join(repoRoot, LEDGER_FILE);
  const historyPath = path.join(repoRoot, HISTORY_FILE);
  const outputPath = path.join(repoRoot, OUTPUT_FILE);

  const ledgerText = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  const historyBlock = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : '';
  const rows = parseLedgerRows(ledgerText);

  const rendered = HEADER + renderFullFile(rows, historyBlock);
  fs.writeFileSync(outputPath, rendered);
  console.log(`buildlog-render: wrote ${OUTPUT_FILE} (${rows.length} ledger row(s) read).`);
}

module.exports = { renderEntry, renderEntries, renderFullFile, parseLedgerRows, HEADER };

if (require.main === module) {
  main();
}
