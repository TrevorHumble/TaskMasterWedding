# Adversarial Review Protocol

**Scope:** all artifacts in this repo — issues, PRs, skills, agents, and docs.
**Who runs this:** the orchestrator spawns reviewers. The product owner is not in the loop.

**Governance freeze (2026-07-17 – 2026-08-08).** The governing-artifact surface this
protocol lives on is frozen; a defect found on it is filed with the `post-wedding` label
and not built unless it blocks a guest-facing path or CI. Full rule: `CLAUDE.md` §
"Governance freeze". This protocol itself reflects the lean practice that replaced the
retired proof layer (evidence artifacts, verdict capture, the severity adjudicator,
reviewer panels, the system-level two-reviewer bar) — see `DESIGN.md`'s teardown ADR for
what was removed and why.

---

## Stance

**assume total failure.** Every artifact enters review as broken. Every individual
piece is broken until proven otherwise. Owe the work nothing.

- Trust nothing the artifact claims about itself. Every "this is enforced / done /
  passing" is false until verified against ground truth.
- When you catch yourself inferring "this probably works," stop and verify.
- Be hostile, skeptical, a "little asshole." Spend energy on what's wrong.

---

## De-bias the setup

The spawner's instructions can bias the reviewer as badly as a soft prompt.

**Give the goal, not the implementation.** State the objective the artifact is judged
against. Do not name the mechanisms ("it uses X loop, a Y gate") — that pre-confirms
their existence and steers review only toward them.

**No positive hints.** Never say "the one thing we got right is…." The reviewer
enters assuming everything is bad and discovers what survives.

**Plant no suspicions.** "Suspect X is broken" biases toward confirming the guess and
away from problems you didn't anticipate. Say "assume failure, look hard."

**Give full scope.** Omission hides weak spots. List every artifact. "Anything not
listed is itself a finding."

This is a spawning discipline the orchestrator follows on every briefing — there is no
separate mechanized audit step or recorded evidence artifact for it. A reviewer who
notices a biased briefing says so in its findings like any other defect.

---

## Calibration — adversarial is not fabrication

Maximum suspicion without a truth-guard produces confident garbage.

- Every finding cites real evidence (`file:line`, command output, issue/PR number).
- Every best-practice claim cites a real, current source (full `https://` URL + date).
- If something survives genuine attack, record "survived — here's the proof." Enter
  assuming it won't.
- **Retract your own over-flags.** A false positive left standing is itself a failure.
  Unsupported praise and unsupported criticism are equally worthless.

**Finding-quality bar.** Every blocker or major finding states a **concrete failure scenario**: a specific input or state, and the specific wrong outcome it produces. A blocker/major that names no failure scenario is downgraded to minor/nit until its author supplies one. **Precedence carve-out:** a finding that matches a named red flag in `standards/design-philosophy.md` (cited with the pattern name and quoted evidence, per that standard) is never downgraded below major — the pattern match is its failure scenario; that standard's never-downgrade rule governs. Symmetrically, a PASS is not a bare token: it cites evidence per checklist item (the check performed and what it showed).

Worked example (a real finding): "The example plan step cites `src/routes/photos.js`, which does not exist — an issue author copying the pattern sends the implementer to a phantom file; the real `fileFilter` lives in `src/services/photos.js`." Scenario stated: who acts on it, and what goes wrong.

Counter-example (unfalsifiable, does not survive the bar): "This section could be confusing to some readers." No input, no actor, no wrong outcome — downgrade until evidenced.

Assume-bad stance + no-fabrication guard together → true positives.

**Citations must be in range.** Before citing any `file:line`, open the file and confirm
the line number is within its actual line count. Do not emit a `file:line` you have not
verified is in range — an out-of-range or unverified citation is itself a defect, not a
minor slip. This is the reviewer's own pre-emission self-check; the orchestrator's "The
spawner must never" #5 below is the reader-side check on receipt. Neither half
substitutes for the other. Both halves are judgment calls made by the people running the
review, not a mechanized gate — there is no tooling that rejects an out-of-range citation
before a verdict is recorded.

---

## Independence

Fresh context, different identity/mandate than whoever produced the work. The agent
that produced an artifact must not also write its own passing verdict.

For high-stakes or security-flagged changes the orchestrator may spawn more than one
independent reviewer at its discretion, but the standing rule for every artifact class is
**one reviewer** (plus the design-philosophy reviewer for code — see `## Reviewer count
by artifact`). There is no standing panel requirement and no fixed reviewer count that
scales with risk tier; judgment about whether a change warrants a second opinion belongs
to the orchestrator, exercised sparingly, not to a mechanical rule.

