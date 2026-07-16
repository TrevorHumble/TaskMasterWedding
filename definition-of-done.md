# Definition of Done

A checklist for judging whether a change is actually finished — not just merged. The PR reviewer applies this alongside the issue's acceptance criteria (`agents/reviewer-pr.md`); an unmet clause is a defect, not a nice-to-have. Ten clauses, each a short rule with a concrete example. Read it in under two minutes.

**Why this exists.** Custom badges shipped with a create path and no delete or edit path (#410; the gap is now #533). Nobody decided "no delete" — it just wasn't in the acceptance criteria, so it fell off. This list exists so that gap gets caught before merge, not discovered by a host at the party.

---

## 1. Failure state

Every feature defines what happens when something goes wrong — not only the happy path. A bad input, a dropped network request, an empty result: each has a defined, visible behavior, not a blank screen or a silent crash.

Example: a photo-upload feature that only specifies "guest submits a photo, it appears in the gallery" is half a spec. It also needs to say what the guest sees when the file is rejected (wrong type, too large, upload interrupted).

## 2. Host takedown path (the whole-feature test)

If a change lets a host or guest create a thing — a badge, a photo, a note, a task — the same change gives them a way to undo, edit, or remove it. Ask, for anything the change can create: once this ships, is anyone **trapped, or merely wanting**? "Trapped" means no path out at all — a bad badge stays forever. "Wanting" means a real but lower-priority improvement, like wanting to reorder favorites — that can wait for its own issue. A change owns every state it can create: if it can create a thing, it must also cover that thing being wrong, failing, or needing to go away.

Example: custom badges (#410) shipped an upload path with no delete path. The host who uploaded a bad badge was trapped, not merely wanting — that is the gap this clause exists to catch, now tracked as #533.

Mechanically enforced at: the PR reviewer's create/delete/hide/restore/resubmit checklist item (`agents/reviewer-pr.md`, evidence #190/#191/#196) — this clause is that item's whole-feature framing, checked once there.

## 3. Party-sized data

A feature is tested and reasoned about at party scale — roughly a hundred phones over one night, hundreds of photos, a gallery that keeps growing — not against a handful of rows in a dev database. A route that returns every row, with no pagination or size bound, can look fine with three test photos and fall over with three hundred.

Example: a gallery or feed endpoint written and tested against five seeded photos may hide an unbounded query that only shows up once real guests start uploading.

Mechanically enforced at: the PR reviewer's unbounded-route checklist item (`agents/reviewer-pr.md`, evidence #194) — this clause is that item's whole-feature framing, checked once there.

## 4. Guest undo

Any guest-facing action a guest could plausibly get wrong — submitting the wrong photo for a task, mistagging an entry — has an edit or undo path before the party, not a promise to add one later. Guests are not expected to get a support ticket filed and resolved mid-celebration.

Example: if a guest can submit a photo to the wrong scavenger-hunt task, they need a way to fix that themselves (resubmit, retag) rather than being stuck with a wrong entry until a host notices.

## 5. Notes match the app

Whatever the PR description, issue notes, or in-app copy claims the feature does, the running app actually does. A reviewer or owner who reads the notes and then opens the app should see the same behavior described — not a stale description of an earlier draft, or an aspirational one for behavior that never got built.

Example: if the PR says "hosts can hide a submission from the gallery," the admin screen in that same diff actually has a working hide control — not a placeholder button or a claim about a future PR.

## 6. Clean test run

The test suite is run on a fresh tree — one that is not behind `origin/main` — using `npm ci` (not a stale local `node_modules`), with the CI run itself treated as authoritative over any local pass. A local environment that predates the change, or that drifted from the lockfile, can go green while CI would go red. Every failing test is diagnosed to a specific, named cause before it is dismissed or deferred: an undiagnosed red test is not a license to file a follow-up issue and move on.

Example: a test fails locally, the author reruns it once, it passes, and they ship without knowing why it flaked — that is not a clean run. The cause (a timing race, a shared fixture, a real bug) has to be named.

## 7. Recorded omissions

Anything deliberately left out of a change — deferred behavior, an edge case ruled out of scope, a known limitation — is written down in the issue or PR, not silently dropped. A reader should be able to tell the difference between "we didn't think of this" and "we decided not to do this, on purpose, for this reason."

Example: this issue's own "Deliberately not in scope" note (#538: no mechanical DoD checker, no CI job) is the pattern — the omission is named, not discovered later as a surprise gap.

## 8. Regressions you caused

If a change breaks something that worked before the change, fixing that break is part of finishing the change — not a new issue filed for someone else to pick up later. A regression you introduced is your defect, on your branch, before merge.

Example: a change to the export path that causes an existing gallery view to 500 is not "done" with a note saying "gallery bug filed as #999" — it's not done until the gallery works again.

## 9. Visual changes need owner approval

Any change that alters what a guest or host actually sees — layout, styling, new screens — goes through the owner's live-preview approval loop before it merges, per `agents/orchestrator.md` § "Visual-approval loop" and `DESIGN.md` § "Visual-approval loop reinstated". This clause does not restate that loop's mechanics; it exists so a visual change cannot be called done while skipping it.

Example: a redesigned leaderboard screen is not done at "the code renders it correctly" — it's done once the owner has seen it at phone size and said yes.

## 10. Done means live

An issue whose last step is a manual action by the owner or on GitHub itself — flipping a repo setting, turning on a required check, enabling a feature flag — is **not done when the code merges**. It is done when that manual step has actually been taken and the described behavior is true in production, not just possible in production.

Example: #48 and #431 both closed as done while their final manual step was never carried out — `review-artifact-present` still is not a required check, and `strict` is still `true` on live `main` despite #431 closing as "kill the update-loop." Both looked green on the board and were false in reality. This clause exists so that stops counting as done.

At PR-review time, before the manual step can possibly have run, this clause is satisfied by confirming the step is recorded and the issue cannot auto-close as done ahead of it — full liveness is confirmed at issue-closure, not against the diff (see `agents/reviewer-pr.md` § "Apply the Definition of Done").
