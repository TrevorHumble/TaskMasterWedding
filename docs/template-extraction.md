# Template Extraction Map

**As the owner planning a template repo built from this project's pipeline, I need a written inventory of which files are portable governance machinery and which are wedding-specific content, so that extraction starts from a checked list instead of a fresh audit.**

Snapshot date: 2026-07-06. Verify paths against the tree at extraction time; this list is the starting checklist, not a substitute for the check.

## Portable

Governance and process machinery reusable as-is in any AI-built project:

- `standards/adversarial-review-protocol.md` — reviewer counts, bias gate, severity gate, independence rules; domain-free
- `standards/design-philosophy.md` and `standards/design-philosophy-examples.md` — Ousterhout-derived review standard plus worked examples
- `standards/documentation-standards.md` — doc quality bar, banned-word list, doc split
- `standards/issue-standards.md`, `standards/agent-standards.md`, `standards/skill-standards.md` — artifact quality bars
- `standards/decision-heuristics.md`, `standards/edge-case-checklist.md` — agent judgment procedures
- `.githooks/pre-commit`, `.githooks/commit-msg` — evidence-gated commits; git-plumbing only, no domain logic
- `tools/` gate scripts — `verdict-core.ps1`, `validate-verdict.ps1`, `review_verdict.ps1`, `persist-review.ps1`, `persist-issue-review.ps1`, `persist-bias-gate.ps1`, `persist-adjudication.ps1`, `persist-self-certification.ps1`, `review-runner.ps1`, `review-verdict.schema.md`, `check-gate.ps1`, `check-issue-reviewed.ps1`, `check-enforcement.ps1`, `setup-hooks.ps1`, `assert-worktree.ps1`, `new-agent-worktree.ps1`, `clear-issue-marker.ps1`, `issue-core.ps1`, `start-run.ps1`, `stop-run.ps1`
- `agents/*.md` — all thirteen pipeline-role definitions (orchestrator, implementation, researcher, reviewers, adjudicator)
- `skills/*.md` — the pipeline skills (issue-create, spawn-adversarial-review, capture-system-defect, github-write, agent-writer, skill-writer, research-prior-art, session-brief, update-claude-md, write-documentation)
- `.claude/commands/build.md` — the `/build` pipeline entry point
- `.github/workflows/` server-side backstops — the CI jobs `commit-gate-integrity` and `merge-association`, and the separate `issue-guard.yml` workflow (job name `guard`); `lint`/`test` generalize with the stack
- The system-level-change concept (`DESIGN.md` § "System-level change (definition)" + the regex in `tools/verdict-core.ps1`) — the path list matches any repo using this folder layout

## Wedding-specific

Content a template strips or replaces:

- `docs/north-star.md` — couple names, date, guest count, the four goals
- `CONTEXT.md` — domain vocabulary (Guest, Task, Submission, badge names, branding)
- `CLAUDE.md` North Star section — restates the wedding goals inline
- `README.md`, `package.json` name/description — app identity
- The wedding-critical dependency list (`multer`, `sharp`, `ejs`, `better-sqlite3`, `bcryptjs`, `archiver`) in `CLAUDE.md` § Dependency updates and `tools/classify-dep-pr.ps1`
- `src/`, `tests/`, `scripts/`, `fixtures/` — the app itself
- `DESIGN.md` decision entries — the _format_ (decision, rationale, honest bar) is the portable pattern; the entries are this app's history
- The `#197` smoke gate (`scripts/smoke.js`) — behavior-verification-in-CI is the portable idea; the probes are app-specific

## Parameterization points

Hard-coded values a template turns into variables:

- `tools/audit-issue-markers.ps1` — default `-Repo 'TrevorHumble/TaskMasterWedding'`
- `tools/classify-dep-pr.ps1` — the wedding-critical dependency list (drift-guarded by `tests/classify-dep-pr.test.js`, which moves with it)
- `CLAUDE.md` — North Star restatement and the dependency-tier summary
- `agents/reviewer-tracker-sync.md` — the epic issue number (#126) it audits against
- `.github/workflows/` — any job pinned to this repo's check-run names (see `tools/apply-branch-protection.ps1`'s five base required checks)
- `tools/apply-branch-protection.ps1` — the required-check list (the repo slug is resolved at runtime via `gh repo view`, not hard-coded)
