# Issue Standards

**As a reviewer or implementer of an issue, I need a single checkable standard so I can determine whether an issue passes or fails without guessing.**

---

## User story

Written from the end-consumer POV: the agent, human, or system that will use the produced artifact. Format: `As a [consumer], I need… so that….` If you cannot name a consumer, the issue has no purpose.

---

## Acceptance criteria

Written as Given/When/Then criteria testable by an agent. Each criterion must be mechanically checkable with no semantic interpretation required — either a literal string or structural check (present/absent phrase, section header, file path, token count) verifiable by reading the produced artifact, or a behavioral input→output assertion (a concrete input and its exact expected output) verifiable by reading the recorded output of the artifact's own test.

**A ready-tier issue's criteria must include at least one that asserts a behavioral output value** (input → expected output), so the criteria can catch a wrong implementation — an issue whose criteria are _all_ presence/structural checks cannot, since a broken implementation can satisfy every "file contains X" check. **Documentation-only issues** (those whose `Touches` paths are all docs — `.md` or under `docs/`) are exempt and may use purely string/structural criteria. (Backlog-tier issues capture intent before implementation and need only one deterministic criterion — see Issue tiers.)

For a documentation issue, acceptance criteria must reduce to literal string or structural checks (no criterion of the form "an agent can understand X" — that is unfalsifiable). Lesson from issue #0001: every AC that said "an agent can answer X" was unfalsifiable; rewrite as "the file contains the phrase `X`".

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
- **Acceptance criteria** — each criterion in **Given/When/Then** form, resolving to a literal string or structural check.
- **implementation plan** — at least three numbered steps, each naming a file path or concrete deliverable.
- **Dependency map** — `Depends on`, `Blocks`, and `Touches` all present.
- **`**Run tier:**` field** — a `**Run tier:**` line whose value is `sonnet-only` or `opus`. The declared value must equal `tools/classify-issue-run.ps1`'s output for the issue's `Touches` paths and flags (security-flagged, escalated, schema-or-data-migration) — the classifier is the single source of truth for eligibility. A backlog-tier issue defers its run tier to graduation: it carries no `**Run tier:**` field, and the field is filled in when the orchestrator opens the graduated ready-issue.

The reviewer applies the full checklist to a ready-issue.

### backlog tier

A backlog-issue captures intent before implementation is possible. It requires:

- **user story** — same form as the ready tier.
- **Acceptance criteria** — at least one deterministic criterion (literal string or structural check).
- **`Graduate after:`** field — a **deterministic** condition the orchestrator can evaluate without human judgment (e.g., "after issue #NNNN merges"). A `Graduate after` condition that requires human-approval is a FAIL.

A backlog tier omits `Blocks`/`Touches` and omits a full implementation plan. The reviewer does not fail a backlog issue for missing those fields.

### Graduation

A backlog issue is never implemented in place. When its `Graduate after` condition is met, the orchestrator opens a new numbered ready-issue. The backlog issue is then closed.

---

## Reviewer checklist

### Ready-tier checklist

- [ ] PASS/FAIL — User story names an end-consumer (not the author) and follows `As a [consumer], I need…` form.
- [ ] PASS/FAIL — Every acceptance criterion is in Given/When/Then form and resolves to a literal string/structural check or a behavioral input→output assertion.
- [ ] PASS/FAIL — At least one acceptance criterion asserts a behavioral output value (input → expected output), not only presence/structural checks — except documentation-only issues (`Touches` all docs). An all-presence-check issue a wrong implementation could pass is a FAIL.
- [ ] PASS/FAIL — Implementation plan is present and contains at least three numbered steps, each naming a file path or a concrete deliverable.
- [ ] PASS/FAIL — Dependency map contains all three fields: `Depends on`, `Blocks`, `Touches`.
- [ ] PASS/FAIL — No FINAL, LAST, or TRULY_FINAL in filenames or section headers referenced by this issue.
- [ ] PASS/FAIL — Reviewer independently derives the run tier by running `tools/classify-issue-run.ps1` against the issue's `Touches` paths and flags, and confirms it matches the issue's declared `**Run tier:**` value.

### Backlog-tier checklist

- [ ] PASS/FAIL — User story is written from the consumer POV and follows `As a [consumer], I need…` form.
- [ ] PASS/FAIL — At least one acceptance criterion names a testable desired outcome (literal string or structural check).
- [ ] PASS/FAIL — `Depends on` field is present.
- [ ] PASS/FAIL — `Graduate after` field is present and states a deterministic condition (not a human approval).
- [ ] PASS/FAIL — Tier is declared as `backlog` in the `**Type:**` line.

---

## In-license check (all tiers)

An issue that requires an `external/paid API`, a `non-Anthropic model key`, or a `hosted third-party service` is `out of license` — return `FAIL`.
