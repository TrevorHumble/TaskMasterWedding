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
citation before a verdict can be recorded. The PR-path reviewers (`reviewer-pr`,
`reviewer-design-philosophy`) emit that JSON block per #474; #455 wired the runner into
the pipeline to consume it, via `tools/capture-reviewer-verdict.ps1` (see "PR-review
recording: capture → runner (#455)" below) — a PR-review verdict is now recorded
mechanically from the reviewer's own returned text, not transcribed by hand. For the
issue-stage reviewers (`reviewer-issue`, `reviewer-architecture`), which stay on prose,
the reviewer's own self-check remains the only guard.

---

## PR-review recording: capture → runner (#455)

A PR-review verdict is recorded by capturing each PR-path reviewer's own emitted JSON
block and feeding it through `tools/review-runner.ps1` — never by a hand
`tools/persist-review.ps1` call. For each PR-path reviewer (`reviewer-pr`,
`reviewer-design-philosophy`, per #474), `tools/capture-reviewer-verdict.ps1
-RawReturnFile <f> -RunDir <dir>` extracts the trailing fenced ```json verdict block
from that reviewer's raw return text and writes it, verbatim, to `<dir>/<reviewerId>.json`
— fail-closed (exits non-zero, writes nothing) if no such block exists, the block does
not parse as JSON, or it has no non-empty `reviewerId`. Once every reviewer in the round
is captured into the same `<dir>`, `tools/review-runner.ps1 -RunDir <dir> -TreeOid <T>
-Mode <both-pass|unanimous>` citation-validates every defect and, only on a fully clean
pass, calls `tools/persist-review.ps1` per reviewer and `tools/review_verdict.ps1` to
bind the tree-level PASS.

This closes the residual `DESIGN.md` § "Commit gate: review evidence bound to the staged
tree" named as still open: the actor that could invent a PASS by hand (the orchestrator,
running `persist-review.ps1` directly with a free-text reviewer id) is no longer the
actor recording it for the PR-review path — the evidence is mechanically derived from
the reviewer agent's own returned bytes. The orchestrator's "The spawner must never" #5
post-hoc verification (confirm every citation, every item in scope has a finding) is now
performed by the runner's citation validation before any evidence is written, not by the
orchestrator reading the verdict and deciding to trust it.

The issue-review path (`tools/persist-issue-review.ps1`, step 2 of
`agents/orchestrator.md`) is unchanged by this wiring — it remains a direct,
hand-invoked call, since #455 scopes only the PR-review recording path.

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

**Kernel/experimental split (#218):** reviewer charters — files matching `agents/reviewer-*.md`, including new lens charters — take the **routine** bar above, not the system-level bar. Everything else on the governing-artifact surface (see `DESIGN.md` "System-level change (definition)") stays kernel, explicitly including the rest of `agents/`, all of `standards/`, `tools/`, `.githooks/`, `skills/`, `.github/`, and `.claude/`. Charter iteration is where governance experimentation happens, and the governance ledger (a separate issue in the same overhaul set; not yet landed) will make a weakened charter detectable via falling catch-rates; bar-definitions fail silently when weakened, so they stay kernel. `Get-RequiredBar` in `tools/verdict-core.ps1` enforces the split mechanically.

Reviewers remain **Opus** on every tier except the explicitly-scoped `sonnet-only` tier (#427) — model is not a savings lever elsewhere. A reviewer must run on a different, non-weaker model than the implementer; `standards/agent-standards.md` makes Opus required for a gate. Savings otherwise come from reviewer _count_ only. The `sonnet-only` tier is a bounded exception: an issue eligible under `tools/classify-issue-run.ps1` (routine, off the wedding-critical guest paths, small and reversible) runs its implementer and every reviewer that fires on Sonnet, mitigated by the retained design-philosophy lens and a coverage-first instruction on every reviewer charter that can run on that tier — see `standards/agent-standards.md` § "`sonnet-only` tier carve-out" and `agents/orchestrator.md` § "Model policy" for the escalation safety valve.

---

## Review batching

Related governance changes sharing one stated intent MAY ship as one reviewed batch: one issue-review pass and one PR review covering the entire batch. The PR description lists every change in the batch, and the reviewer's verdict covers the whole batch — a PASS on a batch is a PASS on each change in it, and a FAIL on any change is a FAIL on the batch; a batch mixing kernel and experimental paths takes the kernel bar.

---

## Advisory-lens lifecycle

A new reviewer lens (e.g. design-language, security) enters the pipeline as **ADVISORY**: it runs on every change its dispatch row matches, its findings are recorded in the review record, and it **cannot block a merge**. Promotion to gating — or removal — is an owner decision made on the recorded evidence after a trial of roughly 10 PRs. Precedent: the #197 smoke gate's two-stage promotion (`DESIGN.md` § "Empirical smoke gate"), which ran every push as signal before becoming a required check.

**Security escalation exception:** a security-lens finding of severity major or blocker immediately flags the change `security`, and the security-flagged bar in `## Reviewer count by artifact` applies to that change: ≥3 independent reviewers, 2-of-3 majority — or ≥3 all-must-PASS when the change is also system-level. A security hole must be able to block even during a lens trial — the advisory status governs the lens's routine findings, never a live vulnerability.

---

## Trivial dep-bump path (base-tier waiver)

**Not a dispatch-table row.** Every row in `## Which reviews does this change need?` below is additive to the base review for the change's risk tier — a lens never replaces the PR reviewer or the design-philosophy gate. This section is different in kind: a **base-tier waiver**, the one case where the base review itself does not run, because the change class already merges with no review at all when Dependabot authors the identical diff (`CLAUDE.md` § "Dependency updates (Dependabot)"). Keeping a hand-built commit of the same class inside the base review would cost more ceremony for the identical change purely because of who typed it.

**Eligibility (all three, recomputed from the staged tree — never attested):**

1. The staged paths are exactly a non-empty subset of `{package.json, package-lock.json}`, and `package.json` is among them (a lockfile-only diff stays `standard`, fail closed).
2. Every direct dependency whose version differs between `HEAD:package.json` and the staged copy classifies `auto` under the shared tier logic (`tools/classify-dep-pr-core.ps1`) — wedding-critical deps and prod majors can never qualify.
3. The commit subject starts with the fixed prefix `chore(deps): `.

**When all three hold, green CI alone gates the merge** — no PR reviewer, no design-philosophy reviewer, no issue-review — mechanically enforced by `tools/classify-trivial-commit.ps1` plus the `.githooks/pre-commit` / `.githooks/commit-msg` exemption branches. Any other condition takes the full gate for that risk tier, unchanged. Full design, the version-adapter fail-closed rules, and the ledger consequence (a merge with no `governance-ledger` comment harvests as `reviews: []`, exactly like a Dependabot auto-merge already does): `DESIGN.md` § "Trivial dep-bump gate (#448)".

---

## Which reviews does this change need?

Path-based and mechanical — no judgment calls. Every row whose paths the change touches applies; a change matching multiple rows runs every matched lens, and any kernel path takes the whole change to the kernel bar. **A manifest-only dependency bump may instead qualify for the `## Trivial dep-bump path (base-tier waiver)` above, which waives the base review entirely rather than adding a lens to it — check that section first for `package.json`/`package-lock.json`-only changes.**

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

## Finding disposition — fix in place, drop, or defer (#514)

The section above answers a narrow question that only fires at the 3-round soft cap: is a
_remaining_ defect consequential or inconsequential. This section answers a broader question that
applies at **every** round, from the first finding onward: what happens to a finding once it is
raised — is it fixed now, dropped, or filed as a new issue. The two share one underlying test — real
defect vs. taste — this section just applies it to routing from round 1, not only after the cap
trips.

Every review finding takes exactly one of three dispositions.

**1. Fix in place — mandatory for an in-scope-fixable defect.**

A finding is _in-scope-fixable_ when both hold:

- it is a real defect, not taste (the taste test is disposition 2, below); and
- fixing it changes only the work under review — its own diff, its touched files, or a direct
  consequence of the change — and the fix is bounded: not a new feature, not a large refactor.

An in-scope-fixable defect **must** be fixed in the current change before it merges. It may
**never** be deferred to a new GitHub issue or a `spawn_task` chip. Another review round is the
accepted cost of a correct fix, and it is cheaper than the issue → issue-review → implement →
PR-review → CI pipeline a deferral would spawn — a pipeline that also locks the finding's file out
of concurrent development until it lands. **"I do not want another review round" is never a valid
reason to defer.** Neither is "it's trivial" — see the anti-pattern below.

**2. Drop — for taste.**

A finding that is a matter of opinion — both the implementer's and the reviewer's choices are
valid, with no functional, correctness, or comprehension impact — is dropped: not fixed, not filed.
These are the same criteria as the `## Stop condition — soft cap and severity gate` section's
`inconsequential` test above, so the two never drift: taste is dropped at round 1 exactly as it is
dropped at round 4. Taste is never escalated into a new issue merely because nobody wants to argue
about it further.

**3. Defer to a new issue — only for genuinely separable scope.**

A finding may become a new GitHub issue only if fixing it requires genuinely separable new scope:

- a different feature than the one under review;
- a large or risky refactor that would itself need its own review cycle; or
- a pre-existing defect in code this change does not touch.

A `spawn_task` chip is never the vehicle for a review finding — GitHub issues are the single source
of truth for tracked work. "I do not want another round" is excluded as a reason here exactly as in
disposition 1 above — deferral is earned by the scope being genuinely separable, never by review
fatigue.

**Anti-pattern — "trivial" gets filed, not fixed.** The tell: a finding is labelled "trivial" or
"minor" and then routed to a new issue or a `spawn_task` chip instead of being fixed, on the theory
that something this small isn't worth another round. This is backwards. A trivial-and-fixable
finding is the _exact_ case disposition 1 requires be fixed on the spot — the smaller the fix, the
worse a whole downstream pipeline is as its vehicle for landing it. Severity labels do not decide
disposition; only in-scope-fixable vs. genuinely-separable-scope does. "Trivial" is evidence for
fix-in-place, never for defer.

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

**Worked example — defer to a new issue.** A reviewer finds: "`src/services/scoring.js`, untouched
by this PR, computes tie-breaks with a comparator that silently mis-ranks entries sharing a
timestamp — unrelated to the badge-catalog change under review." The defect lives in code this
change never touches, and fixing it is a separate correctness fix to a different subsystem with its
own test surface. Disposition: defer to a new GitHub issue (filed via `skills/capture-system-defect.md`
if it is a machinery/process defect, or `skills/issue-create.md` for a product defect) — genuinely
separable scope, not this change's job to carry.
