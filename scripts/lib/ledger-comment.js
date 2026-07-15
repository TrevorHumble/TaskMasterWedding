// scripts/lib/ledger-comment.js — shared governance-ledger PR-comment
// locator and parser (#48).
//
// Extracted out of scripts/ledger-harvest.js so the pre-merge checker
// (scripts/check-review-artifact.js) and the post-merge harvester
// (scripts/ledger-harvest.js) share exactly one comment-locate/JSON-parse
// implementation. Before this extraction each script would have carried its
// own copy, and a checker that accepted a comment shape the harvester then
// failed to parse (or vice versa) would be a silent split between the gate
// that decides mergeability and the job that writes the permanent record —
// not a hardening. See DESIGN.md "Governance ledger (#219)" and
// "Review-artifact-present check (#48)".
'use strict';

const LEDGER_COMMENT_RE = /governance-ledger[\s\S]*?```json\s*\n([\s\S]*?)```/;

// Find the structured review report in a PR's comments: a comment containing
// the marker token `governance-ledger` and a fenced json block. The LAST such
// comment wins (a re-posted report supersedes earlier ones). Returns the
// parsed object, or null when no comment carries a parseable report — the
// caller records an honestly-visible gap, never a fabricated entry.
function extractLedgerComment(comments) {
  let found = null;
  for (const c of comments || []) {
    const body = c && c.body ? c.body : '';
    const m = LEDGER_COMMENT_RE.exec(body);
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

module.exports = { extractLedgerComment, LEDGER_COMMENT_RE };
