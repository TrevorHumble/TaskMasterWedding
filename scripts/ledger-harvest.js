// scripts/ledger-harvest.js — governance-ledger harvest (#219).
//
// The ONLY sanctioned writer of governance/ledger.ndjson is the CI job in
// .github/workflows/ledger.yml, which runs this script post-merge on main.
// No local session or agent ever writes the ledger: a row must never be part
// of the tree it describes (appending the row would change the tree and
// invalidate the tree-bound verdict). See DESIGN.md "Governance ledger (#219)".
//
// Pure functions (exported, unit-tested on fixtures): extractLedgerComment,
// buildRow, buildGovernanceRow, buildReversalRow, touchesKernelSurface,
// resolveIssueNumber, appendRows. The network/CLI entry (main) is a thin shell
// around them and runs only inside the workflow.
'use strict';

const fs = require('fs');
const path = require('path');

// Mirrors $SYSTEM_PATH_REGEX / $EXPERIMENTAL_PATH_REGEX in tools/verdict-core.ps1.
const SYSTEM_PATH_REGEX =
  /^(\.githooks\/|tools\/|standards\/|agents\/|skills\/|\.github\/|\.claude\/|docs\/north-star\.md|DESIGN\.md|CLAUDE\.md|AGENTS\.md)/;
const EXPERIMENTAL_PATH_REGEX = /^agents\/reviewer-[^/]+\.md$/;

const LEDGER_PATH = path.join('governance', 'ledger.ndjson');
const REVERSAL_LABEL = 'design-reversed';

// True when any changed file is on the kernel (governing-artifact) surface.
function touchesKernelSurface(files) {
  return (files || []).some((f) => !EXPERIMENTAL_PATH_REGEX.test(f) && SYSTEM_PATH_REGEX.test(f));
}

// Find the structured review report in a PR's comments: a comment containing
// the marker token `governance-ledger` and a fenced json block. The LAST such
// comment wins (a re-posted report supersedes earlier ones). Returns the parsed
// object, or null when no comment carries a parseable report — the caller
// records reviews: [] (an honestly-visible gap, never a fabricated entry).
function extractLedgerComment(comments) {
  const re = /governance-ledger[\s\S]*?```json\s*\n([\s\S]*?)```/;
  let found = null;
  for (const c of comments || []) {
    const body = c && c.body ? c.body : '';
    const m = re.exec(body);
    if (m) {
      try {
        found = JSON.parse(m[1]);
      } catch {
        // Malformed report: keep whatever parsed earlier; a broken latest
        // report must not erase a valid prior one silently.
      }
    }
  }
  return found;
}

// Find the last PR comment carrying the `<!-- buildlog-entry -->` marker and
// return the narrative text that follows it, verbatim (leading/trailing
// whitespace trimmed). The LAST such comment wins, same rule as
// extractLedgerComment above (a re-posted entry supersedes earlier ones).
// Returns null when no comment carries the marker — an honestly-visible gap
// (buildlog-render.js renders it as "(no buildlog-entry comment on PR #N)"),
// never a fabricated entry (#447).
const BUILDLOG_MARKER = '<!-- buildlog-entry -->';
function extractBuildlogComment(comments) {
  let found = null;
  for (const c of comments || []) {
    const body = c && c.body ? c.body : '';
    const idx = body.indexOf(BUILDLOG_MARKER);
    if (idx !== -1) {
      found = body.slice(idx + BUILDLOG_MARKER.length).trim();
    }
  }
  return found;
}

