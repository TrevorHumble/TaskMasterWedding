# Issue Standards

**As a reviewer or implementer of an issue, I need a single checkable standard so I can determine whether an issue passes or fails without guessing.**

---

## User story

Written from the end-consumer POV: the agent, human, or system that will use the produced artifact. Format: `As a [consumer], I need… so that….` If you cannot name a consumer, the issue has no purpose.

---

## Acceptance criteria

Written as Given/When/Then criteria testable by an agent. **An acceptance criterion is a promise: when this is true, we are done.** Criteria exist to align the owner, issue reviewer, implementer, and PR reviewer around one shared picture of what "done" means — not to catch anyone. A criterion must be readable by the product owner: if the owner cannot read a criterion and know what was promised, it is not a contract — the mechanical checking is already done for free by `npm test`, `npm run lint`, and `npm run format:check`.

A criterion need only be answerable yes/no by a competent reviewer against real evidence — that bar does not move, but the old requirement that answering it involve no judgment is dropped. In practice, two reviewers may disagree on the same criterion, and that is accepted knowingly: the alternative is criteria shredded into dozens of greppable strings that nobody could hold in the first place.

**Write 1–6 criteria — 8 is the ceiling, not a target.** More criteria are not more safety; past the ceiling, nobody can hold them, and a reviewer ends up picking one, citing it, and missing the rest. Blowing the ceiling is at least major severity: #410 carried 34 criteria, and its review spent itself on one of them while the real question went unasked.

**A ready-tier issue's criteria must include at least one that asserts a behavioral output value** (input → expected output), so the criteria can catch a wrong implementation — an issue whose criteria are all presence/structural checks cannot, since a broken implementation can satisfy every "file contains X" check.

**Documentation-only issues** (those whose `Touches` paths are all docs — `.md` or under `docs/`) are exempt from the behavioral-value requirement above and may use purely structural criteria. (Backlog-tier issues capture intent before implementation and need only one such criterion, answerable yes/no by a competent reviewer — see Issue tiers.)

