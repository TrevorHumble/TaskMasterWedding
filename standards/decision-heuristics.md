# Decision Heuristics Standard

**As a Sonnet implementation agent or Opus orchestrator facing a judgment call this pipeline's mechanical steps do not settle, I need an explicit procedure for each recurring call, so that I reach the decision a stronger reasoner would reach instead of guessing or punting.**

**Scope:** every agent operating in this repo. Referenced by `agents/orchestrator.md` and `agents/implementation-agent.md`.

---

## Decide from the goals

When a decision surfaces mid-task, run this procedure before considering asking anyone:

1. **Restate the decision in one sentence**, naming the two (or more) concrete options. If you cannot name the options, you have a research gap, not a decision — go find the options first.
2. **Find the governing constraint.** Check, in order: the issue's acceptance criteria, `CLAUDE.md`, the North Star goals (`docs/north-star.md`), and the relevant standard. One of them usually settles it outright.
3. **If settled → act.** Record nothing beyond the normal trail. A question answerable by re-reading the goals is not a question for the owner.
4. **If it is a pure tradeoff** (both options satisfy the constraints) → pick the option that is cheaper to reverse; if equally reversible, pick the one touching fewer files. State the choice and the reason in one line where the work is recorded (PR body or issue comment) and move on.
5. **Surface to the owner ONLY when all three hold:** the action is irreversible, it is owner-exclusive (spends money, publishes outward, deletes owner data, changes owner-recorded intent), AND steps 2–4 did not settle it. Surface as a one-line non-blocking note; keep working on independent items.

> **Example (settled by constraint — act):** an implementer must choose between storing a new admin flag in `data/` or in a new top-level folder. `CLAUDE.md` says runtime state lives in gitignored `data/` and paths come from `config.js`. Settled — use `data/` via `config.js`, no question asked.

> **Example (pure tradeoff — pick reversible):** two working ways to mark a retired policy section: delete it or prepend a dated retirement notice. Both satisfy the standard; deletion loses history and is harder to reverse. Pick the notice, note the reason in the PR body, continue.

> **Example (surface — owner-only):** a review finds a seeded task title misspells a guest-facing word. Correcting seeded owner content changes what the owner chose to display — irreversible in the "owner's intent" sense and not derivable from the goals. Fix nothing; surface the one-line note and continue with independent work.

---

## Verify before you claim

"Done" is a claim about the world, and claims need evidence. Before reporting any task complete:

1. Re-read the acceptance criteria of the issue you implemented.
2. For **each** criterion, run the check it implies — a grep for the required string, the test that asserts the output value, the command whose exit code proves the gate holds.
3. Report per-criterion evidence. A claim without a run is a defect. Use this **per-criterion evidence** table (copy it into the handoff message or PR body):

```text
| Criterion (short form)          | Check run                                  | Observed result |
| ------------------------------- | ------------------------------------------ | --------------- |
| file contains phrase X          | Select-String -Path <file> -Pattern "X"    | 1 match, line N |
| input P returns output Q        | npm test -- <suite> (test name)            | pass, Q asserted|
```

> **Example:** an agent finishes an edit and is about to reply "the frontmatter no longer says direct-push." Wrong — that is a belief. Right — run `Select-String -Path skills/github-write.md -Pattern "direct-push"`, observe zero matches, and report the command plus the zero-match result.

If any criterion cannot be checked mechanically, say so explicitly in the report — do not substitute confidence for the missing check.

---

## Evidence before state change

Before any command that changes state — deleting a file, `git reset`, rewriting config, killing a process, force-pushing — stop and confirm the evidence supports **that specific action**, not just "something in this area is wrong."

1. State the observed symptom in one line.
2. State the mechanism by which the planned command fixes that symptom.
3. If the mechanism is "this usually fixes it" rather than a traced cause → gather one more observation first (read the log line, print the value, check the file's actual state).

> **Example (pattern-matched wrong fix):** a commit is blocked at `pre-commit`. The pattern-match reflex says "re-run `tools/setup-hooks.ps1`" — but the hook being _live_ is exactly why it blocked. The traced cause (read the hook's stderr) is a missing PASS verdict for the staged tree; the correct action is recording the genuine review verdict, not reinstalling hooks. The reflex action would have changed state without addressing the cause.

Destructive commands with no in-loop undo (deleting owner data, force-push over shared history) are never justified by inference alone — they need direct observation of the target's current state first.

---

## Scope discipline

The issue's `Touches` list is the contract. Work stays inside it.

1. Touch only the files the issue names. A file the plan forgot but the acceptance criteria require is in scope; anything else is not.
2. A defect you notice outside scope — a stale doc, a misnamed variable, a broken reference — is captured through `skills/capture-system-defect.md` and left unfixed in this change.
3. Never widen an issue mid-implementation because more improvement "would be easy here." Adjacent improvement is a new issue.

> **Example:** while editing `agents/reviewer-pr.md` for issue N, you notice `agents/reviewer-agent.md` has the same stale sentence. Editing it feels free — but it is outside `Touches`, invisible to N's reviewers, and widens the diff others must reason about. File the capture, fix only the named file.

---

## When stuck

Being stuck is a state to exit by procedure, not by looping. The ladder — take the rungs in order:

1. **Re-read the issue** — the acceptance criteria and plan step you are on. Most stuckness is a drifted goal.
2. **Check prior art in this repo** — an existing skill, tool script, test, or standard has usually solved the shape of this problem; steal it.
3. **Check the dependency's own documentation** for the API you are fighting — do not guess signatures from memory.
4. **Form two competing hypotheses** about the cause, name them explicitly, and test the cheaper one. A hypothesis you cannot test cheaply is a hypothesis to write down, not to act on.
5. **Surface to the orchestrator/owner** — state what was tried (rungs 1–4), what each showed, and the one question whose answer unblocks you.

Hard cap: **three attempts on one hypothesis** is the anti-pattern line. If the same fix idea has failed three times, the hypothesis is wrong — return to rung 4 and switch hypotheses, or climb to rung 5.

> **Example (anti-pattern):** a test fails; an agent re-orders the same mock setup five times, re-running the suite each time. Three attempts in, the ladder demands a second hypothesis — e.g., "the module under test caches state between runs" — which one `console.log` would have confirmed on attempt four.
