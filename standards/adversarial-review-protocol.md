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
fail-closed, no third tie-breaker needed.) This ≥3 / 2-of-3 floor applies to **high-stakes** reviews as defined in `## Reviewer count by artifact`; routine code uses the panel rule defined there and is not governed by this floor.

---

## Reviewer count by artifact

Reviewer count scales to risk. Every change resolves to exactly one count-rule via this **precedence order — evaluate system-level → high-stakes → routine, first match wins:**

- **Issue / plan** → exactly **1** Opus reviewer (`reviewer-issue`). Never a panel of duplicate issue-reviewers. The additive architecture gate (`reviewer-architecture`) fires for system-level / new-component issues — it is a distinct gate, not a second issue-reviewer.
- **System-level change** — touches the governing-artifact surface (see `DESIGN.md`) → see `## Self-modification bar` for the two-independent-both-PASS threshold. **If a system-level change is also security-flagged**, the resolved rule is stricter: **≥3 independent reviewers, all must PASS** — never weaker than either the self-modification bar or the high-stakes floor.
- **High-stakes code** (non-system-level) — security-flagged, or a change the orchestrator judges safety- or correctness-critical beyond routine → the `## Independence` floor of **≥3 reviewers, 2-of-3 majority**. "High-stakes" means security-flagged or explicitly escalated by the orchestrator; the defining criterion is that it is **security-flagged**.
- **Routine code** — none of the above → round-1 panel of **2–5 reviewers in parallel, judged unanimous-PASS** (any FAIL → fix and re-review); rounds 2+ use **1 fresh reviewer** each round. The rounds-2+-single rule does **not** apply to system-level changes: for a system-level change, the round that produces the accepted tree must carry two independent PASSes on that exact tree.

The rounds-2+-single optimization applies to non-system-level reviews only. For system-level changes, a single rounds-2+ reviewer may run to surface FAILs early, but a PASS is never recorded on fewer than two independent PASSes for the final tree (evidence is tree-bound).

The "up to 5" figure is the round-1 panel size, not a round count. The 3-round soft cap and severity adjudicator (`## Stop condition — soft cap and severity gate`) remain unchanged.

Reviewers remain **Opus** — model is not a savings lever. A reviewer must run on a different, non-weaker model than the implementer; `standards/agent-standards.md` makes Opus required for a gate. Savings come from reviewer _count_ only.

---

## research-first

Before judging, the reviewer establishes the _current_ best-practice yardstick for
the area (with dated citations). Grading against stale priors is a calibration
failure.

---

## Bias gate

Before fanning out to N reviewers, spawn one independent agent to audit the briefing
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

## Fable self-certification (full exception)

Fable may self-certify any issue or PR it authors/implements, at **every** risk tier —
routine, system-level, security-flagged/high-stakes, and self-modification. No
independent reviewer is required at any tier for Fable-authored work.

**Scope.** This applies only to Fable. Every other implementer remains bound by the
rest of this protocol at full strength, unchanged.

**Supersession.** For Fable only, this section supersedes:

- `## Independence` — the no-self-review rule does not apply to Fable; Fable's own
  recorded PASS is sufficient.
- `## Self-modification bar` — the two-independent-reviewer, both-must-PASS
  requirement does not apply to Fable; Fable's own self-cert evidence satisfies the
  bar mechanically (see below).

No other section of this protocol is altered. The reviewer-count precedence order,
the bias gate, and the soft-cap severity gate continue to apply in full to every
non-Fable implementer.

**Permanence.** This is owner-authorized, standing policy — not a trial, not
time-boxed, no expiry, no review-window language. It does not sunset and is not
subject to periodic re-authorization.

**CI remains the only gate.** `npm run lint`, `npm run format:check`, and
`npm run test:coverage` are unaffected by this exception and still run and still
gate Fable's work exactly as they gate everyone else's. This exception removes only
the independent-adversarial-review requirement — it does not touch, weaken, or
bypass any mechanical CI check.

**Mechanism.** Fable's self-certification is recorded as evidence, not hand-waved:
`tools/persist-self-certification.ps1` writes `Count` distinct evidence files with
`reviewer_id` values `fable-self-1` … `fable-self-<Count>`, `role: 'self-cert'`,
`verdict: 'PASS'` — to `.review_state/issue-reviews/<N>/` (issue mode, schema
`irev1`) or `.review_state/reviews/<tree_oid>/` (tree mode, schema `rev1`). Because
`Reduce-Verdicts` (`tools/verdict-core.ps1`) counts distinct `reviewer_id`s with a
PASS against `Required` without inspecting `role`, `Count` self-cert records
mechanically satisfy any `Required` bar, including the system-level `Required = 2`
bar from `Get-RequiredBar`, with no code change needed to the counting kernel
itself. For a system-level tree, `tools/persist-bias-gate.ps1 -SelfCertify` writes
the corresponding passing `bg1` bias-gate artifact attributed to `fable-self`, so a
Fable-certified system-level tree does not additionally require an independent
bias-gate agent run.

The `role: 'self-cert'` field keeps Fable's self-certified evidence honestly
distinguishable from an independent reviewer's PASS in the audit trail — the
exception is documented and visible in the evidence itself, not hidden behind a
free-text `reviewer_id` that could be confused with a real reviewer.
