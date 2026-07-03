# What a green build actually proves

Plain-English guide for the owner. This explains what a passing build checks for this app — and the one thing it cannot check, where you remain the eye after the fact.

---

## What the green checkmark proves

When all checks pass, these things have been confirmed automatically, without anyone reading the code:

**Every change went through a hostile review before it landed.**
Before any code is committed, independent AI reviewers — whose job is to find what's wrong, not to approve — go over the change against what it was supposed to do. A gate (the "commit gate") then blocks any commit that does not have a recorded passing review tied to exactly that version of the code. Unreviewed code cannot slip in.

**The code is checked for cleanliness on every push.**
Two tools run in GitHub's CI system (not before the local commit): `eslint` scans each change for sloppy or risky code patterns, and `prettier` checks that formatting is consistent. These run automatically on every push and every pull request.

**The working pieces are tested against known correct answers.**
The test suite (powered by `vitest`) runs on every build. It checks that the app's logic — sign-in, scoring, badges, photo handling, the admin panel — produces the right results, not just that the code ran without crashing.

**GitHub's own security tools are watching continuously.**
Two GitHub-native checks are configured for this repo:

- **CodeQL** scans the code for known security weaknesses, the kind that make apps exploitable. It runs on pushes to the main branch, on pull requests targeting main, and once a week on a fixed schedule — not on every feature-branch push.
- **Dependabot** watches the outside code the app depends on and opens update pull requests automatically — on a weekly schedule (configured in `.github/dependabot.yml`). It is not a per-build check; it runs on its own timer.

These run automatically. You do not have to ask for them.

---

## The one honest limit

The commit gate proves a passing review was recorded for the exact code being committed — but it cannot yet prove that the review process itself could not be shortcut. The protection rests on the reviewer panel (independent, adversarial Opus reviewers) plus the gate, not on the gate alone. Strengthening that mechanical guarantee is tracked as an open issue in the backlog.

---

## What the checks cannot answer — where you are the eye after the fact

A machine can confirm the math is right. It cannot confirm the result **looks** right or that it is what you **meant**.

Every build that changes something a guest or admin sees produces a result you can look at — a rendered page, a flow through the app. The checks above guarantee the logic is correct. The question they cannot answer is: _is this what I wanted?_ That judgment is yours, as the owner.

Every change type — bug fixes, security fixes, under-the-hood correctness work, and visual or product-direction changes alike — merges automatically once the adversarial review passes and the build is green. Visual and product-direction changes are not held open for your approval first; you review the live result after the fact and can request changes or revert if it isn't what you wanted. Your control is upstream (which work gets specced, via issues) and downstream (revert, via git history), not a pre-merge checkpoint.

**Green means the work is correct and built to standard. Whether it is the right work is still your eye — just after it has already shipped.**