**For the visual surface only, the approved screen is the acceptance criterion (#378).** Taste is discovered, not specified — nobody knows a decoration is clutter until they see it. So for `views/**/*.ejs` / `src/public/**` work that goes through the phase-1 live-preview loop (`agents/orchestrator.md` § "Visual-approval loop"), the written criteria **transcribe** what the owner already approved on the seeded preview link; they do not **define** it up front the way every other criterion in this standard does. Any behavior phase 1 faked to settle the look (e.g. "top 5, not top 10" hard-coded just to see the shape) becomes real, specified work in the phase-2 criteria — the faked shortcut is not shipped as-is. **This transcription rule applies only to the visual surface.** Logic, data, and tests — everything that is not the approved screen itself — still take spec-first, adversarial criteria written before implementation, exactly as the rest of this standard describes; a criterion that is not about how a screen looks or reads does not get to claim this exemption.

No criterion of the form "an agent can understand X" — that is unfalsifiable and is a FAIL. Lesson from issue #0001: every AC that said "an agent can answer X" was unfalsifiable; rewrite as "the file contains the phrase `X`" or a behavioral input→output assertion.

---

## Acceptance-criteria amendment (bounded, mid-flight)

An issue's acceptance criteria are not frozen the instant the issue passes review — they may be amended mid-flight, but only under two conditions together: **owner approval plus one reviewer** sign off on the amended text before the implementer treats it as the new contract. Neither alone is sufficient — owner approval without a reviewer skips the adversarial check this whole standard exists to force; a reviewer alone cannot authorize spending the owner's scope without the owner's own approval.

The amendment is bounded to the issue's existing footprint: it may only add work **inside files already on the issue's `Touches` list** — put plainly, an amendment never adds a file. The `Touches` list is a hard line set at issue-review time (see #338/#538 context: it is what makes concurrent waves safe, since two agents must never share a file) — an amendment that needs a file outside that list is not an amendment, it is a new issue, filed and reviewed on its own.

Example: an issue touching `src/services/photos.js` may be amended to also validate a file's MIME type inside that same file, with owner + reviewer sign-off. It may not be amended to also touch `src/routes/admin.js` to add a moderation control — that is a new, separately-reviewed issue, even if the owner wants it done "at the same time."

---

## The Haiku bar

The implementation plan is a clarity heuristic: it must be clear and unambiguous enough that following it would not send a weak model off the rails. It is a thought experiment about plan clarity, not a requirement to inline every fact. The implementer is a Sonnet agent; Opus is used only for review.

---

## Dependency map

Every issue must include:

```
Depends on: <issue number(s) or "none">
Blocks: <issue number(s) or "none">
Touches: <file paths or artifacts modified>
```

All three fields are required. Missing a field is a FAIL.

---

## Naming

A draft's identity is its GitHub issue number, not a locally-minted one: the draft file in `data/wip-issues/` is named `<N>-slug.md`, where `N` is the number GitHub assigned when the issue was created (`gh issue create`), captured before the draft is written. The file's `N`, its `# N —` header, and any self-referential `(#N)` must all equal that GitHub issue number. No FINAL, LAST, or TRULY_FINAL.

A draft with **no** `# N —` header is a **nit** (non-blocking) — GitHub's own issue title is the canonical identity, and the in-file header is a convenience, not the source of truth. A **present-but-wrong** header — `N` or a `(#N)` self-reference disagreeing with the GitHub-assigned number — is a blocking **FAIL**: a wrong number actively misdirects a reader to the wrong issue, which a missing header does not.

---

## Issue tiers

Issues are filed at one of two tiers. The tier is declared in the issue's `**Type:**` line: either `ready` or `backlog`.

### ready tier

A ready-issue must include all of the following before it can be reviewed:

- **user story** — `As a [consumer], I need… so that….`
- **Acceptance criteria** — each criterion in **Given/When/Then** form; see § "Acceptance criteria" above for what a criterion must be.
- **implementation plan** — at least three numbered steps, each naming a file path or concrete deliverable.
- **Dependency map** — `Depends on`, `Blocks`, and `Touches` all present.
- **`**Run tier:**` field** — a `**Run tier:**` line whose value is `sonnet-only` or `opus`. The declared value must equal `tools/classify-issue-run.ps1`'s output for the issue's `Touches` paths and flags (security-flagged, escalated, schema-or-data-migration) — the classifier is the single source of truth for eligibility. A backlog-tier issue defers its run tier to graduation: it carries no `**Run tier:**` field, and the field is filled in when the orchestrator opens the graduated ready-issue.

The reviewer applies the full checklist to a ready-issue.

### backlog tier

A backlog-issue captures intent before implementation is possible. It requires:

- **user story** — same form as the ready tier.
- **Acceptance criteria** — at least one criterion, answerable yes/no by a competent reviewer, per § "Acceptance criteria" above.
- **`Graduate after:`** field — a **deterministic** condition the orchestrator can evaluate without human judgment (e.g., "after issue #NNNN merges"). A `Graduate after` condition that requires human-approval is a FAIL.

A backlog tier omits `Blocks`/`Touches` and omits a full implementation plan. The reviewer does not fail a backlog issue for missing those fields.

### Graduation

A backlog issue is never implemented in place. When its `Graduate after` condition is met, the orchestrator opens a new numbered ready-issue. The backlog issue is then closed.

---

## Spawn justification

Any issue an agent creates **during a run** — as opposed to an issue the owner files directly — carries the `spawned-in-run` label and must contain a `## Spawn justification` section in its body. The label is the machine signal that this block is required; an issue without the label is not subject to it.

The block has four required fields, each non-empty:

- **Spawned by** — the spawning issue `#`, PR `#`, or run identifier the finding came from (provenance).
- **Why** — the defect or gap the new work addresses (the need).
- **Why separable** — why the work is more work, not absorbed into the spawning change. The value must name one of the three defer categories `standards/adversarial-review-protocol.md` § "Finding disposition" defines — that section is the single owner of the categories' substance; this section only requires citing one of them, it does not restate them.
- **Why not solved in the spawning session** — the concrete blocker that kept the work out of the spawning change (e.g. needs an owner design decision; outside the spawning change's touched files; would exceed the change's bounded scope).

Example block:

```
## Spawn justification

- **Spawned by:** #514
- **Why:** <the defect or gap this issue addresses>
- **Why separable:** <one of the three § "Finding disposition" defer categories>
- **Why not solved in the spawning session:** <the concrete blocker>
```

A `spawned-in-run` issue missing the block, or with any of the four fields empty, fails review — see the Reviewer checklist below.

---

## Reviewer checklist

### Ready-tier checklist

- [ ] PASS/FAIL — User story names an end-consumer (not the author) and follows `As a [consumer], I need…` form.
- [ ] PASS/FAIL — Every acceptance criterion is in Given/When/Then form and is answerable yes/no by a competent reviewer, or asserts a behavioral input→output value.
- [ ] PASS/FAIL — At least one acceptance criterion asserts a behavioral output value (input → expected output), not only presence/structural checks — except documentation-only issues, per the exemption defined in § "Acceptance criteria" above. An all-presence-check issue a wrong implementation could pass is a FAIL.
- [ ] PASS/FAIL — Implementation plan is present and contains at least three numbered steps, each naming a file path or a concrete deliverable.
- [ ] PASS/FAIL — Dependency map contains all three fields: `Depends on`, `Blocks`, `Touches`.
- [ ] PASS/FAIL — No FINAL, LAST, or TRULY_FINAL in filenames or section headers referenced by this issue.
- [ ] PASS/FAIL — Reviewer independently derives the run tier by running `tools/classify-issue-run.ps1` against the issue's `Touches` paths and flags, and confirms it matches the issue's declared `**Run tier:**` value.

### Backlog-tier checklist

- [ ] PASS/FAIL — User story is written from the consumer POV and follows `As a [consumer], I need…` form.
- [ ] PASS/FAIL — At least one acceptance criterion names a testable desired outcome, answerable yes/no by a competent reviewer.
- [ ] PASS/FAIL — `Depends on` field is present.
- [ ] PASS/FAIL — `Graduate after` field is present and states a deterministic condition (not a human approval).
- [ ] PASS/FAIL — Tier is declared as `backlog` in the `**Type:**` line.

---

## In-license check (all tiers)

An issue that requires an `external/paid API`, a `non-Anthropic model key`, or a `hosted third-party service` is `out of license` — return `FAIL`.

---

## Definition of Done ownership

`definition-of-done.md` (repo root) lives outside the governing-artifact surface `tools/verdict-core.ps1` `$SYSTEM_PATH_REGEX` matches, so changing it does not take the system-level two-independent-reviewer bar — it takes the routine one-reviewer bar like any other non-kernel change. That placement is deliberate: the DoD needs to stay cheap to amend as the project learns what "done" actually requires.

Cheap to review is not the same as unowned. Changing `definition-of-done.md` requires **owner approval** before it merges — the owner is the one person who can add or loosen a clause that every future PR review will be judged against. This is a recorded rule, not a mechanically enforced one: on this solo-maintainer repo (`required_approving_review_count = 0`), a CODEOWNERS-style gate cannot force owner sign-off, so the check is tamper-evident, not tamper-proof, the same honest posture as the rest of this pipeline (`DESIGN.md` § "Issue-review gate").
