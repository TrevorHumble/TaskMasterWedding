---
name: session-brief
description: >
  Renders a paste-able session brief for one epic #126 track on demand, straight from the live
  board — no stored roadmap file. Use when asked to "start a session", "give me the brief for
  track F1", "/session <track>", or "what's next to build in GOV-A" — invoked as `/session <track>`.
---

# `/session <track>`

Generates a paste-able brief for one epic #126 session group ("track", e.g. `GOV-A`, `F1`) by
reading the live board. There is **no stored copy** of this brief — it is rendered fresh from
GitHub every time, per `DESIGN.md` § "Roadmap: board-derived, session-structured (#139)".

## Procedure

0. **Freshness check:** run `powershell -File tools/check-freshness.ps1` before anything else. It
   is read-only (`git fetch` + an ahead/behind count) and exits non-zero when the local checkout
   is behind `origin/main` — if it reports drift, `git pull` before proceeding. Build sessions
   merge on GitHub from isolated worktrees, so a primary checkout never updates itself; a brief
   (or an owner review) started from a stale checkout is pointed at code that no longer exists
   (#200: the owner once reviewed a checkout 32 commits behind without knowing).
1. **Read the epic:** `gh issue view 126` — find the named track's section, its `Files:` line,
   its relation tag (`depends on <track>` / `parallel-safe with <track>` / `parallel after
#<root>`), and its issue checklist in listed order. This order **is** the build order.
2. **Read each issue on the track:** `gh issue view <n>` for every issue listed under that track,
   in the order the epic lists them. Pull each issue's `Depends on` and `Touches` fields and its
   milestone.
3. **Render the brief** (stdout, paste-able) with these parts:
   - **Build order** — the track's issues, in the order step 1 found them.
   - **Touches** — each issue's `Touches` paths, so shared-file collisions across the track are
     visible before work starts.
   - **Depends on** — each issue's `Depends on` field, so cross-issue ordering inside the track is
     explicit, not assumed.
   - **parallel-safe** — the track's relation tag from the epic. Two tracks are `parallel-safe`
     only when their `Files:` sets are disjoint AND neither depends on the other; state this
     rule plainly so the reader can re-derive it, not just repeat the epic's tag.
   - **Merge policy** — do not restate it. Point to it:
     See: `DESIGN.md` § "Merge policy: owner-merge boundary retired" for the merge policy, and
     `CLAUDE.md` for the pipeline gate order (issue review → implement → PR review → commit/PR).

## Why board-derived, not stored

A committed brief/roadmap file is a second copy of state the board already holds, and it goes
stale or gets wiped (`DESIGN.md` § "Roadmap: board-derived, session-structured (#139)"; a stored
`docs/roadmap.md` was wiped twice by build-session git operations for exactly this reason). This
skill keeps the copy-paste convenience without keeping the file: it reads `gh issue view 126` and
each issue on demand, so there is **no stored copy** to drift from the board. If a rendered brief
and the board ever disagree, the board wins.

## Out of scope

Launching the session directly (running the build agent against the rendered brief) is a separate
concern — this skill only produces the brief text.