---

## Reviewer count by artifact

- **Issue / plan** → exactly **1** Opus reviewer (`reviewer-issue`).
- **Code, round 1** → exactly **1** PR reviewer plus the design-philosophy reviewer
  (`agents/reviewer-design-philosophy.md`) — **both must PASS**. The design-philosophy
  gate is required for every implementation artifact (code, an agent spec, a skill, or a
  standard) regardless of change size — doc-only and typo-only changes are not
  implementation artifacts and skip only this gate, per `agents/orchestrator.md`.
- **Code, rounds 2+** → see `## One-round stop rule` below: a re-check fires only for a
  blocker/major finding, and is scoped to the fix, with **1 fresh reviewer**.
- **Security lens** (`agents/reviewer-security.md`) → a single advisory lens, dispatched
  per `## Which reviews does this change need?` below. A major/blocker finding from it
  takes the standard one-round stop rule like any other finding — there is no separate
  reviewer-count escalation.
- **Architecture lens** (`agents/reviewer-architecture.md`) → an on-request design lens,
  not a gate. It fires when the orchestrator or the owner asks for an architecture
  opinion on a new component or a significant structural change; it never fires
  automatically and never blocks a merge on its own.

Reviewers run on **Opus**, a different and non-weaker model than the implementer
(`standards/agent-standards.md`), on every issue — there is no run-tier classifier that
downgrades this.

---

## One-round stop rule

Round 1 of code review runs the PR reviewer and the design-philosophy reviewer together
(`## Reviewer count by artifact`). What happens next depends on what they found:

- **Minor and nit findings are fixed inline by the implementer and shipped with no
  re-review.** They do not block the merge and do not need a second look once addressed.
- **A blocker or major finding triggers exactly one re-check**, scoped to that fix: the
  implementer fixes it, and one fresh reviewer confirms the fix — not a full re-review of
  the whole artifact again.
- There is no severity adjudicator, no contest/concede fork, no round-count soft cap, and
  no reviewer panel. A PASS with an open blocker or major finding is never a PASS.

