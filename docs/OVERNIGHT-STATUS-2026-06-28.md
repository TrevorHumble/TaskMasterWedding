# Overnight status & resume plan — 2026-06-28

> **Superseded 2026-06-28 (morning).** The overnight blocker is cleared, the repo guardrails are fixed, and the goals session is done — the North Star is confirmed in [`north-star.md`](north-star.md). Kept as a point-in-time record; the "goals pending / do not finalize" notes below were true overnight only.

Working-state handoff so a fresh/compacted instance can resume precisely. Owner (Trevor) is asleep; goals/design session is in the morning — do NOT finalize product goals, North Star, or visual design.

## Blocker right now

**Anthropic monthly spend limit hit** → spawning subagents / Workflows fails with "You've hit your monthly spend limit". The main loop, git, gh, npm, and the local app all still work. Until the limit is raised (claude.ai/settings/usage), do remaining work **single-threaded in the main loop** (no Agent/Workflow calls). Re-check by attempting one cheap agent; if it still errors, stay main-loop-only.

## Repo / environment

- GitHub repo: `TrevorHumble/TaskMasterWedding` (https://github.com/TrevorHumble/TaskMasterWedding). Local: `C:\wedding-scavenger-hunt` (git remote `origin`).
- gh CLI: `C:\Program Files\GitHub CLI\gh.exe` (full path; authed, scopes repo+workflow). Shell: PowerShell (no `&&`/`||`).
- Node 24 local; CI uses Node 20. `.env` exists locally (has COOKIE_SECRET); `data/` has a demo guest "Ava" (token `demo`) + photos. `data/`, `.env`, `node_modules/` are gitignored. A dev server may still be running on :3000 (background task).
- Commit gate (`.githooks/pre-commit`) is shipped but NOT armed in my working copy (core.hooksPath unset), so commits aren't blocked. It self-arms on next Claude Code session via `.claude/hooks/session-greeting.ps1`.

## Done

1. **Baseline** committed + pushed (as-built app).
2. **PR #1 (scaffold) MERGED to main** (`main` is green for lint/test/commit-gate-integrity):
   - Orchestrator framework ported Blender→Node: `standards/`, `agents/` (reviewers, orchestrator, severity-adjudicator), `skills/`, `tools/`, `.githooks/pre-commit`, `.gitattributes`, `.claude/hooks/*` + `settings.json`.
   - CI/CD: `.github/workflows/ci.yml` (commit-gate integrity + ESLint + Prettier + Vitest coverage), `codeql.yml` (javascript), `dependabot.yml` (actions + npm).
   - Lint/format/test: `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `vitest.config.mjs`, `tests/smoke.test.js`, package.json scripts (`lint`, `format`, `test`, `test:coverage`) + devDeps. Repo-wide prettier baseline applied. **ESLint: 0 errors, 22 warnings.**
   - Docs: README, CLAUDE.md, AGENTS.md, LICENSE (MIT), DESIGN.md, PLAN.md, BUILDLOG.md, docs/architecture.md. North Star = CUSTOMIZE placeholder (goals pending).
3. **Adversarial review COMPLETE** → `docs/reviews/2026-06-28-adversarial-review.{md,json}`. Bias-gated, 9 reviewers (arch×3, sec×2, test×2, ux×2), bias gate CLEAN, all FAIL. **60 findings: 11 blocker, 23 major, rest minor/nit; 26 confirmed by ≥2 reviewers.** Verdict: **salvageable via refactor, not rewrite** (defects are localized, not structural rot).
4. **GitHub labels created**: severity:blocker/major/minor, area:security/ux/testability/refactor/correctness, from-adversarial-review.
5. CodeQL default-setup disabled (advanced workflow supersedes). The one-time "CodeQL fail 8s" on PR#1 was the no-base-analysis first run; should clear now main has a baseline.

## NOT done (the remaining plan, prioritized)

Failed workflows are re-runnable once budget is restored (cached agents return instantly):

- Plans: `Workflow({scriptPath:"...workflows/scripts/taskmaster-plans-wf_478138a3-bd2.js", resumeFromRunId:"wf_478138a3-bd2"})`
- Issues: `Workflow({scriptPath:"...workflows/scripts/taskmaster-issues-wf_53ede5c9-0e8.js", resumeFromRunId:"wf_53ede5c9-0e8"})`
  (Full paths under `C:\Users\thumb\.claude\projects\C--wedding-scavenger-hunt\...\workflows\scripts\`.) Both fully defined the work; they only failed on the spend limit. If budget stays limited, do these in the main loop instead.

### P1 — Refactor plan + test plan (docs)

Write `docs/refactor-plan.md` and `docs/test-plan.md` from the 60 findings. Workstreams (sequence matters):

1. **Testability seams** (prereq for tests): db factory + `:memory:` + env-overridable `DATA_DIR`/`DB_PATH` [db-seam]; `createApp()` + `require.main` guard [createapp]; service factories (scoring/photos/export/auth) [service-seams].
2. **Test suite** to 80% meaningful coverage + turn on CI gate [test-suite] — depends on #1.
3. **Security**: CSRF; remove hardcoded admin pw + login leak; helmet headers; login rate-limit + strong pw; guest session ≠ QR token; photo-serving auth + real takedown removal; revocable admin session; HTTPS/secure cookies + fail-closed secret; CSV/formula injection in export.
4. **Visible correctness/bugs**: gallery photos + lightbox; nested `<main>`; guest CSS-class mismatch; admin CSS-class mismatch; task-deletion orphan files; centralize scoring/points + bonus-clamp; de-scaffold bootstrap; upload-config single-source + avatar parity + thumb naming.
5. **UX-usability** (NOT visual redesign): duplicate flash; forced-camera `capture`; tap targets/button spacing; client upload validation; HEIC avatar accept.
6. **Cleanup batch** + **lint-to-zero** (`--max-warnings=0`).
   Test plan: db-factory/:memory:, createApp+supertest, injected clock/rng; target scoring thresholds (grant at exactly 5/10/15, revoke on takedown), getPoints=completed+clamped bonus, export xlsx values + formula-injection neutralization, gallery thumbnail has working src, auth gating. Mutation/tamper check. Ramp CI coverage gate to 80%.

### P2 — Create ~27 GitHub issues (issue-standards: user story, Given/When/Then incl ≥1 behavioral, impl plan ≥3 steps w/ file paths, Depends/Blocks/Touches). Apply labels + `from-adversarial-review`, link the review file. The exact spec list (key · severity · tier · title) is the SPECS array in the issues workflow script (recoverable) — summary:

- BLOCKERS (ready): csrf; gallery; main-tags; admin-pw; guest-css; db-seam; createapp.
- MAJORS (ready): admin-css; service-seams; scoring-owner; descaffold; upload-config; task-del-files; csv-injection; helmet; login-hardening; guest-session; photo-access; admin-session; https-cookies; test-suite; upload-ux; flash-dup.
- MINORS (ready): tap-targets; lint-zero; mime-validate.
- BACKLOG: cleanup-batch; ux-polish-batch.

### P3 — Fix PRs through the Ralph loop (issue → impl-plan review → implement → reviewer-pr → PR). Prioritize visible + safe:

1. **gallery/photo blocker** — `src/routes/community.js` pass `pageScript:'gallery.js'` in the `render('gallery')` (~line 145) and `render('public-profile')` (~line 237) calls; fix lightbox: `src/public/js/gallery.js` toggle `.classList.add/remove('open')` instead of `hidden` (CSS shows via `.lightbox.open`); add a real `src` fallback to thumbnails. **This is THE broken-photos bug.**
2. **guest CSS mismatch** [guest-css] — align view class names to the ones `theme.css` actually defines (form-row→form-group, btn--primary→.btn, task-row→.task-item, leaderboard-list→the `.leaderboard` table, progress-bar→.progress). Makes the ugly/unstyled pages render. NOT a redesign.
3. **admin-pw** — `scripts/set-admin-password.js` drop hardcoded `ButtMonster` default (require arg); `src/routes/auth.js:~156` stop printing the command/password to unauth visitors. Rotate.
4. **helmet** + **csrf** + **flash-dup** + **capture removal** + **tap-targets/spacing** (Trevor explicitly wants button spacing fixed).
5. Then de-scaffold, scoring-owner, upload-config, testability seams, test suite.
   Merge policy: infra/bugfix/security PRs may merge on adversarial-review PASS + CI green (owner is final eye on result, not code). Anything touching product direction/visual design → leave as open PR for Trevor.

### P4 — Branch protection on `main`: require PR + status checks `commit-gate-integrity`, `lint`, `test` (NOT CodeQL, which can lag). `gh api repos/TrevorHumble/TaskMasterWedding/branches/main/protection -X PUT ...`.

### P5 — Morning briefing for Trevor (this file + a short chat summary). Honest about shipped-vs-queued.

## Notes / decisions made

- PR-based flow (Trevor wants PRs). Commit gate shipped dormant so overnight commits aren't blocked.
- Confirmed photo root cause: gallery.js never loads (no `pageScript`) + lightbox `.open` class never added.
- The "ugly UI" is largely the CSS-class-mismatch blocker (markup references classes absent from theme.css) — a correctness fix, separate from Trevor's design work.
