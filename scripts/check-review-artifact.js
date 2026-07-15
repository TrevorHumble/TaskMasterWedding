// scripts/check-review-artifact.js — server-side check that a PR carries
// structured, tree-and-issue-bound review evidence before it can merge (#48).
//
// The server side previously accepted a merge with no review-aware check:
// `merge-association` (.github/workflows/ci.yml) only verifies a commit
// message NAMES an issue, it never verifies a review happened, and
// `required_approving_review_count` stays 0 (solo maintainer, GitHub forbids
// self-approval — DESIGN.md "Branch protection on main"), so the
// review-aware gate has to be a status check, not an approval count.
//
// This script IS that check. It reads the same pre-merge
// `<!-- governance-ledger -->` PR comment tools/emit-ledger-comment.ps1
// assembles from the pipeline's own review evidence, and fails closed unless
// the evidence it names matches THIS PR's actual head tree and issue — so a
// stale comment left over from an earlier push (bound to an old tree oid)
// fails by construction, and a missing or forged comment fails outright.
// Trust model: tamper-evident, not tamper-proof — the same bar as every
// other gate in this repo (DESIGN.md "Issue-review gate"). Full decision:
// DESIGN.md "Review-artifact-present check (#48)".
//
// Pure decision function (exported, unit-tested on fixtures, no network):
// checkReviewArtifact. main() is a thin CLI shell around it: the real path
// talks to the GitHub API; --fixture is the offline seam that reads a JSON
// file shaped exactly like checkReviewArtifact's input, so CI's fixture
// coverage (tests/check-review-artifact.test.js, AC1-AC4) and this exact
// process boundary run without a network call.
'use strict';

const fs = require('fs');
const { extractLedgerComment } = require('./lib/ledger-comment');
const { touchesKernelSurface, resolveIssueNumber } = require('./ledger-harvest');

// input: {
//   comments:           PR issue-comment list (same shape the GitHub API returns)
//   headTreeOid:        the PR head commit's tree oid
//   headCommitSubject:  the PR head commit's message (first line is the subject)
//   changedPaths:       the PR's changed file paths
// }
// returns { ok: bool, message: string } — message always starts with the
// check's own name so a reader of raw CI log lines can attribute it.
function checkReviewArtifact(input) {
  const comments = (input && input.comments) || [];
  const headTreeOid = input && input.headTreeOid;
  const headCommitSubject = (input && input.headCommitSubject) || '';
  const changedPaths = (input && input.changedPaths) || [];

  const report = extractLedgerComment(comments);
  if (!report || !Array.isArray(report.reviews)) {
    return {
      ok: false,
      message: 'review-artifact-present: no governance-ledger comment found on this PR.',
    };
  }

  // Same (#N) / Closes #N / Fixes #N / Resolves #N convention resolveIssueNumber
  // already owns (scripts/ledger-harvest.js) — reused via a synthetic
  // pr-shaped object rather than a second regex, so the two checkers can
  // never drift on what "(#N)" means.
  const issueNumber = resolveIssueNumber({ title: '', body: headCommitSubject, head: { ref: '' } });
  if (issueNumber === null) {
    return {
      ok: false,
      message: 'review-artifact-present: head commit names no issue (expected e.g. "(#N)").',
    };
  }

  const issuePass = report.reviews.some(
    (r) => r && r.role === 'issue' && r.verdict === 'PASS' && r.issue_number === issueNumber
  );
  if (!issuePass) {
    return {
      ok: false,
      message: `review-artifact-present: no PASS issue-review entry bound to issue #${issueNumber}.`,
    };
  }

  const prPassEntries = report.reviews.filter(
    (r) => r && r.role && r.role !== 'issue' && r.verdict === 'PASS'
  );
  const boundToHeadTree = prPassEntries.filter((r) => r.tree_oid === headTreeOid);

  if (boundToHeadTree.length === 0) {
    const message =
      prPassEntries.length > 0
        ? `review-artifact-present: PR-review evidence is bound to a tree that does not match the PR head tree ${headTreeOid}.`
        : `review-artifact-present: no PASS PR-review entry bound to tree ${headTreeOid}.`;
    return { ok: false, message };
  }

  if (touchesKernelSurface(changedPaths)) {
    const distinctReviewers = new Set(
      boundToHeadTree.filter((r) => r.reviewer_id).map((r) => r.reviewer_id)
    );
    if (distinctReviewers.size < 2) {
      return {
        ok: false,
        message: `review-artifact-present: system-level tree ${headTreeOid} requires two independent PASS reviewer_ids; found ${distinctReviewers.size}.`,
      };
    }
  }

  return { ok: true, message: 'review-artifact-present: review evidence OK.' };
}

// ---------------------------------------------------------------------------
// CLI entry. Real usage talks to the GitHub API and runs only inside the
// workflow; --fixture is the offline seam used by tests and by any future
// dry-run tooling. Keep it a thin shell over checkReviewArtifact above.
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

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--pr') args.pr = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--head-sha') args.headSha = argv[++i];
    else if (a === '--changed-paths') args.changedPaths = argv[++i];
  }
  return args;
}

async function buildLiveInput(args) {
  const token = process.env.GITHUB_TOKEN;
  if (!args.pr || !args.repo || !args.headSha || !token) {
    throw new Error(
      'usage: node scripts/check-review-artifact.js --pr <n> --repo <owner/repo> --head-sha <sha> ' +
        '[--changed-paths <a,b,c>] (or --fixture <path.json>); GITHUB_TOKEN required for the live path.'
    );
  }
  const [commit, comments] = await Promise.all([
    ghApi(`/repos/${args.repo}/commits/${args.headSha}`, token),
    ghApi(`/repos/${args.repo}/issues/${args.pr}/comments?per_page=100`, token),
  ]);
  const changedPaths = args.changedPaths
    ? args.changedPaths.split(',').filter(Boolean)
    : (await ghApi(`/repos/${args.repo}/pulls/${args.pr}/files?per_page=100`, token)).map(
        (f) => f.filename
      );
  const message = (commit.commit && commit.commit.message) || '';
  return {
    comments,
    headTreeOid: commit.commit && commit.commit.tree && commit.commit.tree.sha,
    headCommitSubject: message.split('\n')[0],
    changedPaths,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.fixture
    ? JSON.parse(fs.readFileSync(args.fixture, 'utf8'))
    : await buildLiveInput(args);

  const result = checkReviewArtifact(input);
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}

module.exports = { checkReviewArtifact };

if (require.main === module) {
  main().catch((err) => {
    console.error(`check-review-artifact: ${err.message}`);
    process.exit(1);
  });
}
