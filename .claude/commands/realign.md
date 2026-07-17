---
description: Between-waves mechanical resync + next-batch overlap check. Usage: /realign <next-batch-issue-numbers>
---

# `/realign` — mechanical alignment between waves

Run at the seam between waves, per the **one-wave-in-flight** constraint (`data/wip-issues/357-fetch-fresh-worktrees-wave-alignment.md`, `agents/orchestrator.md` § "Wave boundary"): the next wave is not launched until the previous one has merged and `/realign` has run. `/realign` never launches issues, writes code, or judges whether the merged app still works — it only answers two mechanical questions and reports.

## How this differs from `/post-wave-review`

`.claude/commands/post-wave-review.md` is a **post-merge judgment** gate: an outside eye asks whether the merged whole still behaves, whether earlier waves' promises still hold, whether the docs still describe the app — owner-invoked, never automatic, never a precondition for the next wave.

`/realign` is the **mechanical alignment** complement, not a duplicate: it does not evaluate behavior, only positions — is the primary checkout's `main` caught up with `origin/main`, and does the next wave's declared `Touches` collide with anything a sibling merged since the last realign. It runs `tools/check-freshness.ps1` (the same overlap engine #357 built for build-session freshness) rather than booting the app or reading transcripts. Collisions _within_ the next batch itself (two issues in the same wave declaring an overlapping `Touches` file) are caught by hand at issue-review time (`agents/reviewer-issue.md`), not by this command.

## Steps

**Ordering is load-bearing: the overlap report (step 2) MUST run before the fast-forward (step 3).** `tools/check-freshness.ps1` derives its drift range from `merge-base(origin/main, HEAD)..origin/main`. In the primary checkout on `main`, `HEAD == main`; while local `main` still trails `origin/main`, that range is exactly the commits merged since the last realign — precisely "what did siblings just merge." Fast-forward `main` first and the range collapses to `origin/main..origin/main` = empty, and the next-batch overlap detector can never fire. So report overlap while `main` still trails, then fast-forward.

1. **Fetch.** Run `git fetch origin`. A non-zero exit means this can't proceed on a trustworthy view of the remote — report the fetch failure and stop. Never fall back to whatever `main` happens to be locally.

2. **Next-batch overlap — run now, BEFORE any fast-forward, while local `main` still trails `origin/main`.** Given the next wave's issue numbers as `$ARGUMENTS`:
   - Run `powershell -File tools/check-freshness.ps1 -Touches "<comma-separated union of every issue's Touches list in the batch>"` to catch collisions between the next batch and anything a sibling merged since the last `/realign` — the same overlap engine `tools/check-freshness.ps1` runs for a single build session, reused here against the whole next batch's declared surface. This depends on local `main` NOT yet being fast-forwarded: its drift range is `merge-base(origin/main, main)..origin/main`, which equals the just-merged commits only while `main` still trails. An `OVERLAP: <file>` line (exit 1) is a real next-batch collision — surface it and treat the next batch as needing a resync check per that file. A bare "N commits behind origin/main" with **no** `OVERLAP` line is expected here (those N are exactly the commits step 3 is about to fast-forward past) and is not itself a collision.
   - This tool is read-only (see its own header) and names the file and the responsible issue numbers/commits on any real collision.

3. **Safe fast-forward of local `main` — never mutate a dirty or diverged tree.** Only after step 2 has read the pre-fast-forward drift range:
   - Check the tree is clean: `git status --porcelain`. If it prints anything, report the dirty paths and **stop** — never run `merge`, `reset`, or `checkout` over uncommitted work.
   - Check `main` has not diverged: `git rev-list --left-right --count origin/main...main` prints `"<behind> <ahead>"` (left = commits only on `origin/main`, right = commits only on local `main`). If `ahead` is greater than 0, local `main` carries commits `origin/main` doesn't have — report that and **stop**; this is not a case `/realign` resolves automatically.
   - If `behind` is 0, report "already aligned" with no mutation.
   - If `behind` is greater than 0 and `ahead` is 0 (a clean, pure-behind ref — the only case this command will touch): `git switch main`, then `git merge --ff-only origin/main`. `--ff-only` is the fail-closed backstop — it refuses non-zero rather than silently falling back to a real merge commit if the fast-forward is somehow not trivial, which the `ahead == 0` check above should have already ruled out.

4. **Report.** One message: clear / collision (with file + issue numbers) for the next batch, per step 2; then aligned / not-aligned (with the reason if not, per step 3). No source-code changes are made by this command beyond the step-3 fast-forward of local `main`, and step 3 never runs against a dirty or diverged tree.
