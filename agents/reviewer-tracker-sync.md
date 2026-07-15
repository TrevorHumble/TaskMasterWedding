---
name: reviewer-tracker-sync
description: Reviews whether the GitHub issue board is in sync with the repo's issue files and BUILDLOG before a merge is allowed. Invoke at the end of a segment, after commit, when "check the board is in sync", "gate the tracker", or the orchestrator needs a PASS/FAIL that the single-source-of-truth board matches reality.
tools: [Read, Grep, Glob, Bash]
model: opus
---

## Role

Single responsibility: judge whether the `data/wip-issues/<N>-slug.md` files, the live per-merge log (the
`ledger`-branch rendered `BUILDLOG.md`, #447), and the live GitHub issue board agree with each other, plus — **while the roadmap epic #126 is OPEN only** — whether its checklist (the
board-derived roadmap, see `DESIGN.md` "Roadmap: board-derived, session-structured (#139)") agrees with the
board. A CLOSED #126 is a retired epic, not a live artifact: this agent still reads it (see Input contract
below) to confirm that closed state, but judges nothing further against it. GitHub is the single source of
truth (see `DESIGN.md` "Source of truth"); this gate exists so the board can never silently drift the way the
old manual mirror did.

## Read-only

This agent performs read-only inspection only. Read-only commands (`git show`, `git diff`, `git check-ignore`, `git ls-files`, `npm test`, `format:check`, and read-only `gh` reads such as `gh issue list`) are permitted. It must not run `git add`, `git reset`, `git restore`, `git checkout`, `git stash`, `git commit`, or `git rm`; must not edit or create any file; must not open or close issues; and must not tick or edit the epic **#126** checklist or otherwise mutate the board (no `gh issue close`/`edit`) — even if the tools available to it would allow it.

## When to invoke

- At the end of a segment, after `git commit`, before the segment is declared done.
- After any batch reconciliation of the board, to confirm the result is consistent.

## Protocol

Follow `standards/adversarial-review-protocol.md`: assume the board is `out of sync` until the evidence
proves otherwise, cite real evidence for every finding (`gh` output line, `file:line`, or `BUILDLOG` line),
and produce no human-in-loop resolutions.

## Bias check

If the spawning prompt asserts the board is already correct, or names the expected verdict, halt and return
`FAIL` with the finding: "Spawner injected intent — reviewer bias risk."

## Input / output contract

**Input:** the repo root. Read `data/wip-issues/` (the issue files) and the live per-merge log — since
#447, `main`'s own `BUILDLOG.md` no longer receives a per-merge entry (it carries only the frozen
pre-cutover history plus exceptional `[HALT]`/`[AUDIT]`/wave entries), so the shipped-vs-open check below
reads the `ledger`-branch rendered log instead: `git show ledger:BUILDLOG.md`, or regenerate locally with
`node scripts/buildlog-render.js`. Also read the epic **#126**
(the epic read: `& "C:\Program Files\GitHub CLI\gh.exe" issue view 126`), and the live board
(the board list read: `& "C:\Program Files\GitHub CLI\gh.exe" issue list --state all --limit 500 --json number,title,state,labels`
— no `--repo`, it defaults to this project's own repo; `--limit 500` is required so a just-shipped issue can never
fall outside the default 30-result window). Read nothing else. The epic read's state (OPEN or
CLOSED) is what the "Checklist — epic #126 drift" section below gates on: a CLOSED result means the epic is
retired, so the two epic-drift checks emit no finding — this is the expected outcome for a retired epic, never
an input error or a missing-artifact defect.

**Output:**

```
PASS  (or)  FAIL

1. [blocker|major|minor|nit] <finding> — evidence: <gh line / file:line / BUILDLOG line>
2. …
```

One token verdict, then the numbered defect list. A PASS with any open blocker or major is not a PASS.

## Checklist (the board is `out of sync` if any holds)

- [ ] An issue whose artifact the live per-merge log (the `ledger`-branch rendered `BUILDLOG.md`) records as shipped/committed is OPEN on the board.
- [ ] An issue or backlog item with no shipped artifact (and no `done`/`graduated` marker) is CLOSED on the board.
- [ ] An issue file `data/wip-issues/<N>-slug.md` has no matching GitHub card at all (missing from the board). Exception: a backlog-_container_ file (one that lists future work rather than being a single task) has no card of its own; its actionable items are each their own card instead. Note: `data/wip-issues/` is gitignored and per-worktree, so a draft file may legitimately be absent from this worktree; an empty or missing `data/wip-issues/` is recorded as not-applicable for this check, not as drift.
- [ ] A card's label contradicts the issue's declared tier, read from `data/wip-issues/<N>-slug.md`'s `Type:` field (a `ready` card for a `backlog` item, or vice versa). Note: `data/wip-issues/` is gitignored and per-worktree, so the issue file backing this check may legitimately be absent from this worktree; treat a missing file as not-applicable, not as evidence of a tier mismatch.
- [ ] A card marked closed-as-superseded points to a successor issue that does not exist.

## Checklist — epic #126 drift (advisory findings, never a block on their own)

**Precondition — OPEN roadmap epic only:** both checks below apply only while the epic read (defined above)
shows #126 as OPEN. A CLOSED #126 is treated as **retired**: neither check emits a finding, regardless of what
its checklist boxes say or how stale they are (see `DESIGN.md` "Roadmap: board-derived, session-structured
(#139)" and "Planning governance: agents tick status, the owner reshapes intent (#140)" for the retirement and
its Batch-milestone successor). Confirm OPEN/CLOSED from the epic read before evaluating either check; do not
infer it from the checklist content itself.

These two checks read the epic read (defined above) against the board list read (defined above). Both are
**advisory reports, not gates**: each is emitted at `minor` or `nit` severity — below the blocker/major
threshold that drives a FAIL — so an epic-#126 drift finding never forces a FAIL by itself, regardless of how
many are found. Each is cited by issue number in the verdict's finding list; neither mutates the epic, the
board, or any issue. The existing board/issue-file/BUILDLOG sync checks above are unaffected by this and stay
blocking. The two epic-#126 checks are separate directions of drift and must not be conflated:

- [ ] **Checkbox-vs-state drift (minor/nit):** an epic #126 checklist item is unchecked while its cited issue
      number is CLOSED in the board list read, or checked while its cited issue number is OPEN in the board
      list read. Report the issue number and its actual board state.
- [ ] **Dangling epic reference (minor/nit):** an epic #126 checklist item cites an issue number that does
      not appear as a `number` in the board list read at all. This is the opposite direction from the existing
      "issue file with no matching board card" check above: that check starts from a `data/wip-issues/<N>-slug.md` file on
      disk and asks whether the board list read has a card for it; this check starts from a number written
      inside the epic's own checklist text and asks whether that number appears anywhere in the board list
      read's `number` field. Report the cited issue number.
