# Adversarial Review Protocol

**Scope:** all artifacts in this repo — issues, PRs, skills, agents, and docs.
**Who runs this:** the orchestrator spawns reviewers. The product owner is not in the loop.

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

**Citations must be in range (#94).** Before citing any `file:line`, open the file and
confirm the line number is within its actual line count. Do not emit a `file:line` you
have not verified is in range — an out-of-range or unverified citation is itself a
defect, not a minor slip. This is the reviewer-side half of the citation guarantee: the
reviewer verifies before emitting a citation; the orchestrator's "The spawner must
never" #5 below is the other half, verifying on receipt. Neither half substitutes for
the other. `tools/review-runner.ps1` (#128) is the mechanical enforcement of this same
rule for the JSON-verdict path — it rejects any out-of-range or nonexistent `file:line`
citation before a verdict can be recorded. Prose verdicts have no such mechanical
backstop yet, so the reviewer's own self-check is the only guard until a verdict moves
to the runner.

---

## Independence

Fresh context, different identity/mandate than whoever produced the work. The agent
that produced an artifact must not also write its own passing verdict.

For high stakes: spawn a minimum of **three** independent adversaries. A finding is
recorded only when at least two of the three confirm it; a verdict of fine requires
the same threshold. With fewer than three adversaries the review is invalid — do not
proceed with two, as there is no majority on a tie. (Exception: a `system-level change`
uses the two-reviewer, both-must-PASS bar defined in the Self-modification bar section —
fail-closed, no third tie-breaker needed.) This ≥3 / 2-of-3 floor applies to **high-stakes** reviews as defined in `## Reviewer count by artifact`; routine code uses the single-reviewer-plus-design-philosophy rule defined there and is not governed by this floor.

---

## Reviewer count by artifact

Reviewer count scales to risk. Every change resolves to exactly one count-rule via this **precedence order — evaluate system-level → high-stakes → routine, first match wins:**

- **Issue / plan** → exactly **1** Opus reviewer (`reviewer-issue`). Never a panel of duplicate issue-reviewers. The additive architecture gate (`reviewer-architecture`) fires for system-level / new-component issues — it is a distinct gate, not a second issue-reviewer.
- **System-level change** — touches the governing-artifact surface (see `DESIGN.md`) → see `## Self-modification bar` for the two-independent-both-PASS threshold. **If a system-level change is also security-flagged**, the resolved rule is stricter: **≥3 independent reviewers, all must PASS** — never weaker than either the self-modification bar or the high-stakes floor.
- **High-stakes code** (non-system-level) — security-flagged, or a change the orchestrator judges safety- or correctness-critical beyond routine → the `## Independence` floor of **≥3 reviewers, 2-of-3 majority**. "High-stakes" means security-flagged or explicitly escalated by the orchestrator; the defining criterion is that it is **security-flagged**.
- **Routine code** — none of the above → round 1 uses exactly **1** PR reviewer plus the design-philosophy reviewer (`agents/reviewer-design-philosophy.md`) — **both must PASS** (any FAIL → fix and re-review); rounds 2+ use **1 fresh reviewer** each round. The rounds-2+-single rule does **not** apply to system-level changes: for a system-level change, the round that produces the accepted tree must carry two independent PASSes on that exact tree.

The **design-philosophy gate remains required for every implementation artifact** (code, an agent spec, a skill, or a standard) regardless of change size. There is no small-change, bug-fix, or copy-change exemption from it — the #201 round-ledger evidence showed it catching consequential defects on the smallest issues (the #88 a11y clamp bug hid in a home-page cleanup). Doc-only and typo-only changes are not implementation artifacts and skip only this gate, per `agents/orchestrator.md`.

**Why 1 PR reviewer, not a panel (#201):** across three build sessions (~9 multi-reviewer panels reconstructed), no second or third same-charter panelist ever flipped a verdict — every panel was unanimous PASS. Every FAIL that sent work back came from the differently-chartered design-philosophy reviewer or from a fresh single reviewer on a later round. Panel width bought reassurance, not catches; a different lens bought catches. So routine round 1 pays for one PR reviewer and keeps the different lens, and the "2–5 reviewers" range is retired. The 3-round soft cap and severity adjudicator (`## Stop condition — soft cap and severity gate`) remain unchanged.

**Kernel/experimental split (#218):** reviewer charters — files matching `agents/reviewer-*.md`, including new lens charters — take the **routine** bar above, not the system-level bar. Everything else on the governing-artifact surface (see `DESIGN.md` "System-level change (definition)") stays kernel, explicitly including the rest of `agents/`, all of `standards/`, `tools/`, `.githooks/`, `skills/`, `.github/`, and `.claude/`. Charter iteration is where governance experimentation happens, and the governance ledger (a separate issue in the same overhaul set; not yet landed) will make a weakened charter detectable via falling catch-rates; bar-definitions fail silently when weakened, so they stay kernel. `Get-RequiredBar` in `tools/verdict-core.ps1` enforces the split mechanically. **Fable interaction:** for Fable-authored work, an edit to any `agents/reviewer-*.md` is self-modification and takes Pattern 2 (one independent reviewer — see `## Fable review patterns`) regardless of this bar-1 carve-out; Fable never commits a charter edit on self-certification alone, because a charter reviews the very work Fable produces.

Reviewers remain **Opus** — model is not a savings lever. A reviewer must run on a different, non-weaker model than the implementer; `standards/agent-standards.md` makes Opus required for a gate. Savings come from reviewer _count_ only.

---

## Review batching

Related governance changes sharing one stated intent MAY ship as one reviewed batch: one issue-review pass and one PR review covering the entire batch. The PR description lists every change in the batch, and the reviewer's verdict covers the whole batch — a PASS on a batch is a PASS on each change in it, and a FAIL on any change is a FAIL on the batch; a batch mixing kernel and experimental paths takes the kernel bar.

---

## Advisory-lens lifecycle

A new reviewer lens (e.g. design-language, security) enters the pipeline as **ADVISORY**: it runs on every change its dispatch row matches, its findings are recorded in the review record, and it **cannot block a merge**. Promotion to gating — or removal — is an owner decision made on the recorded evidence after a trial of roughly 10 PRs. Precedent: the #197 smoke gate's two-stage promotion (`DESIGN.md` § "Empirical smoke gate"), which ran every push as signal before becoming a required check.

**Security escalation exception:** a security-lens finding of severity major or blocker immediately flags the change `security`, and the security-flagged bar in `## Reviewer count by artifact` applies to that change: ≥3 independent reviewers, 2-of-3 majority — or ≥3 all-must-PASS when the change is also system-level. A security hole must be able to block even during a lens trial — the advisory status governs the lens's routine findings, never a live vulnerability.

---

## Which reviews does this change need?

Path-based and mechanical — no judgment calls. Every row whose paths the change touches applies; a change matching multiple rows runs every matched lens, and any kernel path takes the whole change to the kernel bar.

| Change touches                                                                                                                                                                                       | Reviews that run                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Any kernel path (governing-artifact surface minus `agents/reviewer-*.md`)                                                                                                                            | Kernel bar, full stop (`## Self-modification bar`; `Get-RequiredBar` = 2)                                  |
| Docs/copy only (`.md` files that are NOT implementation artifacts — an agent spec, including `agents/reviewer-*.md` charters, a skill, or a standard never qualifies — and EJS text-only copy edits) | CI + the existing doc-only exemptions; no specialist lens                                                  |
| Views/CSS/badge assets/guest-or-admin-facing copy                                                                                                                                                    | Design-language lens (advisory; charter ships in #221)                                                     |
| Upload/intake, auth, file-serving, admin routes                                                                                                                                                      | Security lens (advisory with the escalation exception above; charter: `agents/reviewer-security.md`, #222) |
| `src/services/` scoring/feed logic                                                                                                                                                                   | The #206 duplicated-ownership self-check gets explicit reviewer attention                                  |

Every row is additive to the base review for the change's risk tier (`## Reviewer count by artifact`); a lens never replaces the PR reviewer or the design-philosophy gate.

---

## research-first

Before judging, the reviewer establishes the _current_ best-practice yardstick for
the area (with dated citations). Grading against stale priors is a calibration
failure.

---

## Bias gate

The bias-gate audit runs **once per distinct briefing template**, not once per
fan-out round: a briefing reused verbatim across rounds (same artifact type, same
instructions) is audited the first time it is used, and that audit covers every
later round that reuses it. A **fresh briefing** — different artifact type,
different instructions — **requires a fresh audit**. (This matches what all three
observed build sessions independently did in practice; per-round re-audits of an
unchanged template caught nothing and cost a full agent each round.)

Before first use of a briefing template, spawn one independent agent to audit the briefing
and per-reviewer charters for bias. The only permitted bias is anti-builder; remove
everything else: implementation leaks, positive framing, planted suspicions, tool
favoritism, scope-narrowing. That agent returns required edits with quoted evidence.
Apply the edits, then fan out. If the bias-gate agent itself errors or returns a
verdict the orchestrator cannot verify (e.g., the gate agent praises the briefing
without quoting evidence), spawn a second independent gate agent from a clean prompt
and require it to agree before proceeding.

**Evidence artifact and fail-closed rule (#47).** The bias-gate step above leaves a
tree-bound evidence artifact at `.review_state/bias-gate/<tree_oid>/<gate_id>.json`
(schema `bg1`), written by the single writer `tools/persist-bias-gate.ps1`. For a
**system-level change** (`Get-RequiredBar` returns `2`), `tools/validate-verdict.ps1`
fails closed unless at least one `bg1` artifact bound to the exact staged tree is
`PASS` and none is `FAIL` (per-artifact FAIL-wins, mirroring the reviewer FAIL-wins
rule above) — a system-level tree with two independent review PASSes but no recorded
bias-gate step still does not authorize a commit. A routine (non-system-level) tree
does not require a bias-gate artifact. See `DESIGN.md` "Commit gate" for the full
mechanics and the honest tamper-evident (not tamper-proof) bar this shares with the
other `.review_state/` writers.

The severity adjudicator (`## Stop condition — soft cap and severity gate` below)
similarly leaves a durable evidence artifact at
`.review_state/adjudication/<tree_oid>/<adjudicator_id>.json` (schema `adj1`),
written by `tools/persist-adjudication.ps1`. This is a record only — no gate consumes
it as of #47; enforcement, if ever added, is a separate issue.

---

## No human in the loop

The product owner does not resolve findings. Translate any "owner reviews/approves"
control into a deterministic check or an independent adversary. Reserve human judgment
for what the human can actually judge (product direction, taste).

**Findings-resolution vs. the visual-approval gate (#294).** This rule governs
findings-resolution only: the owner never adjudicates a blocker/major/minor/nit an
adversarial reviewer raised, and that stays true with no exception. It does not forbid
the separately-decided **visual-approval loop** (`agents/orchestrator.md` § "Visual-approval
loop"; `DESIGN.md` § "Visual-approval loop reinstated") — a product-taste, pre-merge
screenshot approval that runs on visual changes only, before the adversarial PR review.
The loop carries no review finding to the owner and resolves no defect; it is exactly
the "product direction, taste" carve-out this section already reserves for human
judgment, made into an explicit step.

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
   own pre-emission self-check (see "Citations must be in range (#94)" under
   Calibration above) is the first half — the two do not replace one another.

---

## Reviewers are read-only

Reviewers perform read-only inspection only. Read-only commands (`git show`, `git diff`, `git check-ignore`, `git ls-files`, `npm test`, `format:check`) are permitted. A reviewer must not run `git add`, `git reset`, `git restore`, `git checkout`, `git stash`, `git commit`, or `git rm`, and must not edit any file — even if the tools available to it would allow it.

**Rationale.** On 2026-07-02 a PR reviewer ran `git restore`, unstaged a fix, and then failed the tree it had just altered — review evidence is bound to an exact staged tree (`git write-tree` oid), and a reviewer that mutates git or files can invalidate the very tree it is judging without anyone noticing. `agents/reviewer-*.md` and `agents/severity-adjudicator.md` declare `tools: [Read]` (or a narrow read-only set), but a reviewer instantiated with a broader tool set must still be bound by this rule in prose, not by tool-list omission alone.

---

## Self-modification bar

A system-level change requires two independent reviewers. The reviewers must be independent of each other and of the implementer — spawned from clean prompts with no shared context. The change passes only when both reach PASS; disagreement is treated as FAIL, and the fix-and-re-review loop continues.

This is the system-level specialization of the high-stakes independence rule in the Independence section: instead of ≥3 adversaries with 2-of-3 majority, a system-level change uses two independent reviewers who must both reach PASS, and disagreement is treated as FAIL (fail-closed), so no third tie-breaker is needed.

This bar is additive to the soft cap and severity gate below. When a system-level change reaches the soft cap trigger, both the two-reviewer requirement and the severity adjudicator apply. See `DESIGN.md` for the definition of system-level change. For the full precedence order placing this bar within the risk-tier hierarchy — including the security-flagged-system-level combination — see `## Reviewer count by artifact`.

---

## Event mode (#220) — the wedding-day freeze exception

A pre-declared, expiring window in which a mid-event hotfix ships on green automated checks alone, with review owed — and mechanically collected — after the event. Full design and rationale: `DESIGN.md` § "Event mode (#220)".

**What it bypasses.** While `governance/event-mode.json` is a valid `em1` flag with a future expiry, a commit whose subject starts `hotfix: ` passes the local hooks with **no review evidence and no reviewed issue** (pre-commit defers the evidence gate to commit-msg, which honors the prefix; the shared gate body is `.githooks/gate-core.sh`). While the flag **file** is present, every other commit meets the full evidence gate at commit-msg (keyed on file presence, not ACTIVE state, so the flag expiring between the two hooks can never skip the gate in both — see `DESIGN.md`); with no flag file, the hooks behave exactly as always. An expired or invalid flag enables nothing.

**What it never bypasses.** CI stays fully required: lint, format, tests + coverage, commit-gate integrity, the smoke job — and main's branch protection (PR + green required checks). Review is deferred, never waived.

**Single writer.** `tools/set-event-mode.ps1` is the only writer of the flag (`-ExpiresUtc <date> -Reason <text>` / `-Clear`). The flag file is never hand-edited, and committing its creation or removal takes the normal gate.

**Retro-review consumer.** Each freeze shipment produces a `freeze:true` ledger row (harvest marks merged PRs carrying a `hotfix: ` commit subject). `tools/set-event-mode.ps1 -Clear` **refuses** to remove the flag while any such row since the flag's creation lacks a review PASS bound to that commit's tree (recorded via `tools/persist-review.ps1`). The CI job `event-mode-expiry` goes red while an expired flag remains in the tree, forcing the cleanup — and through it, the retro reviews. A retro review applies this protocol's full stance to the shipped tree; it is a real review that happened late, not a rubber stamp.

---

## Wave governance (#310) — grandfathering, owner-invoked wave review, doc-currency step

Three governance mechanisms recorded 2026-07-08 by owner decision, during the Wave-1 post-wave review session. Evidence and rationale: issue `#310`. Architecture-rationale entry: `DESIGN.md` § "Wave governance (#310)".

**Grandfathering — a mid-wave governance change does not reach back.** A governance or gate change (an edit to this protocol, an agent charter, a standard, or the commit-gate mechanism) that merges mid-wave governs from the **next issue picked up onward**. An open sibling PR already in flight — its implementation began before the governance change merged — merges under the bar that was in force when its implementation began; it is not required to re-satisfy a bar that landed after it started, and a reviewer must not flag it as a defect for that reason alone. This is a deliberate **grandfather** clause. Worked example: PR #295 (the visual-approval loop, #294) merged 2026-07-08 01:37:53; PR #298 (#254) merged 39 minutes later touching the exact `views/**`/`src/public/**` surface the new loop governs, with no screenshot-approval step and no reference to #294 — that is correct behavior under this clause, not a defect.

One exception: a **`severity:blocker`** security gate change applies to every open sibling PR immediately, with no grandfathering. This is a **narrower, distinct** rule from the "Security escalation exception" in `## Advisory-lens lifecycle` above, and the two thresholds are not in tension: the escalation exception governs a security-lens finding (major **or** blocker) raised **on the current change under review**, escalating that change's own reviewer count. This clause instead governs a **new gate merging mid-wave and reaching backward** into already-in-flight sibling PRs that are not themselves under review — a materially riskier reach-back, so its bar is narrower (blocker-only, not major-or-blocker): a mid-wave gate change does not retroactively fail every open PR over a major finding, only over a blocker-severity security gap.

**Owner-invoked whole-of-wave review — not a gate.** The whole-of-wave review (mechanism: `/post-wave-review`, #302) is **owner-invoked**: the owner runs it by hand when a wave completes; it never runs automatically, and this protocol adds no rule making it required, automatic, or a precondition for starting the next wave. Scope: cross-PR regressions, seams between PRs that individually passed review, docs-vs-code drift, and a lived-data drill (boot the previous wave's played-in DB on the new tree, restore a backup, verify the badge-catalog count). Orchestrator-side nudge: `agents/orchestrator.md` § "Wave boundary".

**Doc-currency — implementer-side step, not a reviewer.** The `doc-currency` pipeline step defined in `agents/orchestrator.md` § "Doc-currency step" (spawned with an explicit `model: sonnet` pin) is an **implementer-side** step: it adds no reviewer, no entry to the Opus reviewer-model table in `## Reviewer count by artifact`, and no `doc-currency` row to the `## Which reviews does this change need?` dispatch table. It is **separate from any documentation-currency review** — distinct in mechanism and scope from `agents/reviewer-doc-currency.md`, an unwired reviewer charter that blocked on front-door/index-doc staleness against `standards/documentation-standards.md` and was retired as an orphan in #323. Neither mechanism substituted for the other; this section did not retire that charter — #323 did.

**`docs-only` rule.** The doc-currency agent's output is restricted to `.md` files; a non-`.md` need halts-and-reports instead of being committed (owner decision 2026-07-08: build speed over serialization). A `.md`-only (`docs-only`) contribution is covered by the single combined-tree PR-review PASS and forces no separate re-confirm round. Operational staging mechanics — why and how the correction must land before the verdict binds: `agents/orchestrator.md` § "Doc-currency step".

---

## Stop condition — soft cap and severity gate

the 3-round mark is a trigger, not a hard cap.

**Trigger:** At 3 rounds without PASS, the orchestrator invokes a `severity adjudicator` — a
fresh Opus agent with no context from prior rounds. The loop does not stop at this point.

**Classification:** The severity adjudicator inspects every remaining open defect and classifies
each as `consequential` or `inconsequential`. A defect is consequential if it does any of the
following:

- violates an acceptance criterion
- is a correctness, safety, or security defect
- is a real internal contradiction in the artifact
- would mislead a future reader or agent

A defect is inconsequential only if it is none of those — a pure style or wording nit with no
functional, correctness, or comprehension impact. The severity adjudicator must cite a basis for
each classification.

**Exit rule:** exit is authorized only when every remaining defect is inconsequential. The
system never accepts work while a consequential defect remains.
the author, implementer, and orchestrator never classify severity or authorize exit — that power
belongs solely to the severity adjudicator.

**Loop-continues path:** If any defect is consequential, the implementation agent fixes it, a
fresh reviewer re-reviews, and the severity adjudicator is re-invoked. The loop continues
until either a reviewer returns PASS or the severity adjudicator authorizes exit.

**Impasse:** A consequential defect that survives the severity gate plus 3 further fix-and-re-review rounds
is declared an impasse. The orchestrator tracks the post-gate round count and declares the impasse; the
severity adjudicator only classifies severity per invocation and cannot track elapsed rounds. The segment
halts and surfaces to the operator; a halt is not an acceptance — the work is not committed. This bound
guarantees the loop terminates without ever self-exiting by accepting consequential work.

---

## Fable review patterns (#203, narrowed by #207)

**Retired 2026-07-06 (#274).** The Fable model is no longer available to this
project; its final session ended 2026-07-06 and no current implementer qualifies
for these patterns. **Every implementer follows the unmodified protocol above —
the independence rules, reviewer counts, and self-modification bar apply with no
exception.** The text below is preserved as the historical record of the
decision and its rationale; it is not live policy.

**Decision lineage.** #203 (2026-07-04) granted Fable full self-certification at
every risk tier. **#207 (decided by the owner the same day, 2026-07-04) narrows
that grant to the two patterns below and caps all Fable reviews at one round.**
Where this section and any record of the original #203 grant disagree, this
section governs.

**Pattern 1 — routine work: fresh-context self-review.** Fable-authored work that
is **not** system-level, **not** security-flagged, and **not** self-modification is
certified by a self-review that Fable runs in a **fresh context**: a clean prompt
containing the issue, the diff, this protocol's stance, and the design-philosophy
charter (`standards/design-philosophy.md`) — and none of the implementing
conversation. Re-reading one's own work inside the implementing context is not a
review; the independence gained here is context-independence, and the
design-philosophy charter is the lens because it is the one reviewer role the
repo's own round-ledger evidence (#201) showed catching every consequential
defect. Recorded via `tools/persist-self-certification.ps1` (`role: 'self-cert'`).

**Pattern 2 — governance surface: one independent reviewer.** Fable-authored work
that is **system-level** (the governing-artifact surface defined in `DESIGN.md`),
**security-flagged**, or **self-modification** takes exactly **one independent
reviewer** — per the Model policy table (Opus), spawned from a clean prompt with
no shared context with the implementer. Rationale: an agent that can rewrite the
machinery that checks it and certify its own rewrite has no remaining independent
check of any kind; the failure mode is undetectable by construction, so no degree
of implementer capability substitutes for outside eyes here.

**One-round cap (both patterns).** Every Fable review is exactly one round: the
reviewer reports, the implementer fixes, and the **same** reviewer confirms the
fixed artifact once within that round. No fresh-reviewer rounds, no panels, no
soft-cap loop, no severity-adjudicator invocation. A consequential defect that
cannot be resolved within the round halts the work and surfaces to the owner — it
is not merged.

**Scope.** This applies only to Fable. Every other implementer remains bound by the
rest of this protocol at full strength, unchanged — including the reviewer-count
precedence order, the bias gate, and the soft-cap severity gate. For Fable-run
reviews, the bias-gate agent ceremony does not apply; the bias-gate evidence
artifact is written via `tools/persist-bias-gate.ps1 -SelfCertify`.

**Supersession.** For Fable only, this section supersedes:

- `## Independence` — replaced by Pattern 1 (fresh-context self-review) for routine
  work and Pattern 2 (one independent reviewer, not two-plus) for the rest.
- `## Self-modification bar` — the two-independent-reviewer requirement is reduced
  to Pattern 2's one independent reviewer. It is **not** waived: self-modification
  never proceeds on self-certification alone.

**Permanence.** Owner-authorized standing policy (decided 2026-07-04, #207) — not
time-boxed. Any future widening back toward full self-certification is an owner
decision to be recorded the same way.

**CI is unaffected.** `npm run lint`, `npm run format:check`, and
`npm run test:coverage` still gate Fable's work exactly as everyone else's, and the
empirical smoke gate (#197, shipped with this policy) probes the running app on
every push and PR.

**Mechanism.** Evidence, not hand-waving: `tools/persist-self-certification.ps1`
writes distinctly-tagged records (`reviewer_id: fable-self-<i>`,
`role: 'self-cert'`) to `.review_state/issue-reviews/<N>/` (issue mode) or
`.review_state/reviews/<tree_oid>/` (tree mode). **Tree mode is capped at one
record (#207).** Because `Reduce-Verdicts` (`tools/verdict-core.ps1`) counts
distinct `reviewer_id`s with a PASS against `Required`, and a system-level tree
requires `Required = 2` (`Get-RequiredBar`), the cap makes Pattern 2 mechanical:
a system-level tree needs at least one PASS recorded by a real independent
reviewer via `tools/persist-review.ps1` — self-certification alone can never
satisfy it (`tests/persist-self-certification.test.js` pins both directions).

The `role: 'self-cert'` field keeps Fable's self-certified evidence honestly
distinguishable from an independent reviewer's PASS in the audit trail — the
exception is documented and visible in the evidence itself, not hidden behind a
free-text `reviewer_id` that could be confused with a real reviewer.