This replaces the multi-round soft-cap-and-severity-gate process that used to run when
review dragged past three rounds — that machinery is retired along with the rest of the
proof layer (see `DESIGN.md`'s teardown ADR).

---

## Review batching

Related changes sharing one stated intent MAY ship as one reviewed batch: one issue-review
pass and one PR review covering the entire batch. The PR description lists every change in
the batch, and the reviewer's verdict covers the whole batch — a PASS on a batch is a PASS
on each change in it, and a FAIL on any change is a FAIL on the batch.

---

## Advisory-lens lifecycle

A new reviewer lens (e.g. design-language, security) enters the pipeline as **ADVISORY**: it
runs on every change its dispatch row matches, its findings are recorded in the review, and
it **cannot block a merge** on its own — a finding from it is fixed, dropped, or deferred
exactly like any other finding under `## Finding disposition` below. Promotion to gating —
or removal — is an owner decision made on the recorded evidence after a trial of roughly 10
PRs.

---

## Which reviews does this change need?

Path-based, and additive to the base review for the change's artifact class — a lens never
replaces the PR reviewer or the design-philosophy gate.

| Change touches                                                                                                                                                                                       | Reviews that run                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| The frozen governing-artifact surface (see `CLAUDE.md` § "Governance freeze")                                                                                                                        | Not built during the freeze without recorded owner approval — see there |
| Docs/copy only (`.md` files that are NOT implementation artifacts — an agent spec, including `agents/reviewer-*.md` charters, a skill, or a standard never qualifies — and EJS text-only copy edits) | CI + the existing doc-only exemptions; no specialist lens               |
| Views/CSS/badge assets/guest-or-admin-facing copy                                                                                                                                                    | Design-language lens (advisory)                                         |
| Upload/intake, auth, file-serving, admin routes                                                                                                                                                      | Security lens (advisory; `agents/reviewer-security.md`)                 |
| `src/services/` scoring/feed logic                                                                                                                                                                   | The duplicated-ownership self-check gets explicit reviewer attention    |

**Note:** "Docs/copy only" above is a review-dispatch question — which lenses run — not the
acceptance-criteria question of whether an issue may use purely structural criteria. That is
a separate exemption, defined once in `standards/issue-standards.md` § "Acceptance criteria".

---

## research-first

Before judging, the reviewer establishes the _current_ best-practice yardstick for
the area (with dated citations). Grading against stale priors is a calibration
failure.

---

## No human in the loop

The product owner does not resolve findings. Translate any "owner reviews/approves"
control into a deterministic check or an independent adversary. Reserve human judgment
for what the human can actually judge (product direction, taste).

**Findings-resolution vs. the visual-approval loop.** This rule governs findings-resolution
only: the owner never adjudicates a blocker/major/minor/nit an adversarial reviewer raised,
and that stays true with no exception. It does not forbid the separately-decided
**visual-approval loop** (`agents/orchestrator.md` § "Visual-approval loop") — a
product-taste loop, live and pre-implementation, that runs on visual changes only: the
owner settles the look himself against a seeded `npm run preview` link, refreshing a real
running instance of this worktree's own front end as the orchestrator edits it, until he
says approved — and only then are that surface's acceptance criteria written and the
normal pipeline (issue review, implementation, PR review) runs. The loop carries no review
finding to the owner and resolves no defect; it is exactly the "product direction, taste"
carve-out this section already reserves for human judgment, made into an explicit step.

---

## Output discipline

- Review item-by-item. Do not ingest everything and emit one blob.
- Number each defect. Assign a severity (blocker / major / minor / nit).
- For each gap give a concrete, copy-pasteable fix.
- Final verdict: **PASS/FAIL** — one token, no hedging. Attach the numbered defect
  list. A PASS with open blockers or majors is not a PASS.

---

## The spawner must never

1. Tell the reviewer which specific parts are suspected weak — that leads the witness.
2. Include positive framing, praise, or "we tried hard on X" in the briefing.
3. Give the reviewer a curated subset of artifacts — full scope or it's not a review.
4. Allow the producing agent to review its own output, even as a secondary reviewer.
5. Accept a PASS verdict without the orchestrator first completing a required
   verification step: confirm every cited URL resolves, every `file:line` reference
   exists at that location, and every item in scope has an explicit finding. This
   check is the orchestrator's responsibility and is not delegated to the reviewer.
   This post-hoc check is the second half of the citation guarantee; the reviewer's
   own pre-emission self-check (see "Citations must be in range" under Calibration
   above) is the first half — the two do not replace one another.

---

## Reviewers are read-only

Reviewers perform read-only inspection only. Read-only commands (`git show`, `git diff`, `git check-ignore`, `git ls-files`, `npm test`, `format:check`) are permitted. A reviewer must not run `git add`, `git reset`, `git restore`, `git checkout`, `git stash`, `git commit`, or `git rm`, and must not edit any file — even if the tools available to it would allow it.

**Rationale.** On 2026-07-02 a PR reviewer ran `git restore`, unstaged a fix, and then failed the tree it had just altered — a reviewer that mutates git or files can invalidate the very work it is judging without anyone noticing. `agents/reviewer-*.md` declare `tools: [Read]` (or a narrow read-only set), but a reviewer instantiated with a broader tool set must still be bound by this rule in prose, not by tool-list omission alone.

---

## Wave governance — grandfathering, owner-invoked wave review, doc-currency step

Three governance mechanisms recorded 2026-07-08 by owner decision, during the Wave-1 post-wave review session. Architecture-rationale entry: `DESIGN.md` § "Wave governance".

**Grandfathering — a mid-wave governance change does not reach back.** A governance or process change (an edit to this protocol, an agent charter, or a standard) that merges mid-wave governs from the **next issue picked up onward**. An open sibling PR already in flight — its implementation began before the governance change merged — merges under the bar that was in force when its implementation began; it is not required to re-satisfy a bar that landed after it started, and a reviewer must not flag it as a defect for that reason alone. This is a deliberate **grandfather** clause.

One exception: a **`severity:blocker`** security gate change applies to every open sibling PR immediately, with no grandfathering — a narrower, distinct rule from a security-lens finding on the change currently under review.

**Owner-invoked whole-of-wave review — not a gate.** The whole-of-wave review (mechanism: `/post-wave-review`) is **owner-invoked**: the owner runs it by hand when a wave completes; it never runs automatically, and this protocol adds no rule making it required, automatic, or a precondition for starting the next wave. Scope: cross-PR regressions, seams between PRs that individually passed review, docs-vs-code drift, and a lived-data drill (boot the previous wave's played-in DB on the new tree, restore a backup, verify the badge-catalog count). Orchestrator-side nudge: `agents/orchestrator.md` § "Wave boundary".

**Doc-currency — implementer-side step, not a reviewer.** The `doc-currency` pipeline step defined in `agents/orchestrator.md` § "Doc-currency step" is an **implementer-side** step: it adds no reviewer, no entry to `## Reviewer count by artifact`, and no row to `## Which reviews does this change need?`. Its output is restricted to `.md` files; a non-`.md` need halts-and-reports instead of being committed. A `.md`-only (`docs-only`) contribution is covered by the single combined-tree PR-review PASS and forces no separate re-confirm round.

---

## Finding disposition — fix in place, drop, or defer

Every review finding takes exactly one of three dispositions.

**1. Fix in place — mandatory for an in-scope-fixable defect.**

A finding is _in-scope-fixable_ when both hold:

- it is a real defect, not taste (the taste test is disposition 2, below); and
- fixing it changes only the work under review — its own diff, its touched files, or a direct
  consequence of the change — and the fix is bounded: not a new feature, not a large refactor.

An in-scope-fixable defect **must** be fixed in the current change before it merges — the
`## One-round stop rule` above covers exactly this case. It may **never** be deferred to a
new GitHub issue or a `spawn_task` chip. **"I do not want another review round" is never a
valid reason to defer.** Neither is "it's trivial" — see the anti-pattern below.

**2. Drop — for taste.**

A finding that is a matter of opinion — both the implementer's and the reviewer's choices are
valid, with no functional, correctness, or comprehension impact — is dropped: not fixed, not
filed. Taste is never escalated into a new issue merely because nobody wants to argue about
it further.

**3. Defer — only for genuinely separable scope.**

A finding may be deferred only if fixing it requires genuinely separable new scope:

- a different feature than the one under review;
- a large or risky refactor that would itself need its own review cycle; or
- a pre-existing defect in code this change does not touch.

**During the governance freeze (through 2026-08-08), a deferred finding is never filed as a
new GitHub issue.** It is recorded as one line commented on the single parking issue — **#588**,
named in `CLAUDE.md` § "Governance freeze" — instead — the freeze's `post-wedding`-filing rule applies
to every deferred finding, not only defects found on the governing surface itself. Outside
the freeze window, a deferred finding is filed as a new GitHub issue via
`skills/capture-system-defect.md` (machinery/process defect) or `skills/issue-create.md`
(product defect). "I do not want another round" is excluded as a reason here exactly as in
disposition 1 above — deferral is earned by the scope being genuinely separable, never by
review fatigue.

**Anti-pattern — "trivial" gets filed, not fixed.** The tell: a finding is labelled "trivial" or
"minor" and then routed to a new issue, the parking issue, or a `spawn_task` chip instead of
being fixed, on the theory that something this small isn't worth another round. This is
backwards. A trivial-and-fixable finding is the _exact_ case disposition 1 requires be fixed
on the spot — the smaller the fix, the worse a whole downstream pipeline (or parking-issue
line) is as its vehicle for landing it. Severity labels do not decide disposition; only
in-scope-fixable vs. genuinely-separable-scope does. "Trivial" is evidence for fix-in-place,
never for defer.

**Floor, not ceiling.** This rule sets a minimum, not a maximum. Fixing more than the
in-scope-fixable set — e.g. sweeping a related pre-existing defect in a file you are already
touching — is always allowed and encouraged. The rule only forbids fixing _less_ than the
in-scope-fixable set by punting part of it elsewhere. A defect in the work under review is in scope
by definition: fixing it completes the asked work, it is not scope-creep — only genuinely separate
work is deferred.

**Worked example — fix in place.** A reviewer finds: "this PR's diff moves the upload handler from
`src/routes/photos.js` to `src/services/photos.js`, but the comment block this same diff adds two
lines above still says `// see src/routes/photos.js for the multer config` — a reader following the
comment lands on a file this PR deleted." The cited file's comment is inside the PR's own
touched-files set and the fix is a one-line path correction. Disposition: fix in place. Filing it as
a follow-up issue or chip would be the anti-pattern above — a trivial, in-diff fix routed around the
review instead of made in it.

**Worked example — defer.** A reviewer finds: "`src/services/scoring.js`, untouched by this PR,
computes tie-breaks with a comparator that silently mis-ranks entries sharing a timestamp —
unrelated to the badge-catalog change under review." The defect lives in code this change never
touches, and fixing it is a separate correctness fix to a different subsystem with its own test
surface. Disposition: defer — during the freeze, one line in the parking issue; outside it, a new
GitHub issue.

**Severity labels.** `severity:major` is restored to its narrow definition: crash, data-loss, or
security defects only. A feature gap, a missing edge case, or a process nit is `severity:minor` or
carries no severity label at all.