// Resolve the issue a PR closes, from title/body/branch. Returns a number or
// null (recorded as null in the row — a visible gap, not a guess).
function resolveIssueNumber(pr) {
  const text = `${(pr && pr.title) || ''}\n${(pr && pr.body) || ''}`;
  let m = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(text);
  if (m) return parseInt(m[1], 10);
  m = /\(#(\d+)\)/.exec(text);
  if (m) return parseInt(m[1], 10);
  const branch = (pr && pr.head && pr.head.ref) || '';
  m = /(?:^|[-/])issue[-/](\d+)(?:$|[-/])/i.exec(branch);
  if (m) return parseInt(m[1], 10);
  return null;
}

// Event mode (#220): a PR carrying any commit whose subject starts 'hotfix: '
// is a freeze shipment — during a valid event-mode window the hooks let such
// commits through without review evidence, so the row is marked freeze:true
// and becomes the retro-review worklist that tools/set-event-mode.ps1 -Clear
// refuses to dissolve until every entry has a recorded retro-review PASS.
// Deliberately over-inclusive: a 'hotfix: ' commit that WAS reviewed still
// gets freeze:true, which only ever adds a review, never skips one.
function hasFreezeCommit(commitMessages) {
  return (commitMessages || []).some((m) => typeof m === 'string' && m.startsWith('hotfix: '));
}

// One gl1 row per merged PR (schema v1). `comments` is the PR's issue-comment
// list; the reviews array is taken VERBATIM from the governance-ledger comment,
// or [] when none exists. `commitMessages` is the PR's commit-subject list,
// used only to derive freeze (see hasFreezeCommit above). `buildlog` is the
// narrative from the last `<!-- buildlog-entry -->` comment, verbatim, or
// null when no such comment exists — additive field, #447.
function buildRow(pr, comments, commitMessages) {
  const report = extractLedgerComment(comments);
  return {
    schema: 'gl1',
    pr: pr.number,
    issue: resolveIssueNumber(pr),
    merged_sha: pr.merge_commit_sha,
    ts: pr.merged_at,
    reviews: report && Array.isArray(report.reviews) ? report.reviews : [],
    labels: (pr.labels || []).map((l) => l.name),
    freeze: hasFreezeCommit(commitMessages),
    buildlog: extractBuildlogComment(comments),
  };
}

// gl1-governance row: emitted alongside gl1 when the merged PR touched the
// kernel surface. `files` is the PR's changed-file path list.
function buildGovernanceRow(pr, files) {
  return {
    schema: 'gl1-governance',
    pr: pr.number,
    merged_sha: pr.merge_commit_sha,
    ts: pr.merged_at,
    files: (files || []).filter(
      (f) => !EXPERIMENTAL_PATH_REGEX.test(f) && SYSTEM_PATH_REGEX.test(f)
    ),
  };
}

// gl1-reversal row: emitted when the owner applies the design-reversed label
// to a merged PR.
function buildReversalRow(pr, ts) {
  return {
    schema: 'gl1-reversal',
    pr: pr.number,
    ts: ts || pr.merged_at,
    label: REVERSAL_LABEL,
  };
}

// Append rows to ledger text, skipping rows already present (same schema + pr;
// reversals also match on label). Returns { text, appended } — pure on strings
// so it is testable without touching disk.
function appendRows(existingText, rows) {
  const lines = (existingText || '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  const seen = new Set();
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      seen.add(`${r.schema}|${r.pr}|${r.label || ''}`);
    } catch {
      // Unparseable line: leave it in place; the report script surfaces it.
    }
  }
  const appended = [];
  for (const row of rows || []) {
    const key = `${row.schema}|${row.pr}|${row.label || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(JSON.stringify(row));
    appended.push(row);
  }
  const text = lines.length > 0 ? lines.join('\n') + '\n' : '';
  return { text, appended };
}

// ---------------------------------------------------------------------------
// CI entry. Everything below talks to the GitHub API and runs only in the
// ledger workflow; keep it a thin shell over the pure functions above.
// ---------------------------------------------------------------------------

async function ghApi(url, token) {
  const res = await fetch(`https://api.github.com${url}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${url} -> ${res.status}`);
  }
  return res.json();
}

async function harvestPush(repo, token, payload) {
  const shas = (payload.commits || []).map((c) => c.id);
  const prsByNumber = new Map();
  for (const sha of shas) {
    const prs = await ghApi(`/repos/${repo}/commits/${sha}/pulls`, token);
    for (const pr of prs) {
      if (pr.merged_at && pr.merge_commit_sha === sha) {
        prsByNumber.set(pr.number, pr);
      }
    }
  }
  const rows = [];
  for (const pr of prsByNumber.values()) {
    const comments = await ghApi(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`, token);
    const files = (await ghApi(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`, token)).map(
      (f) => f.filename
    );
    const commitMessages = (
      await ghApi(`/repos/${repo}/pulls/${pr.number}/commits?per_page=100`, token)
    ).map((c) => (c.commit && c.commit.message ? c.commit.message : ''));
    rows.push(buildRow(pr, comments, commitMessages));
    if (touchesKernelSurface(files)) {
      rows.push(buildGovernanceRow(pr, files));
    }
    if ((pr.labels || []).some((l) => l.name === REVERSAL_LABEL)) {
      rows.push(buildReversalRow(pr, pr.merged_at));
    }
  }
  return rows;
}

function harvestLabeled(payload) {
  const pr = payload.pull_request;
  if (!pr || !pr.merged_at) return [];
  const label = payload.label && payload.label.name;
  if (label !== REVERSAL_LABEL) return [];
  return [buildReversalRow(pr, new Date().toISOString())];
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!repo || !token || !eventName || !eventPath) {
    console.error('ledger-harvest: missing GITHUB_* environment; CI-only entry.');
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));

  let rows;
  if (eventName === 'push') {
    rows = await harvestPush(repo, token, payload);
  } else if (eventName === 'pull_request') {
    rows = harvestLabeled(payload);
  } else {
    console.log(`ledger-harvest: nothing to do for event ${eventName}.`);
    return;
  }

  const existing = fs.existsSync(LEDGER_PATH) ? fs.readFileSync(LEDGER_PATH, 'utf8') : '';
  const { text, appended } = appendRows(existing, rows);
  if (appended.length === 0) {
    console.log('ledger-harvest: no new rows.');
    return;
  }
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, text);
  console.log(`ledger-harvest: appended ${appended.length} row(s).`);
}

module.exports = {
  BUILDLOG_MARKER,
  extractLedgerComment,
  extractBuildlogComment,
  resolveIssueNumber,
  buildRow,
  buildGovernanceRow,
  buildReversalRow,
  touchesKernelSurface,
  hasFreezeCommit,
  appendRows,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`ledger-harvest: ${err.message}`);
    process.exit(1);
  });
}
