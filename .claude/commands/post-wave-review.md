---
description: Post-wave consultant review gate — end-to-end judgment of the merged wave. Usage: /post-wave-review <wave number>
---

Wave $ARGUMENTS just merged — see the matching Batch milestone on the repo
for its issue list.

We'd value your judgment on the state of this app. Wave $ARGUMENTS of
the build just merged to main, and before we commit to the next one we'd like
an experienced outside eye on the merged whole with end to end testing. You
have the full run of the repo (C:\wedding-scavenger-hunt — CLAUDE.md will
orient you to how this project works). Where you see a thread worth pulling
that we haven't named, pull it — and if you conclude our plans themselves need
adjusting, say so; that kind of input is exactly why we're asking you.

Feel free to ask if you need more tools, chrome is open

THE SITUATION
This is a wedding scavenger-hunt app going live for real guests on Friday,
Aug 7, 2026. We're building in concurrent waves, each wave a batch of issues
implemented in parallel and merged. Individual PRs were each reviewed on their
own — what nobody has yet judged is the whole: how this wave's changes behave
together, and whether they disturbed anything the earlier waves built.

WHAT WE'RE HOPING TO LEARN — at heart, in each area:

- Yesterday's promises. Features from earlier waves worked when they shipped.
  We're hoping they still do — the failure we fear most is the quiet one
  nobody's watching for anymore.
- The seams. Each feature passed review alone. We're hoping they also work
  together — privacy settings and the export, moderation and the feed, new
  sign-in and old sessions, wherever two features share ground.
- The data's future. Real guests' data will live through many deploys. We're
  hoping a database that's been played in — not a fresh seed — comes through
  a migration whole, and that a backup, once actually restored, contains a
  usable app.
- The record. We're hoping the docs, the test plan, the board, and the build
  log still describe the app that exists tonight — not the one from two waves
  ago. Where the record has drifted, we'd like to know.
- Under load. We have baseline numbers in docs/loadtest.md. We're hoping this
  wave didn't bend the curve.
- The process itself. You'll see what our reviews caught and what they didn't.
  We'd genuinely value your read on where our review process was blind this
  wave — that observation compounds more than any single bug.
- and advise us: are we still meeting our goals?

HOUSE RULES (the few things we do need held firm)

- Tag the tree wave-$ARGUMENTS before you begin — our rollback point and your
  diff anchor.
- This session doesn't change source code. What you find becomes GitHub issues
  per standards/issue-standards.md, milestoned into our batch schedule — that
  includes documentation rot.
- Where you assert something, we'd like to see the run that showed it to you.

THE REPORT
When you're done, one message: your verdict (SHIP / SHIP WITH ISSUES / BLOCKED)
and the reasoning, the few things Trevor genuinely must know in plain
language, links to the issues you filed, your evidence. If your explorations
changed your view of our roadmap, close with that — we mean it about the
consulting.
