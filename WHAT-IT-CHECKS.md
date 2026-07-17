# What a green build actually proves

Plain-English guide for the owner. This explains what a passing build checks for this app — and what
it cannot check, where you remain the eye after the fact.

---

## What the green checkmark proves

When all checks pass, these things have been confirmed automatically, without anyone reading the code:

**The code is checked for cleanliness on every push.**
Two tools run in GitHub's CI system: `eslint` scans each change for sloppy or risky code patterns, and
`prettier` checks that formatting is consistent. These run automatically on every push and every pull
request.

**The working pieces are tested against known correct answers.**
The test suite (powered by `vitest`, with a coverage threshold) runs on every build. It checks that the
app's logic — sign-in, scoring, badges, photo handling, the admin panel — produces the right results, not
just that the code ran without crashing. The smoke job boots the real app against a scratch database and
walks a guest through the app for real.

**GitHub's own security tools are watching continuously.**
Two GitHub-native checks are configured for this repo:

- **CodeQL** scans the code for known security weaknesses, the kind that make apps exploitable. It runs on pushes to the main branch, on pull requests targeting main, and once a week on a fixed schedule — not on every feature-branch push.
- **Dependabot** watches the outside code the app depends on and opens update pull requests automatically — on a weekly schedule (configured in `.github/dependabot.yml`). It is not a per-build check; it runs on its own timer.

These run automatically. You do not have to ask for them.

**A code commit must name a GitHub issue.**
A cheap local check (`.githooks/commit-msg`) blocks a commit that changes a non-`.md` file and names no
GitHub issue — `(#N)` in the message, a GitHub closing keyword (`Closes #N`, `Fixes #N`, `Resolves #N`),
or a branch named `feat/issue-N`. This proves the change is tied to a tracked piece of work. It does not
prove that work was reviewed — see the honest limit below.

---

## What review actually is, honestly

Every PR is intended to go through independent, adversarial review before merge — one PR reviewer plus a
design-philosophy reviewer for code, on a different AI model than the one that wrote the change, per
`standards/adversarial-review-protocol.md`. That review practice is real and is how this project actually
works day to day. But **there is no mechanical gate that blocks a commit or a merge for lacking a review**.
No file records that a review happened; no check confirms one before code lands. The commit-msg check
above only confirms an issue is named, not that its review passed.

This is a deliberate trade for the weeks before the wedding (2026-07-17 through 2026-08-08): the previous
version of this repo did try to mechanically enforce review evidence — a "commit gate" that blocked a
commit without a recorded passing review tied to the exact code — and that machinery itself became the
dominant source of defects and review overhead, at the cost of guest-facing work. It was retired; see
`DESIGN.md`'s teardown ADR and `CLAUDE.md` § "Governance freeze" for what changed and why. Review practice
continues; only the machinery that tried to prove it happened is gone.

---

## What the checks cannot answer — where you are the eye after the fact

A machine can confirm the math is right. It cannot confirm the result **looks** right or that it is what
you **meant**.

Every build that changes something a guest or admin sees produces a result you can look at — a rendered
page, a flow through the app. The checks above guarantee the logic is correct. The question they cannot
answer is: _is this what I wanted?_ That judgment is yours, as the owner.

Bug fixes, security fixes, and under-the-hood correctness work merge automatically once the adversarial
review passes and the build is green. Your control there is upstream (which work gets specced, via
issues) and downstream (revert, via git history), not a pre-merge checkpoint — you review the live result
after the fact and can request changes or revert if it isn't what you wanted.

**Visual and product-direction changes are different: you settle the look live, before it is even written
down.** `npm run preview` boots a real, seeded copy of the app and hands you a localhost link. You keep
that open while the build edits the real front end directly against it — you refresh, say "arrows are
clutter," refresh again, and repeat until you say approved. Only then does the pipeline freeze what you
approved, write it down as the acceptance criteria, and run the normal issue-review / implementation /
adversarial-review / merge pipeline on it. Nothing is left open waiting on you to click merge yourself,
and nothing you approve gets quietly redecorated later without asking you first — the freeze plus the
"two doors" rule (`agents/orchestrator.md` § "Visual-approval loop") see to that.

**Green means the code builds, lints, and passes its tests. For visual changes, whether it looks and
feels right is also checked before it ships, not just after.**
