# Issue-review backfill — pre-#359 merges (2026-07-09 audit)

## Why this file exists

`tools/persist-issue-review.ps1` wrote issue-review evidence only to
`.review_state/issue-reviews/<N>/`, which is gitignored and per-worktree. When a
wave worktree was deleted after its PR merged, that evidence went with it. Issue
#359 makes the PASS durable going forward through a `role:"issue"` entry in the
CI-written `governance/ledger.ndjson` (see `DESIGN.md` § "Governance ledger
(#219)"). That mechanism did not exist before this issue, so it cannot retroactively
cover PRs that merged earlier.

## The 19 issues

An audit on 2026-07-09 found 19 issues merged since 2026-07-05 whose `BUILDLOG.md`
entries assert an issue-review PASS, but for which no evidence record survives in
any surviving checkout:

#248, #251, #254, #257, #258, #282, #289, #290, #291, #294, #302, #304, #306, #307,
#310, #313, #318, #321, #322

For every one of these 19 issues, the asserted issue-review PASS **cannot be
corroborated** from any surviving evidence. This file does not assert a PASS for
any of them, and it does not assert a FAIL either — it records that the claim is
unverifiable, not that it is false. The `BUILDLOG.md` entry for each remains as
originally written; this file is the honest counterpart noting that the
underlying evidence no longer exists to check it against.

## What changes going forward

Every issue-review PASS recorded after #359 lands is carried into the merging
PR's pre-merge `governance-ledger` comment as a `role:"issue"` entry, which CI
harvests verbatim into a committed `gl1` row. That row survives worktree cleanup,
so the same "cannot be corroborated" gap should not recur for issues closed after
this mechanism shipped.
