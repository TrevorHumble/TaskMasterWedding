# DESIGN.md — Architecture decisions and rationale

Why the app is built the way it is. Decisions and tradeoffs, not getting-started instructions (those are in `README.md`) and not agent rules (those are in `CLAUDE.md`).

**North Star / goals:** confirmed. The product goals live in [`docs/north-star.md`](docs/north-star.md) (one-screen summary in [`CLAUDE.md`](CLAUDE.md)). The decisions recorded below serve those goals — most directly getting any guest in fast and keeping the app standing under the whole guest list at once (Goal A). One goal-driven decision is still **open and unbuilt**: Goal C's contained sharing (scoping content to the right audience). Moderation today is takedown-only (see "Photos: … takedown over delete" below); the audience-split design will be recorded here once chosen. The app must be live for guests by **Friday, Aug 7, 2026**.

## Table of contents

**Live app architecture** — how the deployed guest/admin app actually works.

- [Constraints that shaped the design](#constraints-that-shaped-the-design)
- Key decisions (app architecture):
  - [Single SQLite file via better-sqlite3 (synchronous)](#single-sqlite-file-via-better-sqlite3-synchronous)
  - [Server-rendered EJS, vanilla client JS, no build step](#server-rendered-ejs-vanilla-client-js-no-build-step)
  - [guests.token: an internal session credential, never distributed (#244)](#gueststoken-an-internal-session-credential-never-distributed-244)
  - [Guest identity: contact as the account key, plaintext re-entry PIN (#239)](#guest-identity-contact-as-the-account-key-plaintext-re-entry-pin-239)
  - [Single admin password, bcrypt hash on disk](#single-admin-password-bcrypt-hash-on-disk)
  - [COOKIE_SECRET must be fixed for the event](#cookie_secret-must-be-fixed-for-the-event)
  - [Guest sessions are rolling and long-lived, admin is not (#242)](#guest-sessions-are-rolling-and-long-lived-admin-is-not-242)
  - [Photos: multer intake, sharp normalization, takedown over delete](#photos-multer-intake-sharp-normalization-takedown-over-delete)
  - [Avatar processing: a dedicated small avatar gate, not a share of the upload semaphore (#929)](#avatar-processing-a-dedicated-small-avatar-gate-not-a-share-of-the-upload-semaphore-929)
  - [HEIC accepted and converted to JPEG at intake (#281, supersedes #188's rejection)](#heic-accepted-and-converted-to-jpeg-at-intake-281-supersedes-188s-rejection)
  - [sharp 0.35.2 SAC block was a reputation-lag, now cleared (#304)](#sharp-0352-sac-block-was-a-reputation-lag-now-cleared-304)
  - [Scoring derived, not stored](#scoring-derived-not-stored)
  - [Badge thresholds live in scoring.js; custom badges reverse the earlier "fixed catalog" decision](#badge-thresholds-live-in-scoringjs-custom-badges-reverse-the-earlier-fixed-catalog-decision)
  - [Task badges: one badge row per task, awards carry the variable data (#483)](#task-badges-one-badge-row-per-task-awards-carry-the-variable-data-483)
  - [Two UNIQUE constraints enforce the core rules in the schema](#two-unique-constraints-enforce-the-core-rules-in-the-schema)
  - [Export as a ZIP + xlsx, then discard](#export-as-a-zip-xlsx-then-discard)
  - [Hosted deployment](#hosted-deployment)
  - [CSRF tokens and security headers: implemented (#284)](#csrf-tokens-and-security-headers-implemented-284)
  - [Rate limiting and persistent admin lockout (#283)](#rate-limiting-and-persistent-admin-lockout-283)
- [ADR: Backup split — database and photos get opposite cadences (#558)](#adr-backup-split-database-and-photos-get-opposite-cadences-558)
- Feature ADRs (one per shipped guest/admin feature):
  - [Host checklist: one row-definition module, feature-detected rows (#646)](#host-checklist-one-row-definition-module-feature-detected-rows-646)
  - [Memory-day bonus: event-local day math in JS, leaderboard's JS re-sort (#656)](#memory-day-bonus-event-local-day-math-in-js-leaderboards-js-re-sort-656)
  - [Flash guest marker: shared shape, separate hue, no floor, no neutral fallback (#762)](#flash-guest-marker-shared-shape-separate-hue-no-floor-no-neutral-fallback-762)
  - [Recap: derived events vs. written events, and the badge-moment stamp (#644)](#recap-derived-events-vs-written-events-and-the-badge-moment-stamp-644)
  - [Admin Photos, task-scoped: taken-down included, feed narrowed, H1 reads the scope (#748)](#admin-photos-task-scoped-taken-down-included-feed-narrowed-h1-reads-the-scope-748)
  - [Badge celebration priority derived from the catalog, not a code list (#714)](#badge-celebration-priority-derived-from-the-catalog-not-a-code-list-714)
  - [Community guard completeness: stack-derived, not hand-maintained (#574)](#community-guard-completeness-stack-derived-not-hand-maintained-574)
  - [Lucky task: its own columns, no special_mode member, banked-not-derived, last in the walk (#650)](#lucky-task-its-own-columns-no-special_mode-member-banked-not-derived-last-in-the-walk-650)
  - [Gallery live search: one parameterized wiring serves both grouped views (#527)](#gallery-live-search-one-parameterized-wiring-serves-both-grouped-views-527)
  - [Flash task: HOST surface — sentinel radio, one no-op rule, candidate-selection date math (#763)](#flash-task-host-surface-sentinel-radio-one-no-op-rule-candidate-selection-date-math-763)
  - [Rank & award: a separate page, one-badge-system consolidation, client-side-only draft state (#661)](#rank-award-a-separate-page-one-badge-system-consolidation-client-side-only-draft-state-661)
  - [Bug-report lifecycle: additive `status` over a `resolved` rebuild, one count owner (#686)](#bug-report-lifecycle-additive-status-over-a-resolved-rebuild-one-count-owner-686)
  - [Crowd favorites: derived not materialized, standard-competition rank, one absorbed ranker (#625)](#crowd-favorites-derived-not-materialized-standard-competition-rank-one-absorbed-ranker-625)
  - [Crowd favorites: per-guest dedupe reverses the no-cap sweep rule (#896)](#crowd-favorites-per-guest-dedupe-reverses-the-no-cap-sweep-rule-896)
  - [Crowd-favorite events: a per-guest placing-status diff, not a per-photo rank diff (#895)](#crowd-favorite-events-a-per-guest-placing-status-diff-not-a-per-photo-rank-diff-895)
  - [Crowd-favorite crown: a render-time marker, never a stored badge (#788)](#crowd-favorite-crown-a-render-time-marker-never-a-stored-badge-788)
  - [TOPLIKED: the Most Liked crown as a materialized, transferable badge (#817, widened by #821)](#topliked-the-most-liked-crown-as-a-materialized-transferable-badge-817-widened-by-821)
  - [Badge icon search tags: a public client-side data file, not server-rendered attributes (#903)](#badge-icon-search-tags-a-public-client-side-data-file-not-server-rendered-attributes-903)

**Retired governance history** — the AI-review pipeline's own evolution. Most of this machinery no
longer runs (see the teardown ADR); it is kept as a record of what was tried and why. A few entries
(the coverage-floor ratchet, the sonnet-only tier, wave governance, the visual-approval loop, Fable)
describe pipeline rules still in force today — recorded here as the history of how they came to be,
not as app architecture.

- Key decisions (process/governance):
  - [Merge policy: owner-merge boundary retired](#merge-policy-owner-merge-boundary-retired)
  - [Visual-approval loop reinstated (active screenshot gate) (#294) — SUPERSEDED by #378](#visual-approval-loop-reinstated-active-screenshot-gate-294-superseded-by-378)
  - [Visual-approval loop, live-preview mechanism (#378)](#visual-approval-loop-live-preview-mechanism-378)
  - [Commit gate: review evidence bound to the staged tree](#commit-gate-review-evidence-bound-to-the-staged-tree)
  - [Bias-gate and adjudication evidence artifacts (#47)](#bias-gate-and-adjudication-evidence-artifacts-47)
  - [Program-driven review runner (#128)](#program-driven-review-runner-128)
  - [Issue-review gate: every code commit names a reviewed issue (#46)](#issue-review-gate-every-code-commit-names-a-reviewed-issue-46)
  - [Issue-creation review marker: born `needs-issue-review`, cleared by a separate reader-gated tool (#62)](#issue-creation-review-marker-born-needs-issue-review-cleared-by-a-separate-reader-gated-tool-62)
  - [Worktree-per-agent isolation (#113)](#worktree-per-agent-isolation-113)
  - [Fetch-fresh worktrees, overlap-aware freshness, and wave alignment (#357)](#fetch-fresh-worktrees-overlap-aware-freshness-and-wave-alignment-357)
  - [Branch protection on main](#branch-protection-on-main)
  - [Review-artifact-present check (#48)](#review-artifact-present-check-48)
  - [Server-side issue-creation guard (#116)](#server-side-issue-creation-guard-116)
  - [Roadmap: board-derived, session-structured (#139)](#roadmap-board-derived-session-structured-139)
  - [Planning governance: agents tick status, the owner reshapes intent (#140)](#planning-governance-agents-tick-status-the-owner-reshapes-intent-140)
  - [Fable: available, owner-signal only (#453)](#fable-available-owner-signal-only-453)
  - [Empirical smoke gate (#197)](#empirical-smoke-gate-197)
  - [Review-cost overhaul: 1-reviewer routine rounds, batching, advisory lenses (#201, #218)](#review-cost-overhaul-1-reviewer-routine-rounds-batching-advisory-lenses-201-218)
  - [Governance ledger (#219): committed record, CI is the only writer](#governance-ledger-219-committed-record-ci-is-the-only-writer)
  - [BUILDLOG comment harvest (#447): per-merge entries move off hand-appended edits](#buildlog-comment-harvest-447-per-merge-entries-move-off-hand-appended-edits)
  - [Governance snapshots (#224): tagged states, exported surface + stats](#governance-snapshots-224-tagged-states-exported-surface-stats)
  - [Event mode (#220): wedding-day freeze with expiring flag and mandatory retro-review](#event-mode-220-wedding-day-freeze-with-expiring-flag-and-mandatory-retro-review)
  - [Trivial dep-bump gate (#448): recomputed, not attested](#trivial-dep-bump-gate-448-recomputed-not-attested)
  - [Coverage floors are a ratchet; mutation score is the quality signal (#198, #199)](#coverage-floors-are-a-ratchet-mutation-score-is-the-quality-signal-198-199)
  - [Wave governance (#310): grandfathering, owner-invoked wave review, doc-currency step](#wave-governance-310-grandfathering-owner-invoked-wave-review-doc-currency-step)
  - [Merge queue (#404)](#merge-queue-404)
  - [Sonnet-only run tier (#427)](#sonnet-only-run-tier-427)
  - [Acceptance criteria as a promise, not a rulebook (#541)](#acceptance-criteria-as-a-promise-not-a-rulebook-541)
  - [No severity adjudicator when the orchestrator concedes a rewrite (#540)](#no-severity-adjudicator-when-the-orchestrator-concedes-a-rewrite-540)
- [System-level change (definition)](#system-level-change-definition)
- [Security lens (#222)](#security-lens-222)
- [ADR: Governance teardown and freeze (#587)](#adr-governance-teardown-and-freeze-587)
- [ADR: Sonnet-only tier reinstated as reviewer judgment (#680)](#adr-sonnet-only-tier-reinstated-as-reviewer-judgment-680)
- [ADR: DESIGN.md carved out of the governance freeze (#707)](#adr-designmd-carved-out-of-the-governance-freeze-707)

## Constraints that shaped the design

- One small Linux host (VPS or PaaS volume) with a persistent disk and TLS terminated at a reverse proxy, running from before the welcome dinner until the post-event export.
- About 100 concurrent guests, all on phones, over the public internet.
- The couple and a non-developer admin still run it; setup is the `docs/deploy.md` runbook.
- Everything must be exportable after the event, then the host is torn down.

## Key decisions

### Single SQLite file via better-sqlite3 (synchronous)

One file at `data/app.db`, opened synchronously. No separate database server to install or babysit. better-sqlite3 ships prebuilt binaries for Node 20 on Windows x64. Synchronous calls keep route handlers linear and readable; at ~100 guests the load never justifies async DB plumbing. WAL journal mode and `foreign_keys = ON` are set on every open (`src/db.js`). The single-file model makes the hosted persistence boundary exactly `data/` plus the backup schedule (`scripts/backup.js`, scheduled per `docs/deploy.md`).

Tradeoff: synchronous DB calls block the event loop. Acceptable at this scale; would not be at thousands of concurrent users.

### Server-rendered EJS, vanilla client JS, no build step

Pages render on the server with EJS. The client side is plain JavaScript in `src/public/js/`. No bundler, no framework, no transpile step means nothing to build on the server, no toolchain to break days before the wedding.

### guests.token: an internal session credential, never distributed (#244)

A guest is identified by a random token, but it is purely internal machinery now: `guests.token` is an internal session credential, carried only inside the signed `gsid` cookie that `attachGuest` reads back on every request, and it is never distributed — never printed on a place-card, never put in a link, never shown to a guest at all. It started life as the opposite: issue #240's shared-signup redesign made the per-guest personal link redundant (every guest now enters through the same `GET /join` poster, described below), and issue #244 finished the retirement — the route that used to consume that personal link and sign someone in is now an unconditional redirect to `/join` that never looks the token up or sets a cookie, so an old printed card kept as a keepsake can't quietly still let someone in.

Sign-in still stores the token in a signed `gsid` cookie (via `cookie-parser` and `COOKIE_SECRET`, which stops cookie forgery), set by `POST /join` (new account) or `POST /login` (re-entry). No guest passwords, no separate account-creation step.

Tradeoff: anyone holding a valid `gsid` cookie can act as that guest — but since the token is never distributed and only ever set server-side after a contact+PIN check, the exposure is the same as any session cookie, not a shareable link.

### Guest identity: contact as the account key, plaintext re-entry PIN (#239)

A guest signs up with their email or phone number and a self-chosen 4-digit re-entry code. `guests.contact` (normalized via `src/services/identity.js`) is the account key — a partial unique index (`idx_guests_contact`, `WHERE contact IS NOT NULL`) enforces one contact maps to exactly one guest row, while legacy/seed rows with no contact still coexist freely.

**PIN is stored in plain text** in `guests.pin`, deliberately unhashed. The threat model is guest mischief — a guest fumbling or guessing another guest's 4-digit code — not database compromise: whoever already holds `data/app.db` already holds every plaintext `guests.token` credential and every uploaded photo, so hashing a 4-digit PIN buys no real protection against that actor. What plaintext buys instead is Goal C: the admin recovery panel (#243) can read a guest's PIN back out loud on the spot at the reception, with no reset flow, for a guest locked out on the wrong device.

### Single admin password, bcrypt hash on disk

The admin ("Task Master") authenticates with one password, hashed with bcryptjs into `data/admin.hash` (set by `scripts/set-admin-password.js`). Sign-in sets a signed `admin` cookie. One role, one secret, no user table for the admin side. The hash file is gitignored.

### COOKIE_SECRET must be fixed for the event

`config.js` now enforces this at boot instead of only advising it (#242): with `NODE_ENV=production` and no `COOKIE_SECRET`, the process throws before the config object is exported, so a misconfigured deployment fails to start rather than silently booting with a secret that regenerates on every restart. Outside production (dev/test) the original fallback remains — a random secret is generated and a warning printed — so a fresh clone still boots without any setup. For the deployment the secret is fixed in the host's environment (`.env` or the platform's secret store); the production hard-failure exists precisely so that requirement cannot be skipped by accident.

### Guest sessions are rolling and long-lived, admin is not (#242)

The guest `gsid` cookie lasts 400 days (`config.GUEST_COOKIE_MAX_AGE_MS`) — the longest Max-Age Chrome will honor — and is re-issued with a fresh `maxAge` on every authenticated request by `attachGuest` (`src/middleware/session.js`), so an active guest's session clock keeps resetting rather than counting down from sign-up. Staying signed in is the primary experience; the PIN re-entry flow (#241) is the fallback for an inactive guest whose cookie did lapse, or a new device. The admin cookie is a separate, unchanged 14-day lifetime (`config.ADMIN_COOKIE_MAX_AGE_MS`) with no rolling refresh — `cookieOpts()` (now the single owner of both cookies' shared attributes, exported from `src/middleware/session.js`) takes `maxAgeMs` as a parameter precisely so the two lifetimes can never drift onto the same literal by accident.

### Photos: multer intake, sharp normalization, takedown over delete

Uploads come in through multer; sharp produces a normalized full-size original plus a small thumbnail (`THUMB_WIDTH = 400`). Originals live in `data/uploads/`, thumbnails in `data/thumbs/`, served at `/uploads` and `/thumbs`. The admin "takes down" a photo by setting `taken_down = 1` rather than deleting the row, so a moderation action is reversible and the submission's history is preserved. A taken-down photo is hidden from the gallery, profiles, and scoring but can be restored.

### Avatar processing: a dedicated small avatar gate, not a share of the upload semaphore (#929)

`src/utils/upload-concurrency.js`'s `withUploadSlot`/`uploadSemaphore` (issue #311, `MAX_CONCURRENT_UPLOADS = 6`) bounds task-submit and memory-batch concurrency, but avatar processing — `src/services/photos/processing.js`'s `saveAvatar`, called from both `POST /join` and `POST /me/edit` — had no bound at all. A poster-rush burst of joins, each running sharp's `.rotate()` + `attention` crop (a full-raster materialization measured at ~325 MB per upload in practice, issue #856), could OOM the ~2 GB host and crash the process for every in-flight guest.

**Why not share `uploadSemaphore`:**

1. **The raster arithmetic doesn't fit.** Admitting avatars at `MAX_CONCURRENT_UPLOADS = 6` would peak at 6 × ~325 MB ≈ 1.95 GB — reproducing the exact OOM the gate exists to prevent, inside the "bound." A separate, smaller `AVATAR_CONCURRENCY` (default 2) peaks at 2 × ~325 MB ≈ 650 MB transient, alongside the unchanged task-upload pipeline.
2. **Head-of-line inversion.** `saveAvatar` runs the (process-wide-serialized) HEIC decode _before_ the sharp crop. An avatar holding a _shared_ slot while parked on that decode would stall the patient, unbounded task-submit/memory-batch waiters behind it — a guest's task photo delayed by someone's avatar, an inversion that does not exist today and must not be introduced by sharing the gate.

**Why the join rate limiter (`RATE_LIMIT_IP_MAX`) can't substitute:** that limiter is IP-keyed and deliberately generous (300/10min) to admit an entire venue-NAT'd reception scanning one poster within minutes — it bounds abuse, not concurrency. A hundred honest guests within the limit, all attaching an avatar in the same burst, is exactly the load this gate exists to survive; the rate limiter does nothing to shape it.

**Semantics are "skip, never stall," the opposite of `uploadSemaphore`'s "queue forever":** losing a task/memory upload is never acceptable (those queue with no depth bound); losing an avatar costs nothing — the guest can add one later from their profile, and the #716 starter point derives from `guests.avatar_path` whenever it's eventually set, not from a one-shot join-time award. `withAvatarSlot` (in `upload-concurrency.js`, alongside `withUploadSlot`) therefore fails fast on two bounds rather than queuing patiently: an immediate `AVATAR_QUEUE_BUSY` throw when the wait queue is already at `MAX_PENDING_AVATAR_WAITERS` (default 16), and an `AVATAR_SLOT_TIMEOUT` when an admitted wait doesn't clear within `AVATAR_SLOT_WAIT_MS` (default 10s — the most spinner an interactive join should make a guest absorb). Both failures flow into paths that already existed before this gate: `POST /join`'s existing catch around `trySaveAvatar` (`src/routes/auth.js`) silently drops the avatar and completes signup; `POST /me/edit`'s existing sharp-failure branch (`src/routes/guest.js`) produces its existing flash. No new guest-facing copy, no route changes — the gate wraps only the sharp pipeline inside `saveAvatar`, so both call sites are covered for free.

The HEIC conversion inside `saveAvatar` stays deliberately _outside_ `withAvatarSlot` — it already has its own decode-semaphore serialization, pixel cap, and per-guest rate limit (see "HEIC accepted and converted to JPEG at intake" below), and gating it too would be exactly the head-of-line inversion reason 2 above rules out.

### HEIC accepted and converted to JPEG at intake (#281, supersedes #188's rejection)

An iPhone (and a recent Samsung) hands over HEIC/HEIF photos by default. The prebuilt `sharp`/libvips binaries this app runs on cannot decode real HEVC-encoded HEIC — their bundled libheif has only an AV1 decoder (`sharp.format.heif.input.fileSuffix === ['.avif']`), and HEVC is excluded from the prebuilt binary for patent-licensing reasons. Issue #188 made the honest call at the time: reject HEIC at intake with actionable copy ("take a screenshot, or switch to Most Compatible") rather than store an original that could never be thumbnailed.

**What we do now:** `src/services/photos/heic.js` detects HEIC by sniffing the ISO-BMFF `ftyp` box's major brand (`heic`/`heix`/`heif`/`mif1`/`msf1`) from a file's leading bytes — not by declared mimetype, since the iOS/Android "Files" picker (and some third-party browsers) hand over a real HEIC under the generic `application/octet-stream` mimetype. A detected HEIC is decoded with `heic-convert` (a pure-JavaScript HEVC decoder — no native build tools, no external/paid service) and re-encoded to JPEG before the stored original, the thumbnail, the gallery, or the export ZIP ever see it. It is in-license and in-process: `heic-convert` is ISC-licensed and pulls in `libheif-js` (LGPL-3.0, dynamically linked as a normal npm dependency) and `jpeg-js` (BSD-3-Clause) — all permissive/LGPL, all running in-process, with no external or paid API. HEIC is invisible to the rest of the system: `ORIGINAL_RE`/`THUMB_RE` (the static-mount allowlist patterns) still match only `.jpg`/`.png`/`.webp`, because nothing else is ever written under those directories.

**Why `heic-convert` over rebuilding libvips:** the alternative — building or sourcing a libvips binary with an HEVC-capable libheif — means either compiling native code for the Windows host (no build tools on the event laptop, and the exact kind of native-binary fragility `DESIGN.md`'s "sharp 0.35.2 SAC block" entry above already burned a build on) or sourcing a third-party prebuilt binary of uncertain provenance days before the wedding. `heic-convert` is pure JS: `npm install` and it works, with no new binary surface for Smart App Control or any other Windows gatekeeper to block.

**Decode runs off the main thread (worker offload):** `heic-convert` → `heic-decode` → `libheif-js/wasm-bundle` has no worker offload of its own and decodes **synchronously**, so running it on the Node main thread would block the entire event loop — freezing every route for every guest — for the full decode duration. Unlike the JPEG/PNG/WebP path, where `sharp` runs off-thread natively, this would be a new main-thread stall, and because HEIC is the iPhone default it is the expected load (a reception-night burst of uploads), not an edge — directly at odds with Goal A ("fast under the whole party at once"). So the decode is dispatched to a `worker_threads` worker (`src/services/heic-worker.js`) and awaited; `convertHeicToJpeg` still returns `Promise<Buffer>` and its call sites are unchanged. A **fresh worker is spawned per decode** and terminated when it finishes: the worker exits after one image, so its WASM heap and raw frame are fully reclaimed each time, and the large allocation is isolated in a short-lived child process — a worst-case decode cannot OOM (or leak into) the main app. A worker crash, error, or non-zero exit is caught on the main side and surfaces as the same guest-safe `BAD_IMAGE_TYPE` "couldn't be read" rejection; it never crashes or hangs the main process.

The decode is also bounded in **time** by `HEIC_DECODE_TIMEOUT_MS` (20s; a legitimate large HEIC decodes in ~1–3s). The pixel cap bounds how much a decode allocates but not how long it runs — a crafted small-`ispe` HEIC with a pathological bitstream can drive libheif into a non-terminating decode, so the worker would post no result and never exit. Without a timeout that decode would never settle, and because `heicDecodeSemaphore` (the single global serialization point, #930 — see below) only advances past a held slot on release, every later HEIC upload would queue behind it forever (a process-wide denial of the iPhone-default path until restart — squarely against Goal A). The timeout turns that hang into a single failed request that also frees the slot: the next upload proceeds normally.

A **per-guest HEIC-decode rate limit** (`HEIC_DECODE_RATE_MAX` per `HEIC_DECODE_RATE_WINDOW_MS`, in `src/services/rate-limit.js`) is checked BEFORE the decode, for files that actually sniff as HEIC, across all three upload paths (task submit, memory batch, avatar). Without it a single hostile guest could flood hang-crafted HEICs — each burning the 20s timeout — and, since decoding is one-at-a-time and global, monopolize it and deny every guest's HEIC uploads (Goals A/D). The limit is tuned generously (60 decodes / 2 min per guest — far above any human's real upload rate) so it only ever stops a pathological flood; JPEG/PNG/WebP uploads never consume it.

**Global pending-decode cap and admission (`MAX_PENDING_HEIC_DECODES`, raised 8 → 12; wait bound and admission mechanism replaced, #930).** A global cap bounds total held decode memory: the per-guest rate limit bounds enqueue RATE, but not queue DEPTH, so many self-onboarding guests (or one guest over many connections) flooding hang-crafted HEICs could grow the queue without bound. What changed under #930 is the admission MECHANISM and, with it, what a pending decode actually costs:

- **Mechanism: the repo's audited `Semaphore` (`src/utils/semaphore.js`) replaces the hand-rolled `heicDecodeChain` promise chain + `pendingHeicDecodes` counter.** `heicDecodeSemaphore = new Semaphore(1)` is the same primitive `withUploadSlot`/`withAvatarSlot` (`src/utils/upload-concurrency.js`) already standardize on, not a new one. Its FIFO wait queue supports `AbortSignal` cancellation with identity-splice removal (a cancelled waiter is spliced out of the queue by identity, never tombstoned) — this is what makes a wait bound on a queued decode safe by construction: a cancelled wait can never leak a slot or double-decrement a counter, because there is no separate counter to decrement and no tombstone that could be handed a slot later. **Round 2 (same #930 thread):** the HEIC gate's own hand-rolled "ceiling check → acquire → timeout-recode → run → release" sequence and `withAvatarSlot`'s independently hand-rolled copy of that identical shape had drifted apart under review — `withBoundedSlot` (`src/utils/upload-concurrency.js`) is now the ONE owner of that shape; both gates are thin callers (`limitKind: 'occupancy'` for HEIC via the semaphore's new `.occupancy` getter — active holders count toward its own cap; `limitKind: 'pending'` for avatar — only queued waiters count).
- **Held-memory arithmetic differs by CALLER KIND — there is no single "one pinned buffer" bound.** `convertHeicToJpeg({ prefix, prefixTruncated }, supplier)` takes the admission-time sniff PREFIX plus a lazy `supplier` that performs the actual full-file read — the disk path's `() => fs.readFileSync(fd)`, the avatar path's `() => buffer` (already in RAM). The supplier runs only AFTER a slot is granted, but what that defers is NOT the same for both callers:
  - **Disk callers (task submit, memory batch).** A queued decode has not yet read its full file — it holds only an open fd, its on-disk temp file, and the `HEIC_ADMISSION_SNIFF_BYTES` prefix already read (default 256 KB, ≈3 MB total across a full 12-deep queue) — not a pinned `MAX_UPLOAD_BYTES` (15 MB) buffer. At most ONE disk caller (the single ACTIVE decode) pins its full 15 MB buffer at any moment. This is the real reduction from the pre-#930 model (`MAX_PENDING_HEIC_DECODES × 15 MB` pinned regardless of caller kind) and is what actually licenses raising the ceiling 8 → 12 for the disk path.
  - **Avatar callers (memory-resident, multer memoryStorage).** There is nothing to defer: `req.file.buffer` is already fully resident in the main process before `saveAvatar` ever calls `convertHeicToJpeg` — the "deferred read" pattern controls when the SUPPLIER reads, but the avatar's buffer was never behind a read to begin with. A guest queued behind a busy decode slot holds their full avatar buffer pinned for the entire wait. Worst case — a pure-avatar HEIC burst filling the ceiling — pins `MAX_PENDING_HEIC_DECODES × MAX_UPLOAD_BYTES` = 12 × 15 MB = **180 MB transient**, bounded to ≤ `HEIC_QUEUE_WAIT_MS` (45s) by the wait bound below, and further bounded in practice by the per-guest HEIC-decode rate limit (60 decodes / 2 min — see above), which caps how many distinct avatar HEICs any one guest can even enqueue. This sits ALONGSIDE, not instead of, the #929 avatar-crop concurrency budget (`AVATAR_CONCURRENCY` × ~325 MB ≈ 2 × ~325 MB ≈ 650 MB, from "Avatar processing" above) — both are transient, do not compound indefinitely, and the combined worst-case stack (≈180 MB avatar-buffer pin + ≈650 MB avatar-crop + the app's own baseline) still fits inside the ~2 GB host.
  - The 8 → 12 raise is licensed by the DISK-path deferral (a real, large reduction in the common case) plus this recorded avatar-path arithmetic — not by a universal "one pinned 15 MB buffer" claim, which never held for the avatar path and would have been an honest-cost-model defect to ship as written.
- **Admission ceiling and acquire() run in one synchronous turn.** `heicPrefixNeedsFullCheck` (the stage-1 pixel check on just the prefix) and `withBoundedSlot`'s own `occupancy >= MAX_PENDING_HEIC_DECODES` check both run, and — with no `await` in between either of them or the `acquire()` call that follows — a decode is admitted or rejected in one synchronous turn; an async gap here would open a check-then-enqueue race that could admit one over the ceiling.
- **New wait bound (`HEIC_QUEUE_WAIT_MS`, default 45000).** An admitted-but-queued decode previously had NO bound on how long it could wait — it would simply succeed late. `acquire({ signal: AbortSignal.timeout(HEIC_QUEUE_WAIT_MS) })` now fails it, re-coded to the same `HEIC_RATE_LIMITED` copy, if a slot doesn't free in time. 45s covers a serial drain of a full healthy 12-deep queue (~1-3s per decode, ≤ ~33s for 11 predecessors) with margin; single-request worst case is `HEIC_QUEUE_WAIT_MS + HEIC_DECODE_TIMEOUT_MS` = 65s, inside the 300s `proxy_read_timeout` `docs/deploy.md`'s nginx example sets (#936).
- **Two-stage pixel-bomb check (`HEIC_ADMISSION_SNIFF_BYTES`, default 262144 = 256 KB).** Stage 1 runs `assertHeicPixelsWithinCap` on a bounded, positioned prefix read (disk: `fs.readSync(fd, buf, 0, N, 0)`; avatar: a subarray of the in-RAM buffer) BEFORE a slot is ever requested — an honestly-oversized HEIC whose `ispe` sits in the leading `meta` box (the normal phone-encoder layout) is refused consuming no slot at all, unchanged in spirit from the pre-#930 single-stage check. Stage 2 re-runs the same check on the FULL buffer, still on the main thread, still before `decodeHeicInWorker`, whenever stage 1 was inconclusive (no `ispe` in the prefix — legal ISO-BMFF, a late `meta` box) OR the prefix read was truncated (`prefixTruncated` — stated explicitly by the producer that already knows it: `sniffBytesRead === HEIC_ADMISSION_SNIFF_BYTES` on the disk path, `buffer.length > HEIC_ADMISSION_SNIFF_BYTES` on the avatar path, rather than re-derived from `prefix.length` inside the checker, which cannot tell "the file ends exactly here" from "the file continues and this is a cut prefix"). This is what keeps the invariant "no over-cap file ever spawns a worker" true even for a HEIC whose `meta` box is not near the front — the old single main-thread check ran on the full buffer unconditionally, so this is a genuine behavior addition, not just a refactor.
- **Honest residuals, restated (unchanged in kind, since #930 narrows rather than removes them):** the hard ceiling still refuses outright at 12 (the batch-kill boundary for a whole memory batch moves from depth 8 to depth 12, reduced but not eliminated — see #931 for batch-atomicity itself). The wait bound is also a **new** loss path under sustained saturation: in the partial-saturation band (a deep queue where each wait sits just under `HEIC_QUEUE_WAIT_MS`), a multi-file HEIC batch can still run long enough to hit a documented-nginx deployment's own proxy timeout and die with a bare 504 — accepted, because the alternative (no wait bound) loses the same batch anyway, later and less honestly.

This completes the decode-DoS defenses: the two-stage pixel cap (per-decode allocation), the 20s timeout (per-decode time), the per-guest rate limit (per-guest enqueue rate), the global pending cap with its wait bound (total held memory and bounded queueing), one-at-a-time serialization, and worker isolation.

**Memory constraint — one decode at a time:** a single HEIC decodes a full RGBA frame into memory and can transiently want a few hundred MB. Decodes are serialized behind `heicDecodeSemaphore` (`src/services/photos/heic.js`, #930 — see above) so at most one decode worker runs at once, regardless of how many guests upload HEIC photos in the same moment. This matters because the app is sized for a small (~2 GB) host per the "Constraints that shaped the design" section above, and a move off the single event laptop to a small VPS is under consideration — a future host-sizing decision should account for this one-decode-at-a-time ceiling rather than assuming photo intake is memory-cheap.

**Pixel-dimension cap — defense against a HEIC pixel bomb:** serializing decodes bounds _how many_ run at once, but not _how big_ each one is. `heic-decode` allocates a full raw RGBA frame (`new Uint8ClampedArray(width*height*4)`) sized from libheif's decoded-image `get_width()`/`get_height()`, and it does so _before_ `sharp` — and `sharp`'s default input-pixel guard — ever runs, so the HEIC path bypasses the protection the JPEG/PNG/WebP path gets for free. A crafted few-MB HEIC (a uniform image compresses to almost nothing under HEVC, well within the 15 MB upload cap) could carry huge dimensions and force a ~1 GB allocation that OOMs the ~2 GB host. Anything over `MAX_HEIC_PIXELS` (100 megapixels) is refused. 100 MP sits above any default-camera phone HEIC (a 48 MP iPhone ProRAW frame, a 50 MP flagship) with headroom while a 100 MP RGBA decode is ~400 MB — the largest single transient the one-at-a-time gate permits — and is deliberately tighter than `sharp`'s ~268 MP default AND than libheif's own ~1-gigapixel default limit, neither of which this host can safely absorb.

**The cap uses libheif's AUTHORITATIVE dimensions, not the `ispe` box (#281 round-8 finding).** An earlier version gated only on the ISO-BMFF `ispe` box (`heicPixelDimensions`). That is a parser differential: **libheif does not size the allocation from `ispe`.** Verified empirically — patching a HEIC's primary-image `ispe` to 4000×4000 leaves libheif's decoded `get_width()`/`get_height()` unchanged (they come from the coded HEVC stream, not the `ispe`), and declaring a non-standard-size `ispe` (e.g. 24 bytes) makes libheif reject the file outright. So a "24-byte `ispe` declaring huge dims → huge allocation" bypass is a **false positive** (the `ispe` cannot drive the allocation), but the same evidence shows an `ispe`-only cap could diverge from the real allocation size. The cap is therefore enforced at two points: (1) a cheap **main-thread pre-check** on `ispe` (`assertHeicPixelsWithinCap`) that avoids spawning a worker for an honestly-huge HEIC, and (2) the **authoritative gate inside the worker** (`heic-worker.js`) on libheif's real `get_width()`/`get_height()`, obtained via `heic-decode`'s `.all()` (which exposes dimensions after the container parse but **before** the raster is allocated — measured: `.all()` ~0.2 MB, the raster only materializes at `.decode()`). Over-cap in the worker aborts and signals oversize, mapped to the same guest-safe `BAD_IMAGE_TYPE` copy; the giant allocation never happens. (worker_threads share the process address space, so this gate — not the worker "isolation" — is what prevents the OOM.) The worker decodes with `heic-decode` + `jpeg-js` directly at `Math.floor(0.9*100)=90` quality, byte-identical to the prior `heic-convert` path.

**EXIF/orientation of the converted original:** libheif-js (1.19.8) applies the HEIF spatial transforms — including `irot`/`imir` orientation — during decode by default (`ignore_transformations=false`), so the decoded raster it hands back is already upright and the JPEG written to `data/uploads/` needs no further rotation. No extra rotation is applied to the converted full-size original; the thumbnail continues to go through `makeThumb`'s `sharp().rotate()` as before.

**Any HEIC-candidate mimetype is now sniffed for jpeg/png/webp too, not just HEIC (#933) — bringing the disk path in line with the avatar path.** `saveAvatar` (memory storage) always handed real bytes straight to sharp regardless of declared type, so a generic `application/octet-stream` JPEG never failed there; `resolveUploadedFile` (disk storage) only sniffed octet-stream for HEIC and rejected everything else under that mimetype, because `ALLOWED_MIME_TO_EXT` has no octet-stream entry — an intake-path asymmetry, not a deliberate security boundary, that deleted a real JPEG/PNG/WebP and blamed the guest whenever Android SAF pickers (or the HTML multipart algorithm itself, when `File.type` is empty) sent one under the generic type. `resolveUploadedFile` now sniffs a non-HEIC candidate's magic bytes (any of `HEIC_CANDIDATE_MIMES` — `application/octet-stream` being the case that matters in practice) for jpeg/png/webp (mirroring `looksLikeHeic`'s signature-over-label approach) before rejecting, and renames the stored file to the sniffed extension on a match — judging the bytes, not the label, exactly as the avatar path already effectively did. `image/heic-sequence`/`image/heif-sequence` (Live Photos) are HEIC candidates too now, with `hevc`/`hevx` added to the accepted `ftyp` brands so admitting those mimetypes can't create a mime-accepted/brand-rejected dead end.

### sharp 0.35.2 SAC block was a reputation-lag, now cleared (#304)

**Finding (2026-07-08):** the `ERR_DLOPEN_FAILED` block on `sharp-win32-x64-0.35.2.node` that cost the #239 and #254 builds a junction workaround was **Smart App Control reputation-lag**, not a permanent signing gap. Smart App Control blocks a new/unknown unsigned binary by cloud reputation until the file's hash accrues it, then allows it once it clears — it is not a static policy against unsigned code. Re-tested on the host with SAC still in **Enforce** mode (`HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState = 1`): a fresh `npm ci` installs sharp 0.35.2, `node -e "require('sharp')"` exits 0, and `npm test` is green (69 files / 546 tests, no sharp-dependent suite failing to import). The `.node` binary is still `NotSigned` with no mark-of-the-web — the exact conditions the original block was attributed to — yet it loads; the install is a genuine npm download, not a junction.

**Decision:** keep sharp at 0.35.2; no pin-back. Pinning back would downgrade a wedding-critical, security-relevant image library to fix a failure that no longer reproduces, and Dependabot would immediately re-open the same bump.

**PR #14's tracked-decision status:** the 0.33.5→0.35.2 bump (PR #14) was triaged `review` tier ("sharp is a wedding-critical prod dep; image processing. HELD for a tested decision.", 2026-07-01) and merged 2026-07-02 — with **no recorded on-host smoke test**. That gap is what armed the landmine: the tier logic correctly held the PR for a decision, but the decision that shipped was a merge with no evidence a native binary swap would still load under SAC on the actual event laptop. See the "Native-binary members need an on-host smoke test before merge (#304)" rule in `CLAUDE.md` § Dependency updates, added by this issue to close that gap going forward.

### Scoring derived, not stored

A guest's score is computed: one point per completed task (a non-taken-down submission whose `task_id` is set) plus `bonus_points` the admin sets by judgment. Completion count drives auto badges. Keeping score derived avoids a denormalized total that can drift out of sync when a photo is taken down or restored.

**Amended (issue #247):** `submissions.task_id` is nullable — a "memory" is a non-taken-down submission with `task_id IS NULL` (a guest photo shared straight to the gallery, not tied to any task). A memory is **not** a task completion and earns no automatic base point; "every non-taken-down submission is worth a point" stopped being true the moment `task_id` could be absent. A memory remains eligible for an admin-awarded per-photo bonus (`submissions.photo_bonus`, issue #89) exactly like a task photo — only the automatic base point is withheld.

**Amended (issue #483): a fourth term, task-badge award points.** The formula gains `+ guest_badges.points` summed over that guest's badge awards — the same field `task-badges.awardTaskBadge` sets when a task's badge is awarded to a photo (see "Task badges" below). This term is **takedown-guarded through its earning photo**, consistent with the taken-down-photo-leaves-scoring rule the base point and `photo_bonus` already follow: an award counts toward score only while its `guest_badges.submission_id` either is `NULL` (a system/auto/metric/transferable/special grant, which never carries points anyway — see "Two ownership groups" below) or points at a submission with `taken_down = 0`. A photo taken down after its badge was awarded drops that award's points from the score; restoring the photo re-adds them — exactly the AC6 behavior `photo_bonus` already has. Implemented as a scalar prepared statement (`scoring.js`'s `stmtAwardPointsSum`, read by `getPoints`) and, separately, an equivalent correlated subquery inside `leaderboard()`'s per-guest SELECT — the same two-query-shape pattern already used for the completed-count/`photo_bonus` terms above (one shape for a single-guest lookup, one for the all-guest aggregate); `leaderboard()` deliberately does **not** add a second `JOIN guest_badges` to its existing submissions-grouped query, because a guest with more than one visible submission would fan that join out and inflate both the `photo_bonus` sum and the award sum.

**Amended (issue #706): the base + `photo_bonus` + award-points model above is superseded by a nine-source economy, owner-settled 2026-07-19/20.** The two freeform terms this section describes — `photo_bonus` (per-photo, admin judgment) and guest-level `bonus_points` (see "Scoring derived, not stored" above) — are being removed (#683 for the guest-level term, #684 for the per-photo term); every point a guest sees must trace to one of nine named sources: host-chosen task worth 1/2/3 (#682), a host-chosen 1/2/3 daily/flash/lucky bonus banked on the photo (#624/#649/#650), first memory of the event-local day +1 (#656), first profile photo +1 once (shipped, #409), +1 per automatic badge held (new issue, not yet filed), ranked task-badge awards paying 5..1 to a task's host-picked 5 best photos (#661/#662, replacing this section's single-photo `guest_badges.points` award model with a five-winner ranked award), and derived crowd-favorite awards paying 5..1 to the 5 most-liked photos, live all weekend (#625). The takedown/restore guarding this section already describes for `photo_bonus` and award points carries forward unchanged for every source above; banked daily/flash/lucky bonuses additionally survive a photo REPLACE. Full rule set and the issue owning each source: `docs/game-design-points-badges.md`.

**Amended (#716): the "first profile photo +1 once" source above is no longer a one-time banked award.** By owner decision (2026-07-20), the point now follows the photo — `+1` derived live from `guests.avatar_path IS NOT NULL`, read through `scoring.js`'s `starterTaskContribution` in both `getPoints` and `leaderboard`. Uploading a photo pays the point, removing it takes the point away, and re-uploading pays it again; `awardProfilePhotoPoint` and the `avatar_point_awarded` one-time-flag column are retired. A guarded migration folds any already-banked point (`avatar_point_awarded = 1`) back out of `bonus_points` (floored at 0) so an existing guest's total is unchanged the moment the derived term picks it back up.

**Amended (issue #753): the one-day-only challenge engine settles three decisions the "daily/flash/lucky bonus" source above left open.** (1) `tasks.special_date` (`YYYY-MM-DD`, `NULL` = ordinary task) is the single authoritative fact that a task is a one-day-only challenge — every reader (the seal predicate `tasks.isSealed`/`sealedTaskWhere`, the on-day bonus banking in `submissions.submitPhoto`, the Completionist exclusion) keys on `special_date`, never on `special_mode = 'oneday'`; `special_mode`'s `'oneday'` value is a lockstep marker written alongside it purely so the existing mode machinery (`liveTaskWhere`/`isTaskLive`) and a future exclusivity guard (#649/#650) can see the task is spoken for. (2) The banked bonus lives on shared `submissions.bonus_amount`/`bonus_reason` columns, not a `#753`-private pair — `bonus_amount` is banked at submit time (never derived at read time, since a photo replace resets `created_at`) and `bonus_reason` records which rule banked it (`'oneday'` for this issue); #649 (flash) and #650 (lucky) reuse the same two columns, writing their own `bonus_reason` literals into the vocabulary this issue starts. (3) Completionist's exclusion of challenge tasks (`tasks.challengeTaskWhere`, keyed on `special_date`) is **permanent**, not a window that closes once the date passes — owner decision D2 (#624): a challenge appearing mid-event must never strip Completionist from a guest who already holds it, and a challenge a guest hasn't reached yet must never block them from earning it.

**Amended (issue #761): the flash engine settles four decisions the "daily/flash/lucky bonus" source above left open, and corrects two claims above.** **Correction 1:** #753's point (1) said the future exclusivity guard would read `special_mode` to see a task is spoken for; the guard that actually shipped (`tasks.whatSpecial()`) reads `special_date` and the flash columns directly, and never reads `special_mode` — the rest of #753's entry stands unchanged. **Correction 2:** this entry also corrects the #753 paragraph above, which had #649 and #650's labels transposed — #649 is flash, #650 is lucky, matching `docs/game-design-points-badges.md`'s "Flash: #649 · Lucky: #650"; the labels in that paragraph are already corrected in place, this note only records that the correction happened. The four decisions: (1) `special_mode` gains **no** `'flash'` value. A stored enum marker cannot expire on its own, and the owner's rule (#649 comment, 2026-07-19) is that a task reverts to no-special automatically the instant its flash window ends, with no stale state — keeping a marker truthful would need either a scheduler (this app has none; read-time evaluation is the accepted shape, settled on #624) or a write on every read. It also sidesteps the `CHECK`-widen table rebuild `ensureTaskSpecialDayColumns()` documents at length (`src/db.js`) and the FK-cascade data-loss hazard that rebuild carries — a rebuild #650's implementer would otherwise be sent to repeat for no behavioural gain. (2) The window rule (`tasks.flashState`) has a JS-only owner **[superseded by #762 below — `flashState` no longer computes the window itself; it now delegates to a separate `tasks.flashWindow()`, see "`flashWindow` split out of `flashState`, correcting the #761 entry above" further down this file]** with **no SQL-fragment counterpart**, unlike `sealedTaskWhere`: no query anywhere needs to filter or suppress a row on window state — a flashed task is never hidden from a list, only decorated onto an already-loaded row — so there is nothing for a second, SQL-side owner to do, and SQLite's `datetime(...)` text output (space-separated, no `Z`) cannot correctly express the half-open `[S, S+D)` window's end-instant arithmetic regardless. (3) The three flash columns (`flash_start_at`/`flash_minutes`/`flash_bonus`) carry **no `CHECK`/pairing constraint**, unlike `special_date`/`special_bonus`'s `chk_special_pairing` — SQLite cannot add a `CHECK` to an existing table without the same rebuild hazard point (1) exists to avoid, so a partially-populated row is a legal database state; `tasks.flashState()` treats it as inert (`'none'`) on the read side rather than trusting the schema to have refused it. (4) **On-day wins the banking tie-break** when a task is somehow both on-day and in-window, decided by one ordered rule list — `tasks.js`'s `SPECIAL_RULES` — rather than two independent hand-restatements of the same daily-before-flash precedence. `whatSpecial()` answers "who is this task spoken for by;" each `SPECIAL_RULES` entry's own `paying` predicate answers the strict-subset question "is this rule paying right now" (`'daily'` is spoken-for by sealed-or-on-day but only _pays_ on-day; `'flash'` is spoken-for by scheduled-or-active but only pays active), and each `SPECIAL_RULES` entry also carries `bonusColumn`/`reason`, so `tasks.js`'s `bonusForTask()` reads the paying rule's bonus column and `bonus_reason` literal straight off the same list — `submissions.js` never hand-maps a kind string to a bonus column or reason itself. Concretely, this is what keeps exclusivity, paying, and banking from drifting apart: a task sealed for a **future** day with a simultaneously active flash window, submitted by a guest who already holds a row on it (the only way to reach the seal gate's existing-row fall-through), is spoken-for by `'daily'` (sealed) — so `'flash'`'s paying condition is never even consulted, and nothing banks until `'daily'` itself starts paying (on-day). Review caught the duplicated precedence (and, in a second pass, the separate hand-written kind-to-column mapping) before merge; one ordered list owning all three questions is what lets `#650` add `'lucky'` as a single new entry, not a hand-edit kept in step elsewhere.

**Amended (issue #755): the one-day-only HOST surface adds a cross-cutting write rule the rest of the codebase now depends on.** #753 built the engine and #754 the guest surface; this issue is the ONLY writer of `special_date`/`special_bonus`, and it settles three things neither earlier issue could.

(1) **A guest submission locks the pair.** Once a task carries at least one submission — visible OR taken down — no save may change its `(special_date, special_bonus)` pair; only the pair is locked, not the rest of the task (title, description, worth, badge all stay editable). This is a single rule with three faces (owner decision, 2026-07-20: _"if guest post to it, can't change. bonus points guest posts to it can't change"_): an ordinary task with photos cannot be dated; a dated task with photos cannot move to a different day or bonus; a dated task with photos cannot be cleared back to an ordinary task. What it costs: a **stale-dated task with photos stays stale** — if the host later narrows the configured wedding dates so a task's stored day falls outside the new range, and that task already has a photo on it, the host can no longer repair the date. The earlier four-branch draft of this rule (4a-4d, keyed on stored-vs-posted MODE) carried a repair exemption for exactly this case; nine rounds of review found a contradiction between its branches every time, and the owner replaced the whole matrix with the single PAIR-keyed rule above, dropping the exemption with it. `src/routes/guest.js:144-145` and the `GET /tasks/:id` sealed-challenge fall-through's own comment (the
`tasks.isSealed(task, todayIso) && !hasSubmission` gate, cited here by name rather than a line pin — the
next edit made anywhere above it in that file would falsify one) already cite this refusal as their
PRIMARY guard (the guest-side exclusion of a sealed-but-already-submitted task from the suppressed set is
defence in depth, not a substitute for it) — written before this issue merged, on the expectation that
this rule would land exactly this shape. **The single enforcement point is `resolveSpecialPairWrite()` in `src/routes/admin.js`** — both `POST /admin/tasks` (create) and `POST /admin/tasks/:id/edit` call it before writing, so #649/#650's implementer extending this rule (or auditing it) has exactly one function to find, not two independently-hand-written refusals to keep in sync.

(2) **`special_mode` now has two writers that must agree on one un-hide rule.** `POST /admin/tasks/:id/edit` is the primary writer (title/description/worth/badge/special_mode/special_date/special_bonus together). `POST /admin/tasks/:id/active` — retained, no live UI path since #682 — is a second, and un-hiding a task that still carries a real `special_date` now restores `special_mode = 'oneday'` rather than falling to `'none'`, because `tasks.isSealed`/`isOnDay` read the stored DATE, not the mode: stranding the date behind `'none'` would leave a guest staring at a locked mystery box for a task the board no longer marks as dated at all. Hiding itself never touches the date/bonus pair.

(3) **Why the hidden `special_date` input exists.** The edit popup's day chips are a closed radio set — they can only express a date inside the currently configured wedding range. A task whose stored date has fallen outside that range (the stale-date case in (1) above) matches no chip, so without an escape hatch a chips-only form would post `(null, null)` on a plain title fix, reading as a pair CHANGE and getting refused as "missing date" — trapping the host in a task they can never save again, for a change they never asked to make. `task-edit-dialog.ejs` carries a `disabled`-by-default hidden `special_date` input that `admin-tasks.js`'s `openEdit()` enables and fills with the stored date only when no chip matches it, and disables again the instant any day chip is clicked — so the chips remain the only source of `special_date` whenever one matches, and the body never carries two values for that field.

### Badge thresholds live in scoring.js; custom badges reverse the earlier "fixed catalog" decision

Auto-badge thresholds (5 / 10 / 15) live once in `src/services/scoring.js`'s `BADGE_THRESHOLDS` and are read by scoring and the guest routes; there is no second copy.

This section previously said the four special badges were a fixed catalog and the admin could not invent new badge types. **Issue #80 reverses that by owner direction**: the admin can now create host-defined `custom` badges (name + `art_path`, an image path or emoji) at runtime via `POST /admin/badges`, no re-seed or SVG-add-and-redeploy required. **Amended (issue #483):** `custom` now also covers the per-task badge rows `task-badges.js` auto-provisions — one per task, never hand-created through `POST /admin/badges` — so `custom` means "not a fixed system-computed type," not "always admin-freeform." See "Task badges" below for that model.

Badge identity stays the single existing `badges.code` column (`NOT NULL UNIQUE`) — issue #80 did not add a second identity key. **Amended (issue #483):** the `TASK-` code prefix is reserved for per-task badges — `task-badges.js` derives every task badge's code as `'TASK-' + taskId`, and `scoring.createCustomBadge` refuses to write any freeform admin code starting with that same prefix (AC8), so the two automated `code` writers can never collide. Issue #483 also adds a partial `UNIQUE INDEX` on `badges(task_id) WHERE task_id IS NOT NULL` — this is **not** a second identity key either: it is a per-task **cardinality** constraint ("a task has at most one badge row"), enforced on a different column than the one that identifies a badge. `code` remains the sole reference identity throughout.

The `type` vocabulary is now five values, in two ownership groups:

- **System-computed** (`awarded_by = 'system'`, only ever written by `scoring.recomputeBadges`/`recomputeTransferableBadges`, never by an admin route):
  - `auto` — the three completed-task threshold badges (BLOOM/BOUQUET/GARDEN), unchanged.
  - `metric` — one-time badges computed per guest from live data, keyed by `code` to a compute function in `src/services/badges.js` (e.g. `COMPLETIONIST`: holds a visible submission for every active task; auto-revokes the moment that stops being true, such as a newly added active task).
  - `transferable` — "steal-able" badges computed globally and reassigned on every recompute (e.g. `MOSTPHOTOS`: the guest(s) with the strict-most visible **task** submissions; ties are held by everyone tied). **Amended (issue #247):** a "memory" (a submission with `task_id IS NULL`, not tied to any task) does not count toward `MOSTPHOTOS` — otherwise a guest could steal the badge by uploading many memories instead of completing tasks, the same flooding the no-automatic-points rule (above) prevents.
- **Admin-awarded** (`awarded_by = 'admin'`, written only via `scoring.awardSpecialBadge`/`removeSpecialBadge`/`createCustomBadge`, or — issue #483 — `task-badges.awardTaskBadge`/`removeTaskAward`):
  - `special` — the original fixed four (EARLYBIRD, SHUTTERBUG, CROWDFAV, CHOICE).
  - `custom` — new: any badge the admin invents at runtime, **or** (issue #483) a per-task badge `task-badges.js` auto-provisions — see "Task badges: one badge row per task, awards carry the variable data" below.

An admin create/award/remove request for a `metric` or `transferable` code is refused outright (no row written) — `scoring.js`'s `ADMIN_AWARDABLE_TYPES` guard and the `POST /admin/guests/:id/badge` route both enforce this, so the system-computed types can never be hand-edited out from under the recompute engine.

**Amended (issue #706): the `transferable` and `special` types this taxonomy lists as live are superseded, owner-settled 2026-07-19/20.** `MOSTPHOTOS` (the `transferable` example above) and `MOSTLIKED` are both removed, replaced by the derived crowd favorite — the 5 most-liked photos, recomputed live rather than materialized and stolen (#625). The fixed `special` four (EARLYBIRD, SHUTTERBUG, CROWDFAV, CHOICE) and the admin-invented `custom` catalog die with them: badges no longer attach to a guest by hand-award, only through a task's ranked photo winners or the crowd-favorite derivation, or through the unchanged system-computed `auto`/`metric` set (First Bloom/Bouquet Builder/Full Garden/Completionist). The five placeholder photo badges in `src/services/photo-badges.js` (a separate, pre-#410 test-era catalog, not this section's `badges` table types) die in the same rewrite. Full model and kill list: `docs/game-design-points-badges.md`.

**Amended (issue #753): the COMPLETIONIST auto-revoke claim above is no longer true without qualification.** "Auto-revokes the moment that stops being true, such as a newly added active task" held only through #753: `src/services/badges.js`'s Completionist query now permanently excludes any task carrying `special_date` (via `src/services/tasks.js`'s `challengeTaskWhere`, the declared owner of task-state predicates) from its "every active task" set — owner decision D2 (#624). So a newly added ORDINARY task still revokes Completionist exactly as before, but a newly added one-day-only CHALLENGE never does, whether or not the guest has reached its date yet.

### Task badges: one badge row per task, awards carry the variable data (#483)

Every task owns exactly one `badges` row of its own — a `type = 'custom'` row carrying `task_id` set to that task, with a derived `code = 'TASK-' + taskId`. `src/services/task-badges.js` is the sole owner of this row: `resolveTaskBadge(taskId)` lazily inserts it (name `'Task Badge'`, `art_path` pointing at the shared `/badges/default-ribbon.svg` **file**) the first time a task's badge is asked for, and `setTaskBadge(taskId, { name, artPath })` updates that same row when the host uploads custom art/a name from the task board. Because every task's badge is a **distinct row** (enforced by the partial `UNIQUE INDEX` on `badges(task_id)` described above), a guest who completes two un-customized tasks holds two distinct `badge_id`s and never collides on the existing `guest_badges UNIQUE(guest_id, badge_id)` constraint — "a guest holds each badge at most once" (below) needed no change to support this.

What is shared across every un-customized task is the default-ribbon **artwork** — a single SVG file — not a shared catalog row: each un-customized task's own row simply points its `art_path` at that same file until the host uploads something different for that task.

The award — points, an optional note, and which submission earned it — lives on `guest_badges` (`points`, `note`, `submission_id`), not on the badge catalog row: the same task badge awarded to two different guests' photos can carry two different point values (AC4). `task-badges.awardTaskBadge(taskId, submissionId, { points, note })` derives the grantee from the submission — refusing (no row written) a missing or currently-taken-down submission, so an award is never made on behalf of a photo the guest can no longer see — and inserts the `guest_badges` row with `awarded_by = 'admin'`; `removeTaskAward` deletes it by `(badge_id, submission_id)`. This is a separate write path from `scoring.createCustomBadge`: task badges never go through it, and (as noted above) `createCustomBadge` refuses any freeform `code` starting with the reserved `TASK-` prefix. System/auto/metric/transferable grants are untouched by any of this — they keep going through `scoring.js`'s existing `stmtGrantBadge`, which never sets `points`/`note`/`submission_id`, so those rows keep the column defaults (`points = 0`, `note IS NULL`, `submission_id IS NULL`) exactly as before (AC7).

This issue is the **foundation** slice only: the schema, the resolver, the admin task-board upload slot, and the minimal award-write path needed to make the model testable. It deliberately does not build the gallery award interface, the guest-facing earnable-badge view, or leaderboard badge display — those are separate, later issues that build on this model.

**Amended (issue #706): the award model above is superseded by ranked award, owner-settled 2026-07-19/20, further amended 2026-07-23.** This section's `awardTaskBadge(taskId, submissionId, { points, note })` awards one task's badge to one photo — it is left in place for its own existing callers/tests, but is no longer the route-facing write path. **Corrected 2026-07-23 (owner, superseding the "five-photo" framing immediately above): the host ranks 1 to 5 of a task's best photos, their choice, not a forced five** — rank 1 pays 5 points and wears the badge gold, rank 2 pays 4, down to whichever rank is last paying 1; a single-winner release is valid (one badge, 5 points). `task-badges.releaseRanking(taskId, submissionIds)` is the new, SEPARATE write path (see "Rank & award" ADR below) consolidating onto the badge substrate this section already established (`badges` + `guest_badges`, points and submission carried on the award row) rather than the disconnected `badge_winners` picker table — which #661 deletes outright, along with its sole reader/writer `photo-badges.js`, rather than repointing it (see that ADR for why). Full model: `docs/game-design-points-badges.md` — that doc still describes a forced-five/worksheet-survives shape as of this writing and has not yet been reconciled with this correction; flagged for a follow-up doc-sync pass, not fixed in this change (out of #661's own `Touches`).

### Two UNIQUE constraints enforce the core rules in the schema

- `submissions UNIQUE(guest_id, task_id)` — one submission per guest per **task**, so a task cannot be completed twice for double points. This defines the duplicate error out of existence at the database layer rather than checking for it in application code. **Amended (issue #247):** `task_id` may be `NULL` for a "memory" (a submission not tied to any task). SQLite treats every `NULL` as distinct from every other value under a `UNIQUE` constraint, so this same constraint lets a guest hold any number of `(guest_id, NULL)` memory rows alongside their at-most-one-row-per-real-task submissions — no separate constraint or table was needed.
- `guest_badges UNIQUE(guest_id, badge_id)` — a guest holds each badge at most once, so re-running scoring or re-awarding is idempotent.

### Export as a ZIP + xlsx, then discard

The admin runs one export: archiver streams a ZIP of all photos grouped one folder per guest, plus a `summary.xlsx` (exceljs) of points, badges, and tasks. After the event the photos are uploaded elsewhere and the `data/` directory is discarded. Durability during the event's run comes from scheduled backups (`scripts/backup.js`, run on a schedule per `docs/deploy.md`) to a separate `./backups` volume, not from retaining `data/` after teardown.

### Merge policy: owner-merge boundary retired

**Decision (2026-07-02):** the orchestrator merges every pull request once its adversarial AI review passes and CI is green — including visual and product-direction changes. This retires the previous two-branch policy, under which bug/security/refactor/correctness/test PRs merged on green CI but visual/product-direction PRs were left open for the owner to merge by hand (the "owner merge boundary").

**Rationale:** the owner does not perform these merges, so PRs held for manual merge accumulated open and nothing shipped. `main` already requires **0 approving** reviews under branch protection (`required_pull_request_reviews.required_approving_review_count = 0`, `strict = true`, verified 2026-07-02) and gates solely on CI checks — a human merge click was never actually enforced by GitHub, only by convention. The owner accepts AI-review-plus-green-CI as the sole merge gate and prefers post-hoc **revert** over an up-front human merge gate: if a merged change turns out wrong, the fix is to revert it via git history, not to have blocked the merge in the first place.

Two owner controls remain, and neither blocks the pipeline: **which** work gets built (upstream, by specifying issues) and **revert** (downstream, via git history) if a shipped result is wrong. This does not authorize agents to redesign — the north-star's "agents do not redesign" still stands; only the human pre-merge gate is removed.

This decision **supersedes** the `agents/orchestrator.md` owner-visual-gate previously recorded in that file's Constraints section (the "owner confirms the visual result" / "sanctioned final-eye gate" clause, describing a checkpoint anticipated but not yet built). That clause no longer applies; `orchestrator.md`, `.claude/commands/build.md`, `CLAUDE.md`, `.claude/commands/resume.md`, `docs/RESUME-STATE.md`, and `WHAT-IT-CHECKS.md` are updated in the same change to state the uniform merge-on-green policy.

**Superseded-for-visual-changes (2026-07-08, #294):** the decision above is kept as the historical record of why the owner-merge boundary was retired. It still governs non-visual changes unchanged. For **visual** changes specifically, it is superseded by the "Visual-approval loop reinstated" decision immediately below — see that entry for the reinstated mechanism and rationale.

### Visual-approval loop reinstated (active screenshot gate) (#294) — SUPERSEDED by #378

**SUPERSEDED (2026-07-15, #378).** This entry's mechanism — an implemented change screenshotted at
three phone form factors and sent to the owner for approve/edit — is retired. It is kept below as the
historical record of what shipped 2026-07-08 and why; it no longer describes how the loop works. The
current mechanism is "Visual-approval loop, live-preview mechanism (#378)" immediately below.

**Why it was retired, not just replaced.** Screenshots were not merely swapped for a cheaper
alternative — they were found unreliable in practice (2026-07-15 owner evidence): in one session the
`claude-in-chrome` classifier went intermittently unavailable, `save_to_disk` wrote images the agent
could not locate, `preview_screenshot` timed out, and Artifact hosting returned `401`. Worse, a
viewport capture is unfaithful even when it succeeds — it clips exactly the off-screen overflow an
owner needs to catch (#388's iPhone-SE masthead overflow is the worked example), and fonts do not
reliably render in a headless capture. Owner: _"no longer want screenshots, is always bad... font not
render."_ The replacement is not "screenshots but automated better" — it is the owner looking at the
real, running app himself, which no capture step can misrender or fail to produce.

**Decision (2026-07-08, historical):** the owner reinstated a pre-merge **visual-approval loop** for visual changes only, superseding "Merge policy: owner-merge boundary retired" (2026-07-02) **for visual changes**. A change is visual when its diff touches `views/**/*.ejs`, `src/public/**`, badge art or other rendered assets, or guest-/admin-facing copy shown in a rendered page — the same surface as the "Views/CSS/badge assets/guest-or-admin-facing copy" row of `standards/adversarial-review-protocol.md` § "Which reviews does this change need?". Non-visual changes are unaffected: they still merge on adversarial-review PASS + green CI, exactly as the 2026-07-02 decision states.

**Mechanism as shipped 2026-07-08 (historical, no longer live).** After implementation and before the adversarial PR review, the orchestrator (running in the screenshot-capable `/build` main-loop session) booted the worktree's own app — the current worktree's `src/app.js`, worktree-relative working directory, on a local port — so it served the worktree's edited `views/**` and `src/public/**` rather than the primary checkout. It then captured an active screenshot of the affected screen(s) at three form factors (iPhone SE, iPhone 14 Pro Max, Samsung Galaxy S20 Ultra) and sent them to the owner, driving an approve/edit loop to an explicit yes/no before the visual change proceeded to adversarial PR review, the commit gate, CI, and merge.

**Rationale as shipped 2026-07-08 (historical) — answered the 2026-07-02 failure mode.** The retired 2026-07-02 gate failed because it was _passive_: a PR was left open for the owner to merge by hand, so PRs held for manual merge accumulated open and nothing shipped. The 2026-07-08 gate was _active_: the orchestrator did the running and screenshotting the owner previously had to do himself, and drove the loop to a decision rather than parking a PR. This removed the "nothing ships" failure mode while restoring the owner's ability to catch "correct but not what I meant" before it was expensive to change — a goal the #378 replacement keeps, by a different mechanism (see below).

**Not a redesign license (unchanged).** Neither this retired gate nor its #378 replacement is authorization for agents to originate design changes — the north-star's "agents do not redesign" still stands.

### Visual-approval loop, live-preview mechanism (#378)

**Decision (2026-07-15, owner):** replaces the screenshot mechanism above with a **live seeded-preview
link + byte-freeze + two-doors** loop. A change is visual under the same trigger as before — its diff
touches, or will touch, `views/**/*.ejs`, `src/public/**`, badge art or other rendered assets, or
guest-/admin-facing copy shown in a rendered page (the "Views/CSS/badge assets/guest-or-admin-facing
copy" row, unchanged). Non-visual changes remain unaffected, exactly as the 2026-07-02 decision states.

**Mechanism.** `scripts/preview.js` (`npm run preview`) seeds a scratch, throwaway database (`DATA_DIR`
never the real event's — AC2) and boots this worktree's own `src/app.js` on a free port, printing one
`http://localhost:<port>` line. The orchestrator hands the owner that link and edits the real
`views/**`/`src/public/**` directly, in this worktree, while the owner keeps the link open and
refreshes — "arrows are clutter" → two lines gone → refresh → five seconds, repeated until the owner
says approved. **Nothing commits during this phase**; the commit gate is unmoved, unchanged from
before. At approval, `tools/persist-visual-approval.ps1` hashes the visual surface
(`tools/visual-surface.ps1`, the same glob set the row above defines) and records the approval outside
that hashed set; `tools/check-visual-approval.ps1` (run at commit time) exits non-zero and names the
file the moment anything in the surface drifts from what was approved. Only then are that surface's
acceptance criteria written — they **transcribe** what was approved rather than defining it upfront
(`standards/issue-standards.md` § "the approved screen is the acceptance criterion") — and the normal
pipeline (issue review, implementation, adversarial PR review, CI, merge) runs on the result. Full
mechanics: `agents/orchestrator.md` § "Visual-approval loop".

**Two doors, and only two, for a phase-2 change to the approved pixels.** Door 1: the look moved by
accident — a bug, put it back, the owner is not asked. Door 2: it genuinely cannot be built that way —
stop, bring the owner the screen, one line of why, one option, and he decides back in the fast
phase-1 loop. There is no third door; nobody renegotiates the owner's approved look unilaterally.
Door 2 frequency is unknown, so it is counted in the run report rather than assumed.

**Deliberately not attempted:** no screenshots or PNG capture in any form, no headless browser, no
pixel/image diffing (the byte-freeze gets most of the same guarantee — "did the file change" — for a
fraction of the cost and none of the capture fragility above), no CI-required visual check (the freeze
runs in the pipeline; promoting it to a required status check is a later call).

**The honest hole in the freeze, stated rather than hidden.** What the owner sees depends on more than
the hashed files alone — seed data, a shared partial, a CSS variable, an asset path elsewhere. Something
outside the hashed set can in principle change what renders without moving the hash. No byte check
closes that; the design reviewer and the recorded design language are the intended cover, not a claim
that the freeze is airtight.

**Rationale for the replacement mechanism.** Screenshots were retired, not merely upgraded — see "Why
it was retired, not just replaced" above. The live-preview loop keeps the 2026-07-08 gate's core win
(catch "correct but not what I meant" before it is expensive to change, without leaving a PR parked)
while removing the capture step that kept failing and the surface it could misrepresent (viewport
clipping, font rendering) — the owner now looks at the actual running app, not a picture of it.

**Not a redesign license (unchanged).** This loop is a product-taste checkpoint, not authorization for
agents to originate design changes — the north-star's "agents do not redesign" still stands.

### Hosted deployment

**Decision (2026-07-07):** the app moves from the laptop-and-tunnel model to a rented host. SQLite and local-disk photos are deliberately retained — the host's persistent disk makes them safe at this scale, so the single-file-database decision above is not revisited. TLS terminates at the reverse proxy; the app itself still serves plain HTTP on localhost, as it always did. `TRUST_PROXY` (`config.js`) tells Express to honor the proxy's forwarded-for headers so downstream code sees the real guest IP rather than the proxy's. The public hostname is now stable and load-bearing: the QR codes printed for the event encode it, so it cannot change between print and party the way a tunnel URL could.

The gallery pages are guest-gated; the noindex posture behind that gate (`robots.txt` plus a `noindex` response header and meta tag, decided 2026-07-07) is defense-in-depth, not the access control — it keeps guest photos out of search results if the gate is ever weakened or a page is served outside it.

**Naming note:** `TRUST_PROXY` and the other names recorded in this ADR are the spec — #282 implements exactly these names. A forced divergence updates this ADR in the implementing PR.

**Process lifecycle (#282):** a hosting platform's process supervisor probes liveness and restarts the process on every deploy, so the app must answer both. `GET /healthz` is a DB-touching readiness probe — it runs `SELECT 1` against the live SQLite handle and returns `200 {"ok":true}` normally or `503 {"ok":false}` if that query throws (a wedged or corrupt DB fails the platform's check rather than reporting healthy). It is mounted ahead of maintenance mode, so it stays up during a maintenance window, and ahead of `attachGuest` and the routers, so it never pays session-lookup cost and — once #283's rate limiter lands — is never rate-limited by placement alone. On `SIGTERM` (platform restart/redeploy) or `SIGINT` (local Ctrl+C), `src/utils/shutdown.js` drains in flight requests (`server.close`), closes the database, and exits 0; a `timeoutMs` (default 10s) force-exit backstop guards against a connection that never drains. Both handlers are registered only inside the `require.main === module` guard, so requiring `src/app.js` under test never attaches real process signal listeners.

**Container shape (#286):** the image is a **multi-stage** `node:20-slim` (glibc, not alpine) build. `sharp` resolves a prebuilt native binary via its `@img/sharp-linux-x64` npm package with no compiler needed, but `better-sqlite3` does not ship a prebuilt binary for this base image — it falls back to compiling from source via node-gyp, which needs Python 3, `make`, and a C++ compiler. A **builder stage** installs that toolchain with `apt-get` and runs `npm ci --omit=dev` there, so the compile happens once, at build time, in a stage that never ships. The **final stage** is a clean `node:20-slim` with no toolchain at all; it copies the builder's `/app` (compiled `node_modules` and source) across with `COPY --from=build` — both stages share the same glibc base, so the already-compiled `better-sqlite3` `.node` binary runs unmodified in the final image. The process runs as the non-root `node` user (uid 1000), never root; `docker-compose.yml` bind-mounts `./data` and `./backups` from the host, so the persistence boundary is plain host files under the operator's own backup and disk-failure story, not a Docker-managed named volume. The app always listens on `3000` inside the container (`EXPOSE 3000`, the `HEALTHCHECK` probe, and the `CMD` all agree on this); a different host-facing port is obtained by remapping the host side of the compose `ports:` entry, never by setting `PORT` — setting `PORT` for this path would desync the app's actual listen port from the image's fixed `EXPOSE`/`HEALTHCHECK`, which would report the container unhealthy and trigger `restart: unless-stopped` to loop it. `PORT` remains a live override only for the bare-systemd path (Option B in `docs/deploy.md`), which has no such fixed image contract to desync from. Full runbook: `docs/deploy.md`.

### CSRF tokens and security headers: implemented (#284)

**Decision (2026-07-23, superseding the earlier deferral):** the app now ships a signed double-submit CSRF token (`src/middleware/csrf.js`) plus three baseline security response headers (`src/app.js`). The deferral this section used to record (`grep -rni csrf src/` returning nothing) is no longer the state of the tree — this section states the mechanism actually built, not the case for waiting.

**Mechanism.** `csrfMiddleware` (wired in `src/app.js`, after `cookie-parser` and the `urlencoded`/`json` body parsers, before every router) runs on every request:

- **Issues a token.** Reuses `req.signedCookies.csrf` if present; otherwise mints `crypto.randomBytes(32).toString('base64url')` and sets it as a signed cookie via the SAME shared `cookieOpts()` factory (`src/middleware/session.js`) the `gsid`/`admin` cookies already use — httpOnly, `sameSite: 'lax'`, `secure` per `config.COOKIE_SECURE`, signed, `GUEST_COOKIE_MAX_AGE_MS` (400 days) maxAge. Exposed to every view as `res.locals.csrfToken` — **masked per response since #1013** (see "Per-response token masking" below), not the raw cookie value.
- **Verifies on unsafe methods** (POST/PUT/PATCH/DELETE only — GET/HEAD/OPTIONS are never gated, so a guest's first page load always gets a token instead of a 403 before one exists anywhere). Multipart requests get a NARROW carve-out, not a blanket pass: for a `multipart/form-data` request, the body is not parsed yet (multer runs inside the route), so the middleware checks the always-available `X-CSRF-Token` header, unmasks it, and stamps `req.csrfVerified` with the result — and defers to the route's own post-multer check ONLY if the request's path is one of the four dedicated upload routes (`MULTIPART_UPLOAD_PATHS`: `/join`, `/tasks/:id/submit`, `/memories`, `/me/edit`). A multipart request to any OTHER route falls through to the same header-only verify every non-multipart request gets, and is rejected right here on a missing/wrong header — declaring `Content-Type: multipart/form-data` on a route that never parses a body cannot skip CSRF just by claiming that content type. For every non-multipart unsafe request (urlencoded, JSON, or no body), the submitted token is `req.get('X-CSRF-Token') || req.body._csrf`, **unmasked, then compared** against the cookie token and rejected on mismatch.
- **Comparison is constant-time** (`crypto.timingSafeEqual`, length-guarded first so a mismatch never throws) everywhere a token is checked.

**The multer-ordering problem #560 flagged is solved by deferring, not skipping, verification — and the deferral is scoped to exactly four routes, not "any multipart request."** `POST /join` (`src/routes/auth.js`), `POST /tasks/:id/submit`, `POST /memories`, and `POST /me/edit` (`src/routes/guest.js`) each call the module's second export, `assertCsrf(req)`, themselves — immediately after their own multer callback parses the body, and before any state change (DB write, file save). `assertCsrf` passes if `req.csrfVerified === true` (the header already matched, set by the middleware before multer ran — the path a JS `fetch` upload takes) OR `req.body._csrf`, unmasked, now matches the cookie (the path a no-JS native multipart submit takes, since its only token is the hidden form field multer just parsed). A route acting on a `false` result cleans up whatever multer already wrote to disk before rejecting: `photos.deleteOriginalFile` for the two disk-storage routes (`/tasks/:id/submit`, and `cleanupBatchOriginals` for `/memories`'s whole batch), nothing extra for the two memory-storage avatar routes (`/join`, `/me/edit`), since a buffer that is never saved leaves no file behind. Every other route in the app — including a multipart-declared forgery aimed at one of them — is verified by the middleware itself, never deferred; an adversarial review of an earlier draft of this change (issue #284) found that the deferral had no path restriction at all, so any route could dodge CSRF by simply setting a multipart Content-Type, and only the four routes above ever called `assertCsrf` to catch it after the fact. `tests/csrf.test.js`'s "Multipart-bypass regression" describe block exercises this exact attack shape against one guest route and one admin route.

**Reject behavior, one shared literal:** every rejection path — the middleware's own, and the four routes acting on a `false` `assertCsrf` — renders `res.status(403).render('error', { message: 'Your session could not be verified. Please refresh the page and try again.' })` via the module's third export, `rejectCsrf(res)`. No state changes on a rejected request.

**Client side, one shared owner:** `src/public/js/csrf.js` (loaded on every page via `partials/footer.ejs`, ahead of every other script tag) exposes `window.csrfToken()`/`window.csrfHeader()`, reading the token off `<meta name="csrf-token">` (`partials/head.ejs`). Every write `fetch()` in the app (`upload.js`, `feed.js`, `recap.js`, `admin-tasks.js`, and the inline `sendBeacon`/`fetch` fallback in `admin-bugs.ejs`'s "Open issue" tracking click) merges that header in. Every `<form method="post">` under `src/views/**` includes `partials/csrf-field.ejs`, a single hidden `_csrf` input, as the first field inside its opening tag — enforced by a filesystem walk in `tests/csrf.test.js` (AC5) that strips EJS tags before scanning for `<form>` open tags (an earlier version of that same test used a naive regex whose match stopped at the first `>`, which for a form whose action attribute embeds an EJS output tag is the `>` INSIDE `%>` — silently skipping several real forms; fixed alongside this note) and asserts a floor on how many forms it actually inspected, so the guard itself cannot regress back to checking almost nothing while still reporting green.

**Deliberately no Content-Security-Policy.** Several views render inline event-adjacent attributes via EJS (an inline onclick built from a template literal in `admin-bugs.ejs`, for one), and a CSP tight enough to matter would need an inline-script audit this codebase has not done. Landing an untested CSP alongside the rest of this change risked breaking a page for a guess at hardening the other three headers do not carry the same risk for; the three headers that are safe to add unconditionally shipped, the one that is not did not. Those three headers themselves — `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` — live in `src/app.js`'s existing response-header middleware (alongside `X-Robots-Tag`), not in `csrf.js`: that middleware runs ahead of the static-file mounts, so `/uploads`, `/thumbs`, `/js`, and `/css` carry them too — `nosniff` on `/uploads` (user-submitted photo bytes) is the header that matters most there, and a copy living inside `csrf.js` instead (which is wired in AFTER those mounts) would never reach them.

**The four open questions #284 required answered — now "how the build handles it" rather than "why it can wait":**

1. _Does the deployed hosting put untrusted content on a sibling subdomain?_ **No** — unchanged from the deferral's answer; #544's single dedicated domain is still the only thing this app shares an origin with.
2. _Is any guest-facing state change reachable via GET?_ **No** — unchanged; every mutation route is still `router.post`/`put`/`patch`/`delete`. Every one of those routes is CSRF-gated: directly, by the middleware, for every route except the four dedicated upload paths, which gate themselves post-multer instead (see the mechanism above) — not a blanket "the token layer gates everything the same way" claim, since multipart genuinely does take a different path for those four.
3. _What was the actual cost?_ One new middleware module plus three header lines in `src/app.js`'s existing response-header middleware, four routes (`/join`, `/tasks/:id/submit`, `/memories`, `/me/edit`) each get a four-line post-multer check, every `<form method="post">` under `src/views/**` gets one hidden-field include, five client JS files get a header merged into their write `fetch()` calls, and one new test file (`tests/csrf.test.js`) covers rejection, the multipart no-JS-field path, the multipart-bypass attack against non-upload routes specifically, and a table-driven sweep of a representative set of state-changing routes across every router (not an exhaustive enumeration of every route in the app — a sample chosen to span urlencoded/JSON/no-body shapes plus the two explicit multipart-attack cases) so a future unprotected route is likely to fail the suite. No route needed restructuring; the multer-ordering problem was solved by deferring verification into the route, not by skipping it.
4. _Was cross-site forgery against a guest worth building for?_ **Built anyway, ahead of the original post-wedding timeline**, once the multer-ordering solution above was worked out concretely enough to no longer read as "the highest-blast-radius change in the app" — the actual diff touches every write path exactly once, in a uniform, mechanically-checkable way (the table-driven test above), not as a rewrite of each route's own logic.

**Test-only legacy grandfather clause (`src/middleware/csrf.js`).** The ~150-file test suite predates this issue and no existing test supplies a CSRF token on its own write requests. Rather than hand-editing every one of those files to mint and carry a token — a mechanical change disproportionate to this one issue, and itself a large surface for a new bug to hide in — the module forgives a request that supplies **no** token at all (neither header nor `_csrf` field) while `NODE_ENV=test`, following the same `isTestEnv()`-gated-seam pattern `src/routes/auth.js` already uses for its own post-hoc test seams (`_setCompareImplForTest`, `_resetAdminLoginSemaphoreForTest`) — inert outside test env by construction, so it can never fire in production regardless of the flag's value. It forgives only "never touched this feature," never "got it wrong": a request that supplies a **wrong** token is rejected unconditionally, flag or no flag, so it can never mask a real bug in the double-submit comparison. `tests/csrf.test.js` calls `_setLegacyBypassForTest(false)` to disable this for its own assertions, so that file — and only that file — exercises the real, unforgiving mechanism end-to-end, including the "supplies nothing" case, which is the actual shape of a cross-site forgery.

**Per-response token masking (#1013), BREACH mitigation for #1012's compression.** `res.locals.csrfToken` — the value rendered into `partials/csrf-field.ejs`'s hidden field and `partials/head.ejs`'s meta tag — is `maskToken(token)`, not the raw session token: a fresh XOR mask drawn on every render. `maskToken`/`unmaskToken` (`src/middleware/csrf.js`, declared beside `generateToken`) decode the 43-character base64url token to its 32 raw bytes, XOR against a fresh `crypto.randomBytes(32)` mask, and emit `base64url(mask ++ xored)` — an 86-character value; `unmaskToken` reverses it and returns `null`, never throws, on any malformed input (wrong length, or a decode that does not land on exactly 64 bytes), so a hostile submitted value takes the ordinary rejection path instead of a 500. The signed cookie write (`res.cookie(CSRF_COOKIE_NAME, token, ...)`) is untouched — it keeps writing the RAW token, so session lifetime and the double-submit shape are exactly what they were before this issue. Only what gets rendered into HTML differs per response, which is the entire point: #1012 turned on response compression, and a stable secret reflected into a compressible body alongside attacker-influenced input (the `q` param `gallery.ejs`/`admin-photos.ejs` reflect — see the BREACH note on #1012, below) is the textbook BREACH precondition. Masking removes the "stable" half of that precondition; the other two (compression, reflected input) are unchanged, because BREACH is mitigated at the secret, not by touching either of them.

**Why the test is a 20-render check, not "two renders differ everywhere."** A naive test that renders a page twice and asserts every character position differs would fail a CORRECT implementation roughly three CI runs in four (measured: two masked renders collide at _some_ position 76.2% of the time, N=300,000) — the 86-character masked value carries only 256 bits of entropy, since its second half is fully determined by its first given the fixed token, so it is not 86 independent random characters. `tests/csrf.test.js`'s AC1 block instead renders one page 20 times off a single session and asserts no character position is constant across all 20 (expected count for correct masking: ≈3.6 × 10⁻¹², i.e. never in practice) — that is what actually separates a correct implementation from the broken variant this issue's Context warns against (XORing the mask over the 43-character _string_ instead of the decoded 32 bytes: 100-character output, 14 positions stable across every render). Measured against this tree's implementation: 20/20 renders were 86 characters, all decoded to exactly 64 bytes, all 20 were pairwise distinct, 0 of 86 character positions were constant across all 20, and none of the 20 response bodies contained the session's raw token as a substring.

**`submittedMatches` — one shared comparison, three call sites, never three copies.** Every place a submitted token is checked against the raw cookie token — `csrfMiddleware`'s multipart header check, its shared urlencoded/JSON verify, and `assertCsrf`'s post-multer body check — calls one function, `submittedMatches(submitted, rawToken)`. It accepts either: (1) `submitted` unmasks (`unmaskToken`) to a value equal to `rawToken` — the normal shape every page rendered after this change emits — or (2) `submitted` equals `rawToken` directly. Branch 2 is a deliberate rollout accommodation (AC4): a page a browser rendered BEFORE this change deployed carries the OLD raw 43-character token baked into its hidden field and meta tag, and that already-loaded page must still submit successfully after deploy or a guest with a tab open mid-party gets locked out. Accepting a raw token on the way IN costs the mitigation nothing — BREACH extracts its secret by observing RESPONSE body sizes, and a submitted request value is never rendered back into a response body for an attacker to size-oracle against.

**The rollout accommodation is forward-only — a rollback is not covered, and is not silent about it.** Branch 2 above handles a pre-deploy page submitting after this change ships; it does not handle the reverse. `tools/deploy.sh` ships a push-button rollback (see "Push-button, not automatic, deploy" below), and on a rollback an already-loaded page carries an 86-character masked token that the REVERTED (pre-#1013) code compares raw, directly, against the 43-character cookie — that comparison always fails, so every guest with an open tab gets a 403 until they refresh. This is self-healing, not silent data loss: `rejectCsrf`'s copy literally tells the guest to refresh, a refresh re-renders against the reverted code's own (unmasked) token, and no state is lost — but a rollback is not the symmetric inverse of the forward deploy the way branch 2 above is, and this note exists so a future reader does not assume it is.

**Known cost: HTML responses stop revalidating.** `src/app.js` never disables Express's default weak `ETag` (its own `app.set` calls — `trust proxy`, `view engine`, `views` — carry no `etag`/`disable` line), so every `res.render` has always carried one. Once each rendered body embeds a fresh 86-character token, no two renders of the same page ever hash alike, so a conditional GET for an HTML page can no longer return `304` after this change. Accepted rather than engineered around: the pages this affects (feed, gallery, leaderboard) already change on nearly every request at party scale, so their ETags rarely matched even before masking, and #1012's compression already cuts the full body to single-digit KB regardless of whether a `304` was possible. Static assets are unaffected — they are served by `express.static`, never `res.render`, and carry no CSRF token.

**Known cost: a flat +76 B per HTML page on the wire, under #1012's brotli quality 6.** Measured against this tree: `/login` 997 → 1,073 B, `/join` 1,211 → 1,287 B — both +76 B, not a per-occurrence cost, even though `partials/head.ejs`'s meta tag and `partials/csrf-field.ejs`'s hidden field both render a masked token on the same page (two occurrences). The token is masked once per RESPONSE (one `maskToken(token)` call, cached onto `res.locals.csrfToken` by `csrfMiddleware`), not once per render SITE, so both occurrences on one page are the same masked string — they still compress against each other inside that one response the way two occurrences of the old stable token did, which is why the added cost is flat rather than scaling with how many places a page happens to render the token.

**Residual risk, not closed by this change.** Two things the security review established that masking does not fix:

1. _No cookie rotation._ A token leaked during a window where compression shipped without masking stays a valid forgery credential for `GUEST_COOKIE_MAX_AGE_MS` (400 days) — rotation is the only remediation, and this change does not add one. Deleting the raw-token rollout fallback (branch 2 above) would not retire that exposure either, because re-masking any already-known raw token is accepted by design (masking hides an unknown secret from an observer, it does not stop a holder of the raw value from using it). The mitigating fact: **#1012 has not been deployed** — verified directly on 2026-08-02, `curl -sI https://lillyandaxel.com/login` returns no `Content-Encoding` header — so if #1013 ships in the same deploy as #1012, the compression-without-masking window this risk describes never opens in production at all.
2. _The masked value is not integrity-protected._ `unmaskToken` accepts the standard base64 alphabet (`+`/`/`, not just base64url's `-`/`_`, since Node's base64url decoder is lenient), non-canonical trailing bits, and a submitted value with its mask/xored halves swapped (XOR commutes, so `mask ++ xored` and `xored ++ mask` decode to the same raw token). None of these yield acceptance without the caller already holding a valid raw token — so this is cosmetic, not exploitable — but it means the masked value itself carries no signature of its own; it is a reversible encoding of the real (cookie-signed) secret, not a credential in its own right. Recorded so a later reader does not mistake `unmaskToken` returning non-null for having verified anything beyond "this decodes to the right shape."

**Loopback-only publish (#561):** `docker-compose.yml` binds the published port to `127.0.0.1:3000:3000`, not `3000:3000`. Docker binds an unqualified host port to `0.0.0.0`, which put the app on the public interface in the clear beside the TLS site, defeated `Secure` cookies on that path, and let a caller forge `X-Forwarded-For` to bypass the per-IP limits from #283. A firewall does not fix this: Docker inserts its own iptables rules ahead of ufw's `INPUT` chain, so `ufw deny 3000` does not close a docker-published port. The control is the bind, not the firewall; `docs/deploy.md`'s firewall step is defense in depth on top of it.

**Drift guard reach, stated honestly (#571):** `tests/compose-port-binding.test.js` covers three publish mechanisms, and only those three: (1) the `app` service's `ports:` host-IP binding above (must be `127.0.0.1`, never bare or `0.0.0.0`); (2) `network_mode: host` on the `app` service, which shares the host's network namespace and makes Docker ignore `ports:` entirely — the guard reds this even though the `ports:` block still reads correctly; (3) a `docker-compose.override.yml` committed to the repo, which Docker auto-merges at runtime and could republish the port past a guard that only reads the base file — the guard asserts the path is untracked (`git ls-files`) and `.gitignore`'d, so one cannot be committed at all, deliberately or by an unqualified `git add .` from a checkout that already has one on disk. It does not shell out to `docker compose config` for any of this, because that merges a local override and would false-green on exactly the file it is checking for. The `network_mode` classifier itself discriminates the hazard from the harmless: it singles out `host`, and reports `network_mode: "service:foo"` / `"container:foo"` (sharing another container's namespace, not the host's) and `network_mode: bridge` / a plain `networks:` key as non-host — none of those publish the app past the `ports:` binding. The guard's assertion against the committed file is stricter than that classifier, and deliberately: it requires the `app` service to declare **no** `network_mode` key at all (bridge is already the default, so the committed file needs none), which reds `host` and — fail-closed — any other explicit `network_mode` too, rather than trusting the prose distinction on the one file that actually ships. The guard does not cover every conceivable publish mechanism (e.g. `--network host` passed outside compose, or a reverse-proxy misconfiguration) — only these three, which are the ones a compose-file edit can introduce.

**Push-button, not automatic, deploy (#562):** `tools/deploy.sh` plus a `workflow_dispatch`-only GitHub Actions workflow (`.github/workflows/deploy.yml`) replace the ad hoc `ssh` + `git pull` + `docker compose up -d --build` sequence with one repeatable, logged, reversible script — but deliberately not wired to run on every merge to `main`. Once invitations go out, real guests are on this site for weeks, and the event itself is a fixed date; a merge that rebuilds prod unattended — at 11pm, mid-reception, or mid-upload — drops in-flight connections with no one watching, a failure mode this event cannot absorb. A human choosing the moment is the control, not a CI trigger. Rollback is the same script pointed at an older commit rather than a separate procedure, so there is exactly one code path to keep correct, and it is exercised by the same tests either direction.

**Deployed commit on a public `/healthz` (#562):** `GET /healthz` reports `commit` (the `GIT_SHA` the image was built with, threaded through as a Docker build `ARG` by `tools/deploy.sh`) on both its 200 and 503 bodies. This is intentionally on a public, unauthenticated endpoint: the repository itself is public, so the deployed SHA discloses nothing a `git log` on GitHub does not already show. Knowing the live commit matters most exactly when the probe is failing — that is when someone is deciding whether to roll back — so gating it behind auth would remove the information at the moment it is needed most, for no confidentiality gained. This does not extend to anything non-public — no environment dump, no dependency versions — only the one commit SHA.

**Host key pinned from the provider console, not scanned at runtime (#562):** the deploy workflow writes a repo **variable**, `SSH_KNOWN_HOSTS`, into `known_hosts` and keeps `StrictHostKeyChecking=yes`. It does not run `ssh-keyscan` against the host from the runner. A runtime keyscan fetches the host key over the same unauthenticated network path the subsequent `ssh` then uses — an on-path attacker between the runner and the droplet answers the keyscan with its own key, `known_hosts` records it, and `StrictHostKeyChecking=yes` matches and proceeds against it, authenticating nothing. It is worse than ordinary trust-on-first-use: a GitHub Actions runner is ephemeral, so `known_hosts` never persists between runs and cannot even detect the host key **changing** — the one thing TOFU normally catches. The host's key is instead captured once, by the owner, from the hosting provider's own console (a channel the runner's attacker surface never touches) and stored as a variable rather than a secret, because a host key is public data, not a credential.

**Historical:** the app previously ran on a Windows laptop behind a Cloudflare quick tunnel (`cloudflared tunnel --url http://localhost:3000`), whose URL changed every run and was never depended on being stable.

### Rate limiting and persistent admin lockout (#283)

**Decision:** a hand-rolled, dependency-free fixed-window limiter (`src/middleware/rate-limit.js`), not `express-rate-limit`. The original `js/missing-rate-limiting` re-triage note (above) speculatively named `express-rate-limit`; the shipped implementation is a small in-house module instead, per the issue's own no-new-dependency constraint — a single Node process serving one event needs no external limiter library, and a hand-rolled Map-per-instance limiter is trivial to test with an injectable clock.

**Two DISTINCT limiters coexist, never double-counting the same request:**

- `src/services/rate-limit.js` (#247/#281, pre-existing): a per-guest SLIDING-WINDOW limiter owning `POST /memories` and the HEIC-decode throttle.
- `src/middleware/rate-limit.js` (#283, new): a FIXED-WINDOW limiter owning everything else — `POST /join`, `POST /login` (IP-keyed), `POST /tasks/:id/submit`, `POST /me/edit`, `POST /bug-report`, `POST /p/:id/like`, `POST /p/:id/comments` (guest-keyed).

**Keying, per Goal A's venue-NAT constraint:** authenticated guest actions are keyed per-guest (`'g' + guest.id`), never per-IP — the whole guest list can share one venue-NAT IP, and per-IP limits on guest actions would throttle the group. Only the two unauthenticated endpoints, `POST /join` and `POST /login`, are IP-keyed, and each gets its OWN limiter instance (not a shared bucket) — a signup flood must never also lock a returning guest out of logging in from the same NAT IP, and vice versa.

**Shipped limits (env-overridable, `config.js`):** `RATE_LIMIT_WINDOW_MS` 600000 (10 min, shared by all); `RATE_LIMIT_IP_MAX` 300 (join and login, each its own counter — sized so the whole ~100-guest list joining/logging in from one NAT IP in one window clears with ~3x headroom); `RATE_LIMIT_UPLOAD_MAX` 20 (shared by `/tasks/:id/submit` + `/me/edit`, per guest); `RATE_LIMIT_SOCIAL_MAX` 60 (a SEPARATE counter each for `/bug-report` and the `/like`+`/comments` pair, per guest); `RATE_LIMIT_TRACKED_MAX` 5000 (distinct keys per limiter instance — see the cap discussion below). Full rationale for each number is in `config.js`'s own comments.

**No limiter on `POST /admin/login`, deliberately:** a pre-auth per-IP limiter would also throttle the real admin's correct password once tripped, and at the venue, admin and attacker can share one NAT IP. The brute-force control there is the persistent lockout below, not a rate limiter.

**Persistent admin lockout (`src/services/lockout.js`):** the admin-login failure counter and lockout timestamp now live in a new `settings` key/value table (SQLite, guarded migration in `src/db.js`, shape coordinated with #253's planned table) instead of the module-scoped scalars `src/routes/auth.js` carried before — the one piece of rate-limiting state in this app worth surviving a restart (a hosted deploy or crash-relaunch no longer hands a mid-brute-force attacker a fresh counter). Issue #49's invariant is unchanged: `bcrypt.compare` runs first, unconditionally; a correct password always clears the lockout and wins.

**Admin-login CPU-bound gate (#543) — a concurrency gate, not a rate limiter, so it does not reopen the "no limiter" decision above.** The lockout above bounds _guessing_ (how many wrong passwords land before a `429`), not CPU: a fully locked-out attacker still forces a complete `bcrypt.compare` on every request, because the compare (the `compareImpl` call inside `POST /admin/login` in `src/routes/auth.js`) runs first and unconditionally, ahead of the lockout check (issue #49's invariant, preserved). `bcryptjs` is the pure-JS implementation and runs entirely on the single Node event loop thread; one compare at the shipped cost factor measured ~173ms. Left ungated, N concurrent `POST /admin/login` requests put N compare chains on that one thread at once, and every guest's gallery/task/upload request competes against all of them for a turn — an unauthenticated caller could crowd every guest off the loop with nothing but repeated wrong guesses, directly against Goal A. `src/routes/auth.js` wraps the compare in a module-level `Semaphore` (`src/utils/semaphore.js`, generalized out of `src/utils/upload-concurrency.js`'s pre-existing one) sized from `ADMIN_LOGIN_MAX_CONCURRENT_COMPARES` (default 2), bounding the compare's share of the event loop to that many concurrent holders regardless of how many requests arrive.

This gate bounds _concurrency_, never _rate_, which is what keeps it compatible with the "no limiter" decision above: an over-limit caller QUEUES (no depth bound, nothing ever refuses an arriving request) rather than being rejected, so the real admin's correct password is never turned away even deep in a flood of wrong-password queueing — the queue-don't-reject choice `src/utils/upload-concurrency.js` already made for #311's upload pipeline, reused here for the same reason. The one deliberate refusal: a QUEUED waiter whose client has already disconnected is dropped from the queue (via an `AbortSignal` threaded through `Semaphore.acquire`, tripped by `res`'s `'close'` event — not `req`'s: `req`'s readable stream is already fully drained by the time the handler runs, since the global `urlencoded` body parser reads the whole body first, and `req.on('close')` fires the instant that read finishes — immediately, for every request, not on an actual disconnect. Verified empirically on Node 24.16.0 (this dev host); CI and the shipped Docker image both pin Node 20 (`.github/workflows/ci.yml`, `Dockerfile`), and this is documented `http.IncomingMessage`-vs-`http.ServerResponse` `'close'` behavior, not a version-specific quirk, so the same res-vs-req choice holds there too). That disconnected caller cannot be "refused" in any meaningful sense — there is no one left to answer — so dropping it bounds queue depth by live connections at zero cost to the correct-password guarantee. Cancellation SPLICES the waiter out of the queue by identity rather than leaving a dead entry in place; the queue stores bare resolver functions with no liveness check, so a tombstoned (no-op) entry left behind by a naive implementation would permanently leak a slot once its turn came, worse than the DoS this gate fixes.

A third reason is what makes leaving the depth uncapped harmless rather than merely permitted: **a QUEUED waiter costs no CPU**, the one resource this gate bounds. It is a parked promise resolver sitting in `Semaphore`'s internal queue array, not a running compare chain — it takes zero event-loop turns until a slot frees. There is therefore nothing to protect the loop _from_ by capping queue depth; only in-flight count needs bounding, and that is exactly what the limit already does. (Per-waiter memory — one `req`/`res` frame plus the parsed password — is unaffected by this gate either way; that frame exists for any in-flight request, gated or not, and its own unbounded accumulation under sustained overload is the deferred #553 exposure below, not something this gate's queue depth changes.) Without this reason, "we cannot refuse anyone" (reason 1) reads as merely a constraint to work around — e.g. by adding a depth bound and accepting the AC2 violation as a lesser evil under extreme load. Reason 3 is why that trade is never necessary: an uncapped queue costs nothing to leave uncapped.

**What this gate does not fix, deliberately (tracked as #553):** it bounds the compare's _share_ of the event loop, not the _total drain rate_. One thread at ~173ms/compare drains ~5.8 compares/sec, full stop — raising or lowering the concurrency limit does not change that number, since interleaving chains on one thread is not parallel throughput. A flood arriving faster than ~5.8/s therefore still accumulates in-flight requests without bound, and the ~2GB host (see "Constraints that shaped the design" above) can still OOM under a sustained flood — exactly as it could before this gate, since the arithmetic is arrival-minus-drain and this gate does not appear in it. Fixing that needs a request-body size cap on the global `urlencoded` parser (currently unset, so each pinned password is attacker-sized up to the 100KB body-parser default) and/or a request timeout, both outside this gate's `Touches` and each needing its own issue-review round.

**Guest-login lockout bounding (#464, absorbed into #283):** the two separate `guestFailedAttempts`/`guestLockedUntil` Maps in `src/routes/auth.js` are merged into one Map (`contact -> { fails, lastFailAt, lockedUntil }`), bounded by sweep-on-write eviction (a stale, unlocked entry is dropped the next time a new contact fails) plus a hard cap, `GUEST_LOGIN_TRACKED_MAX` (default 5000). Eviction prefers the oldest UNLOCKED entry, so a contact serving an active lockout is never dropped while a cheaper victim exists — an ordinary flood of fresh contacts cannot un-lock anyone. See the degenerate case below for the one exception.

**Every map here needs a cap, not just a sweep — the sweep is not the bound.** Both maps reclaim expired entries on write, and that alone looks like a bound but is not: inside a single window nothing has expired, so a sweep can free zero while a flood keeps minting keys. Each map therefore carries a hard cap that evicts to make room, and the two caps differ only in which victim is cheapest:

- `src/middleware/rate-limit.js` — `RATE_LIMIT_TRACKED_MAX` (default 5000) per limiter instance; evicts the entry whose window expires soonest (nearest to being swept anyway). This matters most on the IP-keyed `POST /join` / `POST /login`, whose keys come from unauthenticated callers: a distinct-IP flood mints a key per IP, and without the cap the map grows without limit **and** every new-key insert pays an O(map size) scan on the single Node process — measured before the cap at 60,000 keys: ~14s of insert time and 106ms of blocked event loop across 200 further requests, freeing nothing. With the cap the map holds at 5000 and that per-insert scan is bounded rather than growing.
- `src/routes/auth.js` — `GUEST_LOGIN_TRACKED_MAX`, above.

**The one degenerate case, stated rather than hidden:** if every entry in the guest-lockout map is currently locked, there is no unlocked victim, and the cap can hold only by evicting the soonest-EXPIRING lockout — the entry nearest to lapsing on its own. Reaching that state costs an attacker `GUEST_LOGIN_TRACKED_MAX x GUEST_LOGIN_MAX_ATTEMPTS` failed logins (25,000 at the shipped defaults, against the IP-keyed `POST /login` limiter) and buys only the tail of one already-expiring lockout. The alternative — refusing to track the new contact — would leave that contact unable to be locked out at all, which is strictly worse; unbounded growth is worse still.

**No timers anywhere:** neither limiter uses `setInterval` (it would hold the vitest process open) — sweeping and cap enforcement both happen on insert, the next time a genuinely new key is written, rather than on a clock.

### Commit gate: review evidence bound to the staged tree

> **Retired 2026-07-17 (#587):** every mechanism this section describes — the evidence-store files,
> `verdict-core.ps1`, `persist-review.ps1`, `review_verdict.ps1`, `validate-verdict.ps1`, and the
> capture → runner wiring — is deleted. There is no review-evidence gate today; `.githooks/commit-msg`
> only checks that a code commit names a GitHub issue. See the "ADR: Governance teardown and freeze
> (#587)" below for what replaced it and why.

A commit is blocked unless review evidence bound to its exact `git write-tree` says PASS. Two records gate together: `.review_state/verdict.json` (the legacy single-line summary the `pre-commit` hook reads with `sed`) and the per-reviewer evidence files under `.review_state/reviews/<tree>/` (read by `tools/validate-verdict.ps1` through the shared `tools/verdict-core.ps1`). The evidence files are the authoritative per-reviewer record; the summary remains for the cheap shell check. Together they block the literal one-step bypass — a bare recorded PASS with no evidence files no longer authorizes a commit. They do **not** by themselves close the broader hole (see the honest bar below). They are written by **different** tools on purpose: `tools/review_verdict.ps1` records only the summary, and `tools/persist-review.ps1` is the sole writer of evidence — so the script that records a PASS cannot also fabricate the evidence the gate reads. Both records live under the gitignored `.review_state/`, so they never enter the tree they describe.

This is the honest bar: an **evidence-less commit is blocked**, but because the orchestrator can run both `review_verdict.ps1` and `persist-review.ps1` by hand with free-text reviewer ids, it can still self-attest — the self-attestation surface is **relocated, not eliminated**. That residual is made **tamper-evident** by a committed ledger + CI audit (a later slice). **Closed for the PR-review path (2026-07-12, #455):** `tools/capture-reviewer-verdict.ps1` extracts each PR-path reviewer's own trailing JSON verdict block from its raw return and writes it, verbatim, to a `-RunDir` `tools/review-runner.ps1` then consumes — so a PR-review PASS is now fed from the reviewer agent's own returned text, not hand-invoked by the orchestrator with a free-text reviewer id. **Still open:** the issue-review path (`tools/persist-issue-review.ps1`) remains a direct hand-recorded call — #455 scoped only PR-review recording — and even on the closed PR-review path we do not claim cryptographic unforgeability: the orchestrator still controls the machine that runs the capture step, chooses which raw-return file to feed it, and could in principle fabricate a raw return containing a self-authored JSON block. What #455 removes is the _transcription_ step (a human/orchestrator typing a verdict into `persist-review.ps1`'s arguments); it does not remove operator control of the underlying machine.

**Scoped exemption note (2026-07-11, #448):** "an evidence-less commit is blocked" above is no longer an absolute — a staged tree that classifies `trivial` under `tools/classify-trivial-commit.ps1` (a manifest-only dependency bump whose changed deps all classify `auto` under the shared `tools/classify-dep-pr-core.ps1` tier rules) plus a `chore(deps): `-prefixed subject skips this evidence gate entirely, matching the identical diff's Dependabot auto-merge policy. This is a third narrowly scoped exemption alongside the ledger appender (#219) and the event-mode hotfix (#220); see "Trivial dep-bump gate (#448)" below for the full mechanism.

### Bias-gate and adjudication evidence artifacts (#47)

> **Retired 2026-07-17 (#587):** both writers this section describes (`persist-bias-gate.ps1`,
> `persist-adjudication.ps1`) are deleted, along with the severity adjudicator itself and the
> system-level bar that made the bias-gate artifact mandatory. De-biasing a briefing is a spawning
> discipline now, not a mechanized, evidenced step — see `standards/adversarial-review-protocol.md`
> § "De-bias the setup" and the ADR below.

Two more `.review_state/` writers close out the remaining pieces of the 2026-06-28 audit's DoD items 1 and 3 (see the reconciliation note in issue #47): the **bias-gate** step (`standards/adversarial-review-protocol.md` "## Bias gate") and the **severity adjudicator** (`## Stop condition — soft cap and severity gate`) each now leave a tree-bound artifact instead of running invisibly.

`tools/persist-bias-gate.ps1` is the single writer of `.review_state/bias-gate/<tree_oid>/<gate_id>.json` (schema `bg1`; fields `schema`, `gate_id`, `verdict`, `tree_oid` self-binding, `ts`). `tools/verdict-core.ps1` adds `Test-BiasGateSatisfied`, which reuses the shared `Read-Evidence` reader (its tree_oid self-binding filter silently drops a file in the wrong directory or with a tampered `tree_oid`) and returns `ok` only when ≥1 `bg1` artifact for the tree is `PASS` and none is `FAIL` — per-artifact FAIL-wins, mirroring `Reduce-Verdicts`.

**Fail-closed rule:** `tools/validate-verdict.ps1` computes the real bar from the actually-staged paths via `Get-RequiredBar` (independent of any `-Required` override, so a caller forcing a higher bar by hand does not silently opt a non-system-level tree into the bias-gate requirement). When that real bar is `2` (a system-level path is staged), `validate-verdict.ps1` additionally requires `Test-BiasGateSatisfied` to be `ok`; if not, it writes a reason containing the literal token `bias-gate` to stderr and exits non-zero — a system-level tree with two independent review PASSes but no recorded bias-gate step still does not authorize a commit. A routine tree (bar `1`) is unaffected; no bias-gate artifact is required or checked. This runs at commit time automatically because `.githooks/pre-commit` already invokes `validate-verdict.ps1`.

`tools/persist-adjudication.ps1` is the single writer of `.review_state/adjudication/<tree_oid>/<adjudicator_id>.json` (schema `adj1`; fields `schema`, `adjudicator_id`, `exit` (`authorized`|`continue`), `tree_oid`, `ts`). This is a **durable record only** — no gate consumes it as of #47, parallel to the tamper-evident residual documented above. Adjudication enforcement, if ever added, is a separate issue; a missing consumer today is not a defect.

**Honest bar:** both writers share the same residual as `persist-review.ps1` and `persist-issue-review.ps1` above — orchestrator-run, so tamper-evident, not tamper-proof, on a machine the orchestrator controls. Out of scope for #47 (see its reconciliation note): a guarantee that the bias-gate and adjudicator steps _actually ran_ as real agent invocations rather than being hand-invoked; closing that is the same program-driven-runner slice referenced throughout this section.

### Program-driven review runner (#128)

> **Retired 2026-07-17 (#587):** `tools/review-runner.ps1`, `capture-reviewer-verdict.ps1`, and
> `tools/review-verdict.schema.md` are deleted; the PR-path reviewers no longer emit a trailing JSON
> verdict block. Review verdicts are prose only again. See the ADR below.

`tools/review-runner.ps1` (`-RunDir`, `-TreeOid`, `-Mode <both-pass|unanimous>`) is the mechanical front door for a reviewer panel's return: it reads each reviewer's verdict JSON (schema documented in `tools/review-verdict.schema.md`) from `-RunDir`, citation-validates every defect that cites a `file` (fail-closed: `file-not-found` if the file does not resolve under the repo root, `out-of-range` if `line` exceeds the file's line count), and aggregates verdicts across the panel. `-Mode` maps directly to the two reviewer-count bars in `standards/adversarial-review-protocol.md`: `both-pass` requires >= 2 distinct reviewer verdicts, all `PASS` (the system-level two-independent-reviewer bar); `unanimous` requires >= 1 reviewer verdict, all `PASS` (the routine rounds-2+ single-reviewer bar) — either mode still blocks on any `FAIL` or invalid citation regardless of panel size. Before validating anything, the runner computes `git write-tree` of the cwd and refuses to proceed if it does not equal `-TreeOid`, so the citation/verdict validation this script performs and the tree-level bind `tools/review_verdict.ps1` performs independently (via its own `git write-tree`) can never disagree about which tree passed. It does not reimplement evidence writing — on a fully clean pass only, it calls the existing `tools/persist-review.ps1` once per reviewer and `tools/review_verdict.ps1` to bind the tree-level verdict, staying consistent with the shared `tools/verdict-core.ps1` kernel the gate reads. On any invalid citation, any reviewer `FAIL`, an incomplete panel, or a tree-OID mismatch, it prints the specific reason(s) to stderr and exits non-zero, writing no evidence and no `verdict.json` — a reviewer that fabricates a citation cannot produce a recorded PASS. This is the runner referenced by #94's out-of-range citation validation and by #93/#115/#116; the PR-path reviewers (`reviewer-pr`, `reviewer-design-philosophy`) emit the block per #474, alongside their existing prose review, and #455 wired it into the pipeline: `tools/capture-reviewer-verdict.ps1` extracts each reviewer's trailing block from its raw return text and drops it, verbatim, into the `-RunDir` this runner reads — see "PR-review recording: capture → runner (#455)" in `standards/adversarial-review-protocol.md` and `agents/orchestrator.md` step 7 for the full wiring. `tools/review-verdict.schema.md` is part of the governing-artifact surface alongside this note, per the `docs/north-star.md`/`DESIGN.md`/`CLAUDE.md`/`AGENTS.md` system-level list above.

**Design choice weighed:** a directory-of-JSON drop (`-RunDir`, one file per reviewer) was chosen over per-reviewer stdin/args so the runner stays a pure, replayable function of files already on disk — a reviewer agent's return can be inspected, diffed, or re-validated without re-running the agent, and the runner's own input contract (`tools/review-verdict.schema.md`) is testable independent of any particular reviewer's invocation shape.

### Issue-review gate: every code commit names a reviewed issue (#46)

> **Retired 2026-07-17 (#587):** the reviewed-issue evidence check this section describes
> (`.review_state/issue-reviews/<N>/`, `tools/persist-issue-review.ps1`, `Test-IssueReviewed`) is
> deleted. `.githooks/commit-msg` today only checks that the commit message resolves to a GitHub issue
> number (widened to all 9 GitHub closing keywords per #585) — it no longer checks that issue has a
> recorded review PASS. See `WHAT-IT-CHECKS.md` and the ADR below.

**Binding decision:** the `commit-msg` hook (`.githooks/commit-msg`) is the enforcement chokepoint. A code commit is blocked unless its message resolves to a GitHub issue number AND that issue has a recorded issue-review PASS under `.review_state/issue-reviews/<N>/`. Issue-number resolution is deterministic: message first (`(#N)` or `Closes/Fixes/Resolves #N`), branch fallback only from an anchored mandatory-prefix regex (`(?i)(?:^|[-/])issue[-/](\d+)(?:$|[-/])`). A branch like `enforce/v4-s1-gate-core` does not resolve — the branch regex requires an explicit `issue[-/]` token and cannot capture bare numerals from version strings. The shared counting kernel (`Reduce-Verdicts` in `tools/verdict-core.ps1`) drives both the PR/tree gate and the issue gate — one function, two call sites, no duplicated logic.

Doc-only commits (`*.md` / `*.markdown` extension) are exempt from the blocking gate; a code file under `docs/` (e.g. `docs/evil.ps1`) is still CODE — folder location does not exempt it. Doc-only commits still need a linked issue for merge, which the advisory `merge-association` CI job checks.

**Honest bar:** a code commit can no longer reach history through the hooks without naming a GitHub issue that has a recorded issue-review PASS — the evidence-less path (draft locally, skip review, implement) is blocked at the `commit-msg` chokepoint, which fails closed and is CI-integrity-checked. **Reconciled (2026-07-11, #448):** rather than an unqualified "no bypass" claim, the honest statement enumerates three scoped, never-silent exemptions — the ledger appender (#219, the sole staged path is `governance/ledger.ndjson` and the message starts `ledger: `), the event-mode hotfix (#220, an ACTIVE `governance/event-mode.json` flag plus a `hotfix: `-prefixed subject), and the trivial dep-bump path (#448, a staged manifest-only bump that classifies `trivial` under `tools/classify-trivial-commit.ps1` plus a `chore(deps): `-prefixed subject) — each checked explicitly in the hooks, none a blanket skip; every other code commit still names a reviewed issue with no exception. **Still only tamper-evident:** the issue-review record is written by `tools/persist-issue-review.ps1` by hand, so a determined operator can record a PASS for an unreviewed issue. Authenticity (verdict from a real reviewer-agent return) is the deferred auto-runner slice. The record lands where a future ledger + CI audit can flag it; forgery is made visible, not impossible. Like `pre-commit`, the hook is bypassed by `git commit --no-verify` and inert in a clone where `core.hooksPath` is unset — the CI `commit-gate-integrity` and `merge-association` jobs are the server-side backstop, and the un-bypassable merge version is #48. **Not in this slice:** server-side merge enforcement ships as an advisory CI job; the un-bypassable version is #48. No un-forgeability claim on a machine the operator controls.

### Issue-creation review marker: born `needs-issue-review`, cleared by a separate reader-gated tool (#62)

> **Retired 2026-07-17 (#587):** `tools/clear-issue-marker.ps1` and its evidence-reader dependency
> (`Test-IssueReviewed`) are deleted. The label is now cleared directly, by hand, after a PASS on the
> issue review: `gh issue edit <N> --remove-label needs-issue-review`. The label itself, and its
> purpose (an unreviewed issue is board-visible), are unchanged.

Every GitHub issue is created carrying the `needs-issue-review` label (`gh issue create --label needs-issue-review`). The label makes a skipped issue-review tamper-evident and board-visible: an unreviewed issue is distinguishable from a reviewed one on the board without reading any code.

**Separation of writers is preserved.** `tools/persist-issue-review.ps1` is the single evidence writer and never touches the board. The board marker is cleared by a separate tool, `tools/clear-issue-marker.ps1`, which refuses to remove the label unless the evidence reader (`Test-IssueReviewed` from `tools/issue-core.ps1`) confirms a recorded PASS for that issue. The evidence writer cannot clear the marker; the marker-clearer cannot fabricate evidence — it can only act on evidence that already exists.

**Honest bar:** the marker is tamper-evident and board-visible, not cryptographically unforgeable. A determined operator can still record evidence by hand and then clear the label by hand — the same residual documented in the commit gate above. The label is hand-clearable (via `tools/clear-issue-marker.ps1` after evidence is on file), but not automatically clearable without that evidence. No cryptographic claim. No GitHub AI. No external service.

### Worktree-per-agent isolation (#113)

**Binding decision:** each file-mutating agent runs in its own git worktree; one working tree = one driver. `tools/new-agent-worktree.ps1 -Branch <name>` creates it: `git worktree add` gives the agent its own working directory and branch, sharing this repo's one object store and history with the primary checkout. No file is copied and no history is duplicated — only the working directory and the checked-out branch are separate per worktree.

**Rationale:** on 2026-07-02 a Dependabot session and a refactor session shared this one folder. One session's uncommitted work was stashed by the other; branches switched under a task mid-run. Two drivers in one working tree can stash, revert, or switch-branch-under each other with no warning, because git has exactly one HEAD and one index per working directory. A worktree per agent removes the shared mutable state that made the collision possible.

**Mechanism:** the commit gate stays live in every worktree with zero extra setup. `core.hooksPath` is set to the relative path `.githooks` in shared git config (see "Commit gate" above), and `.githooks/` is a tracked directory present on every branch checked out from `main`. Git resolves a relative `core.hooksPath` against the current working tree's root, so `<worktree>/.githooks/pre-commit` and `commit-msg` are found and run automatically — no per-worktree hook install. `tools/new-agent-worktree.ps1` does not assume this; it asserts it by running `tools/check-gate.ps1` inside the new worktree before reporting success. The gitignored `.review_state/`, `.run_state/`, and `data/` directories likewise resolve per-worktree, since each worktree has its own working directory root, so review evidence and runtime state never cross between concurrent agents.

**Pipeline-enforced, not prose-only (#148).** #113 shipped the creator (`tools/new-agent-worktree.ps1`) and a CLAUDE.md rule, but nothing in the pipeline the sessions actually run invoked it — a session could still open `.claude/commands/build.md` step 6 and run `git switch -c` directly in the shared primary checkout, reproducing the 2026-07-02 collision the creator exists to prevent. `tools/assert-worktree.ps1` closes that gap: a pure, side-effect-free check (mirroring `tools/check-gate.ps1`'s shape) that reads `git rev-parse --absolute-git-dir` and passes only when the result contains `/worktrees/` — true in a linked worktree, false in the primary checkout. `.claude/commands/build.md` now runs it at **Step 0**, before research or any file mutation, and directs the session to `tools/new-agent-worktree.ps1 -Branch <name>` on failure; step 6's per-issue `git switch -c` is likewise guarded by the same assertion on the same step, so a per-issue branch can never be cut in the primary checkout. `agents/orchestrator.md` states the same precondition as its first operating rule, so a session invoked directly (not via `/build`) is still bound by it. On failure the guard's remediation message is written to stderr only (via `[Console]::Error.WriteLine`, not `Write-Error`, to keep PowerShell 5.1's error stream clean) and names `tools/new-agent-worktree.ps1` literally, so the failure is both machine-checkable and self-remediating. Isolation is now a mechanical precondition of the pipeline itself, not a rule a session can forget to follow.

### Fetch-fresh worktrees, overlap-aware freshness, and wave alignment (#357)

**What happened (2026-07-09).** A `/build` session ran nearly end to end — full implementation, a 5-round adversarial issue review, two implementer fix passes, a complete system-level PR review, a bias-gate artifact, and a committed, gate-passed tree, every gate green — and a live visual walkthrough then showed the running app was missing a feature (#248, feed card v2) that had already merged to `origin/main`. The worktree had been cut from **local** `main` at a commit 76 behind `origin/main` (`tools/new-agent-worktree.ps1` had never run `git fetch`, so it inherited whatever local `main` happened to be); #248 had rewritten `src/views/feed.ejs`, a file the session also modified, and every review certified the session's work against a base `origin/main` had already abandoned. A human clicking around the running app was the only thing that caught it.

**Two holes, not one.** #200 had already shipped `tools/check-freshness.ps1` for the **owner-review** path (`skills/session-brief.md`, `README.md`): a staleness warning for a human about to review a checkout. #357 is that gap's **build-session** sibling: nothing in `/build`, `tools/new-agent-worktree.ps1`, or the orchestrator ran any freshness check on the worktree a session actually builds in, and #200's bare behind-count could not have caught this incident anyway — the drift that hurt this build arrived from a single overlapping file, not from a large stale commit count.

**Design response.**

- **`tools/new-agent-worktree.ps1`** now runs `git fetch origin` before every worktree it creates and, for a **new** branch, bases it on `origin/main` explicitly (`git worktree add -b <branch> <path> origin/main`) rather than local HEAD — so the new branch is 0 commits behind at birth regardless of how stale the primary checkout's local `main` is. A fetch failure exits non-zero and creates nothing (fail loud, never fall back to a stale base). Resuming an **existing** branch still fetches (so a later freshness check has a true remote view) but is checked out as-is — no rebase, merge, or reset.
- **`tools/check-freshness.ps1`** gains an overlap-aware signal on top of its existing behind-count: given a file list (an issue's `Touches`, a wave's combined `Touches`, or — when none is passed — the branch's own changes since its fork point), it computes the overlap between that list and everything `origin/main` changed since the branch forked, and treats any overlapping, non-carved-out path as a hard resync trigger **independent of commit count** — because one file two people are editing matters more than any number of unrelated commits. `MAX_DRIFT_COMMITS` (default 10) is defined once here as the threshold past which sheer commit count escalates the message even with no detected overlap; `config.js` does not duplicate it. The append-only carve-out list is, in this slice, exactly one path — `BUILDLOG.md` — because two writers appending distinct lines to it cannot corrupt each other's entries; "governance files" broadly are explicitly **not** carved out, since a reviewer-bar change genuinely can drift. **Narrowed (2026-07-11, #447), original text above preserved as history:** the per-merge writers that motivated this carve-out moved off `BUILDLOG.md` onto the harvested `governance-ledger`/`buildlog-entry` PR comments (see "BUILDLOG comment harvest (#447)" below); the carve-out itself remains for the file's now-narrower role — the exceptional `[HALT]`/wave-completion/`[AUDIT]` writers, which can still collide harmlessly the same way distinct per-merge lines once did.
- **`.claude/commands/build.md` step 0 and `agents/orchestrator.md`'s isolation rule** now run `tools/check-freshness.ps1` against the freshly-cut worktree before continuing, and both state explicitly that the **primary checkout's** own behind-count is not this gate and never aborts the build — it is bypassed entirely by cutting straight from `origin/main`.
- **`tools/check-wave-alignment.ps1`** (new) is the pre-wave collision check: given a wave's issue numbers, it reads each issue's `Touches` (from its local draft or `gh issue view`) and reports every pair of issues sharing a non-carved-out file, naming the file and both issue numbers, before the wave ever launches. It dot-sources `tools/check-freshness.ps1` for the carve-out list rather than keeping its own copy, so the two tools cannot quietly disagree about what counts as a real collision.
- **`.claude/commands/realign.md`** (new) is the between-waves command: fetch, fast-forward local `main` only when it is a clean, pure-behind (non-diverged) ref — otherwise report and stop without mutating anything — then report the overlap between what merged since the last wave and the next batch's declared `Touches`, using the same two tools. It is the **mechanical alignment** complement to `.claude/commands/post-wave-review.md`'s **post-merge judgment**; the two answer different questions and neither substitutes for the other.

**One wave in flight at a time (documented, not mechanically enforced here).** `/realign` runs at the seam between waves; the next wave is not launched until the previous one has merged and realigned. If waves overlap in time there is no "between" seat for either check to occupy, and a session can drift mid-run the way this incident did.

### Branch protection on main

> **Retired/superseded 2026-07-17 (#587):** the owner turned `strict` **off** on 2026-07-17, before
> this issue was filed — the `required_status_checks.strict = true` line below is stale on that point.
> The required-check set is also retargeted by this issue to exactly `{lint, test, smoke,
Analyze (javascript)}`; `commit-gate-integrity`, `merge-association`, `review-artifact-present`, and
> `event-mode-expiry` are gone (their jobs were deleted). `tools/apply-branch-protection.ps1` no longer
> takes the `-RequireSmoke`/`-RequireReviewArtifact`/`-RequireEventModeExpiry` switches — its required
> set is baked in. See the ADR below.
>
> **`lint`'s meaning changed 2026-08-01 (#973):** the required `lint` check now runs
> `eslint . --max-warnings=0`, so it blocks on any warning, not only an error — see "Lint is a
> ratchet (#973)" below.

**Binding decision:** `main` requires a pull request and `required_status_checks.strict = true` — GitHub's "require branches to be up to date before merging." The five base contexts are the ones `tools/apply-branch-protection.ps1` PUTs when no switch is passed — the real, observed check-run names on `main` (`commit-gate-integrity`, `lint`, `test`, `merge-association`, and CodeQL's actual produced name `Analyze (javascript)`, not the workflow name `CodeQL`). `required_approving_review_count` stays `0`: the owner is a solo maintainer, GitHub does not allow self-approval, and requiring ≥ 1 approval would lock the owner out of merging their own work — the AI adversarial review plus the required CI checks are the gate, not a human approval click (see § Merge policy). `enforce_admins = true` binds the admin merger to the same rules as everyone else. Applied via `tools/apply-branch-protection.ps1`, which PUTs the payload determined by its switch set and is idempotent **for a given switch set** — not a single fixed payload, since the PUT replaces the whole checks list rather than appending to it, so a run that omits a switch that is currently live silently drops that check (see `tools/apply-branch-protection.ps1`'s header comment).

`event-mode-expiry` — the CI expiry backstop created by #220, documented in full under "Event mode (#220)" below — becomes a required check via `tools/apply-branch-protection.ps1 -RequireEventModeExpiry` (#233), run once — as a deadline, not a wait: it must run before any event-mode flag has expired (both `NONE` and `ACTIVE` states are green), because a post-expiry promotion is pinned green forever and delivers nothing. The replace-not-append trap above applies to that run: carry forward every switch already live, or their checks drop. See § "Event mode (#220)" below for the full operator picture, including the fact that there is no re-arm once a flag has been used.

**Rationale — the concurrent-merge race:** worktree-per-agent isolation (above) keeps concurrent sessions from colliding on local working-directory state, but every session still shares one GitHub repo and one `main`. Two PRs can each go green against an older `main`, then merge close together; the second merge lands without CI ever having run against the tree that includes the first merge's changes, so `main` can end up in a state CI never actually checked. `strict = true` forces an out-of-date branch to update and re-run CI before GitHub allows the merge, serializing concurrent merges through CI instead of letting them race.

**Relation to #48:** this is GitHub-native branch protection — it governs merge _ordering and freshness_, not review _authenticity_. #48's review-authenticity gate is `review-artifact-present`, a separate required check documented in full under "Review-artifact-present check (#48)" below; its required-check activation on `main` is a deferred rollout step, tracked there, not part of this section's payload.

### Review-artifact-present check (#48)

> **Retired 2026-07-17 (#587):** this check was never activated as a required check on `main` in the
> first place (see `definition-of-done.md` § 10's own example). `scripts/check-review-artifact.js` and
> the `review-artifact-present` CI job are deleted along with the governance-ledger comment it read.
> See `WHAT-IT-CHECKS.md` and the ADR below.

**Problem:** branch protection on `main` (above) requires status checks, none of them review-aware: `commit-gate-integrity` only checks the hook files exist, `merge-association` only checks a commit message names an issue, and `required_approving_review_count` is deliberately `0` (solo maintainer, GitHub forbids self-approval). A merge can reach `main` with no evidence a review ever happened — including the local-hook-bypass path (`--no-verify`, a fresh clone with `core.hooksPath` unset).

**Design decision:** reuse the existing evidence channel instead of inventing a fourth one. The pre-merge `<!-- governance-ledger -->` PR comment (`tools/emit-ledger-comment.ps1`, see "Governance ledger (#219)" below) already carries `{role, model, verdict, round}` per entry; this issue widens the schema so the comment can bind to a specific PR. PR-review entries now additionally carry `tree_oid` and `reviewer_id`; `role:"issue"` entries now additionally carry `issue_number` — all three fields already existed in the underlying `rev1`/ledger-entry evidence files, the whitelist in `tools/emit-ledger-comment.ps1` simply stopped dropping them. `scripts/ledger-harvest.js` passes the widened fields through the `gl1` row additively; a pre-#48 row without them stays valid, an honest historical gap rather than a validation failure — the same posture as the `buildlog: null` rule.

**Mechanics:** `scripts/check-review-artifact.js` is the new required check `review-artifact-present` (`.github/workflows/ci.yml`). It locates the governance-ledger comment on the PR (via `scripts/lib/ledger-comment.js`, extracted out of `scripts/ledger-harvest.js` so the pre-merge checker and the post-merge harvester share one comment-locate/JSON-parse implementation — a checker and a harvester that silently disagreed on comment shape would be a split, not a hardening) and fails closed unless: a `role:"issue"` PASS entry names the issue the head commit references (`(#N)`, reusing `resolveIssueNumber` rather than a second regex); at least one PR-review PASS entry is bound (`tree_oid`) to the PR's actual head tree, so a stale comment left over from an earlier push fails by construction; and, when the PR's changed paths touch the governing-artifact surface (`touchesKernelSurface`, the same regex `tools/verdict-core.ps1` encodes — drift-guarded by a test that dot-sources the PowerShell source of truth), at least two PR-review PASS entries carry distinct `reviewer_id`s.

**Trust model, stated honestly:** tamper-evident, not tamper-proof — the same bar as every other gate in this file (see "Issue-review gate" above). The comment is orchestrator-authored, so a determined operator with repo write can still forge one by hand. What this adds over the pre-#48 state: bypassing review now requires forging a public, permanent, structured artifact on the PR itself, inconsistent with the CI-written `gl1` ledger row and visible to a post-wave audit, instead of merely skipping a local hook.

**Merge-queue skip-as-success.** The `review-artifact-present` job carries `if: github.event_name == 'pull_request'`, the same pattern `merge-association` uses (see "Merge queue (#404)" below): on a `merge_group` event the condition is false, the job is skipped, and GitHub treats a skipped required check as success — correct here because the queue entry's tree was already gated by the check's PR-time pass; without the skip, the fail-closed checker would deadlock every queue build (no `governance-ledger` comment is ever posted against a `gh-readonly-queue/*` ref).

**Re-run after posting (AC8).** The governance-ledger comment is posted after the head SHA's CI run has already completed, and no `pull_request` event fires on comment creation — so without an explicit re-run step, `review-artifact-present` stays on its original (red, or stale-evidence) result. `agents/orchestrator.md`'s step-7 ship mechanics instruct the orchestrator to re-run that job (`gh run rerun --job <id>` or the equivalent `gh api .../actions/jobs/<id>/rerun`) immediately after posting or refreshing the comment, before treating the PR as ready to merge.

**Scoped out (explicitly):** server-side enforcement of the bar-2 bias-gate (`bg1`) artifact (see "Bias-gate and adjudication evidence artifacts (#47)" above). The governance-ledger comment schema does not carry `bg1`; extending the evidence channel to include it is a separate slice, filed after this gate exists. This check enforces issue-review and PR-review evidence only.

**Rollout (do not skip):** merging this issue's code does not activate the requirement. `review-artifact-present` becomes a required check only when `tools/apply-branch-protection.ps1 -RequireReviewArtifact` is run — the same two-stage-promotion posture as `-RequireSmoke` (see "Empirical smoke gate (#197)" above) and for the same reason: a branch cut before the `review-artifact-present` job existed can never report that check, so requiring it before the current wave's other open PRs have merged would deadlock those PRs. The activation run is a recorded step in #48's closing comment, run only after that wave's open PRs have merged.

### Server-side issue-creation guard (#116)

**Binding decision:** `gh issue create` is a direct GitHub API call — it triggers no local git hook, so no local mechanism can gate it. The only enforcement point is server-side: `.github/workflows/issue-guard.yml`, a GitHub Action on `issues.opened`. Every sanctioned issue is born carrying `needs-issue-review` (see "Issue-creation review marker" above). When the guard sees an issue opened without that label, it adds `unverified-issue` and posts a comment naming the required flow; an issue opened with the marker is left alone — that is the sanctioned pre-review state, not a defect to flag.

**Setup dependency:** the `unverified-issue` label is pre-created out-of-band (`gh label create unverified-issue`), a one-time step outside the workflow. The guard assumes the label exists and never creates it — keeping the guard a pure reader-and-flagger, not a label-schema owner.

**Honest bar:** tamper-evident, not tamper-proof — the same residual as every other gate in this file. An actor with repo write can still add or remove `needs-issue-review` or `unverified-issue` by hand; the guard makes an unreviewed issue conspicuous on the board, it does not make bypass impossible. It is the advisory-visibility sibling of #48 (un-bypassable server-side merge enforcement), not a replacement for it — #48 still governs whether unreviewed work can reach `main`, this guard only governs whether it can sit unnoticed on the issue board.

**Execution surface:** runs on GitHub-hosted Actions (`runs-on: ubuntu-latest`), not the rented host the wedding app runs on — consistent with the existing `commit-gate-integrity`/`merge-association` CI backstop (see "Issue-review gate" above, #46). The hosting constraint at the top of this file governs where the running wedding app lives; it says nothing about the CI/enforcement surface, so this guard adds no app runtime to the cloud.

**Distinct from `merge-association`:** that CI job checks commit→issue linkage at PR/merge time; this guard fires on `issues.opened`, before any code exists. No overlap between the two.

### Roadmap: board-derived, session-structured (#139)

The build roadmap is **not** a committed file. The **roadmap is derived from the board on demand** — from the epic (#126), the milestones, and each issue's `Depends on` / `Touches` fields — rather than stored as a second copy in the tree. A stored `docs/roadmap.md` was wiped twice by build-session git operations on 2026-07-03 (the #113 hazard) precisely because it duplicated, as an untracked file, state the board already holds durably. Deriving it removes that second source of truth: the board cannot be wiped by a `git clean` / checkout, and it can never silently disagree with itself. This is a distinct decision from "Scoring derived, not stored" above (that governs a guest's point total; this governs the planning roadmap).

Sessions are **grouped by file-locality**, not by theme. The epic's session groups are chunked by the file-family / subsystem they share — each group carries a `Files:` annotation — so a session fits a cheap context window and two sessions that share no file can run in parallel safely. Theme-grouping produced monster sessions that bloat context, cost more, and cannot pivot; file-locality keeps each session small and its merge-collisions visible. Each group lists at most four issues and carries exactly one relation tag: `depends on <group>`, `parallel-safe with <group>`, or `parallel after #<root>` (a fan-out — the group is unblocked once root issue `#<root>` merges).

**Out of scope — the historical refactor plan.** The committed `PLAN.md` and `CONTEXT.md` are a _different_ artifact: the as-built refactor roadmap and its domain context (`README.md` links `PLAN.md` as the "Refactor roadmap"). They are the historical refactor plan, not the board-derived _build_ roadmap this decision governs, and are neither retired nor restructured by #139.

**Retired 2026-07-10 (#393):** epic #126 itself — the roadmap epic this decision derived the plan from — was closed `NOT_PLANNED` on 2026-07-10, by owner authorization. Build sequencing now lives on the **Batch milestones** (every wave issue carries a `Batch N` milestone); the milestones are the successor sequencing surface this decision's "derive, don't duplicate" rationale now points to. The reasoning above — that a stored roadmap file duplicates board state and can be wiped, so deriving it from the board is safer — still holds; only the specific board artifact it derived from changed, from the epic checklist to the milestone assignments. `agents/reviewer-tracker-sync.md`'s epic-#126 drift smoke-check (see #140 below) is updated accordingly: it now applies only while a roadmap epic is OPEN, so a retired (CLOSED) #126 stops generating stale-checkbox findings.

### Planning governance: agents tick status, the owner reshapes intent (#140)

**Decision:** the epic (#126) and its milestones get **light** governance, not gates. The planning layer had none — the epic and milestones were freely editable by any agent or human, with GitHub's audit trail as the only control. The principle: **govern the irreversible, not the fluid.** Code ships to a real wedding and earns heavy gates (adversarial review, CI, the commit-msg issue-review gate); a plan is supposed to change constantly, and gating that fluidity would be self-defeating. Planning gets two cheap things instead of a gate: a drift smoke-check (`agents/reviewer-tracker-sync.md`'s new epic #126 checklist items, see "Roadmap: board-derived, session-structured (#139)" above) and this status-vs-intent boundary.

**The rule:** agents may update **status** — ticking a checklist box on an epic #126 item when its referenced issue merges is a mechanical, agent-allowed action, because it just mirrors a fact that already happened on the board. Agents do **not** reshape **intent** — reordering, rescoping, or gating a milestone is an owner decision, because it changes what gets built next, not just what already shipped. An intent change an agent proposes is **surfaced to the owner** and is **never silent**: it appears as a named finding (in a verdict, a PR description, or a BUILDLOG entry), not as a quiet edit to the epic.

**This surfacing is advisory, not a gate.** The finding is a report for the owner to read, the same way `reviewer-tracker-sync`'s epic-drift checks (above) are reports: it does not block a merge and it does not block a build. Stating this explicitly matters because it would otherwise read as a reintroduction of the owner-merge boundary retired in "Merge policy: owner-merge boundary retired" (#150) above — it is not. That decision retired the human pre-merge click for code; this decision does not reinstate any pre-merge or pre-build human checkpoint — except the visual-approval loop for visual changes (#294, see "Visual-approval loop reinstated" above), which is a deliberate, separately-decided exception and not a reintroduction by this planning-governance decision. An agent that surfaces an intent-change finding keeps going; the owner reads the finding on their own time, the same way they read any other advisory output.

**Retired 2026-07-10 (#393):** epic #126, the specific epic this decision's status-tick permission and drift smoke-check governed, was closed `NOT_PLANNED` on 2026-07-10 (owner-authorized; see #139 above). The status-vs-intent boundary itself is unchanged and still governs any live roadmap epic — "agents tick status, the owner reshapes intent" is a durable rule, not tied to #126's identity. What changed is scope: the epic-drift smoke-check (`agents/reviewer-tracker-sync.md`'s "Checklist — epic #126 drift" section) now runs **only while the roadmap epic it is wired to is OPEN**. That wiring is #126-specific by design — the charter reads exactly `gh issue view 126`, it does not auto-discover an arbitrary roadmap epic; a future successor roadmap epic (were one ever opened instead of the Batch milestones) would need the charter repointed at its number to be drift-checked. A CLOSED #126 is retired, not live, so its stale checklist boxes (unchecked items for issues that have since shipped and closed, e.g. #285, #291) no longer produce findings — this is the surfaced-not-silent principle staying honest about what it is inspecting: a retired artifact generating advisory noise every segment was never useful signal. Sequencing now runs through the **Batch milestones**, which agents tick the same way (mechanical status mirroring) under the same intent boundary, without a #126-specific mechanism to maintain.

### Fable: available, owner-signal only (#453)

Fable is an available model. It is used only on the owner's explicit per-use signal, and until that signal there is no standing Fable-specific review handling — Fable-authored work goes through the same independent adversarial review as any other implementer, per `CLAUDE.md` § "Model policy".

> **Reversed 2026-07-17 (#587):** the paragraph below recorded `persist-self-certification.ps1` and its
> test as intentionally dormant — kept on disk against a future owner-signaled reactivation. This ADR
> **reverses that dormant-retention decision itself**, not just the live policy it described: both
> files are deleted along with the rest of the proof layer. A future Fable-specific review mechanism,
> if wanted, is designed fresh — it does not un-delete this code. See the ADR below.

`tools/persist-self-certification.ps1` and `tests/persist-self-certification.test.js` intentionally remain on disk as dormant mechanism — a future owner-signaled Fable use could reactivate them — not as a record of live policy.

### Empirical smoke gate (#197)

> **Note 2026-07-17 (#587):** `smoke` is now a baked-in required check on `main` (no promotion
> switch); the sibling checks this section lists it alongside (`commit-gate-integrity`,
> `merge-association`, `event-mode-expiry`) are retired. See "Branch protection on main" above and the
> ADR below.

**Binding decision:** `scripts/smoke.js` is the one gate that verifies _behavior_, not provenance. Every prior gate in this file proves a review happened and is bound to a tree; none of them ever started the server — which is how the 2026-07-03 guest-facing defects (#187 onboarding crash, #188 HEIC dead end, #193 missing badge art, #192 export gap) all carried recorded PASSes. The smoke script boots the real app (`require('src/app')` on an ephemeral port, `DATA_DIR` pointed at a temp dir seeded by `scripts/seed-event.js` as a child process) and probes it: admin login page, guest sign-in via a real seeded token, the signed-in hot paths (`/`, `/gallery`, `/leaderboard`, `/feed`), a hostile non-image avatar POST (must 4xx with no unhandled rejection and a live server after — the #187 class), and a referenced-asset audit of **both** badge catalogs (the event-seed DB it serves, plus `scripts/seed.js` seeded into a second scratch dir — the #193 class lives only in the latter until #193 unifies them). Pure helpers are exported and unit-tested in `tests/smoke-harness.test.js`; the end-to-end run is the CI `smoke` job.

**Two-stage promotion (deliberate):** the CI `smoke` job runs on every push and PR from day one, but is **not** a required status check initially — on the day it shipped, it correctly FAILED on `main`, reproducing open defects #187 and #193, and a required check that is red (or whose context name has never produced a check-run) permanently blocks every merge, including the fixes themselves. Promotion is one command once the job is green on `main`: `tools/apply-branch-protection.ps1 -RequireSmoke` (appends the check `smoke`). A red smoke job on a PR before that flip is signal, not a merge blocker.

**Promotion has landed.** `smoke` is a live required status check on `main` (alongside `commit-gate-integrity`, `lint`, `test`, `merge-association`, `Analyze (javascript)`) — the two-stage caveat above describes how it got there, not its current state. `event-mode-expiry` joins this list when `-RequireEventModeExpiry` is run (#233); until then it runs advisory. See "Merge queue (#404)" for what that required-check list means for the `merge_group` event.

### Review-cost overhaul: 1-reviewer routine rounds, batching, advisory lenses (#201, #218)

> **Superseded 2026-07-17 (#587):** the "heavy bars" this section calls unchanged — security ≥3
> all-PASS and the system-level two-independent both-PASS bar — are retired; the kernel/experimental
> split for batching purposes goes with them, since there is no more kernel bar to escalate a mixed
> batch to. The 1-reviewer-plus-design-philosophy routine bar this section established is now the
> **only** bar (see `standards/adversarial-review-protocol.md` § "Reviewer count by artifact"), not
> one tier among several. The evidence and reasoning below for cutting panel width are unchanged and
> still hold.

**Decision (2026-07-04, owner-approved):** routine-code round 1 drops from a 2–5 reviewer panel to exactly **1** PR reviewer plus the design-philosophy reviewer, both-must-PASS. **Evidence:** full round-ledgers reconstructed from three build sessions (~9 multi-reviewer PR panels, issues #81/#83/#84/#86/#87/#89/#78/#80/#88/#149). Every multi-reviewer panel returned unanimous PASS — panel width produced **zero flipped verdicts**. Every FAIL that sent work back came from the differently-chartered design-philosophy reviewer (which caught every consequential defect that survived to a fix cycle: the #78 tie-definition duplication, the #89 per-photo-points duplication, the #87 missing service layer, the #80 badge-registry leakage, the #88 `progressPercent` a11y clamp bug) or from a fresh single reviewer on a later round. So width is cut and the different lens is kept, unchanged, on every implementation artifact regardless of change size. The heavy bars (security ≥3 all-PASS, system-level two-independent both-PASS) are **unchanged** — they insure against unrecoverable risk, not because the ledger showed them catching more. The bias-gate audit likewise runs once per distinct briefing template (what all three sessions did in practice), not once per fan-out round.

**Batching (#218):** related governance changes sharing one stated intent may ship as one reviewed batch — one issue-review, one PR, one verdict covering the whole batch; a batch mixing kernel and experimental paths takes the kernel bar. New reviewer lenses enter advisory (recorded, non-blocking, ~10-PR trial, owner promotes on evidence — the #197 smoke gate's two-stage promotion is the precedent), with the security-severity escalation exception. Full text: `standards/adversarial-review-protocol.md` §§ "Review batching", "Advisory-lens lifecycle", "Which reviews does this change need?".

### Governance ledger (#219): committed record, CI is the only writer

> **Retired 2026-07-17 (#587):** the entire ledger mechanism this section describes —
> `.github/workflows/ledger.yml`, `scripts/ledger-harvest.js`, `scripts/ledger-push.js`,
> `scripts/lib/ledger-comment.js`, `tools/governance-report.ps1`, and the `governance-ledger` PR
> comment — is deleted. The `ledger` branch stays as a frozen archive; no writer remains. See the ADR
> below.

**Binding decision:** every review outcome lands in `governance/ledger.ndjson` — one JSON object per line, append-only, committed — and the ONLY writer is the CI job in `.github/workflows/ledger.yml`, which runs post-merge on pushes to `main`. No local session or agent ever writes the file. The reason is the self-reference constraint from the hostile review of this overhaul's plan: **a row is never part of the tree it describes** — appending the row would change the tree and invalidate the tree-bound review verdict for that same change. Writing post-merge from CI dissolves the problem (the merge commit already exists when the row is written) and avoids worktree merge conflicts between concurrent sessions as a side effect.

**Rows live on the dedicated `ledger` branch (#228).** The harvester's first live run (Actions run 28730043254) proved a direct CI push to `main` impossible: main's protection requires a PR plus all required checks, enforced for admins (GH006), and an auto-PR path is equally dead because pushes and PRs created with `GITHUB_TOKEN` do not trigger workflows — the required checks would never report. Rather than minting a bypass credential or weakening main's protection, the workflow commits appended rows onto branch `ledger` (same file path) via `scripts/ledger-push.js`: `--materialize` seeds the working copy from `origin/ledger` before harvesting, `--push` builds the commit with git plumbing parented on the branch tip and pushes only `refs/heads/ledger` — never `main`. The `ledger` branch carries classic protection of its own (no PR requirement, no required checks, force-pushes and deletion blocked, enforced for admins; applied via `gh api -X PUT repos/<owner>/<repo>/branches/ledger/protection`), so its history is server-side append-only — a hand-edit cannot be force-pushed away, which is a _stronger_ tamper-evidence bar than convention-only rows on `main` would have been. Consumers read the branch: `tools/snapshot-governance.ps1` sources `stats.txt` from `origin/ledger:governance/ledger.ndjson` first, falling back to `HEAD`'s seed copy, then the literal `no ledger rows`.

**Row schema (v1).** Per merged PR, one `gl1` row: `{schema:"gl1", pr, issue, merged_sha, ts, reviews:[{role, model, verdict, defects:{blocker,major,minor,nit}, categories:{correctness,security,test-coverage,docs,design,simplification,style}, round}], labels:[...], freeze:false, buildlog}`. The additive `categories` object (#517) rides the same PR-review entries as `defects` — see "Category breakdown wired end-to-end" below. The `reviews` array is copied **verbatim** from a structured PR comment the orchestrator posts before merge (a comment carrying the token `governance-ledger` and a fenced `json` block; the last such comment wins). When no such comment exists the row records `reviews: []` — an honestly-visible gap, never a fabricated entry. Two further row types share the file: `gl1-reversal` (the owner applied the `design-reversed` label to a merged PR) and `gl1-governance` (a merged PR touched the kernel surface; the file list mirrors `$SYSTEM_PATH_REGEX` minus the reviewer-charter carve-out in `tools/verdict-core.ps1`). Harvest logic lives in `scripts/ledger-harvest.js` as pure exported functions, unit-tested on fixtures; the workflow is a thin shell around them. One review-entry role is `role:"issue"` (#359): the issue-review gate's PASS, emitted by `tools/persist-issue-review.ps1` as `{role:"issue", model, verdict, round}` for the orchestrator to fold into the pre-merge `governance-ledger` comment alongside the PR-review entries. A `role:"issue"` entry omits the `defects` sub-object — issue-review findings are not severity-classified, unlike PR-review findings — so a reader should not expect every `reviews[]` entry to carry `defects`. Durability for the issue-review gate is achieved entirely through this CI-harvested entry: no local session writes `governance/ledger.ndjson` for it, matching every other row on this file. `buildlog` (optional, additive, #447) is the narrative string harvested verbatim from the last pre-merge `<!-- buildlog-entry -->` PR comment, or `null` when the PR carried no such comment — an honest gap, never a fabricated entry; see "BUILDLOG comment harvest (#447)" below for the full decision.

**Hook exemption for the appender.** The `commit-msg` issue-gate would otherwise block the CI appender's own commits (`.ndjson` is CODE by extension rule, and a ledger commit can name no reviewed issue — see the self-reference constraint above). The hook therefore exempts a commit **only** when both hold: the sole staged path is `governance/ledger.ndjson` AND the commit message starts with `ledger: ` (the appender's fixed prefix). A ledger edit smuggled in with any other file, or under any other message, takes the full gate. The exemption is pinned by tests in `tests/governance-ledger.test.js`.

**Reading it:** `tools/governance-report.ps1 -Ledger <path>` — a pure function of the file, no network — prints per-role totals (reviews, PASS/FAIL, defects by severity), rounds per issue, and the reversal count, or the literal line `no ledger rows` for an empty/absent ledger. This is the record governance decisions (keep/promote/kill a lens) are made from.

**Honest bar:** rows are authored by CI on `main`, so a hand-edit is **visible in history** (any non-`ledger: `-prefixed commit touching the file, or a local commit abusing the exemption, is plainly distinguishable from the sanctioned appender's commits) — tamper-evident, not tamper-proof, the same bar as every other gate here. The CI _audit_ half (a check that flags hand-edits) and server-side consumption (#48) are separate, later slices; no tamper-proofing claim is made by this slice.

**Severity breakdown wired end-to-end (2026-07-10, #417).** The `defects:{blocker,major,minor,nit}` sub-object above was documented from the start but, until now, always zero: the writer chain collapsed it away before it reached the ledger. `tools/review-runner.ps1` now tallies each reviewer's `defects[].severity` (still unvalidated — an unrecognized value counts toward `findings_count` but no bucket) and passes the four counts to `tools/persist-review.ps1 -Blocker/-Major/-Minor/-Nit`, which emits the `defects` object into the `rev1` evidence file alongside the existing `findings_count`. `agents/orchestrator.md`'s pre-merge governance-ledger comment step now sources each PR-review entry's `defects` from that evidence. The read side (`tools/governance-report.ps1`, `scripts/ledger-harvest.js`) needed no change — both already handled a populated `defects` object.

**Category breakdown wired end-to-end (2026-07-14, #517).** `category` rides the same chain as a second, independent histogram — no writer changes shape, each only widens. `tools/review-runner.ps1` tallies each reviewer's `defects[].category` (also unvalidated — an unrecognized value counts toward `findings_count` but no bucket) into `{correctness,security,test-coverage,docs,design,simplification,style}` and passes the seven counts to `tools/persist-review.ps1`, which emits the additive `categories` object into the `rev1` evidence file beside `defects`. `tools/emit-ledger-comment.ps1` projects `categories` into each PR entry when the evidence carries it, and tolerates its absence (a pre-category evidence file) as all-zero rather than invalid — the entry still emits, just without a `categories` key, the same posture a `role:"issue"` entry has always used for a missing `defects` sub-object. `tools/governance-report.ps1` gained a parallel by-category aggregation and a "by category" output section, null-guarded so a `reviews: []` historical row (or any pre-category merge) contributes zeros to every category rather than a fabricated bucket. Deliberately out of scope: no category×severity cross-tab, and no per-defect identity — that is the separate, not-yet-built `disposition` dimension's job.

**Comment body generated from evidence, not hand-transcribed (2026-07-11, #449).** The `governance-ledger` comment above was, until now, hand-composed by the orchestrator — a hand-typed brace could silently erase a merge's whole review record, since the harvester's contract turns an unparsable json block into `reviews: []` with no error and no red CI. `tools/emit-ledger-comment.ps1 -TreeOid <T> -IssueNumber <N>` closes that gap: a pure read-validate-emit tool (no network) that reads every PR-review evidence file for `<T>` (the same shape `tools/verdict-core.ps1` `Read-Evidence` reads, including its `tree_oid` self-binding) and every `<ReviewerId>.ledger-entry.txt` for `<N>` (never `*.json` — that extension is deliberately reserved so `tools/issue-core.ps1` `Read-IssueEvidence`'s `*.json` glob cannot double-count it), and prints the complete comment body — marker line plus fenced `json` block — in deterministic order (issue entries first, then PR entries by round then reviewer id). It **fails loud on empty evidence**, per evidence class rather than per total: if either the PR-review class for `<T>` or the issue-ledger class for `<N>` has zero valid entries, the tool exits non-zero naming the empty class and emits no comment body — the realistic partial case (a rebase between review and posting empties the tree-keyed PR-review directory while issue evidence still exists) must block, not harvest as a silently incomplete record. `tools/persist-review.ps1` gained an additive `-Round` parameter (default `1`) so the PR-review evidence it writes now carries the `round` field the gl1 entry shape has always declared, completing the data the comment is assembled from. `agents/orchestrator.md`'s pre-merge step now names this tool as the producer of the comment body; hand-writing the JSON is no longer the described method.

### BUILDLOG comment harvest (#447): per-merge entries move off hand-appended edits

> **Retired 2026-07-17 (#587):** `scripts/buildlog-render.js` and the ledger harvest it depended on
> are deleted. Per-merge entries are hand-appended to `BUILDLOG.md` on `main` again, as part of the
> orchestrator's commit step — see `agents/orchestrator.md` step 7. See the ADR below.

**Binding decision:** the per-merge `<sha> — #<n> — <summary>` entry — previously hand-appended to `BUILDLOG.md` as part of the change commit — is now harvested the same way the `reviews` array is: a pre-merge PR comment, harvested post-merge by CI. This reuses the governance-ledger machinery (#219, #228) rather than inventing a parallel one, and dissolves the same problem it dissolved there: under concurrent waves `BUILDLOG.md` was the dominant rebase-collision point in wave merges, and sessions had taken to keeping it out of the change PR and backfilling it in a dedicated bookkeeping PR (recorded in the pre-cutover history below, e.g. #305, #356) — every change shipped as two PRs. A row is never part of the tree it describes, exactly as for the `reviews` array.

**The mechanism.** Entry source is a pre-merge PR comment: the orchestrator posts (or refreshes — last one wins) a PR comment carrying the marker `<!-- buildlog-entry -->` plus the entry narrative. `scripts/ledger-harvest.js` extracts the last such comment's narrative, verbatim, into an additive `buildlog` field on the gl1 row (see "Row schema (v1)" above) — the store is this `buildlog` field, committed to `governance/ledger.ndjson` on the `ledger` branch alongside every other row: present when a comment exists, `null` — an honest gap, never a fabricated entry — when it does not. **The comment carries narrative only; the SHA is stamped by CI.** A pre-merge comment cannot know the merge SHA (it does not exist until merge), so `scripts/buildlog-render.js`'s renderer composes `<merged_sha> — #<issue> — <narrative>` from the row's own `merged_sha`/`issue` fields and never parses a SHA or issue number out of the narrative text — a narrative that happens to contain a SHA-like or `#NN`-like token cannot spoof the entry's identity.

**The browsable log stays a committed file, not a script output.** `scripts/buildlog-render.js` exports pure render functions (`renderEntries` — one reverse-chronological line per gl1 row; `renderFullFile` — the generated section followed by the frozen pre-cutover history, verbatim) plus a CLI wrapper. The harvest job (`.github/workflows/ledger.yml`) runs the renderer after harvesting and `scripts/ledger-push.js --push` commits the rendered `BUILDLOG.md` to the `ledger` branch in the **same commit** as `governance/ledger.ndjson` — the browsable log and the data it is rendered from can never be observed out of sync. A human reads it by opening `BUILDLOG.md` on the `ledger` branch on GitHub, no tool run required; `node scripts/buildlog-render.js` is the offline/worktree fallback. The frozen pre-cutover history lives in `governance/buildlog-history.md` (the exact pre-#447 dated-entry content of `BUILDLOG.md` on `main`, carried through byte-for-byte).

**`BUILDLOG.md` on `main` is not frozen — it changes role, narrowed rather than voided.** It stops receiving per-merge entries and remains the home of the exceptional non-merge entries the orchestrator writes outside any PR: `[HALT]` impasse logs, wave-completion notes, and `[AUDIT]` lines — none of which have a merged PR (or a gl1 row) to harvest from. A dated cutover note in the file's header states the split; pre-existing entries stay byte-identical. `agents/orchestrator.md`'s periodic-audit counter reconciles: the post-cutover committed-issue count source is the harvested `gl1` rows (one per merge) plus the pre-cutover counted `BUILDLOG.md` entries — `[AUDIT]` entries themselves keep appending to `BUILDLOG.md` on `main`, unchanged.

**The append-only carve-out stays, its premise narrowed (2026-07-11, #447).** The "Fetch-fresh worktrees, overlap-aware freshness, and wave alignment (#357)" section below documents `tools/check-freshness.ps1`'s `$CARVE_OUT_PATHS` list, currently exactly `BUILDLOG.md`, on the premise that two writers appending distinct lines to it cannot corrupt each other's entries. That premise still holds for the file's remaining role — the exceptional non-merge writers can still collide harmlessly the same way — because the collision-prone per-merge writers moved off this file entirely by this decision; the carve-out is **narrowed**, not voided, and `tools/check-freshness.ps1` and `tools/check-wave-alignment.ps1` are deliberately untouched by this issue.

### Governance snapshots (#224): tagged states, exported surface + stats

> **Retired 2026-07-17 (#587):** `tools/snapshot-governance.ps1` is deleted along with the ledger and
> report tools it depended on. See the ADR below.

**Convention:** `tools/snapshot-governance.ps1 -Version <N> [-ExportDir <path>]` creates the annotated tag `governance-v<N>` at HEAD — refusing (exit non-zero, no tag) on a dirty working tree or an existing tag — and exports to `<ExportDir>\governance-v<N>\` the governance surface (`standards/`, `agents/`, `.githooks/`, `tools/`, `skills/`, `CLAUDE.md`, `DESIGN.md`, `docs/north-star.md`, `.github/workflows/`) plus `stats.txt`, the output of `tools/governance-report.ps1` against `governance/ledger.ndjson` as committed at HEAD (or the literal line `no ledger rows` when absent). Tag plus export make every governance version recoverable and comparable by its records: the tag pins the exact tree, the export is the portable copy, and `stats.txt` is that period's performance record. Publishing an export into the scaffold-project template repo remains a **manual owner step** — the tool never pushes anywhere.

### Event mode (#220): wedding-day freeze with expiring flag and mandatory retro-review

> **Retired 2026-07-17 (#587):** every tool this section describes (`tools/set-event-mode.ps1`,
> `event-mode-core.ps1`, `check-event-mode-expiry.ps1`, `scripts/rehearse-event-mode.ps1`) is deleted,
> along with `.githooks/pre-commit`/`gate-core.sh`'s evidence-gate machinery this mechanism deferred
> to. Post-teardown there is no review-evidence gate for a wedding-day hotfix to bypass — an ordinary
> commit during the wedding is already a small, fast, ordinary commit. #568/#573/#586 (open event-mode
> gaps) close as obsolete. See the ADR below.

**Why it exists:** during the wedding weekend a broken guest path must be fixable in minutes, and the commit gates as designed block every code commit until review evidence exists. Waiting on reviewer agents mid-reception fails the event. Event mode is the pre-declared, expiring, fully-recorded exception: a hotfix ships on green automated checks alone, and every such commit is mechanically queued for review after the event. Nothing permanently escapes review. This mechanism covers the wedding weekend itself and is unchanged by the move to a hosted deployment; an incident outside that window takes the normal pipeline.

**The flag.** `governance/event-mode.json` — single-line JSON `{schema:"em1", expires:"<ISO UTC>", reason, created:"<ISO UTC>"}`. Deliberately **not** markdown: creating or removing it is a CODE commit that itself passes the normal gate, so entering and leaving event mode is a reviewed act. Its **single writer** is `tools/set-event-mode.ps1` (`-ExpiresUtc <date> -Reason <text>` to create; `-Clear` to remove); the file is never hand-edited. The shared reader is `tools/event-mode-core.ps1` (states: NONE / INVALID / ACTIVE / EXPIRED — only ACTIVE enables anything; INVALID and EXPIRED collapse to enables-nothing, fail closed).

**What it bypasses (and the pre-commit constraint that shaped it).** While the flag is valid and unexpired, a commit whose subject starts `hotfix: ` passes both hooks with no review evidence and no reviewed issue. The bypass had to target `pre-commit` (the layer that actually blocks), but pre-commit cannot read the commit message — so during an ACTIVE window pre-commit defers the evidence gate to `commit-msg`, the hook that can. `commit-msg` then either honors the `hotfix: ` prefix (exit 0) or runs the **identical** evidence gate plus the normal issue gate — same fail-closed messages, one hook later. The shared gate body lives in `.githooks/gate-core.sh` (`evidence_gate`, `event_mode_state`), sourced by both hooks, so the two paths cannot drift.

**commit-msg keys on flag presence, not ACTIVE state (the expiry race).** The two hooks evaluate the flag independently, and the flag can expire between them — pre-commit defers on a then-ACTIVE flag, commit-msg sees EXPIRED. If commit-msg only acted on ACTIVE, that commit would meet the evidence gate in _neither_ hook: fail-open. So commit-msg runs the evidence gate whenever the flag **file exists** and the commit is not an ACTIVE-window `hotfix: ` — at worst the gate runs twice (it is idempotent), never zero times. Consequence, stated honestly: while a flag file is present, merge commits (which git never passes through pre-commit) also meet the evidence gate at commit-msg — coverage the no-flag world has never had, strictly fail-closed; a `hotfix: `-prefixed merge message bypasses during ACTIVE like any commit. With no flag file present, both hooks behave exactly as they always have.

**What it never bypasses:** CI — lint, format, tests + coverage, commit-gate integrity, the smoke job — and main's branch protection (PR + green required checks). "Ships on green automated checks alone" means exactly that: the automated bar stays; only the human/agent review moves after the event.

**Expiry is enforced twice.** Locally an EXPIRED flag enables nothing (the `hotfix: ` prefix grants nothing again). In CI the `event-mode-expiry` job (`pwsh -File tools/check-event-mode-expiry.ps1`, a thin wrapper over the same `tools/event-mode-core.ps1` reader the hooks use — the validity rules live once) goes red while an expired (or invalid) flag is still in the tree — on `main` and any branch carrying it. Once `-RequireEventModeExpiry` is run (#233) that red blocks merges and forces the cleanup commit; until then it is advisory signal.

**The retro-review obligation has a mechanical consumer.** Each freeze shipment gets a `freeze:true` ledger row (the harvester marks a merged PR whose commits include a `hotfix: ` subject — over-inclusive on purpose: a reviewed hotfix-titled commit only ever gains a review). `tools/set-event-mode.ps1 -Clear` REFUSES to remove the flag while any `freeze:true` row recorded since the flag's `created` timestamp lacks a review PASS bound to that commit's tree (recorded via the existing `tools/persist-review.ps1` path, read via `tools/verdict-core.ps1`). So the sequence is forced once `-RequireEventModeExpiry` is run (#233): event ends → CI red on the expired flag → retro-review each freeze commit → `-Clear` → commit the removal through the normal gate. Until that promotion the red is advisory signal, and nothing mechanically compels the cleanup.

**Rehearsed, not hoped:** `scripts/rehearse-event-mode.ps1` walks the whole lifecycle (arm → hotfix passes → non-hotfix blocks → expiry blocks → `-Clear` refuses → retro-review → `-Clear` succeeds) in a scratch repo with the real hooks; `tests/event-mode.test.js` pins the same behavior in CI. Run the rehearsal before the wedding and after any change to the hooks or tools.

**Honest bar:** the same actor could delete the flag by hand, forge retro evidence, or commit `--no-verify` — unchanged from every other gate here. Tamper-EVIDENT (committed flag lifecycle, append-only ledger branch, CI expiry check), not tamper-proof.

**Operator picture once `event-mode-expiry` is a required check (#233).** Promoting the job (`tools/apply-branch-protection.ps1 -RequireEventModeExpiry`) is what makes the two conditional claims above — that the red forces the cleanup commit, and that the retro-review sequence is forced — literally true. An expired or invalid flag then blocks **every** merge to `main`, not only the cleanup commit, until each freeze commit is retro-reviewed and `-Clear` succeeds. That is the mechanism working as designed, not a side effect.

1. **Expiry guidance is a two-sided trade, sized deliberately.** Too short, and the window closes mid-event: the `hotfix:` bypass disarms mid-reception and `main` accepts no merges at all, with no way to extend it. Too long, and every extra hour is an hour in which a `hotfix:` ships with review deferred (`ACTIVE` is the only state that enables the bypass). Set a bounded, dated expiry — never "or later" — sized to the scope already recorded above ("the wedding weekend itself"). Whether the window should extend into a Monday recovery tail is an open owner scope call, tracked as #573.
2. **There is no re-arm.** `tools/set-event-mode.ps1` refuses to create a flag over an existing one, and `-Clear` refuses while any freeze commit still lacks a retro-review PASS — so once a `hotfix:` commit has shipped under an active flag, the window can be neither extended nor re-opened until those commits are retro-reviewed. This gap is tracked, not fixed here, as #568.
3. **The emergency escape is de-promotion, not re-arm.** If the expiry turns out wrong, the recovery is one admin-authenticated, reversible command: re-run `apply-branch-protection.ps1` without `-RequireEventModeExpiry`, carrying every other switch that is currently live (or those checks drop too — the replace-not-append trap above).

### Trivial dep-bump gate (#448): recomputed, not attested

> **Retired 2026-07-17 (#587):** `tools/classify-trivial-commit.ps1` and the hook exemption branches
> it fed are deleted — there is no more evidence gate for a hand-built dependency-bump commit to be
> exempted from. The Dependabot auto/review tiering this section's classifier shared code with
> (`tools/classify-dep-pr.ps1`, `classify-dep-pr-core.ps1`) is unaffected and stays. See
> `CLAUDE.md` § "Dependency updates (Dependabot)" and the ADR below.

**Why it exists:** #436 (express 4.21.2 → 4.22.2, a security-advisory bump) ran the full pipeline — issue, issue-review, implementer, PR reviewer, design-philosophy reviewer, two PRs — yet `tools/classify-dep-pr.ps1` rates the identical diff `auto`: the repo's own owner-approved policy already says this change class merges on green CI with **no review at all** when Dependabot authors it. The judgment ("CI is a sufficient gate for this class") was already made and encoded; only the hand-built path ignored it, purely because of who typed the commit.

**Design: recompute, don't attest.** Eligibility is recomputed by the commit gate from the staged tree itself every time — no evidence file, no label, nothing to forge. `tools/classify-trivial-commit.ps1` (no params; reads `git diff --cached` directly) emits `trivial` only when all four hold: (1) the staged paths are exactly a non-empty subset of `{package.json, package-lock.json}` with `package.json` among them — a lockfile-only diff (transitive-only changes) stays `standard`, fail closed; (2) every direct dependency whose version differs between `HEAD:package.json` and the staged copy classifies `auto` under `Get-DepPrTier`, dot-sourced from `tools/classify-dep-pr-core.ps1` — the same file `tools/classify-dep-pr.ps1` (its thin CLI) now dot-sources, so the tier rules have exactly one copy; (3) `package-lock.json`'s content, not just its staged path, is bounded to that same changed-dep set (#467, below); (4) the commit subject starts `chore(deps): ` — checked separately by the hooks (see below), since a classifier invoked before a commit message necessarily exists cannot see it.

**Lockfile-content bound (#467).** Condition (2) only ever inspected `package.json`; the lockfile's path was on the allowed list but its content was never read, so a staged `package-lock.json` could carry a change condition (2) never sees — repin a dep the manifest never touched (a wedding-critical package included), swap a `resolved`/`integrity` entry, or add a package — while the manifest still showed one honest auto-tier bump. `classify-trivial-commit.ps1` now parses both `HEAD:package-lock.json` and the staged copy (`lockfileVersion` 2/3's `packages` map) and requires every added/changed/removed key to be `node_modules/<name>` (or nested under it) for a `<name>` that actually changed in the manifest, or the root `""` project entry, whose own diff must in turn be confined to non-dependency-field equality plus changed-dep-only version strings. Anything else is `standard`, and so is any lockfile that fails to parse or carries no top-level `packages` object — fail closed on an unrecognized shape rather than guess. This deliberately **rejects transitive-dependency drift**: a bump that moves a transitive package's pin (even nested under a dep that legitimately changed, if the transitive package itself never appears in the manifest-changed dep's own version bump) routes to the ordinary reviewed path or Dependabot, never this waiver — the bound only ever widens for content nested under a dep whose OWN version the manifest just changed, not for arbitrary transitive movement. (Aside for implementers: the lockfile parser is edition-aware because the classifier runs on two PowerShell editions. On **Windows PowerShell 5.1** — the event laptop — `ConvertFrom-Json` throws on any JSON object with an empty-string key, which real lockfiles always carry at `packages[""]`, so the lockfile half is parsed with the .NET Framework `System.Web.Script.Serialization.JavaScriptSerializer` instead, which has no such restriction. On **PowerShell 7 Core** — the Linux CI runner — that assembly does not exist (`System.Web.Extensions` is .NET Framework-only), so `Add-Type`-ing it there would error; Core instead uses `ConvertFrom-Json -AsHashtable`, which does not have the empty-key limitation and returns the same `.ContainsKey()`/`.Keys`/indexer surface the condition-4 diff needs. Both branches yield an `IDictionary`; head and staged are always parsed within one edition per run, so cross-edition key-ordering differences never reach a comparison. `package.json` itself never carries an empty key, so its `Get-GitJson` read path stays on plain `ConvertFrom-Json`, unchanged.)

**Version adapter (fail closed on every non-conforming shape).** `DepType` is `prod` if the dependency appears in the staged `dependencies` object, `dev` only if solely in `devDependencies` (present in both → `prod`, conservative). A dependency added to or removed from either manifest section (not a version change) → `standard`. Version normalization strips exactly one leading `^` or `~`; the remainder must match `MAJOR.MINOR.PATCH` (three dot-separated non-negative integers, nothing else) — any other range syntax (`>=`, `<`, `||`, `x`, `*`, spaces), any pre-release/build suffix (`-`, `+`), or any non-conforming shape on either side of the diff is `standard`, never guessed. Both sides identical after normalization (a prefix-only change, e.g. `^4.21.2` → `4.21.2`) is `standard` for that dependency — not a bump this path understands.

**The hooks: pre-commit defers, commit-msg decides.** `pre-commit` cannot read the commit message (git never passes it there), so it can only recompute the staged-tree half of eligibility: when `tools/classify-trivial-commit.ps1` says `trivial`, `pre-commit` defers its evidence gate to `commit-msg` — the identical architectural pattern the event-mode hotfix exemption already uses, for the identical reason. `commit-msg` re-classifies the same staged tree (it cannot have changed between the two hooks within one `git commit`) and either honors the `chore(deps): ` prefix (exit 0, bypassing **both** the evidence gate and the issue-reference gate) or runs the evidence gate right there before falling through to the unchanged issue gate. Classifier missing, erroneous, or any non-`trivial` result → `false` → the full gate applies exactly as before this change (fail closed). Shared probe: `classifier_says_trivial` in `.githooks/gate-core.sh`, sourced by both hooks.

**Four self-descriptions reconciled, not left false.** The trivial path bypasses both kernel gates, and `package.json`/`package-lock.json` are CODE by the hooks' extension rule — so four absolute "no bypass" statements would otherwise be false. Each is rewritten to enumerate the three scoped exemptions (ledger appender #219, event-mode hotfix #220, trivial dep bump #448): `.githooks/commit-msg`'s header sentence, `.githooks/pre-commit`'s "Guarantee (scoped honestly)" header block, and the two DESIGN.md passages above ("Commit gate: review evidence bound to the staged tree" and "Issue-review gate: every code commit names a reviewed issue (#46)").

**The ledger stays honest with no review at all.** A merge with no `governance-ledger` PR comment already harvests as `reviews: []` in its gl1 row ("Governance ledger (#219)" above) — exactly how a trivial dep-bump commit appears, indistinguishable in the record from a Dependabot auto-merge of the same class. No fabricated entry, no special-cased row.

**Dependabot remains the preferred author.** This path exists for a security advisory Dependabot has not filed a PR for yet, not as a general substitute for Dependabot PRs — see `CLAUDE.md` § "Dependency updates (Dependabot)". Review-protocol classification (a base-tier waiver, not a dispatch-table lens row): `standards/adversarial-review-protocol.md` § "Trivial dep-bump path (base-tier waiver)". The #304 on-host native-binary smoke rule is unaffected — its members (`sharp`, `better-sqlite3`) are wedding-critical, so `Get-DepPrTier` can never classify them `auto` and they can never reach this path.

### Coverage floors are a ratchet; mutation score is the quality signal (#198, #199)

**Coverage gate (#198).** The thresholds in `vitest.config.mjs` were commented out from the start — the 80% rule the owner believed was enforced never gated anything. Rather than wait for a suite that clears 80 (the "enable later" posture that had already held for months), the gate went ON at the floors measured on `main` @ 485886a (2026-07-05): statements 62, branches 53, functions 65, lines 62. The floors are a **ratchet**: they move up as tests land (tracked by #181), never down. A change that drops coverage below any floor fails the required `test` check — that is the failure mode the gate exists to catch, and it works today, not after some future test-writing push. **The current numbers are not restated here** — they have already moved twice since the 2026-07-05 baseline above — read them straight from `vitest.config.mjs`'s `thresholds` block, which is the single owner and the only copy that can't go stale.

**Mutation testing (#199).** Coverage says a line _ran_ under tests; it cannot say a test would _fail_ if the line were wrong. Stryker (`npm run mutation`, config in `stryker.conf.json`) measures exactly that by planting small bugs and counting how many the suite catches. It is a **signal, not a gate**: too slow and too noisy to block PRs, so it runs on demand and on a weekly schedule (`.github/workflows/mutation.yml`, never a required check). The baseline score, the plain-English list of what the tests currently miss, and the ratchet intent live in `docs/test-quality.md`.

### Wave governance (#310): grandfathering, owner-invoked wave review, doc-currency step

> **Partially retired 2026-07-17 (#587):** the wave-alignment tooling this section's mechanisms relied
> on (`tools/check-wave-alignment.ps1`, `start-run.ps1`, `stop-run.ps1`) is deleted; `/realign` now
> does only the `check-freshness.ps1`-based cross-batch check. Grandfathering, the owner-invoked
> `/post-wave-review`, and the doc-currency step below are unchanged. See the ADR below.

**Decision (2026-07-08, owner):** three governance mechanisms recorded during the Wave-1 post-wave review session, resolving three findings the session surfaced (evidence: issue `#310`).

**Grandfathering.** A governance or gate change merged mid-wave governs from the next issue picked up onward; an open sibling PR already in flight merges under the bar in force when its implementation began, with one exception — a `severity:blocker` security gate change reaches open PRs immediately. Recorded because a real mid-wave case surfaced in Wave-1 (PR #295/#294 and PR #298/#254) and is **correct** behavior under this rule, not a defect a reviewer should flag — worked example with timestamps: `standards/adversarial-review-protocol.md` § "Wave governance (#310)".

**Owner-invoked whole-of-wave review.** `/post-wave-review` (#302) stays a manual, **owner-invoked** check — never automatic, never a precondition for the next wave — because the Wave-1 session showed it catches cross-PR defects (#313, #314, #317, #318) no per-PR review can see, but automating a full-wave review inside every PR would be pure cost on every routine change. Orchestrator-side nudge: `agents/orchestrator.md` § "Wave boundary".

**Doc-currency step.** A `doc-currency` implementer-side pipeline step (Sonnet) fires on the source surface defined in `agents/orchestrator.md` § "Doc-currency step". Chosen over a doc-currency _reviewer_ (which could only flag drift, never fix it) because the #318 evidence showed the drift going unfixed for the life of four schema-changing commits despite an unwired reviewer charter (`agents/reviewer-doc-currency.md`) already on disk — an implementer-side auto-fix closes the gap a flag-only reviewer left open. That charter was retired as an orphan in #323. Mechanics (trigger, staging order, the `docs-only` rule): `agents/orchestrator.md` § "Doc-currency step"; classification: `standards/adversarial-review-protocol.md` § "Wave governance (#310)".

### Merge queue (#404)

> **Note 2026-07-17 (#587):** `commit-gate-integrity`, `merge-association`, and `event-mode-expiry`,
> named throughout this section as jobs the queue must trigger on `merge_group`, are all retired. The
> queue now only needs to trigger `lint`, `test`, `smoke`, and `Analyze (javascript)` on that event —
> the mechanism this section describes (the `merge_group:` trigger, the `gh-readonly-queue/**` push
> exclusion) is otherwise unchanged.

**Why it's adopted:** `main`'s branch protection runs `strict` (require branches up to date) plus the required checks, and under the concurrency of parallel `/build` sessions that combination loops — every merge during a PR's CI window forces that PR to re-sync and re-run the full ~3.5-minute check set, observed directly on PRs #374 and #395 in the current wave. A GitHub merge queue removes the loop without giving up either guarantee: it builds a temporary `gh-readonly-queue/main/*` branch (`main` tip plus the PR), runs the required checks on that branch once, and merges on green, one entry at a time.

**The `merge_group` trigger.** A required status check only gates the queue if its workflow runs on the `merge_group` event; neither workflow did. Both `.github/workflows/ci.yml` (owns `commit-gate-integrity`, `lint`, `test`, `smoke`, `merge-association`, `event-mode-expiry`) and `.github/workflows/codeql.yml` (owns `Analyze (javascript)`) now list `merge_group:` under `on:`. `event-mode-expiry` also runs on the queue build as a side effect of living in `ci.yml`; it is not yet a required check on `main`, so today it can neither gate nor stall the queue — but once `-RequireEventModeExpiry` is run (#233) it gates the queue like any other required check, rather than stalling it, because it already runs on `merge_group` with no `if:` guard.

**`merge-association` skip-as-success.** The job keeps its existing `if: github.event_name == 'pull_request'` gate unchanged — on a `merge_group` event that condition is false, so the job is skipped. GitHub's merge queue treats a skipped required check as success, which is correct here: the issue-link check has already run and passed at PR time, checking it again on the queue build would check nothing new.

**`gh-readonly-queue/**` push exclusion, `ci.yml`-only.** `ci.yml`'s `push:` trigger had no branch filter, so pushing a queue branch would fire both `push` and `merge_group` for the same commit, double-running every required job. `ci.yml`'s `push:` now carries `branches-ignore: ['gh-readonly-queue/**']`. `codeql.yml` needs no equivalent change: its `push` trigger is already scoped to `branches: [main]`, which never matches a `gh-readonly-queue/main/*` branch name, so it was never at risk of double-firing. A future edit that "harmonizes" the two `push` blocks by copying the exclusion into `codeql.yml` would be redundant, not wrong — but the asymmetry is intentional, not an oversight.

**Owner action, and its order.** This issue only makes the workflows queue-compatible; enabling the queue itself is a branch-protection change the owner makes on GitHub (Settings → Branches → main → enable merge queue), and `strict`/up-to-date is then enforced by the queue rather than per-PR. That toggle must be flipped only after this change has merged to `main` — flipping it first would queue-build PRs whose required checks never run on `merge_group`, stalling every entry.

### Sonnet-only run tier (#427)

> **Retired 2026-07-17 (#587), reinstated 2026-07-19 (#680) as a reviewer judgment, not a script.**
> `tools/classify-issue-run.ps1` and the `Run tier` issue field stay deleted — the mechanism section
> below describes them for history only, and is no longer how eligibility is decided. The tier itself
> is back: every reviewer, on every issue, runs on Opus, on a different model from the implementer, by
> default — except an issue the issue reviewer awarded `sonnet-only`, whose implementer and reviewers
> both run on Sonnet. See "ADR: Sonnet-only tier reinstated as reviewer judgment (#680)" below for the
> current mechanism.

**Decision:** a genuinely routine issue's whole pipeline — orchestrator, implementer, and every reviewer that fires — may run on Sonnet instead of the standard Opus reviewer policy, gated by a deterministic classifier (`tools/classify-issue-run.ps1`, mirroring `tools/classify-dep-pr.ps1`) rather than owner judgment per issue. Sonnet now carries a separate cost bucket, so this is a real saving with no shared-budget tradeoff on the issues it covers — but it is restricted to issues where all three eligibility gates hold: off the system-level governing-artifact surface (and not security-flagged or escalated), off the wedding-critical guest paths (join/auth, upload, moderation, gallery/export core), and small/reversible (no schema or data migration). Borderline cases default to `opus`.

**What this trades away, stated honestly.** Same-model review does inherit correlated blind spots — the whole reason the standing rule (`standards/agent-standards.md` § "Reviewer independence") requires a reviewer on a different, non-weaker model than the implementer. This decision does not dispute that rationale; it accepts the tradeoff on a bounded, low-stakes slice of work in exchange for cost, made tolerable by two things: the tier's scope (routine, reversible, off every guest-critical and governance surface) and the fact that the differently-chartered design-philosophy lens (`agents/reviewer-design-philosophy.md`) still runs even when it shares a model with the implementer — a different lens catches what a same-charter panelist misses, independent of which model runs it.

**#201 is cited narrowly.** The #201 round-ledger evidence (see "Review-cost overhaul" above) showed that panel _width_ bought no catches while a different _lens_ did — but that evidence held the model constant (all Opus) and varied reviewer count, so it says nothing about model diversity one way or the other. This decision does not claim #201 shows model diversity is unnecessary; it cites #201 only for the narrower, supported claim that a differently-chartered lens catches defects a same-charter panelist misses, which is why keeping the design-philosophy lens (even same-model) is the retained mitigation here rather than a second same-charter reviewer.

**Mitigating a known Sonnet reviewer quirk.** Sonnet follows "be conservative / only report serious issues" instructions literally and under-reports as a result. Every reviewer charter that can run on the `sonnet-only` tier (`reviewer-issue`, `reviewer-pr`, `reviewer-design-philosophy`) carries a coverage-first instruction scoped to that tier: report every finding, tagged with its own severity and confidence, and let the orchestrator triage — never promise a downstream filtering step, since on the common single-round PASS path none runs.

**Escalation is the safety valve, not a suggestion.** Any eligibility gate tripping mid-run — a touched path turns out to be system-level or guest-critical, a security flag surfaces, a schema/data migration is discovered, or the orchestrator escalates — moves the remainder of the run to the standard Opus policy immediately, per `agents/orchestrator.md` § "Model policy". Reaching the 3-round soft cap is itself an escalation trigger on every tier, whether or not an adjudicator ends up firing (#540): the concede/contest declaration and everything after the cap run on Opus, and on the contest path the severity-adjudicator invocation runs on Opus too — a concession does not exempt the remainder of the run from the escalation.

**Mechanism.** `tools/classify-issue-run.ps1` dot-sources `tools/verdict-core.ps1` for `$SYSTEM_PATH_REGEX` and applies it directly — it does not call `Get-RequiredBar`, whose `$EXPERIMENTAL_PATH_REGEX` carve-out answers a different question (reviewer _count_ for `agents/reviewer-*.md` charters) than run-tier eligibility (which _model_). A reviewer-charter edit is a governance change and classifies `opus` under this script even though the same edit takes the routine reviewer-count bar under `Get-RequiredBar` — the two functions are not in tension, they answer different questions from the same regex. The `sonnet-only` GitHub label is applied by hand to the owner-confirmed qualifying issues; the classifier is the single source of truth for any future issue's eligibility, not the label's presence alone.

### Acceptance criteria as a promise, not a rulebook (#541)

**Decision:** the mandate that every acceptance criterion "resolve to a literal string or structural check with no semantic interpretation required" (`standards/issue-standards.md:15`, replicated across seventeen sites in seven files) is replaced with a single home: a criterion need only be answerable yes/no by a competent reviewer, stated once in `standards/issue-standards.md` § "Acceptance criteria", with every other file pointing at it rather than restating it. **Evidence:** #410 carried 34 acceptance criteria (31 live after three mid-flight withdrawals) and its review failed on AC16 while the real question went unasked; a repo-wide count showed #470 at 16, #538 at 10, #453 at 10, #48 at 9 — the owner's own professional norm is 1–5, occasionally 8. The no-interpretation rule is why: a promise statable in one sentence had to be shredded into a dozen greppable strings to satisfy it.

**What this trades away, stated honestly.** The old rule bought determinism — an agent verifying an issue mechanically, with no judgment call. That is knowingly given up: two reviewers may disagree on the same criterion under the new bar. The trade is accepted because the old determinism was purchased by producing criteria nobody could hold — a worse failure than occasional reviewer disagreement.

**Interaction with the `sonnet-only` tier (#427).** This paragraph described the classifier-based mechanism retired 2026-07-17 (#587); that classifier stays deleted. The tier itself was reinstated 2026-07-19 as a reviewer judgment (#680, see "ADR: Sonnet-only tier reinstated as reviewer judgment (#680)" below) — so "every reviewer is Opus" is now the default, not an absolute. The original interaction this paragraph named doesn't carry forward as written: the sonnet-tier award is a judgment the issue reviewer makes reading the issue's own criteria and touched paths, not a script matching acceptance-criteria text against a path regex. Left here as history of the classifier-era interaction, not current behavior.

### No severity adjudicator when the orchestrator concedes a rewrite (#540)

> **Superseded 2026-07-17 (#587):** the whole concede/contest fork this section describes, and the
> severity adjudicator it partially retained, are retired. Review now runs the one-round stop rule —
> minor/nit fixed inline and shipped, a blocker/major takes exactly one re-check — with no adjudicator
> and no round-count soft cap. See `standards/adversarial-review-protocol.md` § "One-round stop rule"
> and the ADR below.

**Decision:** at the 3-round soft cap, the orchestrator first declares whether it **concedes** —
judges at least one open defect warrants a fix — before anything else happens. On a concession,
the severity adjudicator does not fire: **no dispute, no referee**. There is no dispute to referee
because the orchestrator is not trying to exit with defects open; it commits instead to rewriting
against **all** open feedback (not only the conceded defect) and a fresh reviewer re-reviews. On a
contest — the orchestrator seeks to exit with defects still open — the adjudicator fires exactly
as before, with its clean-prompt / no-context-from-prior-rounds requirement unchanged. Full
mechanics: `standards/adversarial-review-protocol.md` § "Stop condition — soft cap and severity
gate"; orchestrator-side recording: `agents/orchestrator.md` § "Stop condition".

**Why this cannot be gamed toward less work.** Conceding costs _more_, not less: the rewrite must
address every open item, including nits an adjudicator might have classified inconsequential and
dismissed — work a contested round could have gotten to skip. There is no incentive to falsely
concede to dodge the adjudicator; the shirking direction — falsely _contesting_ to get defects
waved through — is exactly the case the adjudicator still fires on, unchanged. A concession is
also explicitly **not** a severity classification and **not** an exit authorization, so it does not
erode the retained rule that the author, implementer, and orchestrator never classify severity or
authorize exit — a concession classifies nothing and authorizes no exit, it only commits to a
rewrite.

**The impasse backstop, re-keyed.** The prior backstop was keyed to the adjudicator ("a
consequential defect surviving the adjudicator plus 3 further fix-and-re-review rounds"); if a
concession skips the adjudicator, that trigger would never fire and a perpetually-conceding run
could loop forever. The backstop is re-keyed to **6 total rounds without PASS, whether or not an
adjudicator ran** — the same effective ceiling as before (3 rounds to the trigger plus 3 further
rounds), so the bound is neither tightened nor loosened on the contested path, and a run that
concedes every round is now bounded too.

**Not tamper-proof, only tamper-evident.** No mechanism verifies a concession was made honestly.
Like every other gate in this protocol, the control is that the concession must be recorded in the
run output naming the defect conceded, so a skipped adjudicator leaves evidence of why it was
skipped rather than a silent gap — not that a false concession is structurally impossible.

## System-level change (definition)

> **Superseded 2026-07-17 (#587):** the two-independent-reviewer, both-must-PASS bar this section
> describes is retired, along with `tools/verdict-core.ps1` and its `$SYSTEM_PATH_REGEX`/
> `$EXPERIMENTAL_PATH_REGEX` regexes. The **surface** this section defines is not gone, though — it is
> now the frozen governing-artifact surface named in `CLAUDE.md` § "Governance freeze": a change to it
> before 2026-08-08 needs recorded owner approval instead of a stricter reviewer count. The
> `agents/reviewer-*.md` carve-out below is moot post-teardown (reviewer charters take the same single-
> reviewer bar as everything else now), but the rest of the surface list is the freeze's own list.

A **system-level change** is one that alters the development system itself rather than the wedding app's features. The gate (`tools/verdict-core.ps1`) treats a staged path as system-level when it is under `.githooks/`, `tools/`, `standards/`, `agents/`, `skills/`, `.github/`, or `.claude/`, or is `docs/north-star.md`, `DESIGN.md`, `CLAUDE.md`, or `AGENTS.md` — **except** files matching `agents/reviewer-*.md` (reviewer charters, including new lens charters), which take the routine bar (#218). `skills/` is included deliberately: the runner's own logic lives there, so editing it must trip the stricter bar. These changes use the stricter two-independent-reviewer, both-must-PASS bar in `standards/adversarial-review-protocol.md`, because a defect there weakens every future change rather than one feature. (This prose and the regexes in `tools/verdict-core.ps1` — `$SYSTEM_PATH_REGEX` and the `$EXPERIMENTAL_PATH_REGEX` carve-out — must list the same surface.)

**Why the charter carve-out is safe there and nowhere else (#218):** charter iteration is where governance experimentation happens, and the governance ledger (separate issue in the same overhaul set; not yet landed) will make a weakened charter detectable after the fact via falling catch-rates. Bar-definitions, hooks, and evidence writers fail **silently** when weakened — nothing downstream measures them — so they stay kernel. `standards/design-philosophy.md` stays kernel because it lives under `standards/`, not under `agents/reviewer-*.md` — the carve-out is a path match, not a judgment about the file's content, and it never applies to the bar-definitions and evidence writers that check the certifier.

## Security lens (#222)

> **Retired 2026-07-17 (#587):** the ≥3-reviewer escalation bar this section's last sentence describes
> is gone. A major/blocker security finding now takes the standard one-round stop rule like any other
> finding — see `standards/adversarial-review-protocol.md` § "One-round stop rule" and the ADR below.
> The rest of this section (conditional firing, advisory status, the four trigger surfaces) is unchanged.

The security lens (`agents/reviewer-security.md`) is **conditional**, not universal: it fires only on diffs touching upload/intake, auth, file-serving/static, or admin routes, because running a security-focused read on every change (a badge-copy tweak, a CSS fix) would be pure cost for no catch — the escaped defects it targets (#196, #180) were both on those four surfaces, nowhere else. It ships **advisory**, per the standard lifecycle (`standards/adversarial-review-protocol.md` § "Advisory-lens lifecycle"): a new lens earns gating status on recorded evidence over a trial, not on day one. The one exception is the escalation rule — a major/blocker security finding flags the change `security` and forces the existing ≥3-reviewer bar immediately, because a real vulnerability must be able to block even mid-trial; the advisory status only shields the lens's routine (minor/nit) findings while its catch-rate is unproven.

## ADR: Governance teardown and freeze (#587)

**Date:** 2026-07-17. **Status:** accepted, owner-authorized.

**What changed.** The proof layer this repo had built up around code review — evidence-store files
bound to a staged tree (`tools/verdict-core.ps1`, `persist-review.ps1`, `review_verdict.ps1`,
`validate-verdict.ps1`), verdict capture and a citation-validating runner (`capture-reviewer-verdict.ps1`,
`review-runner.ps1`), a committed governance ledger with a CI-only writer
(`.github/workflows/ledger.yml`, `scripts/ledger-harvest.js`, `scripts/ledger-push.js`,
`scripts/buildlog-render.js`), a server-side review-authenticity CI check (`review-artifact-present`,
`scripts/check-review-artifact.js`), a bias-gate audit step with its own evidence artifacts
(`persist-bias-gate.ps1`), a severity adjudicator and a contest/concede fork at a 3-round soft cap
(`agents/severity-adjudicator.md`), a run-tier classifier that routed issues to a same-model
Sonnet-only review tier (`tools/classify-issue-run.ps1`), event-mode (a wedding-day evidence-gate
bypass window, `tools/set-event-mode.ps1` and friends), a trivial-dep-bump classifier
(`tools/classify-trivial-commit.ps1`), and wave-alignment tooling
(`tools/check-wave-alignment.ps1`, `start-run.ps1`, `stop-run.ps1`) — all of it is deleted. In its
place: `.githooks/commit-msg` runs one cheap check (a code commit must name a GitHub issue);
`standards/adversarial-review-protocol.md` runs a one-round stop rule (minor/nit fixed inline and
shipped, a blocker/major takes exactly one re-check); and the governing-artifact surface this
machinery lived on is **frozen until 2026-08-08** — see `CLAUDE.md` § "Governance freeze". Kept,
unmechanized: one issue reviewer, one PR reviewer plus the design-philosophy reviewer, the visual-
approval loop, worktree isolation, CI (lint/test/smoke/docker-build/CodeQL/Dependabot), and the
Dependabot auto/review tiering (`tools/classify-dep-pr.ps1`).

**Why.** Measured 2026-07-17: merge throughput ran 20–33 issues/day through 2026-07-12, then fell to
3–10/day — the cliff coincides with the proof layer landing (#447/#449/#474/#455/#427, 2026-07-11/12).
The governance machinery itself grew 2,865 lines (07-04) to 7,099 lines (07-17) — 2.5x in two weeks —
while reviewers found zero blocker/major defects in app code since 07-11 across roughly 200 review-
ledger entries: the machinery had become the only defect-rich surface left, and the pipeline was
converting its own defects into issues (25 filed 07-17 alone, a majority of them governance issues).
The proof layer also kept failing on ordinary git life it was never built to survive: #580 (a rebase
after review silently invalidated the tree-bound evidence), #584 (the wrong changed-path set), #536
(would have blocked every Dependabot PR). Its flagship check, `review-artifact-present` (#48), was
never activated as a required check in the first place, and #431 had closed "done" with nothing
built — `definition-of-done.md` § 10 already records this failure class. Issue review itself had
become the bottleneck it was meant to police: 7 rounds to define one issue's acceptance criteria
(#541), 6 rounds on a robots.txt test probe (#555), 4 bias-gate audits of a single reviewer briefing
(#543) — review effort was being spent on process artifacts, not the product, with three weeks left
before guests arrive.

**Superseded records.** § "Branch protection on main" above recorded `required_status_checks.strict =
true` as a binding decision; the owner turned `strict` off on 2026-07-17, before this issue was filed,
so that section's `strict = true` line is stale as of this ADR — the required-check set itself is also
retargeted to `{lint, test, smoke, Analyze (javascript)}` by this issue (`tools/apply-branch-
protection.ps1`), dropping the proof-layer checks. § "Fable: available, owner-signal only (#453)"
recorded that `tools/persist-self-certification.ps1` and `tests/persist-self-certification.test.js`
"intentionally remain on disk as dormant mechanism — a future owner-signaled Fable use could reactivate
them." This ADR **reverses that dormant-retention decision**, not just the live policy it described:
both files are deleted along with the rest of the proof layer (`persist-bias-gate.ps1` likewise). A
future Fable-specific review mechanism, if the owner ever wants one, is designed fresh against
whatever the pipeline looks like after 2026-08-08 — it does not un-delete this dormant code.

**What is not retired.** Review practice itself — an independent reviewer, by default on a different
model, reading a change against a standard, citing evidence, returning PASS/FAIL — continues exactly
as before, with one addition made 2026-07-19: the `sonnet-only` tier reinstated by #680 lets a
reviewer judgment call put the implementer and reviewer on the same model for a bounded, low-stakes
slice of work — see "ADR: Sonnet-only tier reinstated as reviewer judgment (#680)" below. What is gone
is the machinery that tried to mechanically _prove_ a review happened. `WHAT-IT-CHECKS.md` states this
distinction to the owner directly.

**Revisit.** This freeze and teardown are scoped to 2026-07-17 through 2026-08-08. Whether any retired
mechanism is worth rebuilding — with a leaner design informed by what actually broke here — is a
post-wedding decision, not a foregone conclusion either way.

## ADR: Sonnet-only tier reinstated as reviewer judgment (#680)

**Date:** 2026-07-19. **Status:** accepted, owner-authorized (the freeze-exception approval for this
change, and the six-plus-one-plus-one governing files it touches, is recorded in `CLAUDE.md` §
"Governance freeze" and issue #680 itself).

**What changed.** The `sonnet-only` run tier retired in the #587 teardown (originally #427) is back,
but its eligibility decision moves from a maintained classifier script to a judgment the existing
Opus issue reviewer (`reviewer-issue`) makes once, at issue-review time. No new script, tool, or
agent is added. The reviewer's verdict now carries `AWARD sonnet-only` or `DENY sonnet-only`, decided
against three eligibility gates — governance surface, guest-critical paths, and small-and-reversible —
owned in full by `standards/issue-standards.md` § "Sonnet tier eligibility", with any borderline case
defaulting to `DENY`. On an `AWARD`, the orchestrator
applies the `sonnet-only` GitHub label and runs both the implementer and the PR + design-philosophy
reviewers on Sonnet for that issue; the orchestrator itself stays Opus. Mechanics:
`agents/orchestrator.md` § "Model policy".

**Why a judgment, not a script.** The original #427 mechanism (`tools/classify-issue-run.ps1`)
hard-coded a guest-critical path list and needed its own drift-guard test just to keep that list
honest as the app was renamed and restructured through each wave — a maintained bug surface layered
on top of the tier it was supposed to gate cheaply. The issue reviewer already reads the issue and
every path in its `Touches` list before it can pass review at all; folding the eligibility call into
that existing read removes the drift-prone list rather than reinstating it. There is nothing left to
go stale, because there is nothing left to maintain.

**Decided once; escalation is manual.** Eligibility is decided a single time, at issue review — not
re-checked continuously through the run. If implementation or PR review turns up a guest-critical or
governance-surface path the issue did not declare, the remainder of that run escalates to Opus by the
manual judgment of whoever spotted it — the implementer or the PR reviewer — not an automatic re-run
and not a script re-testing the gates mid-flight. This trades a small chance a human misses the
trigger against the certainty that a scripted mid-run re-check would need the same maintained path
list this decision removes.

**What this trades away, stated honestly.** Same-model review still inherits correlated blind
spots — the errors the implementer makes are the ones a same-model reviewer is likeliest to
miss — exactly the tradeoff the original #427 decision accepted, and exactly what
`standards/agent-standards.md` § "Reviewer independence" states plainly as the default rule's
rationale. Reinstatement does not dispute that; it accepts the same tradeoff again, on the same
bounded, low-stakes slice of work (routine, reversible, off every guest-critical and governance
surface), for the same reason it was tolerable the first time: the differently-chartered
design-philosophy lens (`agents/reviewer-design-philosophy.md`) still runs even when it shares a
model with the implementer, and a different lens catches what a same-charter reviewer misses,
independent of which model runs it. The second mitigation carries forward unchanged from #427: every
sonnet-tier reviewer spawn carries a coverage-first instruction — report every finding, tagged with
its own severity and confidence, and never defer to a downstream filter — to counter Sonnet's
documented tendency to under-report when told to be conservative; on the common single-round PASS
path, no downstream filter exists to catch what that under-reporting would otherwise lose.

**Not built by this issue.** #680 is itself a governance-surface change and runs the full Opus
pipeline throughout — it is not itself `sonnet-only`-eligible.

## ADR: Backup split — database and photos get opposite cadences (#558)

**Date:** 2026-07-17. **Status:** accepted.

**What changed.** `scripts/backup.js` no longer treats the database and the photo directories as one
unit copied together on every run. It now runs in three modes — `--db-only`, `--photos-only`, and the
flagless default (both) — and the two halves are backed up differently:

- The **database** is small and changes minute to minute (points, likes, comments). `--db-only` still
  uses the same WAL-safe `better-sqlite3` online-backup path as before, writing a new timestamped
  snapshot folder under `BACKUP_DIR`, and stays cheap enough to run often. `BACKUP_RETENTION_COUNT`
  prunes these timestamped snapshots exactly as it did before this issue (issue #287) — that logic is
  unchanged.
- **Photos** are write-once (`src/services/photos/constants.js` and `src/services/photos/naming.js` — formerly `src/services/photos.js:203-236` — never rewrite an existing stored file
  under its own name). `--photos-only` (and the default run) copies a file into a single shared,
  append-only store at `BACKUP_DIR/photos/{uploads,thumbs}` only if a file of that name is not already
  there — never a fresh per-run copy of the whole photo set. Because the filename alone already
  identifies identical content, this is a skip-if-exists comparison, not a content hash.

Before the split, every run — including the default, still-recommended one — did a full
`fs.cpSync(srcDir, destDir, { recursive: true })` of `uploads/` and `thumbs/` into each new timestamped
folder. At `docs/deploy.md`'s previously-recommended hourly cadence with `BACKUP_RETENTION_COUNT=48`,
that meant every wedding photo existed on disk up to 49 times over (`retention + 1`), multiplying
whatever the live photo set weighed by up to 49x — on a host whose disk is shared with the live app.

**Why the shared photo store is never pruned.** Under the new shape, a photo is retained in the store
exactly once, for as long as the store exists. Giving that store its own retention count — "keep only
the last N runs' worth of new photos" — would delete the only backup copy of a photo that was
uploaded, backed up once, and never touched again, on nothing but the passage of time. That is the
opposite of what a backup exists to do. Removing a photo from the store is therefore a manual, one-off
act, not a scheduled one: `docs/deploy.md` § "Restore" documents the case that makes this concrete — a
**hard** takedown (deleted from `uploads/` outright, as opposed to a moderation hide, which never
touches `uploads/`) must also be deleted from `BACKUP_DIR/photos/` by hand, or the next restore returns
it to the live set.

**The pre-flight disk-budget guard.** Before the first copy in any mode, `scripts/backup.js` sizes
exactly what that mode is about to write (`D` for `--db-only`, the bytes of not-yet-stored photos for
`--photos-only`, both for the default) against the free space on `BACKUP_DIR`, and aborts before
starting any copy if there is not room — naming the free and needed bytes. This runs for every mode,
not only the default, so a low-disk host is never blocked from the megabytes-sized database snapshot by
a large photo set it is not touching that run.

**The projected-total report reads the raw retention env, and 0 means unbounded.** Alongside the
required bytes, the guard reports a projected retained high-water mark once the schedule catches up:
`S + (N + 1) × D` (the photo set once, plus `N + 1` database snapshots). This must match what
`pruneBackups` actually does, and `pruneBackups` treats any `keep <= 0` — or a non-finite one — as "keep
everything." So a retention that does not positively bound the snapshots (unset, blank, `0`, negative,
non-numeric) is reported as `unbounded`, not as a number: reporting `S + D` for those would tell an
operator whose snapshots grow forever that their backups cost exactly one snapshot. Distinguishing an
unset env from an explicit `0` is why `planBackup` reads `process.env.BACKUP_RETENTION_COUNT` directly
rather than `config.BACKUP_RETENTION_COUNT`: config's `parseInt(...) || 0` coercion collapses "unset"
and "0" into the same `0`, which is lossy for the report even though both resolve to the same unbounded
runtime behavior. That is a deliberate, single-purpose second read of one env var — the projection's need
to see "unset" — not a second owner of the retention _policy_, which stays with `pruneBackups`.

**The free-space seam moved.** `hasFreeSpace`/`setFreeSpaceReader`/`defaultFreeSpaceReader` moved from
`src/services/rate-limit.js` (issue #247/#283's home for it) to a new `src/utils/free-space.js`, joining
`initials.js`, `semaphore.js`, and `shutdown.js`. `scripts/backup.js` needed the same injectable
disk-space primitive the rate limiter already had, and importing it from a module named after a
different concern — and duplicating the underlying `fs.statfs` call to avoid that — would have given one
fact (how much free space is on a volume) two independent owners. `rate-limit.js` re-exports the same
three names unchanged, so every existing caller (`src/routes/guest.js`) and test
(`tests/memories.test.js`) keeps working without knowing the code moved.

## ADR: DESIGN.md carved out of the governance freeze (#707)

**Date:** 2026-07-19. **Status:** accepted, owner-authorized.

**What changed.** `CLAUDE.md` § "Governance freeze" no longer lists `DESIGN.md` in its frozen-surface
enumeration, and the two restatements of that list (`agents/orchestrator.md` § "Governance freeze",
`.claude/commands/build.md` § "Governance freeze") were updated to match. `CLAUDE.md` now states
directly that `DESIGN.md` is documentation, not enforcement machinery, and stays editable through the
normal pipeline for the rest of the freeze. Every other frozen path — `.githooks/`, `tools/`,
`standards/`, `agents/`, `skills/`, `.github/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`,
`docs/north-star.md` — is unchanged, as are the "Filing rule" and "Approval to change the frozen
surface" paragraphs that govern what remains frozen.

**Why.** The freeze (see "ADR: Governance teardown and freeze (#587)" above) exists to keep the
pre-wedding pipeline's capacity on guest-facing work instead of on reviewing, repairing, and
re-reviewing the pipeline's own enforcement machinery. `DESIGN.md` enforces nothing — it is where
architecture decisions get written down after the fact, this ADR included. Freezing it served none of
the freeze's own rationale and only blocked the owner from recording decisions during the exact
three weeks this repo is making the most of them. `docs/` was never frozen wholesale in the first place
(only `docs/north-star.md`, the goals contract, was), which made `DESIGN.md` the sole documentation file
the freeze actually reached.

## Host checklist: one row-definition module, feature-detected rows (#646)

**Date:** 2026-07-21. **Status:** accepted.

**What changed.** `src/services/host-checklist.js` is the single owner of the admin dashboard's
checklist: every row's definition, its evaluation against live state, the bucket ordering (bugs pinned,
then open auto rows with configuration first, then manual rows, then tips, then done rows), the nudge
counts, and the tips gate. `src/routes/admin.js`'s `GET /admin` handler calls `buildRows()` once and
hands the result straight to `src/views/admin-dashboard.ejs`; neither the route nor the view re-derives
any ordering, gating, or row-eligibility logic of its own.

**Why one module, not the route or the view.** The dashboard's per-row rules (bug pin overrides
everything else; a row's own open/done transition; the tips gate depending on the state of every OTHER
row; the daily-challenge roll-forward reading tomorrow's date only once today's is covered) are facts
about the checklist as a whole, not about any one row or about how the page is rendered. Splitting them
between the route (which already owns unrelated stat-grid queries) and the view (which the freeze holds
to "markup and classes only, no new logic") would create exactly the two-owners-of-one-rule drift this
codebase's own convention warns against elsewhere (see `src/services/tasks.js`'s `liveTaskWhere`,
`src/services/feed.js`'s `VISIBLE_WHERE`) — a future auto row added to only one of the two files would
silently disagree with the other about ordering or counting.

**Why an unshipped feature's row is omitted, not hard-dependent on merge order.** Three of the design
table's row types are backed by columns or tables owned by issues that had not merged as of this
issue's own implementation: lucky tasks (#650) and per-task photo ranking (#661/#662) — issue #649
(flash) and #753/#754 (daily challenge, one-day-only) HAD already merged, so their rows are live in this
build, not stubs. `host-checklist.js` runs a `PRAGMA table_info` presence check before it reads a column
it does not itself own (`hasColumn('tasks', 'flash_start_at')`, etc.), and simply skips the row when the
backing feature is absent, rather than throwing or trusting a build-order assumption. The alternative —
coupling this module's release to the exact order the other four issues land in — would make a
merge-queue reshuffle (entirely plausible three weeks out from the wedding) a correctness bug here
instead of a no-op. Per-task photo ranking has no presence check at all: no column or table for
"winners chosen" exists anywhere in the current schema for that row type to detect, so the row is
omitted outright rather than gated on a check that has nothing to test.

**Why manual rows post through a plain form, not new client-side JavaScript.** The design calls for
exactly one interaction shape reused from elsewhere in this admin: a form POST that flips one piece of
server-held state and redirects back (`POST /admin/bugs/:id/track` / `/close` since #686 retired the
single `/resolve` route into a three-state lifecycle, `POST /admin/guests/:id/badge`'s toggle case).
Manual items are persisted the same way `src/services/lockout.js` persists its own
counters — a `settings` key/value row read and written through the exported `db` handle — so no new
storage shape or read/write pattern was introduced. The one visual cost is that a `<button>` needs a
full CSS reset before it can render pixel-identical to the frozen `.check-link` anchor style (a bare
button carries browser chrome an `<a>`/`<span>` never does); that reset (`button.check-link` in
`src/public/css/theme.css`) is additive CSS this issue added.

**What CSS this issue actually shipped in `src/public/css/theme.css`** (corrected — an earlier version
of this note claimed the `button.check-link` reset was the ONLY rule added, which was false: it also
omitted the rest of what shipped). The `.stat-grid-3` / `.check-*` / `.stat-nudge` block is this issue's
own addition, not a pre-existing frozen rule — the phase-1 visual-approval loop settled the LOOK on
localhost first, and this issue is what turned that approved look into real, checked-in CSS for the
first time. Nothing pre-existing in `theme.css` was edited or deleted; every rule added here is new. A
follow-up review pass also found and removed four rules from this same block (`.nudge-strip`,
`.nudge-count`, `.nudge-copy`, `.nudge-sub`) that belonged to a nudge-row treatment the owner rejected in
favor of the full-width `.stat-nudge` cell — dead CSS with zero consumers in any view, deleted rather
than left to rot.

**CSRF deviation from the issue plan (recorded, #769, resolved by #284).** The issue's implementation plan
called the manual-toggle POST "CSRF-protected." At the time this issue shipped, the app carried no CSRF
middleware or token anywhere — `POST /admin/checklist/:id/toggle` matched the same session-cookie-only
protection every other admin POST route used then (`POST /admin/bugs/:id/track`, `POST /admin/guests/:id/badge`,
etc.), which was consistent with existing prior art but was not actually CSRF protection. That gap was
app-wide, not specific to this issue's one new route, and was tracked separately as #769 rather than being
invented ad hoc inside this issue's narrow Touches. App-wide CSRF protection was subsequently implemented
under #284 (see "CSRF tokens and security headers: implemented (#284)" above) — `POST
/admin/checklist/:id/toggle` is now CSRF-gated the same as every other admin POST route, along with every
other admin and guest POST route in the app.

## Memory-day bonus: event-local day math in JS, leaderboard's JS re-sort (#656)

**Date:** 2026-07-21. **Status:** accepted.

**What changed.** A guest's first visible memory (`submissions.task_id IS NULL AND taken_down = 0`)
each event-local day now earns +1 point, capped at one per day. The bonus is DERIVED, not banked: a
memory row's `created_at` never changes after insert (`src/services/submissions.js`'s memory-batch path
never replaces an existing row — there is no `(guest_id, task_id)` collision to replace, since every
memory's `task_id` is `NULL` and SQLite treats every `NULL` as distinct under `UNIQUE(guest_id,
task_id)`), so recomputing the count on every read is always correct: a takedown of a day's only memory
drops that day's point automatically, and a restore brings it back, with no separate bookkeeping step.

**Why the event-local day conversion happens in JS, not SQL.** SQLite has no IANA timezone support —
`datetime(created_at, '-6 hours')` is a fixed offset, which is wrong across a DST transition (the exact
failure mode `src/services/event-days.js`'s own header comment already documents for `dayOpensAt`). The
conversion instead runs through the two single owners this codebase already has for exactly this
problem: `src/services/relative-time.js`'s `parseSqliteDatetime` (the ONE place a SQLite
`datetime('now')`-shaped string becomes a UTC `Date`) and `src/services/event-days.js`'s
`eventLocalDateString(timezone, instant)` (the ONE place a UTC instant becomes an event-local
`YYYY-MM-DD`). `src/services/scoring.js`'s new `memoryDayCount(guestId, timezone)` and
`memoryDayCountsByGuest(timezone)` both read a guest's (or every guest's) visible memory `created_at`
values as raw strings from SQL, then fold them into a `Set` of event-local day strings per guest entirely
in JS. Both `getPoints()` and `leaderboard()` consume these same two functions, so the two scoring
surfaces cannot independently drift on which day a given memory counts toward — the stale-count defect
class this issue's own body calls out by name.

**Why `leaderboard()`'s SQL query carries no `ORDER BY`, and the JS comparator is the single owner of
standings order.** `leaderboard()`'s per-guest points total is a SQL expression, but the memory-day term
cannot be computed in SQL (no IANA timezone support, as above) — it is added to each row's `points` AFTER
the SQL query has already run. An `ORDER BY` inside that query would therefore be deciding an order based
on totals that are not yet final: whenever the memory-day term changes a guest's rank relative to a
neighbor (issue #656's AC5: guest A trails B before the term, leads after it), the SQL-decided order would
already be wrong by the time the term lands, and the JS re-sort that has to run afterward anyway would
just discard it — a second, dead ordering rule that still read as authoritative to anyone skimming the
query. The fix removes the `ORDER BY` from the SQL (the query keeps only its `GROUP BY`) and makes a
single JS `Array.sort`, run once the memory-day term is folded in, the ONE place standings order is
decided: points DESC, then `(last_submission_at IS NULL)` ASC (NULLs last — a guest with no visible
submissions must not rank ahead of a guest who scored), then `last_submission_at` ASC, then name ASC, then
id ASC. A caller reading `row.points` and a caller reading row POSITION can never disagree about a guest's
standing, and there is exactly one place — the comparator itself — where that key sequence is written.
This is the first term in this file's history to be folded into `leaderboard()` in JS after the query runs
rather than as a SQL expression inside it; every future JS-computed leaderboard term needs the same
JS-only-ordering discipline, not a SQL `ORDER BY` that a JS pass will only end up overriding.

**Why the "Share a memory" row is a second instance of the starter-row pattern, with two departures from
it.** Issue #409/#716 established the shape for a synthetic to-do row backed by no `tasks` table row:
`scoring.js` derives its done/points facts from live guest state (`starterTaskContribution`, keyed on
`guests.avatar_path`), and the route/view render it as an ordinary `task-row` alongside real tasks rather
than inventing a separate markup or counting path. The memory row (issue #656) reuses the identical
shape — no `tasks` row backs it, its state (`memoryBonusAvailable`) is derived live by the route from the
guest's visible memories (via `scoring.memoryDaysFor`) and `todayIso` (`todayIso` was already computed for
the one-day-only mystery-box surface, issue #753/#754; the visible-memories query is new in this issue) —
but departs from the starter in two respects, not one:

1. The starter completes once and then moves to the done list, while the memory row never leaves the
   to-do list at all, because "done for today" resets every event-local day rather than being a one-time
   transition. `src/views/tasks.ejs`'s own comment at the row records this difference.
2. The starter is counted into `todoCount`/`doneCount`/`totalCount` (issue #409's original counting
   contract: no visible list ever disagrees with the chip counts next to it); the memory row is
   deliberately NOT counted into any of the three. Counting it would break `allDone`
   (`totalCount > 0 && todoCount === 0`, `src/views/tasks.ejs`): the memory row can never be "done" the
   way the starter can, so if it counted toward `todoCount`, `todoCount === 0` could never be reached and
   the finished-all-tasks card could never fire. `src/views/tasks.ejs`'s header comment records this
   second departure explicitly, next to the original counting contract, so a future reader does not
   conclude the omission is an oversight.

This ADR is the second data point that the synthetic-row pattern generalizes to "a row with no backing
table row," not narrowly to "a one-time starter task" — and the second departure above is the first
instance of that pattern where a synthetic row is deliberately excluded from the counts a sibling
synthetic row is included in.

**Superseded 2026-08-01 (issue #1002, owner call).** The row placement above is retired. "Share a memory"
is now a quiet `btn-secondary btn-block` button in its own `section.tasks-share-cta`, sitting under the
`.task-filters` chips and above the task list — not a synthetic `task-row` at all, so neither of the two
departures this ADR describes still applies (there is no row to omit from the counts, and no "stays in
the to-do list forever" distinction to draw). The `memoryBonusAvailable` plumbing (`src/routes/guest/
tasks.js`, `scoring.memoryDaysFor` call site) was removed with it — the button carries only its label, no
price tag, so nothing on `/tasks` needs to know whether today's +1 is still available. The underlying
first-memory-of-the-day +1 award (this ADR's actual subject — derived scoring, day-boundary math,
`leaderboard()` ordering) is untouched; only its advertisement on `/tasks` moved.

## Flash guest marker: shared shape, separate hue, no floor, no neutral fallback (#762)

**Date:** 2026-07-21. **Status:** accepted, owner-approved live on a seeded preview.

**Shared shape, separate hue.** The flash pill reuses the Today Only row's shape wholesale — same pill,
same position above the title, same struck-through price tag — because both say the identical thing to a
guest: _this one is worth more right now._ A guest should not have to learn two vocabularies for one
idea. Colour is a different story. The pill was first built sharing `--place-1` (the leaderboard gold)
on the reasoning that hue should stay shared across the app's "worth more" signal and motion (the drain
fill) should carry the differentiation between the two rows. Seen live beside an actual gold Today Only
row on the seeded preview, the two read as the same offer at a glance — a guest scanning the list had no
fast way to tell "expires today" from "expires in the next four minutes." The owner asked for the
separation to be carried by colour after all: flash now holds its own `--flash-1` ember orange
(`#b5401a`), held in a token group (`--flash-1`, `--flash-1-ink`, `--flash-1-spent`, `--flash-1-wash`)
rather than derived with `color-mix()`, because that function is newer than some phones that will be at
this wedding. A hue change is still a three-line edit inside that block — `--flash-1-ink` stays `--white`
regardless of hue, so only the three ember-derived values (`--flash-1`, `--flash-1-spent`,
`--flash-1-wash`) move together. `#913000` was also tried and rejected live as too dark against the app's
warm cream background.

**No floor on the drain fill.** The pill's fill recedes left to right as the window burns down (one
ember colour at two densities, not an animation — see `src/public/css/theme.css`'s own comment on why
that makes it free under `prefers-reduced-motion`). Floors at 20% and 5% were both built and rejected: the
owner's call is that the fill runs the full range to empty, so the pill goes visually quiet exactly as the
window closes. That is accepted as correct, not a rendering gap papered over — by the time the fill is
near-empty the row is already pinned to the top of the to-do list (criterion 7's rank function) and the
live `mm:ss` clock beside the pill is what carries the final stretch, not the fill.

**The drained half stays a thinned ember, not neutral grey.** `--flash-1-spent` re-expresses the same
ember hue at low opacity rather than falling back to `--color-text-muted`'s grey the way an exhausted
state elsewhere in the app might. Raised with the owner directly against the live preview and accepted
as-is: a rosy-over-white drained half reads as "this ember is nearly out," consistent with the pill's own
colour story, where a grey drained half would have read as a totally different (and disconnected) UI
state layered on top of it.

**Plan deviation from the issue plan, recorded (#762 architecture review).** The issue's implementation
plan prescribed `flashActive = tasks.whatSpecial(t, clock) === tasks.SPECIAL_FLASH && tasks.flashState(t,
clock.nowMs) === tasks.FLASH_ACTIVE` — deriving the guest's display straight from the exclusivity/window
functions. What shipped derives it from `tasks.bonusForTask(t, clock)` instead, checking that the
presently-paying rule's `reason` is `tasks.BONUS_REASON_FLASH`. This is not a style choice; it changes
which function is the single owner of "does the guest see a flash marker." `bonusForTask()` is the SAME
function `src/services/submissions.js`'s banking decision already reads (see the #761 entry above), so
this makes "what the pill advertises" definitionally identical to "what the submission banks" — a future
guard on what counts as actually paying moves both the pill and the payout together automatically,
because both now read the one function that answers "is anything paying, and if so what." Concretely,
`bonusForTask()`'s own return statement, `return { reason: amount > 0 ? rule.reason : null, amount };`,
already carries exactly this kind of guard, rule-agnostically — not inside any one `SPECIAL_RULES` entry's
`paying` predicate (`'daily'`'s entry carries only `spokenFor`/`paying`/`coalesceNullAmount`; no entry,
`'daily'` included, guards its own `amount`) but as the one expression every rule's payout passes through
on the way out. A guard added there tomorrow — or a new rule added to `SPECIAL_RULES` with its own such
guard — reaches the pill with no route-side change needed. The plan's original shape (`whatSpecial` +
`flashState`) would have needed that same guard hand-applied a SECOND time, in the route, to stay in sync
— exactly the two-owners defect criterion 2 exists to prevent, just relocated one function deeper. **This
is the precedent #650's lucky task should follow, not the plan text it will read** — written the way the
shipped code in `src/routes/guest.js`'s `tasksWithBadges` map actually guards it, not the bare comparison
a literal reading of the paragraph above might suggest:

```js
const bonusDecision = tasks.bonusForTask(t, clock);
const luckyActive = bonusDecision !== null && bonusDecision.reason === tasks.BONUS_REASON_LUCKY;
```

never `bonusForTask(...).reason === BONUS_REASON_LUCKY` alone — `bonusForTask()` returns `null` for every
ordinary row, so reading `.reason` off it without the null check first throws a `TypeError` on the very
first ordinary task in the list.

**`flashWindow` split out of `flashState`, correcting the #761 entry above (#762 plan step 2).** That
entry's point (2) describes `tasks.flashState` as the window rule's JS-only owner; it no longer is.
`tasks.flashWindow(taskRow)` now owns the window's arithmetic (`{startMs, endMs, totalMs}`), and
`flashState` calls it rather than computing `startMs`/`endMs` inline — the split exists because
`src/routes/guest.js` needs the SAME `endMs`/`totalMs` pair `flashState`'s internal comparison already
computed (the guest countdown targets `endMs`, the drain fill divides by `totalMs`), and hand-rolling that
arithmetic a second time in the route would let the clock and the fill disagree the moment the window's
shape changes. The "no SQL-fragment counterpart" claim in the #761 point (2) still holds for both
functions — neither ships one, for the same reason stated there.

## Missed-bonus FOMO: one meaning for a struck-through price, lucky excluded (#926)

**Date:** 2026-07-29. **Status:** landed with #926 — phase-1 pixels owner-approved live on a
seeded preview; the code in this section is mid-pipeline (adversarial review) as of this writing,
not yet merged.

**A struck-through figure means exactly one thing.** Before this issue, a struck-through base worth
appeared on a LIVE special row (Today Only / an active flash — "worth more right now"). Adding a second,
opposite meaning for the identical mark — "you missed this, it's gone" — on an expired row would have
made the strike-through ambiguous the instant a guest saw both states in one scroll. The owner's ruling
collapses this to one meaning: a struck-through figure on the guest list means a bonus that EXPIRED, full
stop. Live rows (`isToday`/`flashActive`) dropped their struck base entirely — the price column now shows
only the raised total, and the pill above the title (the gold Today Only flag, the ember flash pill) is
the sole "worth more now" signal for a still-open window. The missed state reuses
`.task-points-raised`'s column-flex layout for its own stack (`.task-points-lost` struck above the
still-earnable `+worth pts`), but nothing else about the live and missed treatments overlaps — the CSS
comment on `.task-points-raised` (`src/public/css/theme.css`) says so explicitly now, so a future reader
does not reintroduce the old "struck base, then live total" shape by pattern-matching the wrong
neighboring rule.

**Flash and one-day challenge share the ONE missed rule, not two.** `tasks.missedBonusForTask(taskRow,
clock)` (`src/services/tasks.js`) walks the SAME ordered `SPECIAL_RULES` list `bonusForTask`/`whatSpecial`
already walk (see the #761 entry above), each rule now also carrying a `missed` predicate beside its
existing `spokenFor`/`paying`. A row that is BOTH a passed one-day challenge and an expired flash
therefore reports the 'daily' miss — the identical precedence the live path already gives 'daily' over
'flash', for the same reason: one ordered list, one walk, so the live and missed questions can never
independently drift apart on which rule owns a given row. `src/routes/guest.js` derives
`bonusMissed`/`bonusMissedAmount` from this single function alone, gated on `amount > 0` (a legacy
one-day row carrying a date with a NULL `special_bonus` never had anything to miss, and must not render
"+0 bonus"), and never re-derives "expired" per special type.

**`clock.todayIso` is now validated where `clock.nowMs` already was.** Before this issue,
`missedBonusForTask`'s only clock check was `nowMs` (via the shared `assertClock`); an invalid `todayIso`
fell through to the 'daily' rule's own `missed` predicate, which merely gated on `isValidDateString` and
silently answered "not missed" — the exact silent-wrong-answer shape `isSealed()`/`isOnDay()` already
refuse to allow for the SAME parameter on the live path. The fix adds an explicit `todayIso` check inside
`missedBonusForTask` itself, throwing before any rule is walked — deliberately NOT hoisted into the shared
`assertClock`, because `assertClock` is also `findSpecialRule`'s guard, and `findSpecialRule`'s flash-only
callers legitimately pass no `todayIso` at all (flash's own `spokenFor`/`paying` never read it); forcing
the check there would start throwing for a caller that was never wrong.

**Lucky stays invisible, on purpose.** `SPECIAL_RULES`'s `lucky` entry carries no `missed` predicate at
all — `missedBonusForTask` treats a rule with no `missed` key as never-missed, structurally, not via a
special case inside the function. Lucky wears no live marker while its day is open (that secrecy is
#650 AC2's whole point: naming which task is lucky would let a guest game the guess), so growing a
posthumous "+N bonus, missed" mark on a passed lucky day would out it just as effectively as a live
marker would. The omission from the rule table IS the guard — the alternative (special-casing lucky
inside `missedBonusForTask` to force a `null` result) would duplicate, a second way, the exact "no marker
for lucky" fact the missing `missed` key already states for free.

## Recap: derived events vs. written events, and the badge-moment stamp (#644)

**Date:** 2026-07-22. **Status:** shipped.

**Two event shapes, on purpose, not by drift.** #644's recap unions three sources, and only one of
them is a stored table (`notification_events`). Badge grants/revokes are WRITTEN — `guest_badges`'
own row is either overwritten by a later grant or deleted outright on revoke, so nothing else can
reconstruct "this guest held Completionist, then lost it" after the fact (AC4). Likes and comments are
DERIVED, live, from the `likes`/`comments` tables themselves at read time — following the same
"derive over store" rule the rest of the scoring economy already commits to
(`docs/economy-architecture-2026-07-20.md` Rule 4A), rather than doubling every like/comment into a
second table that could drift from the first. A stored badge event and a derived like/comment event
therefore behave differently in one load-bearing way: the stored badge row is PERMANENT (it stays in
the recap forever, tinted read/white by comparison to the guest's checkpoint, so a badge row can still
replay its celebration on demand long after it first showed — AC1's "without depending on the badge
still being owed"), while a derived like-batch row is EPHEMERAL — it exists in the list, and its
displayed count reflects, only likes strictly newer than the checkpoint (AC3: "a photo with 5 older
likes and 3 new ones still reads 3", never a lifetime total). Comments sit with the permanent group
(one row per comment, tinted like a badge row) since each comment already carries its own natural
per-event identity the way a like batch does not.

**`kind` is two vocabularies, deliberately not one.** `notification_events.kind` is the STORED fact
(`badge_granted`, `badge_revoked`, `badge_removed` — the last split from `badge_revoked` in PR review,
see below — and four more #783/#778 will emit: `photo_takedown`, `photo_restore`, `comment_hidden`,
`comment_restored`). `src/services/notifications.js`'s `KIND_VIEW` map is the separate VIEW treatment
(`badge`, `loss`, `photo`, plus `announce`/`gold` from #778/#647) the frozen phase-1 markup renders as
`.recap-row-<view>`. Four stored kinds collapse onto the single view treatment `loss`
(`badge_revoked`/`badge_removed`/`photo_takedown`/`comment_hidden`) — that collision is exactly why the
two can never be the same field. #644 owns the complete map (all seven stored kinds), even though it
emits only three of them; #783 wires the emitters for the other four against a map that already has
their row waiting.

**`badge_revoked` split into `badge_revoked` (system) and `badge_removed` (host) — found in PR
review.** `scoring.js`'s `removeSpecialBadge` (a host un-awarding a mistakenly-given special/custom
badge) originally emitted the same `badge_revoked` kind as the threshold-recompute revoke paths
(`recomputeBadges`/`recomputeTransferableBadges`). `badge_revoked`'s copy asserts a specific reason
("the hosts added a task") and links to `/tasks` — both true for a recompute revoke, both false for a
direct host removal, which has no task-set change behind it and nowhere useful to send the guest.
Rather than make the shared copy vague enough to cover both reasons, `removeSpecialBadge` now emits its
own `badge_removed` kind, dead (no link), with copy that names only what actually happened: the badge
was removed by the hosts.

**The badge-moment stamp moved off the reward cookie, onto `celebrated_at`.** Before #644, the task
page's badge-earned modal was driven entirely by the one-shot `taskComplete` cookie's `newBadgeIds` —
a badge only ever celebrated if the SAME request that granted it also happened to render the task page
(the #563 defect this issue absorbs: a badge granted while the guest was on any other page, or awarded
by a host, was never shown). #644 replaces that with `guest_badges.celebrated_at`: every real grant
path (`recomputeBadges`, `recomputeTransferableBadges`, `awardSpecialBadge`) leaves it `NULL` by simply
never naming it in the `INSERT`, so a fresh grant is "owed" by construction, on ANY guest page, not
just the one that happened to trigger it. `src/services/render-locals.js`'s `resolveBadgeMoment()` — the
ONE place that reads and stamps this column — is called from a single shared helper, `withBadgeMoment()`,
which every `res.render()` in both `src/routes/guest.js` and `src/routes/community.js` passes through
(not a per-route decision list a future route could forget to join). It deliberately does NOT run in
`attachGuest` middleware: that middleware runs on every request including a POST that redirects without
ever rendering a page, and stamping there would consume a celebration the guest never actually saw —
reproducing #563 through a different door.

**"Owed" requires a matching recap event, not just a `NULL` timestamp — found in review.** The first
implementation gated `resolveBadgeMoment` on `celebrated_at IS NULL` alone. Several pre-existing tests
(e.g. `tests/badge-display.test.js`) grant a `guest_badges` row by direct `INSERT`, bypassing
`scoring.js` entirely, to set up a fixture — under the naive rule, that row is also `NULL` and therefore
"owed," so the very next `GET /` unexpectedly auto-opened a celebration modal for a badge no real grant
path had ever announced, breaking assertions written years before this issue existed. The fix adds an
`EXISTS` join against `notification_events` (`kind = 'badge_granted'`) to `resolveBadgeMoment`'s owed
query: a badge is only "owed" if one of #644's own emitters actually wrote a row for it. Every real
grant path always does (the emit call sits right beside the grant statement — plan step 2/3); a
test-fixture `INSERT` that skips `scoring.js` does not, and now correctly never triggers a celebration
it never earned through this app's own doors. This also keeps two questions — "does this badge
auto-open" and "does this badge appear in the recap, replayable" — answering from the same underlying
fact, since the recap list is itself built only from `notification_events` rows.

**Retired: the `day`/`flash`/`task` announcement glyphs — settled by #778, not a gap it needed to close.**
#644's own implementation plan (step 8) originally said to KEEP three `.recap-icon-<kind>`-style glyph
branches for #778's future announcement rows (`day`, `flash`, `task`), the same way `gold` (#647) and
`announce` (#778) were kept and wired into `src/services/notifications.js`'s `KIND_GLYPH` map. That
phase-1 art was never actually committed to this branch — `git log --all -S` over both `KIND_GLYPH` and
`theme.css`'s `.recap-icon-*` rules turns up no prior commit defining them — so #778 had nothing to
restore. Rather than invent three new SVG glyphs unreviewed, the owner's #778 Design section reversed
the plan (2026-07-21): differentiating the three announcement kinds by glyph is unapproved new art, a
separable future nicety, not something any of #778's acceptance criteria needs. #778 shipped every
announcement row — live-transition, challenge-unseal, and flash-open alike — through the single
`announce` glyph already wired above. This is now the settled shape, not an open gap a later issue owns
closing.

**Announcements (#778): derived from task state at read time, never a stored broadcast row.** The
host-driven half of the recap — "a task went live," "a one-day-only challenge unsealed," "a flash window
opened" — differs from every source above it in one structural way: it is a BROADCAST, not a per-guest
fact. `notification_events` (the recap's one STORED source) is `guest_id`-keyed `NOT NULL` and read
`WHERE ne.guest_id = ?` (`src/db.js`, `src/services/notifications.js`'s `EVENT_EXISTENCE_WHERE`) —
every stored row belongs to exactly one guest by construction. A host action belongs to no single guest
and must reach every guest whose recap checkpoint predates it, including one who has not yet joined.
Making that fit the stored shape means either an O(guests) fan-out write per host action (one
`notification_events` row per current guest, missing any later joiner entirely) or widening `guest_id`
to nullable on the hottest read path in the app (`getUnreadCount` runs on every authenticated request) —
neither justified, because every fact an announcement asserts is already sitting on the task row itself
at read time, the same way `flashState()` and the seal predicate (`src/services/tasks.js`) already derive
their own render state without a stored row of their own.

So all three announcement sources are DERIVED, added as a fourth source alongside the recap's two
existing derived sources (likes, comments) — this file's own header comment anticipated exactly this
before #778 landed. The one piece of state that had no home on the task row before #778 was _when_ a
task last became live — nothing recorded that instant. `tasks.live_since` (a guarded `ADD COLUMN`,
`NULL` = never live) supplies it, bumped only at a genuine not-live → live transition (compared via
`tasks.isTaskLive`, the single liveness owner) by the three write seams that can flip liveness — create,
edit, and the `/active` toggle (`src/routes/admin.js`). A pre-existing live task on a migrated database
keeps `live_since` `NULL` rather than being backfilled, so it can never spuriously announce: the read
rule is `live_since > checkpoint`, and `NULL > x` is never true. The other two sources need no new
column at all — a challenge's unseal reads `tasks.isOnDay`/`special_date` against the event-local day
start (`event-days.js`'s `dayOpensAt`), and a flash's open window reads `tasks.flashState`/`flashWindow`
— both already-owned derivations #762/#753 built for their own guest-facing surfaces, consumed here
rather than re-derived. Every announcement is EPHEMERAL by construction (it exists only while its
trigger instant is newer than the checkpoint AND the task is still `liveTaskWhere`-live), so a hidden
task can never announce under any of the three rules, and every announcement is unread the moment it
exists — there is no separate "unread" bookkeeping to keep in sync.

**Known limitation: a like landing in the same whole second as a `markSeen` checkpoint is lost —
found in PR review.** `notifications.js`'s unread-count and row-existence checks
(`stmtUnreadLikeSubmissionCount`, `stmtLikeBatches`) both compare a like's `created_at` to the guest's
checkpoint with a strict `>` (the shared `LIKE_EXISTENCE_WHERE` predicate), matching every other timestamp comparison
in this module. SQLite's `datetime('now')` has only whole-SECOND resolution (the same fact this
module's cursor-tie comment already documents for `notification_events`), so a like written in the
identical wall-clock second as a `POST /recap/seen` call reads as "not newer" and is excluded — and
because a like row is DERIVED (this module's read-time union, not a stored event), that exclusion is
permanent: the like never reappears in a later panel open or count the way a stored badge row would.
The window is a single second wide and requires the guest's own like-notify and their own
recap-checkpoint-advance to land in it, so it is rare in practice for a three-day wedding. Closing it
cleanly would mean moving every timestamp this module compares (checkpoints, `notification_events`,
`likes`, `comments`) to sub-second resolution — a schema and comparison change reaching well past this
module into every other `datetime('now')` comparison in the app-wide "read fresh" pattern — which is
out of proportion to the size of the gap it closes. Recorded as an accepted, narrow limitation rather
than fixed.

## Admin Photos, task-scoped: taken-down included, feed narrowed, H1 reads the scope (#748)

**Date:** 2026-07-22. **Status:** accepted, no visual-approval loop needed (no new pixel — see the
issue's own Non-goals).

`GET /admin/photos?view=task&task=<id>` (`src/routes/admin.js`) now scopes the existing by-task wall to a
single task instead of ignoring `task` entirely. Three divergences from the unscoped `view=task` wall this
scope deliberately introduces, and why:

**Taken-down submissions are included, not filtered.** The unscoped `view=task`/`view=user` wall shows
LIVE submissions only (`taken_down = 0`) — moderation state is judged elsewhere, in Recent or the inline
feed. The scoped view drops that filter for its one group. The reason a host taps a task's photo count in
the first place is to review and moderate that task's entries; a taken-down photo they can no longer see
is a photo they can no longer restore. Hiding it from the one screen built for judging that task would
defeat the screen's own purpose.

**The inline feed panel is scoped too, not held at every submission.** Before this issue, `photos` (and
therefore the feed panel `src/views/admin-photos.ejs` renders from it) always carried the FULL submission
set regardless of `?view=`/`?q=`, so tapping any tile from any view could land on that photo's feed card.
A scoped request narrows the SAME query (`WHERE s.task_id = ?`) instead of running a second one, so
`photos` becomes that one task's submissions — the feed panel is scoped along with everything else derived
from it. This was the plan's own design, not an oversight: narrowing one query keeps the H1 count, the
group, and the feed permanently in sync with no separate bookkeeping, and a scoped session has no reason
to tap into another task's photo anyway (its own tiles are the only ones on screen).

**The H1 count becomes the scoped task's count, not the wall total.** `<%= photos.length %> photo(s)` in
the page header reads the scoped `photos` array directly — this is a consequence of the point above, not a
separate special case, but it is worth stating plainly: the Tasks admin page's own "N photos" count next
to each task card (`src/views/admin-tasks.ejs`) counts LIVE submissions only (`taken_down = 0`,
`src/routes/admin.js`'s `GET /admin/tasks`), while this scoped heading counts live AND taken-down together.
A task with 3 live photos and 1 taken down reads "3 photos" on the Tasks board and "4 photos" once the host
taps through to the scoped Photos view — expected, not a bug, given the first divergence above; the two
counts are deliberately answering different questions ("how many can a guest see" vs. "how many exist for
me to judge").

## Badge celebration priority derived from the catalog, not a code list (#714)

`src/routes/guest.js` used to pick which badge a multi-badge submit celebrates from a literal array,
`BADGE_MOMENT_PRIORITY = ['GARDEN', 'BOUQUET', 'BLOOM', 'COMPLETIONIST']` (#255) — a second, hand-maintained
copy of facts the badge catalog (`scripts/badge-catalog.js`) already states as each row's own `type` and
`threshold`. A code left off that list didn't error; it silently fell through to `earnedBadges[0]`, whose
result depended on `getGuestBadges`'s SQL `ORDER BY` rather than any stated design — a new catalog badge
could end up celebrated or not celebrated by accident of insertion order, with no test able to tell the
difference from "working as designed."

`scoring.compareBadgeMoment(a, b)` replaces the list with a pure three-key comparator over each badge's own
`type` and `threshold`: type rank ascending (`auto` = 0 outranks `metric` = 1, reproducing #255's shipped
"an auto badge beats COMPLETIONIST" choice), then threshold descending (a higher completed-task threshold
is the more impressive badge), then `code` ascending as a deterministic tiebreak.
`scoring.primaryNewBadge(guestId, newBadgeCodes)` resolves a submit's newly-earned codes against the
guest's current holdings and returns the winner by this comparator, or `null` for an empty/no-match set —
the single function `src/routes/guest.js`'s `GET /tasks/:id` now calls instead of carrying its own loop. No
badge code appears anywhere in either function; a catalog addition is ranked on its own fields the moment
it becomes earnable, with no second place a reviewer or a future author needs to remember to update.

The type-rank map (`auto`/`metric`/`transferable`/`custom`/`special`) covers every value `badges.type`'s
CHECK constraint (`src/db.js`) permits today, so an unlisted type is unreachable through the database — it
exists only so a future widened CHECK degrades to "sorts last" rather than an `undefined` rank poisoning the
comparison with `NaN`. `compareBadgeMoment` is exported specifically so a test can assert that fallback on a
synthetic object, since the CHECK constraint makes it otherwise impossible to construct a real row that
exercises it.

Deliberately out of scope: `BADGE_THRESHOLDS` (`src/services/scoring.js`), which still drives which auto
badges are _granted_ — `recomputeBadges` iterates that array, not the catalog. Deriving grant thresholds
from the catalog would make `src/services/scoring.js` depend on `scripts/`, inverting today's layering, and
touches guest-critical granting rather than celebration ordering; it is separate work, recorded as a
deferred finding on parking issue #588.

**Amended at merge with #644 (2026-07-22): the call site named above moved.** This section's claim that
`GET /tasks/:id` calls `primaryNewBadge` "instead of carrying its own loop" describes what #714 shipped
onto pre-#644 `main`; #644's badge-moment stamp (previous section) replaced that whole per-route
resolution with `src/services/render-locals.js`'s `resolveBadgeMoment()`, which calls
`scoring.primaryNewBadge(guestId, owedBadgeCodes)` from the ONE shared `withBadgeMoment()` seam instead —
`GET /tasks/:id` no longer resolves a badge moment itself at all. `compareBadgeMoment`/`primaryNewBadge`
themselves are unchanged by this move; only their caller is. `BADGE_MOMENT_PRIORITY`, the hard-coded list
this section's opening paragraph describes retiring from `guest.js`, had a second, independent copy in
`render-locals.js` (added while #644 and #714 were building in parallel, on separate branches, each
unaware of the other's retirement) — that copy is deleted by the same merge for the identical reason. **Amended again at merge with #902
(2026-07-28): `primaryNewBadge` is deleted.** `resolveBadgeMoment` now calls
`scoring.rankBadgeCandidates(guestId, owedBadgeCodes)` for the whole ordered queue; see "Badge queue:
the #644 render-time drip becomes a client-driven continue-through celebration (#902)" below.

## Community guard completeness: stack-derived, not hand-maintained (#574)

**Date:** 2026-07-22. **Status:** accepted.

`src/routes/community.js`'s `requireGuest` gate is path-scoped (`router.use(['/gallery', '/feed',
'/leaderboard', '/p', '/badge', '/u', '/slideshow'], requireGuest)`, issue #466) rather than filterless,
because the community router is mounted at `/` and is the last router before the 404 handler — a
filterless `router.use(requireGuest)` there would swallow every unknown path, itself a regression (a
404 would become a redirect). Path-scoping is therefore required, not a shortcut; the gap it leaves is
that the guard list and the router's actual route registrations are two hand-maintained copies of one
fact, with nothing keeping them in sync when a route is added.

`tests/community-guard-coverage.test.js` closes that gap by deriving the check from the router's own
`stack` at test time — walking every registered `layer.route` rather than restating the seven prefixes
as a second (or, if the test itself hand-listed paths, third) copy. The suite's actual guarantee is that
every REGISTERED route is gated for an anonymous request, however it is gated (the shared prefix list, or
a route's own inline `requireGuest` — several POST routes already use the latter) — not merely that the
prefix list happens to be complete, which a route gated by other means would satisfy trivially while a
route gated by neither would not. The suite also asserts (AC5) that the router's stack carries exactly one
non-route layer — the `requireGuest` guard itself — so a future `router.use('/hall-of-fame', subRouter)`,
whose nested routes a stack walk at this level never descends into, fails the check instead of silently
passing under AC2's route-count floor.

The suite's AC4 case proves the check catches the issue's own failure scenario without re-typing the real
guard list — doing so would recreate, inside the test that exists to close it, the exact two-copies drift
this issue is about. AC4's throwaway router (never mutating the real one) is instead gated by a single
arbitrary prefix that is not any of community.js's seven, carrying one route registered under a different,
unlisted prefix. The route is discovered by running the SAME `walkRoutes()` the real suite uses against
this throwaway router, not hand-passed as a literal method/path — so a future narrowing of `walkRoutes()`
that silently stopped discovering a class of route would fail AC4's `.find()` first, rather than the
whole suite quietly losing coverage while AC1 and AC2 kept passing on what little `walkRoutes()` still
found. The derived check is then asserted to fail specifically on the assertion it makes (received status
200 where 302 was expected), not merely to reject for any reason — proving the check fires, not just that
something throws.

## Lucky task: its own columns, no special_mode member, banked-not-derived, last in the walk (#650)

**Date:** 2026-07-22. **Status:** accepted; engine + host setter shipped, owner-approved guest card and
admin panel transcribed per the issue's "Approved screens" record.

**(a) Its own columns (`tasks.lucky_date`/`tasks.lucky_bonus`), not #624/#753's `special_date`/
`special_bonus`.** The one-day-only pair already means something specific — a single all-or-nothing
challenge day with an on-day bonus, sealed until it arrives — and lucky is a different rule entirely
(host-picked, secret until won, pays every first-time completer that day, never re-derived from the
calendar). Sharing one pair of columns between two rules with different pairing, sealing, and payout
semantics would mean branching inside every reader on which rule currently owns the pair, recreating
the exact "one column, two meanings" drift class `tasks.special_mode` itself used to be before #727 gave
worth and mode their own columns. A second pair, each singly-purposed, is the same tradeoff #761 already
made for flash and costs nothing extra: SQLite doesn't charge for unused NULL columns.

**(b) Lucky is the one special that does NOT bank on a replace, and the rule lives on the
`SPECIAL_RULES` entry, not a `submissions.js` branch.** Every other special (daily, flash) pays on a
replace too, because their bonus is tied to a CALENDAR fact (the date, the window) a re-upload still
satisfies. Lucky's bonus is tied to a DIFFERENT fact — this is the guest's FIRST-EVER completion of the
task — and a guest's own soft takedown (`photos.hideSubmission`) leaves the original row alive, so any
re-upload is structurally a replace, never a fresh insert (`submissions.js`'s `UNIQUE(guest_id, task_id)`
design, unchanged by this issue). Without a rule that refuses to pay on replace, a guest could bank the
secret bonus twice: once for real, once by deleting and re-posting on the lucky day. The refusal is
encoded as `banksOnReplace: false` on the lucky `SPECIAL_RULES` entry (`src/services/tasks.js`) rather
than a hand-written `if (reason === 'lucky') { ... }` fork inside `submissions.js`'s replace branch,
for the same reason `bonusColumn`/`reason` already live on the rule object instead of a second
hand-written switch (see the #761 entry above): a fourth special added later inherits the documented
one-entry contract (`kind`/`bonusColumn`/`reason`/`spokenFor`/`paying`/optionally `banksOnReplace`)
automatically, instead of a future author needing to remember there is a SECOND place a new rule's
banking behaviour must also be taught. `bonusForTask()` passes `banksOnReplace` through UNCHANGED
(daily/flash simply omit the key, which `toEqual` ignores) — the consumer in `submissions.js` applies
the "anything other than `false` banks" default, not this function.

**(c) Lucky is appended LAST in `SPECIAL_RULES`.** The list order is precedence for a legacy or raced
row that could match more than one rule — unreachable through the UI once the setter guard refuses the
pair (this issue's own exclusivity check), so this is defensive ordering, not a product decision. Daily
and flash both wear a guest-visible marker advertising what will bank (the "Today Only" chip, the flash
countdown pill); lucky wears none by design (AC2's whole point is that it stays invisible until won).
Landing lucky ahead of either in the walk would let a task display one of those markers while the
submission actually banked the lucky amount instead — a guest reads "+2 today only," banks a different
number, and has no way to reconcile the two. Last is the only slot that can never produce that mismatch.

**(d) The success card is keyed to what the submission BANKED, not to whether today is the lucky day
— and those two come apart on purpose.** `src/routes/guest.js` computes `taskComplete.luckyBonus` from
`submitPhoto()`'s own return value (`result.luckyBonus`), never by re-deriving "is today the lucky day"
or "is this the lucky task" in the route. The gap this closes: a guest who already completed a task
before it became the day's lucky pick, then swaps in a new photo on the lucky day itself, hits exactly
the replace-never-banks rule in (b) above — the day is lucky, the task is lucky, but THIS guest's
submission banks nothing, because it isn't their first completion. Keyed off the calendar, that guest
would see a celebration over a total that didn't move. Keyed off the bank (what this function actually
prints below), they see the truth. The one-shot `taskComplete` cookie carries `luckyBonus` as a third,
optional field alongside the pre-existing `points`/`newBadgeIds` pair (`src/middleware/session.js`'s
`setTaskCompleteReward`/`attachGuest`) — `undefined` for an ordinary completion, which `JSON.stringify`
simply omits, so the existing two-key shape guard on the read side needed no code change at all.

**(e) Lucky takes NO `special_mode` member — following #761's flash decision verbatim, for the
identical reason.** SQLite cannot widen a CHECK constraint in place; gaining a `'lucky'` member would
force the exact table rebuild `ensureTaskSpecialDayColumns()`'s own comment documents at length — the
FK-cascade hazard (`submissions.task_id`/`badges.task_id` both `ON DELETE CASCADE`), the #753 guard's
closed-list substring match at `src/db.js`, and, concretely, three existing tests that assert `'lucky'`
is not an accepted `special_mode` (`tests/tasks-normalize.test.js`, `tests/oneday-challenge-migration
.test.js`, `tests/task-worth-mode-migration.test.js`) — all bought for no behavioural gain, since
`tasks.lucky_date` is already the single authoritative "is this task lucky" fact and nothing anywhere
reads `special_mode` to learn it. The Special radio posts `special_mode=lucky`, but
`tasks.normalizeMode` coerces that unrecognized value straight to the handler's own fallback (`'none'`,
or `'hidden'` if the host also hides the task), so the row that lands in the database always stores a
member of the existing three-value enum. What this bought, concretely: `src/db.js`'s
`ensureTaskLuckyColumns()` migration is two plain `ALTER TABLE ADD COLUMN` statements (mirroring
`ensureTaskFlashColumns()` exactly), no `CREATE TABLE tasks_new`, no `foreign_keys` pragma toggle, and
all three of the tests named above stayed green untouched, exactly as this decision predicted.

**(f) The admin popup's "which Special radio is checked" answer is SERVER-derived (`tasks.whatSpecial()`),
not recomputed client-side.** PR review (2026-07-22) caught that `src/public/js/admin-tasks.js`'s
`openEdit()` originally hand-copied the daily rule's `spokenFor` predicate (`isSealed(...) ||
isOnDay(...)`) in the browser, comparing a task's stored `special_date` against a `data-today` attribute
with plain string comparison, to decide whether a stored one-day date should win the Lucky radio over a
stored `lucky_date`. That was a second owner of a rule `src/services/tasks.js`'s `whatSpecial()` already
owns — the same one-ordered-list `SPECIAL_RULES` walk this issue's own "Settled design" section leans on
for exclusivity everywhere else — and it drifts the instant that rule widens: it could not see a live
flash window at all, so once a flash task's day/window becomes host-settable (#763), a task carrying both
a flash window and a stored `lucky_date` would open the popup with the Lucky radio checked when flash
actually owns the row, and a title-only save would repost `special_mode=lucky` straight into the
exclusivity guard's refusal. The fix moves the answer to the server: `GET /admin/tasks` computes one
clock and calls `tasks.whatSpecial(t, clock)` per row (the same call every other exclusivity decision in
this app already makes), emits it as `data-special-kind`, and `admin-tasks.ejs`/`admin-tasks.js` lost the
`data-today` attribute and its client-side date-math entirely. One owner of "which rule owns this task,"
consulted by every caller including the popup, instead of a hand-restatement one file away that can only
ever answer for the ONE rule it was written to know about.

The popup's precedence is a WHITELIST — `storedLuckyDate && (specialKind === '' || specialKind ===
'lucky')` — and that shape is the point, not an implementation detail. The first attempt at this fix
shipped the negative form (`specialKind !== 'daily'`), which named the one kind it knew about and let
every other kind fall through to "check Lucky" — reintroducing the exact flash failure above, and
pre-arming it for every special type added after. A scoped re-check caught it by EXECUTING the script in
jsdom rather than reading it. The whitelist fails safe instead: an unrecognised kind falls back to the
card's own `data-mode` radio, which is always saveable. Both halves of the contract carry
mutation-verified tests — `tests/admin-tasks-script.test.js` cases (i2)/(i3) go red against the negative
form, and `tests/lucky-task.test.js`'s board-contract cases go red if `GET /admin/tasks` stops emitting
`data-special-kind` or the lucky pair. Before those existed, deleting the server field left the entire
suite green.

## Gallery live search: one parameterized wiring serves both grouped views (#527)

**Date:** 2026-07-22. **Status:** accepted, owner-approved live on a seeded preview.

**What changed.** The By-task view's search input now live-filters as the guest types, the same as
By-person already did (issue #251). `src/public/js/gallery.js`'s person-only `applyPersonFilter` /
`wireUpPersonSearch` (issue #251) are generalized into one `applySectionFilter(sections, query, matches,
attribute)` and one `wireUpSectionSearch(inputId, attribute)`, each taking the section attribute (and
input id) as an argument instead of assuming `data-person-section`. A `SEARCHABLE_VIEWS` table plus a
`wireUpGallerySearch()` bootstrap call the one wiring function once per grouped view
(`person-search`/`data-person-section` and `task-search`/`data-task-section`). Adding a third grouped view
needs a row in that table plus three edits in `src/views/gallery.ejs` — the input id, the section's
`data-*` attribute, and the script-include condition; what the table guarantees is that none of them is a
second filter implementation, not that the view is a one-line addition. `wireUpSectionSearch` is a no-op when its
input isn't on the current page, so both calls run unconditionally on every load — the By-person and
By-task views are never rendered together, so this never wires two live filters against one page. This is
the single owner of "does this section's heading match what the guest typed": both call sites reach the
same function, which itself reaches the one injected match rule (`HuntFilter.nameMatchesQuery`, from
`src/public/js/filter.js`) — there is no second, copy-pasted matching implementation anywhere in the
gallery.

**Reversed (#935): the live rule and the no-JS `?q=` fallback now share ONE match rule, not two.** This ADR
originally recorded, and defended, a deliberate divergence: each grouped view's search input submits to a
plain GET `?q=` for guests with JS disabled, and that path was a server-side substring match, unrelated in
shape to the live filter's any-word-prefix rule (`HuntFilter.nameMatchesQuery`, `src/public/js/filter.js`).
The two rules were incomparable, not ordered — `av fe` matched live but not server-side; `ess` matched
server-side but not live — and issue #527's own scope (parity between By-person's and By-task's _live_
behavior only) was cited as the reason folding them together stayed out of scope.

The owner's mobile failure hunt (2026-07-29) hit this divergence as a real guest-facing break, not a
theoretical one: the phone keyboard's Search/Go key is the natural way to "finish" typing in the search
box, and that key submits the GET form — so a guest who watched their match appear live, then pressed
Search, watched it vanish. The owner ordered it filed and fixed. Issue #935 reverses this ADR on that
direction: there is now one rule, one owner. `src/services/feed.js` requires `../public/js/filter` directly
— the same module the client already loads as `/js/filter.js` — and `grouped()`'s `?q=` filter applies
`nameMatchesQuery` to each group's heading instead of a substring test, for both grouped kinds (person and
task). No new module, no copy: the public asset that used to be client-only is now also a server-side
require, and that require is the single owner of "does this text match this query" for `feed.grouped()`'s
`?q=` filter and the live gallery filter. The admin Photos grouped search
(`src/routes/admin/moderation.js`) still applies its own separate substring-match rule and is not covered
by this change — that divergence is known and recorded here, not silently left; issue #1044 tracks
folding it into this same shared rule. A guest who live-filters to a result and presses Enter now lands on
that same result.

## Flash task: HOST surface — sentinel radio, one no-op rule, candidate-selection date math (#763)

**Date:** 2026-07-22. **Status:** accepted; write path + host UI shipped, owner-approved screen
transcribed per the issue's "Approved screen" record.

**(a) `special_mode=flash` is a host-facing SENTINEL the route intercepts, never a stored value —
following #761's read-side decision, extended to the write side it left open.** #761 already settled
that `tasks.js`'s `MODES` stays `[none, hidden, oneday]` forever: a flash reverts to no-special
automatically the instant its window ends, and a stored enum member cannot expire on its own. What #761
did not yet have was a WRITER — this issue is it. The Special radio posts `special_mode=flash` exactly
like it posts `oneday` or `lucky`, so the host sees one "what is special about this task" question with
one answer at a time; `src/routes/admin.js`'s create/edit handlers read that raw value to decide whether
`resolveFlashWrite()` should touch the flash trio at all, then hand the SAME raw value to
`tasks.normalizeMode()`, which — because `'flash'` was never added to `MODES` — falls straight through to
the caller's fallback (the task's current stored mode on edit, `MODE_NONE` on create) as if the host had
never touched the radio. An armed task's `special_mode` column, concretely, is whatever it already was;
only the three flash columns move. This is the same trick #650's lucky radio already plays
(`resolveLuckyPairWrite` reads raw `'lucky'`, `normalizeMode` coerces it away) — flash is the second, not
the first, sentinel value riding this radio, and a third special type can follow the identical shape.

**(b) `resolveFlashWrite()` owns exactly one thing `resolveSpecialPairWrite`/`resolveLuckyPairWrite`
do not need: a no-op rule, because "Now" re-derives on every post.** The one-day and lucky pairs' own
no-op protection is free — comparing a posted day/bonus against the stored pair is enough, because
neither pair carries a "which instant" component that changes just by re-submitting the form. Flash's
`Starts` chip defaults to `Now`, and `Now` is defined as `new Date()` at the moment of the POST (the
issue's own words: "the clock itself, not a calendar conversion") — so a title-only resave of an ALREADY
armed task, with the bonus/duration chips still showing their stored values, would otherwise always read
as "the posted trio differs from stored" (a fresh timestamp never equals an old one) and silently buy the
room a brand-new window. The fix is scoped narrowly, on purpose (the issue's own "load-bearing scope"
callout): a no-op is recognised ONLY on a task whose flash is presently `scheduled` or `active`, ONLY when
`Starts` is `now`, and ONLY when the posted bonus AND minutes both equal what is stored — an EXPIRED
flash is always a real re-arm, because the trio survives expiry by design (nothing writes at expiry) and
the escape hatch this rule leans on (Cancel, then a deliberate re-arm) is unreachable on an expired flash:
the status strip and its Cancel button do not render for one. `not_live` is checked AFTER the no-op
short-circuit, not before — a task the host later hid through the Hidden radio (which never touches the
flash trio) can still be title-edited without the save failing over a liveness question the no-op path
never actually needed answered.

**(c) The general date+time-of-day conversion is its own function, `eventLocalInstant()`, gained via
candidate selection rather than a widened round-trip guard — the issue's own probe caught the guard rule
returning an instant an hour EARLY for a DST-gap wall time in every zone east of UTC.**
`src/services/event-days.js`'s existing two-pass offset correction already computed two candidate instants
(an "uncorrected" and a "corrected" one) to handle a date landing exactly on a transition; extending it to
an arbitrary time-of-day, the new rule takes whichever candidate's OWN local reading matches the request
exactly (covering both the ordinary case and a fall-back-transition AMBIGUOUS wall time, resolved to its
FIRST occurrence by trying candidates in a fixed order), and falls back to the earliest candidate reading
AT OR AFTER the request only when neither matches (a spring-forward GAP swallowed the requested wall
time). `dayOpensAt(dateIso, timezone)` — the two-argument question #753's seal predicate and #754's
daily-challenge rows have always asked — stays a thin wrapper over `eventLocalInstant()` with hour/minute
fixed at `0`/`0`, rather than a second, parallel copy of the algorithm that could drift from it; the two
questions ("when is local midnight" vs. "when is this specific wall-clock moment") are different enough
that sharing one name across a 2-argument and a 4-argument call was its own defect, fixed alongside this
one. `tests/event-days.test.js` runs a same-file regression comparing `dayOpensAt()`'s output against a
locally-defined copy of the pre-#763 two-argument implementation across every zone
`Intl.supportedValuesOf('timeZone')` reports (418 zones on the Node version this was verified against) and
9 transition-adjacent dates (3,762 zone/date pairs): zero differences — the existing two-argument callers
(#753's seal predicate, #754's daily-challenge rows) see no behavioural change at all. A second sweep over
the same 3,762 pairs asserts `eventLocalInstant()` never returns an instant that reads back, in its own
target timezone, before the requested wall time.

**(d) The edit popup's flash panel is server-rendered ONCE, in the "nothing armed" state, and filled per
task by JavaScript — not conditionally included per state.** Every other accordion panel in this dialog
(one-day, lucky) needs no such split: their day/bonus chips are plain radios, cleared and re-checked by
`openEdit()` exactly like the flash bonus/minutes fields here. The flash panel's STATUS STRIP is
different — it is a whole block of markup (`.flash-state-strip`) that either exists or doesn't, and the
edit dialog is the SAME shared `<dialog>` reused for every card, so no single server render can know in
advance which task will be tapped next. Rendering the strip conditionally (the PHASE-1 preview's own
shape) would freeze it at whatever state the LAST page load happened to pass, wrong for every other task
opened without a full reload. The fix renders the strip unconditionally hidden via an INLINE
`style="display:none"` — not the `hidden` attribute plus a matching `theme.css` rule — because the
block's own `.flash-state-strip { display: flex }` rule (an author style) would outrank the browser's
low-priority `[hidden]` UA style exactly the way `theme.css` already documents for `.guest-card[hidden]`
(the live-search hide case), which has to restate the UA rule with `!important` to win that fight. An
inline style needs no such accompanying `theme.css` change to win it, which matters here specifically
because this screen's CSS is part of the owner-approved visual surface recorded in
`.review_state/visual-approval/` — an added rule there drifts the approval hash for a purely mechanical
reason. (That is the visual-approval freeze, not `CLAUDE.md`'s governance freeze, which covers no file
under `src/`; `theme.css` is edited freely by this very change.)
`openEdit()` toggles that same inline style and sets the dot class and sentence from the SAME
server-computed `data-flash-state`/`data-flash-strip-label` attributes the board chip already reads off
`GET /admin/tasks`'s projection — one owner of "what does this task's flash state read as" (the server:
`flashStripLabel` is non-empty exactly when the state is `active` or `scheduled`), and the client keys
its own visibility toggle off that same label being non-empty rather than re-deriving the active/
scheduled test a second time.

## Rank & award: a separate page, one-badge-system consolidation, client-side-only draft state (#661)

**Decision (owner, 2026-07-23, superseding the 2026-07-21 embedded-panel plan).** Ranking a task's photos
and releasing its badge gets its own focused page — `GET/POST /admin/tasks/:id/rank`
(`src/views/admin-badge-rank.ejs`, `src/public/js/admin-badge-rank.js`) — not a panel embedded in the
task-scoped photos gallery (#748). The owner settled the screen and flow live in a phase-1 visual-approval
loop the same day; `src/public/mock-rank.html` was the approved artifact, transcribed here and deleted.
The host taps a task's visible photos to pick 1-to-5 winners in placing order (never a forced five — a
single-winner release is valid), drags them into a ranked list using the SAME technique as the admin
task-card reorder (`src/public/js/admin-tasks.js`: pointer events, `setPointerCapture`, the grabbed row
lifts and follows via `transform`, displaced rows glide via a First-Last-Invert-Play transform), and
releases the badge + 5/4/3/2/1 points in one confirm.

**New component, not a new architectural pattern.** This is a genuinely new page + route + client script,
which is why the architecture lens gates this change per the review dispatch table — but it reuses every
existing seam it can: `task-badges.resolveTaskBadge`/`toTaskBadgeView` for the badge row, the
`.rank-award-*`/`.rank-winner*`/`.rank-medal`/`.rank-handle`/`.rank-controls` CSS already landed in
`theme.css` during the visual loop, and the drag-to-reorder technique verbatim from `admin-tasks.js`
rather than a second implementation of the same gesture.

**No per-drop persistence — the picking/ranking draft lives in the browser until Release.** Unlike the
admin task-card reorder, this page has no endpoint to POST to on every drag drop or every tap. The whole
pick-then-rank sequence is client-side state (`src/public/js/admin-badge-rank.js`) until the host hits
"Release badge & points", which is the one real form submit this screen makes
(`POST /admin/tasks/:id/rank`, body `winners` = a comma-separated, ordered list of submission ids). This
is why `badge_winners` (the give-a-badge picker's own worksheet table, see below) has no replacement
"per-task worksheet" successor: there is nothing left that needs one.

**One-badge-system consolidation: the give-a-badge photo-winner picker is deleted, not repointed.**
`src/services/photo-badges.js` (issue #259's fixed 5-code catalog — SHUTTERBUG/CHOICE/BESTDANCE/GOLDEN/
CROWDFAV — marking a PHOTO as a category winner in `badge_winners`, with no points and no relation to a
guest's `guest_badges`) is removed outright: the file, its `admin-photos.ejs` dialog and trigger buttons,
its CSS (`.admin-badge-dialog`/`-body`/`-picker`/`-choices`/`-ribbon`/`-name`/`-count`/`-buttons`,
`.admin-badge-tilebtn`, `.admin-feed-badge.is-badged`, and the orphaned `.admin-points`/`.admin-point-pill`
group left over from an abandoned earlier #661 attempt), and the `badge_winners` table itself
(`ensureBadgeWinnersTableDropped`, a guarded `DROP TABLE IF EXISTS` for a pre-#661 database; the CREATE
TABLE block no longer declares it at all for a fresh one). The issue's own plan named two options for that
table — "repoint it at task badges, or replace it with a per-task worksheet" — and left the choice to the
implementer: neither. Its one reader/writer is deleted in the same change, and the real ranking screen
needs no worksheet of its own (see above), so keeping or repointing the table would only be a second,
unread source of "who's a candidate winner" behind the one, real award table (`guest_badges`) this
consolidation makes canonical.

**Three `badges` catalog rows die with it, and only three.** `scripts/badge-catalog.js`'s `BADGES` array
drops `SHUTTERBUG`/`CROWDFAV`/`CHOICE` — NOT because they are the give-a-badge codes above (that catalog
was a code constant, never a `badges` table row, per `photo-badges.js`'s own original doc comment), but
because these three happened to ALSO exist as unrelated, independently hand-awardable `type = 'special'`
catalog rows (`POST /admin/guests/:id/badge`) sharing the same display name — a naming collision the
original #259 doc comment flagged as "a different concept" but never resolved. Retiring the give-a-badge
picker is the moment to resolve it: a special badge named "Shutterbug" that no longer describes any real
picker is confusing, not a feature worth keeping. `BESTDANCE`/`GOLDEN`, the OTHER two give-a-badge codes,
were never `badges` catalog rows and need no migration. `db.js`'s guarded
`ensureSpecialBadgeCollisionsRemoved()` (same shape as the pre-existing `ensureRetiredBadgesRemoved` for
MOSTPHOTOS/MOSTLIKED, #711) deletes the three catalog rows and any `guest_badges` rows held on them from an
existing database; `EARLYBIRD` is the one pre-seeded `special` code left. **EARLYBIRD's survival here is
deliberate, not an oversight**: it named no give-a-badge collision (only SHUTTERBUG/CROWDFAV/CHOICE
happened to share a name with that picker's codes), so this issue's own kill scope never touched it —
`POST /admin/guests/:id/badge` still hand-awards it exactly as before (see `tests/admin-badges.test.js`).
The earlier #706 amendment above ("the fixed `special` four ... die with them") describes a broader,
later retirement of hand-awarded special badges entirely that has NOT shipped — #661 is scoped to the
give-a-badge/task-ranking consolidation only, and EARLYBIRD's own eventual retirement (if the #706 plan is
ever carried out) is tracked separately, not silently completed by this change. The drop in
`tests/helpers/event-fixture.js`'s special-badge spread is backfilled with three fixture-local `custom`
rows so that shared fixture keeps awarding a realistic variety of badges without resurrecting a retired
collision code.

**The write path: `guest_badges.rank`, explicit upsert, atomic whole-set replace, same-guest collapse.**
`guest_badges` gains a nullable `rank` column (`ensureGuestBadgeRankColumn`, same guarded-`ALTER TABLE`
shape as every other column this table has grown) — NULL for every award path except a ranked release, so
"does this row carry a rank" is a complete, structural test for "was this a ranked-release award," not a
convention a caller could forget to honor. `task-badges.releaseRanking(taskId, submissionIds)` is the new,
whole-set-atomic write path (`awardTaskBadge`/`removeTaskAward`, #483's original single-photo award/remove
pair, are untouched — kept for their own existing callers/tests, superseded only as the route-facing path):
validates 1-5 entries (amended by #892, see below — 0 is now a deliberate clear-all, not a refusal), no
duplicates, and every id a CURRENTLY VISIBLE submission of THIS task (refusing
the WHOLE release otherwise, never silently dropping one bad entry — a partial write would shift every
following rank/points value out from under the host's on-screen order without telling them); folds
placements onto their guest (`foldRankedPlacements`, pulled out as its own pure function so the same-guest
collapse rule is unit-testable directly); `DELETE`s the badge's whole PRIOR ranked-row set
(`rank IS NOT NULL`) before an explicit `INSERT ... ON CONFLICT DO UPDATE` for the new one — replacing
`awardTaskBadge`'s pre-existing `INSERT OR IGNORE`, which the issue itself called out as unsafe here: it
would silently drop a second guest's award, or a re-rank's changed points/rank/submission, on the same
`(guest_id, badge_id)` pair.

**Same-guest multi-win is real code with no real fixture.** `foldRankedPlacements` sums a same-guest
duplicate's points and pins rank/submission_id to their first-seen placement — which is provably always
their BEST placement, since rank is derived from array position (a strictly increasing function of index)
and the input array's order IS rank order. This can never actually happen through the shipped picking
grid, though: `submissions` carries `UNIQUE(guest_id, task_id)`, so one guest holds at most one visible
submission per task, ever (a resubmit `UPDATE`s that row rather than inserting a second one), and
`releaseRanking` validates every id belongs to the one task being ranked — so two placements can never
resolve to the same guest in production today. The fold rule is implemented and tested anyway
(`tests/task-badge-rank-release.test.js`, against a synthetic input, since no real DB fixture can produce
this state): it is the single place the rule is defined, so a future caller resolving placements from a
wider set inherits it with nothing to keep in sync, rather than a rule that only happens to hold because of
a constraint this function does not itself enforce.

**"Awarded" is a settings-table marker, not a re-derived query.** `task-badges.isTaskBadgeAwarded(taskId)`/
`markTaskBadgeAwarded(taskId)` read/write a `settings` key (`task_badge_awarded.<taskId>`, same
prefixed-key idiom as `host-checklist.js`'s `checklist.<id>` and `lockout.js`), written inside the SAME
transaction that writes the ranked rows — so the marker and the rows it describes can never observably
disagree. This is a duplicated fact by construction (the same "has this badge ever been released" question
is also answerable by `EXISTS (guest_badges WHERE badge_id = ? AND rank IS NOT NULL)`), accepted rather than
collapsed to one query: the issue's own design named the settings marker explicitly as what #662's
checklist item reads, and a flat key read is cheaper there than a join for a row #662 doesn't otherwise
need. `isTaskBadgeAwarded` is the ONE function both this page and #662 call — neither re-derives the
existence check independently.

**Takedown-revert needed no new code.** `scoring.js`'s existing award-points visibility rule already counts
a task-badge award's points only while its earning submission is visible (`taken_down = 0`); AC4 is a
restated guarantee of that pre-existing rule against a ranked award specifically, not a new mechanism —
the award row itself is untouched by a takedown, only its contribution to `getPoints`/`leaderboard` moves.

**The recap event reads rank live, never snapshots it.** `releaseRanking` emits one `badge_granted`
`notifications.recordEvent` per WINNING GUEST — narrowed to NEWLY-winning guests by #889, see
"Double-submit idempotency: possession-keyed release events" below — (not per placement — a same-guest collapse still notifies
once), carrying that guest's pinned `submission_id`. `notifications.js`'s `stmtStoredEvents` gained a `gb`
`LEFT JOIN guest_badges` (keyed on the stored event's own `(guest_id, badge_id)` pair — `UNIQUE(guest_id,
badge_id)` means this can never fan a stored event out into more than one row) so `KIND_VIEW.badge_granted`
can read the guest's CURRENT rank at render time, the same "read live, never duplicate at write time"
discipline `badge_name`/`badge_art_path` already followed on this exact row. A re-rank that changes a
guest's placement therefore also changes what an OLD recap row about that same badge reads on next
render — an accepted consequence of reading live, not a bug: the alternative (a `rank` column on
`notification_events`) would duplicate a fact `guest_badges.rank` already owns for the sole purpose of a
recap snapshot nothing else needs.

**Deferred, not fixed here: two adjacent inconsistencies this change's own retirement work surfaces.**
(1) `src/views/partials/memory-payoff.ejs`'s guest-facing promise — "any photo can win a badge" — was true
under the deleted give-a-badge picker (any photo OR memory, hand-picked by the host) and is no longer true
under ranking (task photos only, one task's own badge, never a memory). Fixing guest-facing copy is a
visual/product-copy decision gated by the live owner-approval loop (`CLAUDE.md`'s pipeline section), not
something this change's `Touches` list authorizes an implementer to silently redecide — flagged for the
owner/orchestrator, not fixed inline. (2) `docs/game-design-points-badges.md` still describes the
pre-2026-07-23 "forced five"/"`badge_winners` survives as a worksheet" shape this ADR's corrections
supersede; a doc-sync pass is a follow-up, not part of this issue's own `Touches`.

## Bug-report lifecycle: additive `status` over a `resolved` rebuild, one count owner (#686)

**Date:** 2026-07-23. **Status:** accepted; shipped.

**(a) `bug_reports.resolved` is retired but not dropped — `status` is a purely additive column plus
a one-time backfill, not a table rebuild.** Every other CHECK-widening migration in `src/db.js`
(`ensureTaskSpecialDayColumns`, `ensureBadgeTypeCheckWidened`, …) rebuilds its table because SQLite
cannot widen a CHECK in place. `bug_reports` has no inbound foreign key from any other table, so none
of the FK-cascade hazard those rebuilds exist to survive applies here — `ensureBugReportStatusColumn()`
instead runs a single `ALTER TABLE … ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN
(…))`, confirmed against this tree's better-sqlite3/SQLite build to accept a CHECK on an added column in
one statement (enforced on every write from that point on, including the migration's own backfill). The
backfill only needs to move the `resolved = 1` half forward (`UPDATE … SET status = 'closed' WHERE
resolved = 1`) — a `resolved = 0` row is already `'open'` from the column's own DEFAULT, so no second
UPDATE is needed for that half. `resolved` itself is left in the table, unread from this point on:
dropping it would cost a rebuild for a column that costs nothing to leave alone once nothing queries it.

**(b) The lifecycle index swap runs unconditionally, outside the column-presence guard, because the
column doesn't exist yet when it would need to.** The top-of-file `CREATE TABLE IF NOT EXISTS` block
runs before any guarded migration, so it cannot unconditionally `CREATE INDEX … ON bug_reports(status,
…)` — that statement would throw `no such column: status` on every pre-#686 database, which by
definition doesn't have the column until the guarded migration below runs. `idx_bug_reports_status`
is instead created (and the retired `idx_bug_reports_resolved` dropped) inside
`ensureBugReportStatusColumn()` itself, every boot, unconditionally (both statements are naturally
idempotent — `DROP INDEX IF EXISTS` / `CREATE INDEX IF NOT EXISTS`) rather than only inside the
column-add branch: a fresh database already has `status` from the `CREATE TABLE` and would otherwise
never get the new index at all, since it never takes the add-column branch.

**(c) One `openBugCount()` owner in `src/db.js`, not two independent `WHERE status = 'open'` counts.**
Before this issue, `src/services/host-checklist.js`'s `buildRows()` ran its own `COUNT(*) … WHERE
resolved = 0` query and reused the local result for both the dashboard stat-grid cell and the "Today"
checklist's bug pin — already one query shared within that function, but the fact itself (what counts as
open) lived nowhere reusable outside it. `openBugCount()` now lives in `src/db.js` next to the schema
that defines `status`, and `host-checklist.js` calls it instead of hand-writing the predicate — so a
future third surface (or a test) asking "how many bugs are open" reads the same answer by construction,
not by two call sites happening to agree today.

**(d) The "Open issue" link stays a plain anchor whose `href` is literally the GitHub prefill URL;
using it also marks the report tracked via a same-origin `sendBeacon` POST, not a route-level
redirect.** The owner-approved screen (settled live 2026-07-23) renders "Open issue" as `<a
target="_blank">` — a link, not a form — because the admin authenticates to GitHub in their own browser
tab and submits there; no token, no server-side GitHub API call. A same-origin GET route that marked the
report tracked and then 302-redirected to GitHub was considered and rejected: it would have made the
rendered `href` an internal path instead of the literal `GITHUB_REPO_URL + /issues/new?...` URL, breaking
AC1's literal requirement and the approved markup's own shape. Instead the anchor keeps its real `href`
and carries an `onclick` that fires `navigator.sendBeacon('/admin/bugs/:id/track')` (falling back to
`fetch(..., {keepalive: true})` on a browser without `sendBeacon`) — a background POST that survives the
click's normal navigation to the new tab, changing no visible markup, class, or structure the owner
approved.

## Crowd favorites: derived not materialized, standard-competition rank, one absorbed ranker (#625)

**Date:** 2026-07-23. **Status:** accepted.

**Why crowd-favorite placements are fully DERIVED — no `guest_badges` row is ever written for one.**
`guest_badges` carries `CONSTRAINT uq_gb UNIQUE (guest_id, badge_id)` (`src/db.js`). Every other badge
this app grants is a single per-guest fact — a guest either holds BLOOM or does not — so one row per
(guest, badge) is the right shape. A crowd-favorite placement is not that shape: issue #625's own no-cap
sweep rule (AC3) lets one guest hold three placing photos at once and collect 5+4+3=12 points, which is
three DISTINCT placements for the SAME guest against the SAME hypothetical badge. [Superseded 2026-07-27
by #896's per-guest dedupe — see "Crowd favorites: per-guest dedupe reverses the no-cap sweep rule
(#896)" below; the derived-not-materialized conclusion still holds, for a different reason — the
placing photo itself changes read-to-read as likes move, so a stored row would go stale; see
`src/services/scoring.js`'s crowd-favorites section comment.]
Materializing that as
`guest_badges` rows would either violate the UNIQUE constraint (one row per guest per badge, no room for
a second placing photo) or force a schema change (a `submission_id` column added to a table three other
badge kinds already write without one). `src/services/scoring.js`'s `crowdFavorites()` sidesteps the
question entirely: it is the ONE function that decides "who is a crowd favorite, at what rank, worth how
much," computed fresh from `submissions`/`likes` on every call, and every reader — `getPoints`,
`leaderboard()`, `feed.slideshowSequence()`'s Most Liked opener, and the two new recap kinds below — reads
that same live answer. Nothing about a crowd-favorite placement can ever go stale, because nothing about
it is ever stored.

**Why crowd favorites uses STANDARD-COMPETITION ranking while the leaderboard (#626) uses DENSE ranking —
two schemes, one module.** Both share the same underlying shape ("walk a sorted list, assign ranks"), so
`src/services/rank.js` (new) is the single home for both as two named, independently tested pure functions
— `denseRank` and `standardRank` — rather than the inline dense-rank block `GET /leaderboard`
(`src/routes/community.js`) used to carry with no second consumer. The two schemes are not
interchangeable: the leaderboard NEVER wants a tie to leave the rank below it empty (dense: `[24,20,20,18]
-> 1,2,2,3`), while crowd favorites specifically WANTS a tie to consume the ranks beneath it (standard-
competition: `[24,20,20,18] -> 1,2,2,4`) — that consumption is what bounds the crowd-favorite paying set
near 5 regardless of party scale. An earlier revision of #625 specified dense ranking for crowd favorites
too; the owner caught the defect live (issue comment, 2026-07-23): dense rank 5 is only the fifth-highest
DISTINCT like count, so at party scale a 60-photo tail all sitting at 1 like would all place — no bound at
all. Standard-competition ranking is the fix: a single tier holding 5+ photos (a big top tie) can still
place more than five, and that is correct — they genuinely tied for most-liked — but nothing below a
placing tier ever pays.

**Why memories compete.** An earlier body of this issue claimed the owner had settled memories OUT of
crowd-favorite eligibility, quoting no artifact that actually recorded it. Re-derived from
`docs/north-star.md` instead (recorded on the issue so it can be overturned by a real decision later): the
anti-flooding worry that motivates excluding memories elsewhere in the economy does not reach this
mechanic — uploading a memory earns nothing on its own, only OTHER guests' hearts place a photo, and
self-likes are already blocked at the route (#712). Excluding memories would mean the best candid of the
weekend — the one nobody was assigned to take — could never be crowned, working against Goals B and D; and
#656 already pays memories a memory-day point, so memories are already inside the points economy. Every
visible photo competes, task-linked or not — `scoring.crowdFavorites()`'s query carries no `task_id`
filter at all.

**Why the crowd term is folded into `getPoints`/`leaderboard()` in JS, after the query runs — the same
shape as the #656 memory-day term.** Standard-competition rank over a live, event-wide like count cannot be
expressed as a per-guest SQL expression without fanning out the query (ranking is inherently a whole-field
computation, not a per-row one). `crowdPointsByGuest()` runs `crowdFavorites()` exactly ONCE — a single
query ranks every liked photo in the whole event — and folds the result into a `Map`; `leaderboard()`
consumes that Map in its existing post-query JS pass (AC8: the leaderboard's crowd term costs exactly one
extra SQL statement, never one per guest row, exactly the guarantee #656's `memoryDayCountsByGuest` already
established for the memory-day term and this issue reuses the pattern for).

**Why the crowd bonus is NOT folded into `scoring.photoPoints()`.** That function's number is what a photo
earned by being SUBMITTED — a stable, banked-feeling value a feed card prints without explanation. A crowd
rank is volatile by design (a later like or takedown can move it on the very next read), so folding it into
the per-photo figure would make a card's number flicker for reasons the card cannot explain. This is a
deliberate exception to #756's "one photo, one number" rule, recorded in `photoPoints`'s own doc comment:
what a crowd-favorite photo earns is stated separately, by #788's crown marker on the photo and by the
guest's grand total (`getPoints`/`leaderboard`), never by this function.

**Why the slideshow's "Most Liked" opener needed a dedicated section builder
(`feed.buildCrowdFavoriteSection`), not a reuse of `buildSlideshowSection`.** Before this issue,
`slideshowSequence()`'s opener was a SECOND, independent ranker — sorted by `like_count` with a points
tiebreak, cut to a positional top 5 via `buildSlideshowSection`, which assigns each photo's rank from its
ARRAY POSITION (`i + 1`). That is correct for a task section (no cap on ties there, since a task's winners
are host-picked, not vote-tied) but wrong for the crowd-favorite opener once ties can share a rank: two
photos tied for a spot must render the IDENTICAL rank label, which a position-based rank can never express.
The venue screen must not crown a photo the standings did not pay — the exact bug the old second ranker
risked, since its likes-first/points-tiebreak sort could disagree with `crowdFavorites()`'s
standard-competition rank the moment two photos' like counts tied. `buildCrowdFavoriteSection` instead reads
each photo's rank straight off `scoring.crowdFavorites()`'s own output (`placing[i].rank`), so the opener,
the standings, and the recap always agree. It is also no longer size-capped: it renders exactly the placing
set (usually ~5 photos, more only under a big top tie) and is omitted entirely when the set is empty,
rather than always showing exactly 5 regardless of how many photos actually have any likes at all.

**Why `notifications.js` requires `./scoring` LAZILY, inside `KIND_VIEW.crowd_favorite.parts()`, not at
module top level.** `scoring.js` already requires `./notifications` at its own top level (the recap's
single write path, `recordEvent`, is how `recomputeBadges` et al. emit badge events). A top-level
`require('./scoring')` added to `notifications.js` would complete the cycle at LOAD time: whichever of the
two modules happened to finish loading first would see the other's `module.exports` still mid-assembly
(missing keys) the moment it destructured from it, and every recap render would throw. Deferring the
require to call time — inside the `parts()` callback, mirroring `feed.js`'s existing deferred
`require('./scoring')` inside `slideshowSequence()` — sidesteps the cycle entirely: by the time any request
renders a `crowd_favorite` recap row, both modules have long since finished loading, and Node's `require()`
cache makes the deferred call free after the first one.

**Why the recap stores only `guest_id` + `submission_id`, never a rank.** `notification_events` needed no
schema change for this issue. A stored rank would be the one fact here that could go stale — a like arriving
after the event was recorded could move the photo's rank again before the guest ever opens their recap.
`KIND_VIEW.crowd_favorite.parts()` reads the CURRENT placing set live from `crowdFavorites()` every time the
row renders, falling back to a rank-free "crowd favorite" line if the guest has since left the placing set
again (a second `crowd_favorite_lost` event, recorded separately at the moment it actually left, is what
tells that part of the story). `crowd_favorite` reuses the existing `gold` recap view; `crowd_favorite_lost`
reuses the existing `loss` view with `dead: true` — no new view-kind glyph or CSS was needed, both were
already wired ahead of their first emitter by issue #644's review.

**Duplicated-ownership note.** The rank-to-points mapping (`CROWD_FAVORITE_POINTS = [5, 4, 3, 2, 1]`) has
exactly one owner, `src/services/scoring.js`; every reader (`getPoints`, `leaderboard`,
`feed.slideshowSequence`, `notifications.js`'s recap copy) reads points off `crowdFavorites()`'s own output
rather than re-deriving the mapping. The standard-competition ranking ALGORITHM itself has exactly one
owner, `src/services/rank.js`'s `standardRank` — `scoring.crowdFavorites()` is its only caller today.

## Crowd favorites: per-guest dedupe reverses the no-cap sweep rule (#896)

**Date:** 2026-07-27. **Status:** accepted.

**What changed.** `crowdFavorites()` (`src/services/scoring.js`) now reduces `stmtVisibleLikeCounts`'s rows
to at most ONE row per `guest_id` — that guest's best (highest `like_count`, then lowest `submission_id`,
the query's own existing tiebreak order) — BEFORE `rank.standardRank` runs, for both tied and distinct
like-counts alike. This reverses #625 AC3's "no-cap sweep" rule entirely: a guest can now hold at most one
of the five paying crowd-favorite slots, no matter how many of their own photos are liked.

**Why the old rule broke.** #625 AC3 deliberately let one guest sweep several placing slots at once — "a
guest sweeping the 3 highest distinct like counts places at ranks 1/2/3 and collects 5+4+3=12 — no cap" —
reasoning that a guest who genuinely earned several well-liked photos should collect for all of them. In
practice this let one guest with many photos (a habitual poster, or one photo re-liked by friends across
many near-duplicates) occupy EVERY crowd-favorite slot: with 20 photos tied at the top like-count, all 20
rank 1, all 20 wear a crown (never gold — `rank1Count > 1` nulls `crownGoldId`, `src/routes/community.js`),
and the guest collects 100 points from a single popularity spike. The owner filed this from the app itself
(`#897`, bug report, 2026-07-26): "Someone can win best pic for 20 of their own tied for first photo." The
mechanic no longer resembles a crowd vote once one guest's own back-catalog can fill every seat; it stops
recognizing DIFFERENT people's best work, which is the whole point of a "crowd favorite."

**Why dedupe-then-rank, not a post-rank cap.** Capping the placing set to N distinct guests AFTER ranking
would still let a guest's second-best photo silently steal the boundary slot from a different guest's only
photo, and would complicate `CROWD_FAVORITE_POINTS[rank - 1]`'s straight index lookup (a capped array no
longer lines up 1:1 with `rank`). Deduping BEFORE ranking sidesteps both: `rank.standardRank` never sees a
guest's second photo at all, so every downstream consumer — `crowdPointsByGuest`, the crown
(`crownRankState`), the slideshow's Most Liked opener, the recap diff (`recordCrowdFavoriteChanges`) —
keeps working unchanged, because the shape of `crowdFavorites()`'s return value did not change, only which
rows can appear in it.

**Why the dedupe stays inside the single AC8 query.** `stmtVisibleLikeCounts` already orders
`like_count DESC, submission_id ASC` for `rank.standardRank`'s own tiebreak needs (#625). That same order
makes "first row seen for a `guest_id`" exactly equal to "that guest's best photo" — a single JS pass over
the rows already fetched, no second SQL statement, no re-sort. AC8 (leaderboard calling `crowdFavorites()`
exactly once, one query regardless of guest count) is unaffected and its test
(`tests/crowd-favorites.test.js`'s AC8 block) passes unmodified.

**Deploy-transition note (accepted, everyone in prod is a tester until the wedding).** Stored
`crowd_favorite` recap rows for photos that dedupe out at deploy remain in guests' recaps in the degraded
rank-free form (`notifications.js`'s `crowd_favorite` fallback), and no `crowd_favorite_lost` fires for them
retroactively — the diff only runs around live mutations. The representative-photo-swap false-pair risk this
note originally flagged is resolved by #895, immediately below.

## Crowd-favorite events: a per-guest placing-status diff, not a per-photo rank diff (#895)

**Date:** 2026-07-27. **Status:** accepted.

**What changed.** `recordCrowdFavoriteChanges()` (`src/services/scoring.js`) diffed the before/after placing
sets keyed by `submission_id`, so ANY rank move on an already-placing photo — even one caused entirely by a
_different_ guest's like shifting the standings, or (after #896) a guest's own representative photo swapping
to a different one of their tied submissions — wrote a fresh `crowd_favorite` row and a fresh unread
increment, for a fact ("you are a crowd favorite") that had not actually changed for that guest. The diff now
keys by `guest_id` instead: a `crowd_favorite` event fires only when a guest's own `guest_id` is absent from
`before` and present in `after` (entry), a `crowd_favorite_lost` event fires only when it is present in
`before` and absent from `after` (exit), and nothing fires while the guest's `guest_id` appears on both sides
— regardless of what their numeric rank did in between. `KIND_VIEW.crowd_favorite.parts()`
(`src/services/notifications.js`) is re-keyed the same way: `stmtStoredEvents` now projects `ne.guest_id`
alongside the columns it already selected, and the live placing lookup at render time matches on
`ev.guest_id` rather than `ev.submission_id`, so a stored event whose recorded photo is no longer the guest's
representative (the #896 swap case) still resolves to that guest's CURRENT rank instead of falling back to
the rank-free "crowd favorite" copy. Nothing about the recap's `href`/thumbnail behavior changed — a stored
event still links to the submission it was recorded against, which was issue #866's separate surface
(since built and merged; see the #866 amendment below).

**Alternative considered — pass the recap owner's `guestId` into `parts()` instead of projecting
`ne.guest_id`.** Rejected: `parts()` renders one stored ROW, and the row's own `guest_id` is the fact the
event was recorded about; threading the page-level `guestId` through every `KIND_VIEW` signature would widen
an interface shared by all stored kinds to serve one kind, and would silently break if a future kind ever
renders another guest's event in someone's recap. Projecting the column keeps the row self-describing.

**Why this loses no information.** The recap card never stores a rank in the first place (see "Why the recap
stores only `guest_id` + `submission_id`, never a rank," above) — `KIND_VIEW.crowd_favorite.parts()` always
read the guest's CURRENT placing state live at render time. Suppressing an event on a rank shuffle or a
representative swap therefore only suppresses a duplicate NOTIFICATION of an unchanged fact; the existing
entry row keeps displaying whatever is true right now.

## Crowd-favorite crown: a render-time marker, never a stored badge (#788)

**Date:** 2026-07-23. **Status:** accepted.

The crown a top-5 photo wears on its tile (`partials/crowd-favorite-mark.ejs`, composing the shared
`partials/crown.ejs`) is read straight off the SAME live `scoring.crowdFavorites()` call the points economy
already reads (see "Crowd favorites: derived not materialized" above) — it is never a `guest_badges` row and
never a `badges` catalog row. `crowdFavorites()` remains the one function that decides "who is a crowd
favorite, at what rank" (its own doc comment); this issue adds no second decider, only three call sites
(`src/routes/community.js`'s GET /gallery, GET /feed, and GET /u/:guestId handlers) that each call it exactly
once per request and hand their view a plain `submission_id -> rank` lookup object built from that one call.
The gallery, feed, and public-profile views render the crown purely from that lookup — none of them re-sorts
or re-counts likes on its own — so a like/unlike/takedown/restore moves the crown on the very next render with
no separate write, the same "nothing is ever stored, so nothing can go stale" property the points term
already has. One partial renders the mark on all three surfaces (gold for rank 1, plain white for ranks 2–5,
`--place-1` the same token the leaderboard podium and slideshow use for "only the winner is gold"), so the
mark cannot drift per page.

## TOPLIKED: the Most Liked crown as a materialized, transferable badge (#817, widened by #821)

**Date:** 2026-07-23. **Status:** accepted. **Amended:** 2026-07-23 (#821) — see below.

`#788` (above) settled the crown as a pure, render-time marker with no `guest_badges` row — deliberately, so a
like/unlike/takedown/restore never leaves a stale badge to clean up. This issue adds a second, additive
representation of the SAME rank 1-5 fact: `TOPLIKED` ("Crowd Favorite"), a `badges.type = 'transferable'`
catalog row (`scripts/badge-catalog.js`) whose holder set is registered in `src/services/badges.js`'s
`TRANSFERABLE_BADGES` as every guest owning any rank 1-5 placing in `scoring.crowdFavorites()`. The two
representations do not compete: the crown stays exactly what #788 built (no code in that path changed), and
`TOPLIKED` is a badge a guest can now see and hold on their profile, beside their name on the leaderboard, and
on its own `/badge/TOPLIKED` page — through the existing shared badge-display partials, with no per-page
display code added. `TOPLIKED` is display-only at 0 points (the transferable-badge engine's existing
`recomputeTransferableBadges()` always grants at `points = 0`, unchanged since issue #709), so it never
double-counts the crowd-favorite points the owner already earns via `crowdPointsByGuest()`.

This is also distinct from the retired `#711` `MOSTLIKED`/`MOSTPHOTOS` pair: those counted a guest's LIFETIME
total likes/photos across the whole event; `TOPLIKED` counts who currently OWNS a top-5 placing (or every tied
co-leader at the boundary, standard-competition ranking, same tie rule `#625` uses for the crown itself) — a
fast-moving, steal-able honor, not a cumulative tally.

**#821 — widened from rank-1-only to every rank 1-5 placing owner.** #817 (above, as originally shipped)
granted `TOPLIKED` only to the strict rank-1 leader (or every tied rank-1 co-leader), while the #788 crown
marks all five placing photos (gold for rank 1, plain white for ranks 2-5) — so a guest holding a silver/bronze
crowned photo saw the crown on their tile but never held the matching badge. #821 widens
`src/services/badges.js`'s `topLikedHolders()` to add every `scoring.crowdFavorites()` placing's `guest_id`
to the holder set, without a rank filter (`crowdFavorites()` itself already truncates its output at rank 5, so
no explicit `<= 5` check is needed in the registry function) — the holder set now matches the crown's
population exactly. The owner separately settled the display name as **"Crowd Favorite"**
(`scripts/badge-catalog.js`'s `name` field) on this issue, since the singular superlative "Most Liked" no
longer fit a badge up to five guests can hold at once; the `code` stays `TOPLIKED` (unchanged, to avoid
`ensureSpecialBadgeCollisionsRemoved()`'s `CROWDFAV` deletion, #661, and `ensureRetiredBadgesRemoved()`'s
`MOSTLIKED` deletion, #711), as does `art_path` and the `/badge/TOPLIKED` URL. No new route, migration, or
recompute call site — same trigger points as #817.

**No new route, migration, or call site.** The transferable-badge engine and its trigger points already
existed and were already wired (the like-toggle in `src/routes/community.js`, `recomputeAfterSubmissionChange`,
and boot in `src/app.js`) — registering one non-empty `TRANSFERABLE_BADGES` entry is what activates that
already-built path; this issue's diff is a catalog row, a registry function, and tests. `ensureBadgeCatalog()`
upserts the new catalog row into both fresh and already-played-in databases on boot, so no migration was
needed.

**Why `src/services/badges.js` requires `./scoring` lazily, inside the registry function, not at module top
level.** `scoring.js` requires `./badges` at ITS OWN top level (to destructure
`METRIC_BADGES`/`TRANSFERABLE_BADGES`), so a top-level `require('./scoring')` added to `badges.js` would
complete a load-order-sensitive cycle: whichever module finished loading first would see the other's
`module.exports` still mid-assembly the moment it destructured from it. Deferring the require to inside
`topLikedHolders()` sidesteps the cycle — mirroring `notifications.js`'s own documented reason for deferring
its `require('./scoring')` to call time inside `KIND_VIEW.crowd_favorite.parts()` (see "Crowd favorites:
derived not materialized," above).

**Left deliberately out of scope: four stale `(registry currently empty, #711)` comment asides.**
`src/app.js`, `src/routes/admin.js`, `src/routes/community.js`, and `src/services/scoring.js` each carry a
parenthetical noting the transferable registry was empty — now stale, since `TOPLIKED` is the first entry.
Fixing all four would be comment-only, but it would expose each whole core route/service file to review for no
functional gain (this repo's review bar judges the whole touched file, not the diff). They are left for a
later low-risk sweep rather than bundled here.

## Bachelor-party second instance: one VARIANT flag, not a fork or a path prefix (#640)

**Date:** 2026-07-23. **Status:** accepted.

The bachelor party ("Stag Master") needed its own game — own standings, own admin backend, own photo pool —
reachable from `lillyandaxel.com/bachelorparty`, styled black-tie instead of garden-pastel, with Lilly's name
scrubbed throughout. Three shapes were on the table: fork the repo into a second codebase; serve it as a path
prefix inside the existing wedding instance; or run a second deployment of the SAME codebase, switched by one
config flag.

**Path prefix was ruled out first, on a concrete fact, not a preference.** The app writes root-absolute links
throughout the views — `href="/…"`, `action="/…"`, 150+ occurrences — so serving a second "instance" under
`lillyandaxel.com/bachelorparty/...` would break every one of them (each would resolve back to the wedding
site's own root). Rewriting every link to be prefix-aware would touch nearly every view in the app for a
feature that exists for one weekend. Two instances on ONE hostname would also collide on cookie names
(`gsid`/`admin` are unscoped by path) — a guest signed into the wedding game and a guest signed into the
bachelor game from the same browser would fight over the same cookie. A path prefix was never a live option
once these two facts were on the table.

**Fork vs. one flag: the fork loses on every axis that matters here.** A fork buys nothing this event needs —
there is no divergent FEATURE set, only a divergent PALETTE, WORDMARK, and BADGE CATALOG, all data/config-
shaped, not behavior-shaped. A fork costs everything a second codebase always costs: every future bug fix
(rate-limit tuning, a HEIC-decode edge case, a moderation fix) now needs porting twice or silently drifts;
two `npm audit` surfaces; two CI pipelines; two places `git blame` has to search. Weighed against a single
`VARIANT` env flag — one boolean-shaped fact threaded through config, `res.locals`, a handful of view
conditionals, and one badge-catalog array swap — the flag is strictly cheaper for a difference this shallow,
and it is REVERSIBLE in a way a fork is not: deleting the flag later (after the bachelor party is over) is a
grep-and-remove; un-forking a diverged codebase is not.

**Config.VARIANT drives three independent things through one flag, deliberately, not three separate flags.**
Palette (`theme.css`'s `[data-theme='stag']` block), branding copy (wordmark, Lilly's name, the brand
ornament), and the milestone badge catalog (`scripts/badge-catalog.js`'s `STAG_BADGES`) all read the SAME
`config.VARIANT === 'stag'` (or, server-side, `res.locals.variant === 'stag'`) test. Three flags
(`THEME=stag`, `BRAND=stag`, `BADGES=stag`) would let an operator accidentally run gold palette with wedding
badge names — a combination nobody asked for and nothing in the design calls for supporting. One flag makes
"stag" atomic: every variant-aware surface moves together or not at all.

**Two instances, one codebase, isolated by `DATA_DIR` alone — no new access-control code.** The bachelor
instance is a second deployment (own `DATA_DIR`/`DB_PATH`/`PORT`/`COOKIE_SECRET`/`BASE_URL`, `docs/deploy.md`
§ Second instance) of the exact same `src/app.js`, not a second code path reachable from the wedding
instance's own process. Admin separation, guest separation, and photo-pool separation all fall out of
`DATA_DIR` separation for free — there is no `WHERE variant = ?` guard anywhere in a query, because there is
no shared database for one to guard. The private join link IS the whitelist (issue #640's own framing): no
per-user access-control code exists or is needed, matching how the wedding instance already onboards guests
(a shared link, not individual invitations enforced server-side).

**AC1's byte-identical default is a testing discipline, not a runtime branch.** Every variant-aware call site
(views, `theme.css`, `scripts/badge-catalog.js`'s `catalogForVariant`) tests the EXACT string `=== 'stag'`,
never truthiness — so a typo'd or unset `VARIANT` behaves exactly like the wedding instance always has,
without a separate "is this a known variant" validation step. `config.VARIANT`'s own default (`''`) and this
exact-match discipline are the only two places this guarantee is enforced; every other file just inherits it
by following the same test.

**Badge art: additive files under `src/public/badges/stag/`, never an in-place recolor.** The phase-1 live-
preview loop (owner-approved 2026-07-23) initially recolored the wedding SVGs in place to iterate quickly;
that was reverted before this issue shipped, because AC4 requires the wedding instance's badge files to stay
byte-unchanged. The gold-on-dark set lives as SEPARATE files mirroring the wedding structure
(`src/public/badges/stag/icons/*.svg`, `src/public/badges/stag/*.svg`) — a stag catalog entry's `art_path`
points at its own file; nothing under the wedding path is ever touched. Only the badges the stag catalog
actually references got a stag copy (the three milestone icons, `earlybird`, `most-liked`, `default-ribbon`)
— the admin custom-badge icon picker (`src/services/badge-icons.js`'s `listIcons`/`resolveIconPath`) stays
wedding-icon-only; no acceptance criterion asks the stag admin to pick from a gold-recolored ~200-icon set,
and recoloring the full set for a picker nobody's shown wanting would be scope with no AC behind it.

**No 15-task tier, no `src/services/scoring.js` change.** The bachelor event runs 10 challenges, so the stag
catalog (`scripts/badge-catalog.js`'s `STAG_BADGES`) has no `GARDEN` entry at all. `scoring.js`'s
`BADGE_THRESHOLDS` still lists `GARDEN` at `n=15` — that array is shared across both variants, not
variant-aware — but `recomputeBadges`' existing `if (!badge) continue` guard (added for an unrelated reason:
tolerating a fresh, not-yet-seeded catalog) already skips a threshold whose `badges` row is absent. The
missing `GARDEN` row on a stag boot is therefore safe by an EXISTING guard, not a new one — one array reused
by two catalogs is simpler than teaching `scoring.js` which variant it is running under.

## Bundled badge-icon glyphs: a theme-driven CSS mask, not a second vendored icon set (#869)

**Date:** 2026-07-24. **Status:** accepted.

#640 shipped a gold recolor for the three stag milestone badges only, as pre-baked vendored SVGs under
`src/public/badges/stag/icons/`. Every other pickable badge icon — the ~349-entry catalog `src/services/
badge-icons.js` serves from `src/public/badges/icons/` — still rendered as an `<img src="…">` with the fill
baked into the file at `#467058` (wedding green-700). An `<img>`'s pixel data cannot be recolored by CSS, so
the stag instance leaked wedding green into the task card, the admin task board, and the badge picker grid —
every surface that renders a custom (picker-chosen) badge.

**Two shapes were on the table: vendor a second gold-recolored ~200-file icon set (mirroring how #640 handled
the three milestone icons), or make the existing set recolorable in place.** The first was rejected. It is the
same duplication #640's own ADR (above) already ruled out for the app as a whole, reintroduced at the file
level instead of the codebase level: every future icon added to the picker catalog would need a second,
hand-recolored gold twin, and the two sets would drift the moment someone updated one file and forgot the
other. Nothing about the difference between green and gold icons is behavior-shaped or even artwork-shaped —
it is one fill color — so paying a per-file vendoring cost for it fails the same test #640 already applied to
a whole second codebase.

**Chosen: recolor via a CSS mask, driven by one theme variable.** The bundled icon SVG becomes an element's
`mask-image` (via a per-render `--icon-src` custom property) instead of an `<img>` payload, and the fill comes
from `--badge-icon-color` — `var(--green-700)` in `:root`, `var(--gold)` under `[data-theme='stag']`
(`src/public/css/theme.css`). `src/views/partials/badge-art.ejs` and `badge-picker.ejs` swap their icon `<img>`
for a `<span class="badge-medallion-icon">` / `<span class="badge-picker-glyph">` carrying that property. The
former `<img alt="">` did double duty as both the accessible name AND (when empty) an implicit "decorative,
skip me" signal to assistive tech; a bare `role="img"` + `aria-label=""` does not get that same auto-demotion,
so the icon branch (PR review fix) branches explicitly on whether the resolved alt is empty: non-empty gets
`role="img"` + `aria-label`, empty gets `aria-hidden="true"` and neither attribute — mirroring the two shapes
the retired `<img alt="">` gave for free. One variable now owns icon color for every surface that renders one;
the ~200 wedding SVG files stay byte-unchanged, matching #640's AC4 discipline of never touching the wedding
art in place, and there is no second icon set to keep in sync going forward. The mask technique itself is not
new here — `theme.css`'s `.gallery-search::before` magnifying-glass icon already recolors an inline SVG the
same way — this issue is that pattern's second call site, not a new one.

**Scope: the pickable custom-icon set only.** A composed/system badge (its own multi-color circle SVG, e.g.
the default ribbon) never went through the icon-glyph branch of `badge-art.ejs` and still does not; the stag
milestone medallions keep their existing #640 gold vendored art untouched (masking an SVG that is already gold
is still gold, so their look is unaffected either way).

**Tradeoff, recorded honestly (PR review):** a `mask-image` that fails to load (a moved/deleted/typo'd icon
file) renders as fully transparent — nothing at all, just the empty ring — where the old `<img>` would have
shown a visible broken-image glyph in the same spot. A missing icon file now fails silently instead of
visibly. Not engineered around here: the ~349-file catalog is checked against disk at require() time
(`badge-icons.js` throws at boot on any catalog/file drift), so the realistic way to hit this is a file
deleted or renamed on disk post-boot without a matching code change — an operational mistake outside this
issue's scope, not a runtime input this feature needs to defend against.

## Guest self-delete attribution: one visibility flag plus one attribution column (#886)

**Date:** 2026-07-24. **Status:** accepted.

`submissions.taken_down` recorded THAT a photo was hidden but not WHO hid it, so a guest's own Delete
(`POST /p/:submissionId/delete`) and a host's takedown (`POST /admin/photos/:id/takedown`) wrote the
identical row shape. #190's sticky-takedown rule then treated a guest's own delete exactly like a host's —
correctly refusing to let a resubmit silently reverse it, but for an actor #190 was never written to guard
against. The consequence: a guest who deleted their own photo and re-uploaded landed on the host's
"Re-review a resubmitted photo" checklist for a decision the host never needed to make, and the guest's own
task page kept promising a host review that would never happen.

**Chosen: keep `taken_down` as the single visibility fact, and add one attribution column,
`taken_down_by TEXT CHECK (... IN ('admin','guest'))`.** This mirrors `guest_badges.awarded_by`
(`src/db.js:162`, `CHECK (awarded_by IN ('system','admin'))`) — an existing precedent in this codebase for
"a flag says THAT something happened; a sibling column says WHO did it," rather than inventing a new shape.
The alternative on the table — two independent boolean flags (`taken_down_by_host` /
`taken_down_by_guest`) — was rejected: it can represent an incoherent state (both true, or a hidden row with
neither true) that the CHECK-constrained single column cannot, and every read site would need to decide
which flag wins when both are set, a question a single attribution value never poses.

**Why a `NULL` attribution reads as a host takedown, never a guest one.** Every gate this issue adds is
written as "is `taken_down_by` `'guest'`?", never as "is it `'admin'`?" — the single most important choice in
this design. A legacy row (this issue's own migration backfills every pre-existing hidden row to `'admin'`,
never derives `'guest'` for one), and any hidden row a future write path adds without setting this column,
therefore default to STICKY, #190's original protection, rather than silently losing moderation the moment
someone forgets to attribute a takedown. The unsafe direction — treating `NULL` as `'guest'` by writing every
gate as "is it NOT `'admin'`?" — would flip that default the wrong way: a bug or omission would silently
grant self-restore instead of silently preserving host moderation. `tests/rewards.test.js:314-330` raw-UPDATEs
an existing row to `taken_down = 1` with no attribution, and `tests/oneday-guest-surface.test.js:587-597`
raw-INSERTs one the same unattributed way — both assert it stays sticky, and this issue leaves both green,
unedited, as the binding regression check for this direction.

**Why a host takedown wins when both actors hide the same row (AC4).** If a guest calls Delete on a photo the
host already took down, the row stays attributed to `'admin'` — the guest's delete becomes a no-op on an
already-hidden row rather than overwriting the attribution to `'guest'`. Without this guard a guest could
"launder" a host's moderation decision into their own self-delete, silently converting a sticky takedown into
a non-sticky one and recovering the exact resubmit-reverses-a-takedown hole #190 closed. Host precedence is
therefore not a tie-break convenience; it is the property that keeps `'guest'` a value only the codebase can
assert honestly (this row really was hidden by nothing but the owning guest's own choice), never a value a
guest can talk their way into.

**The cross-service seam this issue introduces: `submissions.js` calling into `photos.js`'s moderation
writer.** A guest-attributed replace must bring the row back visible, but `submissions.js` is not allowed to
write `taken_down` itself — `photos.js` documents itself as the SINGLE writer of that column for moderation,
because its own `_setTakenDownAndRecount` snapshots `scoring.crowdFavorites()` before the flip and emits
`scoring.recordCrowdFavoriteChanges(beforeCrowd)` after it, in the same transaction. A raw `UPDATE submissions
SET taken_down = 0` from `submissions.js` would silently skip that emission: a guest who deletes and
re-uploads a top-liked photo keeps the same row id, so its likes survive and it can retake the top rank, but
neither that guest's regain nor a displaced guest's loss would ever be written to the recap. So
`submissions.js` calls `photos.restoreSubmission()` — the existing single-writer seam — instead. The ordering
constraint this creates (PR review fix, MAJOR A): `restoreSubmission` must run AFTER the replace's own
transaction (`replaceAndBank`) has committed, not nested inside it, because `restoreSubmission` reaches
`scoring.recomputeAfterSubmissionChange` unguarded — a throw there used to roll back the whole nested
transaction, and the outer catch around `replaceAndBank` then deleted the guest's newly-written original and
thumbnail from disk. The call now runs at the call site, wrapped in the same log-and-swallow shape the
ordinary per-submit recompute already used: a badge-recount failure costs the guest only the un-hide (the row
stays visibly taken down, recoverable by a host from `/admin/photos`), never the photo they just replaced.

**Why guest self-restore was deliberately not built.** The owner's approved design (live preview, 2026-07-24)
is "delete means delete" from the guest's side: no undo control, no notice that a host reviewed anything,
because none did. A guest recovers the ordinary way — upload again — which the guest-attributed replace path
now honors by coming back visible immediately (no pending review), and a host can still restore the original
from `/admin/photos` if the guest wants the exact original file back. Building a guest-facing restore control
would also have reintroduced a version of the very confusion this issue closes: a guest deciding whether to
"restore" a photo they just chose to remove is a control with no clear affordance value once the delete
already reads as final.

**Why `guestCleanSlateReplace` is a boolean beside `status`, not a fourth status value (recorded deviation,
design-philosophy review).** `submitPhoto`'s `status` union already encodes replace variants
(`'replaced'` / `'replaced_hidden'`), so the consistent-looking move was a `'replaced_clean_slate'` member.
Deliberately not done: `status` is consumed by gates that mean "did the replace's DB write land"
(the lucky-bonus gate, the route's error branches), and a clean-slate replace IS an ordinary `'replaced'`
at that layer — same write, same banking rule, same failure handling. The clean-slate fact is a
presentation-only overlay (which flash/success card the guest sees on redirect), and it can be true while
the un-hide itself failed-and-was-swallowed, a combination a single enum value cannot represent without
every status consumer learning the new member. The cost accepted with the boolean: a consumer branching on
`status` alone treats a clean-slate replace as a plain replace — which is exactly the safe default for
every current consumer.

**Known, accepted gap: `/admin/photos` cannot tell the two takedown reasons apart.** The admin photos grid
(`src/views/admin-photos.ejs:99,248,297`) renders every `taken_down = 1` row identically — the same "Taken
down" tile state and the same Restore control, regardless of `taken_down_by`. A host can therefore Restore a
photo a guest deliberately removed, without any visual cue that it was the guest's own choice rather than the
host's earlier moderation call. That view is deliberately not on this issue's `Touches` list — the fix is a
guest-visibility differentiation the AC set never asked for — and the failure mode is recoverable (the guest
can simply delete it again), so this ships as a named, deferred gap rather than a silent one.

## Double-submit idempotency: possession-keyed release events, a 30-second bug-report window (#889)

**Date:** 2026-07-27. **Status:** accepted.

Two spamming reports from the owner traced to the same shape of bug: a button click that fires more than
once (double-tap, a slow response re-tapped, a browser resubmit-on-refresh) had no server-side floor, so
each extra POST produced its own extra side effect — a second `bug_reports` row, or a second `badge_granted`
recap event and a re-opened celebration dialog for a badge the guest already had. `releaseRanking`
(`src/services/task-badges.js`) was already idempotent on WHICH `guest_badges` rows exist (the delete-then-
upsert #661 already built), but not on the two things layered on top of that write: the recap event, and the
`celebrated_at` stamp the delete silently wiped and the upsert never restored.

**Release & Award: keyed on ranked possession, not on the POST.** `releaseRanking` now reads the badge's
existing `rank IS NOT NULL` holders (guest_id -> celebrated_at) before the delete that #661 already runs,
mirroring `scoring.js`'s `awardSpecialBadge` — an `INSERT OR IGNORE`-gated event on a real state
change, not a per-call one. A winner who was already in that captured set (the same guest re-released,
whether at an identical rank or a changed one) gets their prior `celebrated_at` written back after the
upsert and no event; a winner NOT in that set — genuinely new to the badge — gets the normal grant: one
event, `celebrated_at` left NULL. A double-clicked or re-posted release now produces at most one recap row
and one celebration per guest, no matter how many times the identical (or a re-ranked) winner list is
POSTed. This is possession-keyed on purpose, not POST-keyed: re-releasing the SAME winner list twice and
re-releasing a CHANGED list that still contains that winner both count as "already held it" — a rank or
points change alone is not a new grant, since the recap renders rank live off the current row
(`notifications.js`'s own `KIND_VIEW.badge_granted`) and would otherwise read as duplicate, byte-identical
noise.

**`/bug-report`: a 30-second same-guest, same-stored-body window.** The existing `socialRateLimiter` throttles
abuse volume; it does nothing about one guest's own accidental double-tap landing as two rows with identical
text seconds apart (the owner's own report reproduced exactly this). `POST /bug-report` now checks, before
the INSERT, for a `bug_reports` row from the same guest whose STORED body (the same trimmed + truncated-to-
`BUG_REPORT_BODY_MAX` string the INSERT itself writes) matches and was created within the last 30 seconds
(`created_at >= datetime('now', '-N seconds')` with the window bound as a parameter, compared directly against the column's own `datetime('now')`
storage shape — no JS-side clock parsing needed). A match skips the INSERT and returns the identical success
response, so a spammed button reads as one filed report, not several. The window is a resubmit guard, not a
report cap: a distinct body, a different guest, or the same wording filed again minutes later all record
normally — 30 seconds covers a double-tap or a refresh-resubmit without suppressing a deliberate repeat
report.

**Deliberately not in scope.** `notification_events` rows already duplicated by PRE-#889 double-clicks are
left as-is — stored events are permanent by design (`notifications.js`'s own doc comment) and every guest in
prod today is a disposable tester (the wedding is 2026-08-07). Client-side button-disable guards that would
stop the extra POSTs from firing at all are `#898`, tracked separately as the visual half of this fix.

## Amendment: a never-celebrated `badge_granted` event is retracted, not permanent (#894)

**Date:** 2026-07-28. **Status:** shipped.

The #644 ADR above states stored `notification_events` rows are permanent — no emitter has ever deleted
one, and #889's own "deliberately not in scope" note above just leaned on that same permanence to justify
leaving pre-#889 duplicate rows in place. #894 narrows that rule for exactly one case: a transferable
badge's `badge_granted` event whose grant the guest never actually saw celebrated.

`recomputeTransferableBadges()` (`src/services/scoring.js`) revokes and re-grants a transferable badge
(e.g. TOPLIKED) as a pure side effect of ANY guest's like/unlike moving the standings — a guest sitting at
the rank-5 boundary can flap out and back in from someone else's action alone, with no visit to the site
of their own. Before #894, every re-grant wrote a second, permanent `badge_granted` event, and
`render-locals.js`'s `resolveBadgeMoment` treats any `guest_badges` row with `celebrated_at IS NULL` and a
matching event as owed — so a flapped-back-in guest saw the #255 celebration dialog again on their very
next render, indefinitely, as standings kept wobbling (the guest-reported bug: "it isn't one after another
it's every time the page reloads").

**The permanent event log becomes an accurate "this grant was announced" memory, in both directions:**

- **Re-grant of an announced badge is silent.** If a `badge_granted` event already exists for
  (guest, badge), the restored row is inserted with `celebrated_at` already set (`stmtGrantBadge`'s
  `alreadyAnnounced` flag) and no second event is written. The guest was already told once; a flap is not news.
- **A never-announced grant that un-happens is fully retracted.** When a revoke removes a row whose
  `celebrated_at` is still `NULL` — the guest never rendered a page between the grant and the revoke —
  its `badge_granted` event is deleted with it (`notifications.retractGrantAnnouncement`). Without this, a
  flap interleaving between grant and the guest's first render would leave a stale event on file, make a
  later GENUINE re-grant look already-announced, and silently swallow the guest's first-ever celebration
  of that badge. `notification_events` has no uniqueness constraint, so this deletes every matching row
  for the pair, not just one — a pre-existing flap could have left more than one behind.

**Accepted, not engineered around:** a guest may briefly have seen the row in the recap strip before it
vanishes (the row existed for the seconds between grant and revoke) — the flap window is short and the
alternative (leaving the stale event standing) loses a real first celebration, which is the worse
failure. `badge_revoked` emission is unchanged by this issue — its own event-spam and recap-copy
questions on flap-out predate #894 and stay parked on `#588`. `recomputeBadges()` (the per-guest
auto/metric path) is untouched: this amendment applies only to `recomputeTransferableBadges()`'s
grant/revoke pair, since only a transferable badge's holder set is subject to this outside-driven flap.

## Amendment: a taken-down submission never leaves a dead link or broken thumb (#866)

**Date:** 2026-07-30. **Status:** shipped.

The #644 ADR above states stored `notification_events` rows are permanent, and `stmtStoredEvents`
(`src/services/notifications.js`) has never filtered on the joined submission's visibility — unlike the
DERIVED comment/like sources beside it, which compose `feed.VISIBLE_WHERE`. So a submission taken down
(by a host, or by the guest themself) after its stored event was written left that row's `/p/<id>` link
permanently 404ing and its thumbnail permanently broken, for as long as the row exists — which, per the
permanence rule above, is forever.

**Why not filter the row out.** `EVENT_EXISTENCE_WHERE` (`ne.guest_id = ?`) is shared, unmodified, between
`stmtStoredEvents` (the list) and `stmtUnreadEventCount` (the chip) — the source-registry pattern the
#644 ADR's own review established, so the two can never disagree about which rows exist. Appending a
visibility predicate to that shared constant would either throw "no such column" at
`stmtUnreadEventCount`'s own `db.prepare()` time (that statement has no `submissions` join to hang the
predicate off), or — filtering only the list's own query instead — make the chip count rows the list never
renders. Marking a row dead touches neither statement's WHERE, so the invariant holds structurally rather
than by convention.

**Three outcomes, not one, because "taken down" doesn't mean the same thing for every stored kind:**

- **`badge_granted`:** the guest still holds the badge — `recomputeAfterSubmissionChange` runs only the
  auto/metric and transferable passes on a takedown; `releaseRanking`'s ranked award is never re-run, so a
  takedown cannot revoke it. Only `href`/`thumb` go null; the row stays the celebration-replay button
  (badge data and `badgeArtHtml` untouched).
- **`crowd_favorite` whose guest still places:** `crowd_favorite` is a per-guest fact, not a per-photo one
  (`scoring.crowdFavorites()` dedupes to one row per guest, their single best photo — #896). Taking down
  the ONE photo a stored event happened to name does not necessarily end the guest's placement; if
  `crowdFavorites()` still lists them, the row re-points `href`/`thumb` at their CURRENT representative
  photo instead of demoting a placement they still hold. The representative's thumbnail is a second,
  narrow lookup (`stmtSubmissionThumb`, keyed on the survivor's own `submission_id`) since
  `crowdFavorites()`'s return shape carries no `thumb_path`.
- **Everything else** (every other submission-bearing kind, and a `crowd_favorite` whose guest no longer
  places): `dead: true`, `href`/`thumb` null, `kind: 'loss'` — the identical composite already shipped and
  approved for `crowd_favorite_lost`/`badge_removed`, so no new CSS or view branch is needed.

**Keyed solely on `submission_taken_down`** (`s.taken_down`, newly joined into `stmtStoredEvents`), never
re-checking `submission_id != null` alongside it: a stored event's `submission_id` is either null or points
at a live row (`ON DELETE CASCADE` on `notification_events.submission_id`, `src/db.js`), so
`submission_taken_down` is already falsy for every event with no submission at all — a separate
"missing join" branch would be unreachable and untestable.

**`scoring.crowdFavorites()` is resolved at most once per `storedRows()` call**, memoized rather than
re-run per row — it used to be called once per `crowd_favorite` row inside that kind's own `parts()`
closure; that closure now takes the memoized accessor instead of calling scoring itself, and the takedown
re-point branch shares the same memoized result. `storedRows()` runs on every guest recap render, so this
was worth hoisting rather than adding a second per-row full scan.

**Deliberately left alone, not missed:** a muted `crowd_favorite` row (the no-longer-placing case) keeps
its present-tense copy beside the `crowd_favorite_lost` row the same takedown mints — read together they
read as history; a richer treatment is a taste call for the owner to raise at a preview, not decided here.
The two #783 restore kinds (`photo_restore`, `comment_restored`) would, under the generic `loss` branch,
render "back up" copy in muted loss styling if their submission is taken down again after a restore —
copy contradicting treatment. Accepted for now: no route emits these yet (`recordEvent` is a public
export; tests reach them through it), and #783 is the right place to pick those kinds' own takedown
treatment.

The takedown code itself needs no defensive branch to cover that gap in the meantime, either: each kind's
`takenDown` (`KIND_VIEW.photo_restore`/`comment_restored`'s is the shared `LOSS`) runs unconditionally
whenever `storedRows()` reads `submission_taken_down` true, in that same synchronous read — the identical
same-turn/CASCADE discipline the missing-join omission above already relies on, not a second guarantee
argued separately.

## Badge icon search tags: a public client-side data file, not server-rendered attributes (#903)

The admin badge-icon picker's search box (`src/public/js/badge-picker.js`, part of #410) matched only an
icon's display name — a host had to already know the catalog called it "Rough Morning" rather than typing
the word that actually came to mind ("hangover"). Fixing that needed a much richer set of search words per
icon (15+ synonyms/categories/related terms) than the one-line `name` the catalog (`src/services/
badge-icons.js`) already carries.

That tag data lives in its own bundled script, `src/public/js/badge-icon-tags.js` — `window.BadgeIconTags`,
a plain id-to-tag-array map, loaded before `badge-picker.js` in `src/views/admin-tasks.ejs` (the same
data-before-consumer script ordering the file already documents for `badge-icon-mask.js`). Two alternatives
were passed over: server-rendering the tags into a `data-tags` attribute per grid cell would repeat the whole
tag corpus once per admin page load for no benefit (the tags never change per-request and add nothing a
static asset can't serve, cached, instead); and exporting the map from `badge-icons.js` itself would hand a
server-only module a client-search concern it has no other reason to know about. Keeping it a separate
public data file means the search stays entirely client-side (`applyFilter` matches the query as a substring
of a per-cell `data-search` string built once at init from name + tags), and one shared map keeps every
grid cell's own HTML lean — no per-cell tag markup to render or diff.

The catalog and the tag map are two independently-edited artifacts describing the same id set, so nothing
stops them drifting apart (a new catalog icon shipped with no tags, a renamed id left orphaned in the tag
map, a hand-typed tag that isn't actually lowercase). `tests/badge-icon-tags.test.js` is the drift guard:
it evaluates the real data file's source with `new Function('window', src)` (no jsdom needed — the file has
no other DOM dependency) and asserts its key set matches `badge-icons.js`'s `listIcons()` exactly, every
entry carries at least 15 well-formed tags, and every word of every display name shows up in that icon's own
tags — binding the two files together the same way a foreign key would, without either module importing the
other.

**Deliberately not in scope.** The data file (~106 KB at #903 merge time; it grows with the catalog) loads on every `/admin/tasks` view
with no lazy-load; this is a one-host admin page, not a hundred-guest surface, so the payload cost of
loading it whole is accepted rather than engineered around. (It is, however, compressed like every other
response since #1012 — 115,455 B → 26,435 B, 77% smaller on the wire at the brotli quality 6 this app
actually serves — so the un-lazy-loaded weight this paragraph accepts is post-compression, not the raw
figure above.) The tag map has no guest-facing consumer.

## Badge queue: the #644 render-time drip becomes a client-driven continue-through celebration (#902)

**Date:** 2026-07-28. **Status:** shipped.

**The problem the guest actually reported.** #894's guest report read "when I get a badge it isn't
one after another it's every time the page reloads" — the #644 drip design working exactly as built:
`resolveBadgeMoment` paid ONE owed badge per render and left the rest genuinely owed, so a guest who
crossed several thresholds at once (or was awarded a badge by a host while mid-session) saw them
trickle out across unrelated page loads over the following minutes, not as one connected win. #894
fixed a different bug in the same neighborhood (a transferable-badge flap replaying an
already-celebrated badge); this issue is the owner's confirmed follow-up on the drip itself.

**The queue replaces the drip; the stamp-at-render contract for the HEAD badge does not change.**
`resolveBadgeMoment` (`src/services/render-locals.js`) still resolves and stamps exactly one badge —
the same highest-priority owed badge #714's `compareBadgeMoment` would have picked before this issue —
at the same moment it always did (render time, never from `attachGuest`, for the same #563-recreation
reason the #644 ADR above already gives). What changes is everything AFTER that: instead of leaving the
rest of the owed set untouched for a later, unrelated render to pick up one at a time, this issue
resolves and orders the WHOLE owed set up front (`scoring.rankBadgeCandidates`, see below) and exposes
positions 2..K as a `badgeQueue` render local. The dialog (`src/views/partials/header.ejs`,
`src/public/js/badge-moment.js`) drives the rest client-side, in one sitting: "Continue — N more"
advances in place (title/description/art swap, the bloom animation replays) until the last badge reads
"Done" and closes.

**The stamp for a QUEUED badge moves from render-time to a client POST, because "resolved" and "shown"
are no longer the same instant.** Under the drip, resolving a badge and showing it were the same
event — a render either surfaced the celebration or it didn't, so stamping at resolve time was
equivalent to stamping at shown time. Once the whole queue resolves at ONE render but its members are
shown one Continue tap at a time, possibly seconds or minutes apart (or never, if the guest abandons the
page), stamping the whole queue at resolve time would celebrate-and-forget badges the guest never
actually looked at. `POST /badge-moment/celebrated` (`src/routes/guest.js`) is the new stamp site for
positions 2..K: `src/public/js/badge-moment.js` calls it once per badge, at the exact moment a Continue
tap reveals it — never before, and (matching `POST /recap/seen`'s existing fire-and-forget posture) never
retried on failure. The guard against a double-tap, a replayed request, or a badge code naming someone
else's badge (or one already shown) is the safety net, not the client's good behavior — see
`markBadgeCelebrated` below for where that guard actually lives. A guest who navigates away or closes the
tab mid-queue therefore leaves every unshown badge exactly as owed as it was before this issue's
render — it re-offers itself, correctly ordered, on the guest's next page load.

**`markBadgeCelebrated` — one owner of the stamp AND the "owed" predicate it must never contradict (PR
review, major finding 3).** The original cut of this route hand-wrote its own `UPDATE ... WHERE guest_id
= ? AND celebrated_at IS NULL AND badge_id = (SELECT id FROM badges WHERE code = ?)` directly in
`src/routes/guest.js` — a SECOND, narrower definition of "owed" than `render-locals.js`'s `stmtOwedBadges`
(the query `resolveBadgeMoment` above actually auto-opens from), missing that query's `EXISTS` half
entirely (a matching `notification_events` `badge_granted` row — the #644 guard that keeps a
hand-inserted test fixture, which bypasses `scoring.js`'s real grant paths, from ever auto-opening). Two
independent "what counts as owed" queries meant a fixture row invisible to the auto-open query could still
be stamped through the route — route-layer SQL quietly deciding a service-owned question a second way.
`render-locals.js` now exports `markBadgeCelebrated(guestId, code)`: one module-scope prepared UPDATE
carrying the identical predicate shape as `stmtOwedBadges` (`celebrated_at IS NULL` AND the same
correlated `EXISTS` against `notification_events`), returning a boolean. The route's own SQL is gone
entirely; it just maps `true`/`false` to `204`/`404`, keeping its `400`-on-missing-code, rate limiter, and
status codes unchanged.

**`window.paintBadge` — one client-side painter for the `.badge-title`/`.badge-sub`/`.badge-sway` DOM
contract (PR review, major finding 2).** The original cut hand-wrote the identical three-field swap
independently in THREE places: `header.ejs`'s server render (the first paint), `recap.js`'s own
`openBadgeDialog` (replay), and `badge-moment.js`'s `showQueued` (queue advance) — three places that had
to agree on which selector holds which field, with nothing enforcing it. `header.ejs`'s server render
stays as-is (it is the one SERVER-side owner, before any script has run); `src/public/js/recap.js` now
defines the one CLIENT-side owner, `paintBadge(dialog, {name, description, artHtml})`, exposed as
`window.paintBadge` — the same plain-global convention `src/public/js/csrf.js`'s `window.csrfHeader`
already uses — and both `recap.js`'s `openBadgeDialog` and `badge-moment.js`'s `showQueued` call it rather
than repainting the three fields by hand. `recap.js` is the right home: it loads on every guest page,
unconditionally, before any click can happen, while `badge-moment.js` only loads when a celebration is
owed this render — so `recap.js` is guaranteed to have already defined `window.paintBadge` by the time
either script's Continue handler actually runs, even though `header.ejs` loads `badge-moment.js`'s
`<script>` tag first (`defer` only guarantees execution order between the two files, not that a LATER
click waits for anything — and it doesn't need to).

**`rankBadgeCandidates` — one filter+sort owner shared by the single-winner and whole-queue callers.**
Building the ordered queue needs the same two steps #714's `primaryNewBadge` already performed (filter
the guest's held-badge set, which alone carries the `type`/`threshold` the comparator ranks on, down to
a candidate code set, then sort by `compareBadgeMoment`) — `primaryNewBadge` just discarded every row
past the winner. Duplicating that filter+sort a second time in `render-locals.js` to get the whole list
would have left two independent copies of one ranking rule. `scoring.rankBadgeCandidates(guestId, codes)`
is now the single owner of that step, and `resolveBadgeMoment` calls it directly for the whole ordered
array. **PR review, minor finding 5:** the original cut of this issue kept `primaryNewBadge` around as a
one-line wrapper taking `rankBadgeCandidates`'s first result, on the theory that `guest.js`'s
task-complete modal still called it — but that call site had already been replaced by
`resolveBadgeMoment` back in #644, so `primaryNewBadge` shipped with no production caller left at all.
It and its export are deleted; `tests/badge-moment-priority.test.js` (#714) now reproduces the same
one-line wrapper locally, over the real `rankBadgeCandidates`, so its assertions keep proving the
identical "single winner, or null" contract. `compareBadgeMoment` is the one entry point from #714 that
keeps both its existing signature/behavior and a live production caller (inside `rankBadgeCandidates`).

**Continue-button ownership: badge-moment.js takes over from recap.js for the whole page load, the same
way the owner-approved `?badge-demo=1` mock already did.** The shared `#badge-dialog` also serves
`src/public/js/recap.js`'s own on-demand REPLAY of an already-celebrated badge (tap a recap row), which
closes on Continue with no queue and no count (AC6, unchanged). Once a celebration is owed at all,
`badge-moment.js` registers a CAPTURE-phase `document` listener for `.badge-continue` clicks and calls
`stopPropagation()` — capture-phase listeners on `document` run before any bubble-phase listener on that
same node regardless of script load order, which is exactly the guarantee the phase-1 demo's own
capture listener relied on to "beat" `recap.js`'s plain bubble-phase closer. `badge-moment.js` owns every
Continue tap for the rest of that page load this way: it advances the queue while one remains, and closes
the dialog itself once its own `queueIndex` reaches the end of `queueItems` (matching AC4's single-badge
case, where the queue is empty from the start) — so `recap.js`'s own close-on-Continue handler only ever
actually runs on a page where `badge-moment.js` was never loaded at all (nothing owed this render, a pure
replay session).

**PR review, major finding 1 (all three reviews converged on it): `queueIndex` reaching the end was not,
in fact, guaranteed — a real broken trace.** A guest owed 3 badges who DISMISSES the dialog mid-queue
(Escape, or any other native dismissal) never fires a click on `.badge-continue`, so `badge-moment.js`'s capture listener
— the only place `queueIndex` moved — never ran, and `queueIndex` was left wherever it was when the
dialog closed. A LATER recap-row replay reopening the same dialog and tapping Continue hit that stale,
still-mid-queue `queueIndex`: it resumed the ABANDONED queue instead of closing — advancing to the next
badge, posting its stamp, and showing a count (AC6 violated; AC3's "abandon keeps it owed" broken by the
very tap meant to replay a different badge). The fix is a `dialog.addEventListener('close', ...)` listener
that forces `queueIndex = queueItems.length` the instant the dialog closes, BY ANY MEANS — not just by
walking every queued item via Continue. That is what actually makes "a later replay's Continue plainly
closes" true: exhaustion is now guaranteed on every path the dialog can close by, not assumed from the one
path (completing the queue) the original cut only handled. `recap.js`'s `openBadgeDialog` was given one
more, independent fix: reset the Continue button's label back to plain "Continue" every time it opens for
a replay, since `badge-moment.js` leaves that same shared button reading "Done" (or a stale count) once
its own queue finishes, and a later replay must never inherit it.

## Flash mobile launch: accordion visibility moved to a single JS-class owner (#918)

**Date:** 2026-07-29. **Status:** shipped (phase-2).

**The problem.** The owner reported flash launch working on desktop but not from his phone over the
stag weekend. A read of the whole tap-to-Save chain found no single smoking gun — no mouse-only event,
no viewport branch — but four independent mobile hazards, all traced to #763's flash partial: the
accordion's only visibility owner was a CSS `:has()` selector (fails closed on an engine without it, at
both the mode-panel and the "Pick a time" sub-panel level), no `touch-action: manipulation` on the
dialog (iOS reads fast +/- taps on the minutes stepper as double-tap-zoom), a blocked native submit is
silent on iOS Safari (no validation bubble), and two chip rows had no `flex-wrap` and overflowed narrow
phones. None of the four is provable as _the_ exact failure without the owner's phone in hand, so the
fix is a hardening bundle, not a single-mechanism patch — each piece is independently correct and cheap
regardless of which one (or more) was the actual culprit.

**Accordion visibility has exactly one owner now: the class, set by `syncSpecialPanels()`.** The first
cut of this fix ADDED class-based rules beside the `:has()` originals as a fallback mirror; the
design-philosophy review rejected that as duplicated ownership of one visibility rule (two
independently-written statements — a `:has()` selector and a JS conditional — that a future edit could
change on one side and miss on the other). The `:has()` visibility rules were deleted instead:
`.special-active` on `.special-option-group` and `.flash-later-active` on `.flash-start-field`
(`syncSpecialPanels()`, `src/public/js/admin-tasks.js`) are the sole owners at both accordion levels.
The first-paint property `:has()` provided costs nothing to give up, because the task dialogs are only
ever shown by the same script that sets the classes — `openEdit()` and `resetCreate()` both run
`syncSpecialPanels()` before `showModal()`, and it re-runs on every mode/Starts change. A saved flash
task's edit popup therefore shows its panel open the moment it appears, on every engine, `:has()` or
not.

**Why a JS unit test proves the class fact but not the pixel.** jsdom has no CSS layout engine, so
`tests/admin-tasks-script.test.js`'s new cases (issue #918) assert the DOM fact the CSS depends on —
which element carries which class, and when (tap-time AND dialog-open-time) — the same limitation and
the same CSS-guardrail-regex workaround `tests/leaderboard-overflow.test.js` already established for
`touch-action`/`flex-wrap` source-text assertions. The pixel-level proof (the class alone renders the
panel `display: flex` on a `:has()`-less engine) happened in the owner's phase-1 visual-approval loop,
not in this suite.

## Rank & award results view: one hidden-button bug, one release-means-clear amendment (#892)

**Date:** 2026-07-29. **Status:** shipped.

**The problem, and its actual root cause.** The owner reported the Rank & Award page giving no visual
cue that Release did anything ("the button indents, and nothing after that"), which led to spamming
Release and the duplicate-notification bugs #889 already fixed server-side. The client-visible root
cause: the released (Awarded) page differed from the live editor only by a `hidden` Release button —
and `.btn`'s own `display` rule already beat the UA's `[hidden]` attribute rule in specificity, so that
button never actually disappeared. The page looked identical whether released or not, in every state,
the entire time #661 shipped.

**Fix: `.rank-award-foot .btn[hidden] { display: none }`, plus a genuinely different released view.**
`src/public/css/theme.css` gains one rule scoped to this foot so a future `hidden` toggle on any of its
buttons actually paints hidden — a stylesheet-presence test (`tests/admin-badge-rank-script.test.js`)
guards this specifically, since jsdom does no layout and a geometry assertion there would be vacuously
green. On top of the CSS fix, a released task now opens as a distinct RESULTS view (card titled
"Results", a check-glyph "Awarded" pill, medal rows with no drag handles) rather than the same editor
with one button hidden — the owner's own diagnosis ("make it obvious without writing it, with the UI
changes") ruled out a text explanation or a confirm dialog as the fix.

**The photos stay visible always; the tile's ROLE swaps with the mode, not its presence.** Hiding the
grid entirely on a released task was considered and rejected live: the owner wants to keep browsing a
task's photos after release. `src/public/js/admin-badge-rank.js`'s `renderGrid()` now branches per photo
on `editing`: a pick-tile button (numbered checks, toggles `picked`) in edit mode, or a `.js-lightbox`
BUTTON (no href — `/p/:id` is guest-gated and would 302 an admin to `/join`, the same shape
`admin-photos.ejs`'s own admin-feed lightbox trigger already uses) on the results view, so a tap browses
full-resolution instead of touching the ranking. `data-lightbox-photo` carries `photo_path` (the
original filename), not `thumb_path` — the route's `stmtVisibleTaskPhotosForRank` SELECT was widened to
carry it (`src/routes/admin.js`), since `lightbox.js` always prefixes its source attribute with
`/uploads/` and a thumbnail path there would resolve to a nonexistent file.

**One state machine, `editing`, replaces the old `released`-mutates-in-place model.** #661's original
design let ANY pick-tile tap silently exit the read-only Awarded state and re-enter live editing
(dropping this same photo's pick status in the same click) — the exact "mis-tap pulls a released ranking
apart with no visual cue" root cause #2 the owner's report also named. `editing` (a released task starts
`false`, an unreleased one starts `true`) is now flipped ONLY by the explicit Edit-ranking / Cancel
buttons; `released` itself becomes a read-only fact (has this badge EVER been released — still sourced
from the same `data-released` attribute / `isTaskBadgeAwarded` settings marker) that only gates whether
Cancel has a released baseline to return to. A `baseline` snapshot (`picked.slice()` at load) is what the
Release button's visibility is keyed on now — `isDirty()` compares the live `picked` order against it, so
edit mode with nothing yet changed shows Cancel alone, and Release appears the moment the ranking
actually differs (added, removed, or reordered) from what was last released.

**Amending #661's own 1-to-5 floor: an empty release is now a deliberate clear, not a refusal.**
`task-badges.releaseRanking`'s guard originally refused `submissionIds.length === 0` outright (see the
`#661` ADR above, "the release refuses an empty set"). The owner's own requirement here —
"everyone posted junk must never force the host to reward someone" — needed a real path to zero winners,
so the floor is dropped: only the CEILING (`length > MAX_RANKED_WINNERS`) still refuses. An empty array
reaches the exact same whole-set `DELETE` every release already ran; the fold-and-upsert loop simply has
nothing to iterate, so it writes zero rows and emits zero events — no guest is newly notified, matching
the existing (undocumented until now) behavior of a shrinking re-release that drops a winner with no
replacement. `markTaskBadgeAwarded` still runs unconditionally, so the badge stays marked released and
the page reopens on the Results view reading "No winners." rather than falling back to the picker.

**The route, not the service, is where "absent" and "deliberately empty" are told apart.** A raw HTML
form has no way to distinguish "the `winners` field was never in this POST" from "`winners` was posted
as an empty string" once both reach `req.body` as `undefined`-vs-`''` — so `src/routes/admin.js`'s POST
handler checks `typeof req.body.winners !== 'string'` FIRST (refused, same as pre-#892 — an absent field
is never a clear) before trimming; only a present, trimmed-empty value is passed through as `[]`. This is
also where a second, previously-silent gap closed: the old parse (`.filter(Number.isInteger)`) DROPPED
any non-digit entry and released the shortened list, quietly shifting every later placement's rank/points
out from under the host. The route now tests every comma-separated entry against a whole-string
digits-only regex (`RANK_WINNER_ENTRY_RE`, `/^\s*\d+\s*$/`) BEFORE parsing any of them, and refuses the
WHOLE post if one fails — a length-compare against `parseInt`'s own output was tried first and rejected
in review (both the PR and design-philosophy passes caught it independently): `parseInt` coerces
`'12.9'` to `12` and `'12abc'` to `12`, so a parsed-count-vs-entry-count check lets exactly the malformed
input it exists to catch through. This mirrors `releaseRanking`'s own no-silent-drop rule for a
submission id that fails its visibility/ownership check.

## Static photo caching: content-immutable filenames license a 7-day pinned cache (#937)

**Date:** 2026-07-30. **Status:** shipped.

**The problem.** `/uploads` and `/thumbs` (`src/app.js`) were mounted with no `express.static` options,
so every response carried the framework default `Cache-Control: public, max-age=0` — a guest's phone
re-validates every already-seen photo on every gallery scroll. Each revalidation first passes through the
synchronous better-sqlite3 takedown query in `blockTakenDownOriginal`/`blockTakenDownThumb`
(`src/services/photos/moderation.js`) before a 304 can even be answered, on the same main JS thread the upload
pipeline's 6-slot semaphore is trying to protect. A hundred guests scrolling one gallery multiplies into
thousands of blocking round-trips competing with in-flight uploads.

**The filename invariant that licenses `immutable`.** A stored name is `<16 hex>-<ms timestamp>.<ext>`
under both `/uploads` and `/thumbs`, and the bytes under a given name never change once written: takedown
hides or deletes a row, it never rewrites the file in place, and a re-save always mints a fresh random
name. `/uploads` has a second tenant beyond submission originals — guest **avatars** — and the same
invariant holds for them: `saveAvatar` (`src/services/photos/processing.js`) writes a new random filename per save
and updates `guests.avatar_path` to point at it; it never overwrites bytes under an old avatar's name.
Both tenants of `/uploads`, and everything under `/thumbs`, are therefore safe to mark `immutable` —
a client that has fetched a name once never needs to ask again for that same name.

**Why 604800 seconds (7 days), not longer or shorter.** The takedown guard still blocks every _new_
fetch immediately and unconditionally — nothing about this change touches that. What a 7-day `max-age`
adds is that a phone which already cached a photo before it was taken down keeps rendering its own copy,
without asking the server, for up to 7 days, on any surface that still emits that URL. Shorter would
re-open the revalidation flood mid-wedding-weekend, exactly when it matters most; longer would stretch
the takedown residual (below) past the point the owner accepted. Seven days covers the full wedding
weekend for performance while guaranteeing every phone converges to a takedown within a week.

**Dependency: #866 (merged, PR #946, commit `5a4d851`, 2026-07-30).** Before #866, a taken-down photo's
`/p/<id>` link could still be re-emitted from a guest's stored recap row, so a cached copy plus a
still-live link would have compounded into a durable-looking dead-photo experience. #866 made every
stored-event surface stop emitting a taken-down submission's `href`/`thumb` (see the #866 ADR above), so
by the time this issue shipped, no in-app surface renders a taken-down photo's URL. This issue was
sequenced to depend on and ship after #866 for that reason.

**The residual, accepted as-is.** With #866 landed, the only way a guest's phone still shows a
taken-down photo is a direct URL they browsed to and cached _before_ the takedown, revisited manually
(bookmark, browser history, a screenshot-shared link) within the 7-day window — one phone, one guest,
capped at 7 days, never renderable from any in-app link. The export/keepsake pipeline reads the server's
files directly, never a phone's cache, so the kept record is unaffected by this residual.

**Why `public` is the safe directive here — an assumption, not a given.** This deployment terminates
TLS at the reverse proxy (§ "Hosted deployment" records that termination); no CDN is deployed today and
none is planned for the event, so no shared/intermediary cache sits in the request path. `public` on an HTTP response
normally permits ANY shared cache — a corporate proxy, a CDN edge — to store and reuse it, but with none
of those in the request path, "public" resolves to "cacheable by the requesting device" in practice. A
future deployment that adds a CDN or drops to plain HTTP through a shared proxy must revisit this
directive before shipping — `public` would then mean what it actually says.

**The admin-bypass and 404 branches get their own directives, not `immutable`'s.** The two guard
middlewares set `Cache-Control` themselves, one line each, before passing through — `express.static`'s
underlying `send()` only sets `Cache-Control` when the response doesn't already carry one, so a value
set upstream in the guard survives untouched to the client:

- **Admin bypass** (`isAdminRequest(req)` branch, both guards): `private, no-cache`. An admin's bypassed
  view can include a taken-down file — that response must never be marked publicly cacheable, but the
  host's own bodiless-304 revalidation flow (useful on the moderation gallery, which re-fetches the same
  thumbnails repeatedly) still works under `no-cache` (revalidate-before-reuse), unlike `no-store` (never
  cache at all).
- **404 branches** (both the stage-1 allowlist rejection and the stage-2 takedown 404): `no-store`. A
  takedown 404 must never be cached as a negative, or a later restore would have to fight a stale cached
  404 on top of the takedown guard already re-allowing the file. Because the stage-1 allowlist check runs
  _before_ the admin-bypass check in both guards, a malformed/non-matching filename 404s — with
  `no-store` — for an admin requester exactly the same as for a guest; the bypass only ever reaches
  stage 2 (the DB takedown check), never stage 1.

No new middleware was added: `STATIC_PHOTO_OPTS` is passed directly as `express.static`'s second
argument in `src/app.js`, and the guards' existing single functions grew one `res.set()` line each per
branch — the same shape the #191 admin bypass already used.

## Feed in-place loading: scroll correction owned by the module, native anchoring suppressed only mid-insert (#677)

**Date:** 2026-07-29. **Status:** shipped (phase-2, PR review fix).

**The problem.** #677's phase-1 approved module (`src/public/js/feed-scroll.js`) restores scroll
position itself after prepending a newer window above the guest's current photo (measure the anchor
tile's position before/after insert, `scrollBy` the difference). The first cut also disabled native CSS
scroll anchoring statically and permanently — `.feed { overflow-anchor: none }` plus a second rule
covering everything below it (sentinels, edges, pager, footer) — reasoning that native anchoring and the
module's own correction would otherwise stack and double-correct. PR review found two real problems with
that static approach, not hypothetical ones: `.feed` is not unique to this page (`src/views/admin-photos.ejs`
renders its own `.feed` for the moderation view), so the static rule silently turned off anchoring there
too, on a surface #677 was never meant to touch; and suppressing anchoring page-wide, permanently, also
removed the browser's own compensation for photos ABOVE the viewport that resolve to their real height
AFTER paint (issue #612's `contain-intrinsic-size: 600px` on `.feed-item` is only an estimate) — with
anchoring off at all times, a guest scrolling up through freshly-prepended cards would see the page drift
as those cards resolved, with nothing left to correct it once the module's own one-shot adjustment had
already run.

**The fix: suppress anchoring only for the tick that processes one insert.** `overflow-anchor: none` on
one element excludes that element AND its whole subtree from anchor candidacy, so toggling it on
`<body>` (a single `body.feed-inserting` rule in `theme.css`) covers every anchor candidate on the page in
one place, without scoping to `.feed` at all — the admin photos panel is never touched. `feed-scroll.js`'s
`load()` takes a counted hold on the class immediately before calling `edge.insert(...)` (a counter, not
a bare add/remove pair, so overlapping inserts from the two independent edges never strip the class out
from under each other) and releases it two animation frames later (one frame for the browser's layout
pass over the inserted nodes, a second so anchoring is live again before the next observer tick), falling
back to a synchronous release when `requestAnimationFrame` is unavailable so a test environment without
it never hangs. Native anchoring is
therefore OFF only while the module's own measure-and-adjust (`prependNewer`) is doing the correcting for
that one insert, and back ON the rest of the time — including while a later-resolving image height drifts
the layout, which is exactly the case the static version broke.

**Provenance.** Issue #677; the original static suppression was written against the 2026-07-29 phase-1
preview observation (headless Chrome: an append at the bottom sentinel anchored there instead of leaving
scroll position untouched, stalling the observer chain) — that observation is still the reason anchoring
must be off during an insert; the fix only narrows WHEN and WHERE it is off.

## Rank & award checklist row: "done collecting" is read-only, and lives beside the setting it reads (#662)

**Date:** 2026-07-31. **Status:** shipped.

**What changed.** `src/services/host-checklist.js`'s `buildRows()` gained one open auto row per task
that is done collecting photos, still holds at least one visible submission, and has not yet had its
badge released (`task-badges.isTaskBadgeAwarded`) — `Rank & award: [task title]`, linking to
`/admin/tasks/<id>/rank`. This fills in the omission #646 recorded in the
`host-checklist.js` comment this change deletes ("rank-and-award … still has no backing column or
table at all, so that row type stays omitted" — the same substance #646's ADR above records as "no
column or table for 'winners chosen' exists") now that #661 gives the row a fact to read: a task's
visible-submission count plus the settings-table awarded marker.

**"Done collecting" is a host-facing signal, not a write-side seal.** Submission code never hard-closes
a task to photos except while sealed for a future day (`tasks.js`'s `isSealed`/`sealedTaskWhere`) — a
past-dated task can still technically receive a photo, and the rank page itself supports re-ranking one
in after release. The predicate this issue adds is therefore read-only, with two cases and an explicit
precedence: a **dated** task (a real `special_date`) is done when that date is strictly before today in
the event timezone — its own day governs in both directions, so a task dated after `event_end_date` is
not done until its own day passes even though the event is over. An **undated** task (no real
`special_date` — ordinary, flash, lucky, or a `'oneday'` row with a NULL date) is done only once the
configured `event_end_date` is a real date strictly before today. A flash task's expired window is
deliberately NOT a third case and never substitutes for either: `flashState()` governs only the bonus,
the task remains a fully live ordinary task once its window closes, and a row keyed off a flash window
closing would invite releasing the badge mid-collection — the exact defect issue-review round 1 caught
in this issue's first draft, before the trigger was reconciled to "done collecting" instead of the
`#259`-era "5th chosen winner" the original body assumed (a persisted "chosen" state #661's one-badge
consolidation had already removed).

**Predicate placement: split at the seam, not all-or-nothing (corrected — PR review round 1, design-
philosophy finding, information leakage).** The first-shipped version put the DATED arm's own `<`
comparison (`special_date` strictly before today) inline in `host-checklist.js` as a bare string compare
— a duplicate of a comparison that already existed, privately, inside `tasks.js`'s `SPECIAL_RULES` daily
`missed` predicate (the "has this challenge's day passed" fact `missedBonusForTask` uses for the
struck-through missed-bonus marker, issue #926). That predicate is a raw `special_date`/`todayIso`
comparison with no event-level input, so it belongs to `tasks.js`'s existing `isSealed` (`>`) /
`isOnDay` (`=`) family, not to this module — the fix adds `tasks.isPastDay(taskRow, todayIso)` as their
`<` sibling (same signature shape, same `todayIso` validation, same `isRealDateString` guard against a
regex-shaped-but-impossible `special_date`), and both the daily `missed` predicate and
`host-checklist.js`'s dated arm now call it instead of each carrying their own copy. What stays in
`host-checklist.js`, deliberately, is the UNDATED arm and the two-case composite: `event_end_date` is an
EVENT-LEVEL setting this module already owns reading, through its own `settingRaw` helper specifically
because that helper distinguishes "never configured" from "configured" — `db.getEventConfig()` would
silently default an unset `event_end_date`, which would make an unconfigured event's undated tasks read
as permanently NOT done rather than correctly undecidable — and deciding WHICH arm applies has exactly
one consumer today. Moving that single-consumer, cross-module composite into `tasks.js` on spec would be
the premature generalization this codebase's own convention (`liveTaskWhere`, `feed.js`'s
`VISIBLE_WHERE`) exists to avoid; a second surface needing the COMPOSITE is what graduates it, as its own
reviewed issue — the raw `<` comparison itself had no such excuse, since a second raw consumer already
existed the day this predicate was written.

**One grouped query for the candidate set, plus one small settings read per candidate (corrected — the
first-shipped note here overclaimed "not a second SQL round trip per task").** The row's candidate set is
one `tasks` query with a `LEFT JOIN submissions` gated in the `ON` clause (not a `WHERE`) by
`feed.VISIBLE_WHERE` — so a task with zero visible submissions still survives the join as one row with
`photo_count = 0` rather than being dropped by the join — filtered to not-hidden via
`tasks.liveTaskWhere('t')`. Both filters are composed from their declared owners, not re-typed: this is
the same discipline `host-checklist.js`'s own file comment already sets for the rest of this module's
rows. The done-collecting test runs in JS afterward at no further SQL cost, but `taskBadges.
isTaskBadgeAwarded` genuinely does execute one prepared `settings` SELECT per candidate task — that is a
real per-task SQL statement, just a cheap indexed single-row read bounded by the party's own task count
(tens, not thousands), not the N+1 shape (a submissions-table query per task) this query's `LEFT JOIN`
was built to avoid.

**A hidden task's row disappears, not just goes dormant.** `tasks.liveTaskWhere('t')` excludes a
`special_mode = 'hidden'` task from the candidate query entirely, so hiding a done-collecting task with
photos waiting drops its row on the very next render — matching this row type's other auto rows, which
carry no dismiss control of their own, and the host's only way to silence one is to act on it (here:
hide the task, or release its badge).

## Scoped feed windows: every photo grid opens a feed constrained to its own set (#952)

**Date:** 2026-07-30. **Status:** shipped (phase 2).

**The problem.** The Shared Gallery's tile → `/feed?from=<id>#photo-<id>` → lightbox chain is the star
pattern, but it always opens the WHOLE event's feed — a tap on a task section, a person's profile grid,
or "My Photos" dropped the guest into every visible photo, not just that grid's own set. Phase 1 (owner-
approved 2026-07-30) mocked the fix client-side in `src/public/js/feed-scroll.js`: a `?scope=u<id>|t<id>|m`
query param told the already-downloaded feed page to hide non-matching cards, chaining past a fully-
filtered-out window until one contributed a visible card. That still downloaded every unscoped window
over venue wifi first — the exact cost issue #194 exists to bound — so it was a look, not the shape.

**The fix: the scope is a SQL predicate, not a DOM filter.** `src/services/feed.js` now precompiles four
statement sets (`FEED_STATEMENTS_BY_SCOPE`) at module load — one per scope shape (`guest` →
`s.guest_id = ?`, `task` → `s.task_id = ?`, `memory` → `s.task_id IS NULL`, plus `none` for today's
unscoped feed) — so `feedWindow(fromId, scope)` composes the SAME `VISIBLE_WHERE`/ordering rules this
file already owns with a ready statement instead of building SQL text per request. A non-matching photo
is never fetched, let alone hidden client-side.

**`feed.js` owns both directions of the `u<id>` / `t<id>` / `m` grammar.** `feed.parseScope(raw)` is the
single place a `?scope=` string becomes a scope descriptor (parsing); `feed.scopeToken(scope)` is the
single place a descriptor becomes a string again (emission), delegating to the same per-shape
`SCOPE_SHAPES` table `feedWindow` itself reads. Every other caller — the window query, `community.js`'s
back-link context, both pager hrefs — consumes one of these two functions rather than re-matching or
re-building the scope string itself. The token side reaches the photo-grid VIEWS too (a review fix
after phase 2 first shipped): every route resolves tokens server-side and hands the views ready
strings, all under the one name `scopeToken` — `GET /gallery` stamps each group's token
(`g.scopeToken`) plus a `taskWallScope` for the filtered wall, while `GET /u/:guestId` and
`GET /` (`guest.js`) each resolve their single token once — and `partials/gallery-tile.ejs` only ever
composes a token it was given into its own `/feed?...&scope=` link; no view calls the token builder or
re-derives the `u`/`t`/`m` grammar itself. A malformed value and a well-formed but
nonexistent guest/task id both resolve to `null` (one EXISTS-shaped lookup per shape) and are
therefore indistinguishable from "no scope" downstream — the route never has to special-case "bad scope"
separately from "no scope"; both just render the plain unscoped feed. This is a deliberate simplification
over the phase-1 mock's `SCOPE_RE`, which had no such validation (a garbage or dead id in the URL, or a
guest who deleted their whole profile, would have raised errors client-side, not degraded quietly).

**An out-of-scope `from` anchor degrades exactly like a stale one already does.** `feedWindow` reused the
existing "missing/taken-down anchor falls back to the first page" branch: after resolving the anchor row,
one extra check (`matchesScope`) discards it if it exists but sits outside the scope, so the caller gets
the scoped set's own newest page — the same one-branch shape as the pre-existing stale-`from` fallback,
not a second, parallel "wrong scope" code path.

**Back-link copy is looked up server-side, not scraped from rendered rows.** The phase-1 mock derived the
task title / guest name for its back-link chrome from the DOM (`feedEl.querySelector(...)`) — which
cannot work for an empty scoped set (AC4: every photo in the set taken down still has to render a back
link naming what would have been there). `community.js`'s `scopeBackLinkContext()` looks the title/name up
directly from the DB once per request, so the frame renders identically whether the scoped set holds
photos or none.

**The no-JS pager stays real, not just present.** `src/views/feed.ejs` still renders
`<nav class="pagination">` on a scoped page with scope-carrying hrefs on both directions — `feed-scroll.js`
reads those same hrefs off each fetched page and hides the nav at runtime exactly as it already did for
an unscoped feed (issue #677's degradation contract, untouched); this issue's own phase-1 mock's DOM-
filtering/chaining logic (`SCOPE_RE`, `scopeGuestId`, `itemMatchesScope`, `applyScope`, `scopeContext`,
`insertScopeChrome`, and the `scopeId`/`visBefore`/`visAfter` chaining inside `load()`) is deleted outright
rather than adapted, since the server now guarantees every fetched window is already scoped.

## Scoped admin inline feed: a client-side filter, deliberately not a server query (#953)

**Date:** 2026-07-30. **Status:** shipped.

**The problem, and why it is NOT sibling #952's problem.** Both issues scope a feed to one guest's or
task's photos on open. #952 (immediately above) had to move that scoping onto the server, because the
guest-side `/feed` downloads its window over venue wifi — shipping every unscoped card first, then hiding
most of them client-side, was the exact cost #194 exists to bound. `/admin/photos`'s inline feed carries
no such cost: it is one server-rendered page (issue #259's "one view file / one route" design) that already
loads the full photo set once, on the host's own laptop, not venue wifi. Scoping that already-downloaded
page client-side — a single `data-scope-key` attribute-match approach, the same shape the phase-1 mock's
`data-guest-id` / `data-task-id` pair used — costs nothing extra a server round trip wouldn't also cost,
and a round trip per section-open (grid tap, or the post-moderation `#feed-photo-<id>` reopen) would only
slow the host down mid-moderation. So this issue keeps `applyFeedScope()` / `openFeedAt()` exactly as the
owner approved it in phase 1 (`src/views/admin-photos.ejs`'s inline `<script>`), rather than porting #952's
`FEED_STATEMENTS_BY_SCOPE` pattern over — the two features share a shape (scope-on-open) but not a cost
profile, so they do not share an implementation. PR review folded the phase-1 pair of attributes into the
one `data-scope-key`: `src/routes/admin.js`'s `scopeKey(p, view)` is the single computation of "which
section does this photo belong to," consumed both by the route's own task/user grouping and by the value
stamped onto each row as `p._scope_key` — the view renders that stamp verbatim, and the inline script reads
it off the card instead of re-deriving the guest-vs-task axis itself from a `VIEW` switch.

**Real like counts ride the same `photosSelect` the scoping reads — through one shared column, not a third
hand-typed copy.** `src/routes/admin.js`'s `photosSelect` carries the real per-photo like count, replacing
the phase-1 mock's deterministic `(p.id * 7) % 9` fake. Phase 2 first shipped this as a third hand-typed
correlated subquery, alongside two pre-existing hand-typed copies already disagreeing on a single owner:
`src/services/feed.js` carried its own copy twice over (`GALLERY_COLUMNS` and `slideshowSequence()`),
and `src/services/scoring.js` carried a separate copy again. PR review flagged
that a fresh fourth copy compounded rather than fixed the drift risk. `feed.js` now exports
`LIKE_COUNT_COLUMN` — the one `(SELECT COUNT(*) FROM likes l WHERE l.submission_id = s.id) AS like_count`
fragment (indexed by `idx_likes_submission`, `src/db.js`), used inside both of `feed.js`'s own internal
call sites (`GALLERY_COLUMNS` and `slideshowSequence()`) and imported by `admin.js`'s `photosSelect` — so
those sites can no longer drift apart. `scoring.js`'s copy is deliberately left alone: it is pre-existing,
out of #953's scope, and the one remaining known duplicate for a future issue to fold in, not a defect
this one introduces.

## Task detail redesign: badge state is the first PER-GUEST read of `guest_badges.rank` (#611)

**Date:** 2026-07-31. **Status:** shipped.

**The problem.** The task detail page's phase-1 mock (owner-approved look, six rounds) faked three
things purely to show the shape: the success beat forced onto specific task ids with hard-coded point
values, the badge hero's win state hard-coded per task id, and the badge art itself swapped to a bundled
Material icon so a real medallion rendered instead of the seeded placeholder ribbon. None of that reached
the real render path — `resolveTaskBadge`/`taskComplete` already drove the page underneath the mock.
Making it real meant answering one question no read in the codebase answered: does THIS guest hold an
award for THIS task's badge, and at what rank? `guest_badges.rank` was already read on a guest-facing
surface — `victoryRankBySubmission` feeds the gallery tile's victory medal (issue #811) — but only
event-wide and keyed by submission, never scoped to one guest asking about one badge.

**`guestBadgeRank(badgeId, guestId)` (`src/services/task-badges.js`) is the one read**, added beside
`victoryRankBySubmission` (the gallery tile's event-wide, unscoped read) and `currentRanking` (the admin
rank page's task-scoped read) — a third shape scoped to one guest and one badge, because neither existing
read fits a single guest asking "did I win this." It returns `undefined` for no row, `null` for a
possession-only award (no rank column set — `awardTaskBadge`'s single-photo path), or the numeric rank for
a ranked release. `undefined` vs `null` has to stay distinguishable because they route to different hero
states: no row falls back to the pre-#611 earned/locked split, a row falls straight into "won" regardless
of rank. `src/routes/guest.js`'s `GET /tasks/:id` resolves the mapping into one of four modifier suffixes
(`locked`/`earned`/`won-first`/`won-place`) and hands `taskBadgeState` to the view as a plain string —
`task.ejs` branches on nothing, matching the same "resolve in the route, not the template" pattern
`guestFacingSubmission` already established for issue #886.

**Possession, not resubmission, decides the win — same rule #886 and #661 already committed to.**
`releaseRanking`'s own contract keeps a guest's award row when their winning photo is later taken down
(issue #661 AC4); `guestBadgeRank` reads that same row regardless of the submission's current visibility,
so a badge a guest already won does not vanish off their task page just because a host hid the photo
later. This is exactly why the route computes `taskBadgeState` from the award row FIRST and only falls
back to `guestFacingSubmission` (issue #886's own null-if-guest-hid-it signal) when no award row exists at
all — the two guest-190/886 visibility rules apply to different facts (whether the PHOTO shows, whether
the BADGE reads as won) and neither should leak into the other's branch.

**Gold is conditional on art kind, and the win is never conditional on it.** Criterion 3's rule, applied
as the owner stated it live ("not won is greyed out, wins are the proper color, no extra circles"):
grey-to-colour is the universal win signal every task badge can show regardless of its art, and the gold
ring + glyph is a refinement layered on top ONLY when `badge-art.ejs` would already render that badge
through the medallion component (`badgeIsIcon(art_path)` — a bundled Material icon). A task badge whose
art is the default ribbon or a host-uploaded photo renders as a plain `<img>` with no `.badge-medallion`
element for `theme.css`'s `.task-badge-hero--won-first .badge-medallion` rule to match, so it stays in its
own colours, ungrayed, with the placement carried in the note line beneath it instead of the ring. No new
CSS selector encodes this split — it falls out for free from `badge-art.ejs`'s existing icon/composed
branch, the same one every other badge surface already reads. Forcing gold onto non-icon art would have
meant either a second ring drawn over an arbitrary host photo (the extra circle the owner explicitly cut)
or rewriting the default badge art itself, both reaching outside this one screen into the task board,
profile grids, and the badge modal that also render through `badge-art.ejs`.

**The lucky card lost its gold accent edge too — recorded, not incidental.** The owner's rule was
stated about card design generally ("no solid line of color as a card accent … it just reads very ai
design", 2026-07-31), so removing `border-left: 4px solid var(--color-primary)` from `.success-card`
necessarily also drops `.success-card--lucky`'s `border-left-color: var(--place-1)` — the lucky variant
recolours that same edge rather than drawing its own. Issue #650's approved lucky treatment therefore
ships changed: the gold inset ring and the gold clover remain and still make a lucky win read as its own
rarer moment, but the 4px gold edge is gone. The owner reviewed the lucky card in exactly that state
during the same session before approving.

**The upload form is one partial, included from three mutually exclusive branches.**
`src/views/partials/task-upload-form.ejs` — the picker button, caption textarea, and submit — is included
by `task.ejs`'s never-submitted branch, its issue #190 host-takedown branch, and inside the `<details
class="replace-disclosure">` a completed task collapses the form behind. Exactly one of the three renders
per request (task.ejs's own `if`/`else if`/`else` on `submission`/`submission.taken_down`), which is what
keeps the partial's fixed element ids (`#caption`, `#upload-preview`, `#upload-error`) unique on the page
— it does not render twice on one page at any point, only once from whichever of the three branches the
guest's current state selects.

## Source-text test assertions: one shared comment stripper, not per-file private copies (#939)

**Date:** 2026-07-31. **Status:** shipped.

**The rule.** Any test assertion whose subject is backend source code — a positional `indexOf`
comparison, a positive/negative-presence check, a regex extraction over a file read from `src/**` —
runs over `tests/helpers/source-text.js`'s `stripComments()` output, never the raw file read. A
comment added or reworded anywhere in the asserted file must never be able to flip such a result. This
replaces the private, less-complete stripper that used to live inline in `tests/heic-conversion.test.js`.

**Assertions on comment prose itself stay raw** — stripping would delete the very thing under test.
`tests/flash-engine.test.js` (~:496-510) is the one such case in the repo: it asserts on comment text,
not code shape.

**Two raw reads outside `src/` are deliberate scope exclusions from #939, not oversights:**
`tests/loadtest.test.js` and `tests/check-freshness.test.js`. Route them through `stripComments()` the
next time either file is touched.

## Comment archaeology: present-tense constraints, not review history (#966)

**Date:** 2026-07-31. **Status:** shipped.

**The rule.** A source comment states the current constraint, not the argument that produced it. A
provenance tag of the shape `(issue #N review fix, SEVERITY)` trims to a bare `(#N)` — the constraint
stays, the review-round vocabulary goes. A comment narrating what an earlier version of the code, or an
earlier draft of the comment itself, said — once that fact no longer constrains anything — is rewritten
to its present-tense fact or deleted outright; a comment recording that behavior moved (e.g. the admin
brute-force throttle now living in `services/lockout.js` instead of module-scoped scalars in
`routes/auth.js`) keeps the fact plus a bare `(#N)` pointer, never "used to." Deletion applies to the
narrating clause only — a comment never loses a constraint that is still true. The narrative is not
lost, only relocated: it already lives in git history and, for anything architecture-bearing, in this
file.

**What stays untouched, on purpose.** Rendered copy and string literals (a guest-facing "Delete this
comment?" confirm dialog is not source commentary). Present-tense self-reference ("this comment already
warns against X" — a comment pointing at its own surrounding prose, not at history). Domain or purpose
phrasing a naive sweep could mis-flag as archaeology: "an earlier holder calls release()" (a semaphore's
own queueing vocabulary), a guest's "previously-second-best" tied photo (a ranking term, not a code
version), or "used to auto-suggest" in its ordinary functional sense ("is used to do X"), not the
narrating sense ("this code used to do X, now does Y").

**Scope.** A sweep over 29 candidate files (25 edited) across `src/**/*.js`, `src/views/**/*.ejs`, and
`src/public/css/*.css`, run against four case-insensitive searches (`used to (say|describe)`,
`review (fix|finding)`, `this comment`, `used to|previously|formerly|an earlier|a prior`) and the union of
their matches, each hand-classified against the rule above. `src/services/tasks.js`'s SPECIAL_RULES doc
comment kept its live claim — flash deliberately does not extend the mode enum — while dropping the
trailing correction clause a prior sweep had left attached to it; `tests/flash-engine.test.js` pins that
exact claim and stayed untouched, per #939's "assertions on comment prose stay raw" carve-out.

**The searches are line-based, not phrase-based.** All four patterns match within a single physical line;
a phrase split across a comment wrap (e.g. `review\n// fix` or `used\n// to`) evades every one of them.
Two adversarial review rounds on this issue found such wrap-split archaeology the line-based searches
missed. The honest re-verification tool is a wrap-tolerant re-run of the same patterns, allowing 1-12
characters of whitespace or a comment leader (`[\s*/#<%-]{1,12}`) between the split words, not a rerun of
the line-based originals.

## Split the four oversized modules: entry-file pattern, db boot order, one-owner helpers, contiguous CSS slices (#969)

**Date:** 2026-07-31. **Status:** shipped.

**The rule this issue set: a ceiling, not a citation.** `src/routes/admin.js` (2,878 lines),
`src/db.js` (1,873), `src/services/scoring.js` (1,506), and `src/public/css/theme.css` (7,535) were file
obesity, not tangled logic — the routes/services/db layering was already clean. This issue set the
ceilings (900 lines per JS module, 2,000 per CSS sheet) rather than citing a pre-existing repo bar, and
split each oversized file along the seams it already had.

**The entry-file pattern.** Each split file becomes a thin entry that keeps its exact pre-split require
path and public API, with the real logic moved to internals under a same-named directory:
`src/routes/admin.js` -> `src/routes/admin/*.js` (one module per seam-table area, plus `shared.js` for
the two cross-area helpers and `task-form.js` for the tasks-core/tasks-manage create/edit validation
helpers); `src/db.js` -> `src/db/*.js`; `src/services/scoring.js` -> `src/services/scoring/*.js`. A
caller anywhere in the app (`require('../db')`, `require('./scoring')`, `app.js`'s
`require('./routes/admin')`) keeps resolving to the same thing; the split files are internals behind
that entry, never a second public surface.

**db boot order and the connection-handle rule.** `src/db/connection.js` is the _only_ `src/db/`
internal with a module-load side effect: it creates `config.DATA_DIR`, opens the database, and applies
the pragmas, in that order (the mkdir must precede the open or a fresh clone dies `SQLITE_CANTOPEN` —
every test helper mkdtemps its own `DATA_DIR` first, so no CI gate had ever caught that ordering
depending on it). Every other `src/db/` internal (`schema.js`, `migrations-tasks.js`,
`migrations-submissions.js`, `migrations-badges.js`, `migrations-guests.js`, `migrations-ops.js`,
`bug-reports.js`, `event-config.js`, `guest-lookups.js` — the migration files regrouped by domain rather
than by split-order in the PR review fix, see below) takes the open handle as a parameter, or reads it
fresh inside a function body — **never** a module-load `const { db } = require('./connection')` binding.
The entry (`src/db.js`) is the one place allowed a module-load `db` capture, because the entry and
`connection.js` are always evicted and re-required together — `tests/helpers/db-boot.js`'s
`evictDbModules()` is the single owner of that eviction pairing, called by every class-4 migration test
that needs a real second boot (the "boot a second, independent database in one process" pattern) — a
capture anywhere else would pin the FIRST boot's handle inside a module that survives the second boot
uninvalidated, silently querying a stale connection. `src/db.js` itself keeps the ordered 27-call
`ensure*()` boot sequence, calling into the
internals' exported functions in bd70cff's exact source order, under a comment stating that order is
load-bearing (several migrations rebuild a table from an explicit column-copy list; a column added by a
later migration run out of order would be silently dropped by an earlier migration's rebuild).
`src/services/scoring/*`'s internals are the one deliberate exception to the parameter-passing rule:
each prepares its own `db.prepare`/`db.transaction` statements at its own module load, safe because
scoring is never independently evicted from `require.cache` the way the db entry and connection are —
every caller reaches it only after `require('../db')` has already fully resolved.

**One-owner shared helpers.** A helper or statement consumed by more than one internal lives in exactly
one place, imported by every consumer, never re-declared: `src/routes/admin/shared.js` owns
`redirectWithMsg`/`renderNotFound` (both consumed across every admin area); `task-form.js` owns
`resolveBadgeIcon` (imported by both `tasks.js` and `tasks-manage.js`); `src/services/scoring/
badge-engine.js` owns the private `stmtBadgeByCode` statement behind its exported `badgeByCode(code)`
wrapper (consumed there and by `guest-badges.js`'s `badgeWithHolders` — the PR review fix stopped
exporting the raw statement itself, so a consumer can no longer reach past the wrapper to an internal
better-sqlite3 method neither call site used). Everything else stays area-local, beside its sole
consumer.

**CSS: contiguous, order-preserving slices — cascade-safe by construction, not by content.**
`theme.css`'s admin/tasks/badges surfaces interleaved throughout the file (e.g. admin rules spanned
:205-:6638, tasks :651-:7048) and selectors repeated with wide spread (`:root` alone at four separate
line ranges) with no guarantee those repeats stay non-overlapping forever — a per-surface regrouping
cannot preserve source order, and source order is what makes the cascade correct. The split is instead
five **contiguous** slices of the original file — `base.css`, `guest.css`, `feed.css`, `admin.css`,
`admin-tasks.css` (named for its dominant content — the admin task board, task dialog, and create
wizard — plus the lightbox/badge-picker/checklist rules that shared its byte range; renamed from the
split's original placeholder `misc.css` by the PR review fix), each under 2,000 lines — cut only at a
boundary where the preceding line is exactly `}` at column 0 (never an indented `}` inside an `@media`
block) and the following line is non-blank, so no prettier-deleted boundary blank line and no severed
at-rule. `head.ejs` links them as five plain `<link>` tags in slice order (no `@import` chains); the
browser's parallel-fetch-then-apply-in-link-order behavior reproduces the original cascade exactly.
Verified byte-identical: concatenating the five slices in link order reproduces bd70cff's `theme.css`
byte-for-byte (`Buffer.compare` on the concatenation against the original, before the original was
deleted). `tests/helpers/theme-css.js`'s `readThemeCss()` derives sheet order by parsing `head.ejs`'s own
`<link>` hrefs — one owner of order, so the test helper can never drift from what the app actually
serves.

**Accepted tradeoff: one stylesheet request became five.** `express.static(config.PUBLIC_DIR)`
(`src/app.js`) sets no explicit `Cache-Control` on `/css/*`, so the browser conditionally revalidates
every sheet on every navigation — where one such round trip sufficed before this split, a navigation now
pays five. Accepted rather than fixed here because production sits behind a reverse proxy (Caddy or
nginx, per `docs/deploy.md`) terminating TLS, and a TLS-terminating proxy in front of a modern browser
negotiates HTTP/2 (or better) by default, which multiplexes all five requests over the single already-open
connection — the wall-clock cost of five small conditional GETs over one multiplexed connection is not
five times the cost of one, so north-star goal A ("fast under the whole party at once") was considered
and judged unaffected in practice, even though the raw request count is a real five-fold increase.

**Known, disclosed byte-identity artifact — since closed (#921, #927/PR #1005).** `base.css`'s first
line briefly read `/* src/public/css/theme.css */` — the original file's own top-of-file header
comment, left naming a file that no longer existed, because correcting it at split time would have
broken the byte-identity concatenation that issue's own acceptance criterion required and would have
invalidated the pixel-equal visual-approval re-persist. That constraint was the visual-approval hash
recorded in `.review_state/`, not the governance freeze (nothing under `src/` is governance-frozen; the
freeze scopes to `.githooks/`, `tools/`, `standards/`, `agents/`, `skills/`, `.github/`, `.claude/`,
`CLAUDE.md`, `AGENTS.md`, and `docs/north-star.md` only; see `CLAUDE.md`'s "Governance freeze" section) —
any edit to `base.css` re-persists that hash per the render-identical rule (a pixel-equal change gets a
fresh approval record against the reviewer's pixel-equal verification rather than bouncing back to the
owner for a "re-confirm"), so the fix was always a same-day, no-owner-gate change once someone next
touched the file. The header correction landed on `origin/main` via #927 / PR #1005. `base.css`'s first
line now reads `/* src/public/css/base.css */`.

**Follow-up, explicitly not this issue.** The five CSS slices are contiguous, not surface-pure (a rule's
sheet is decided by its position in the original file, not by which surface — guest, admin, feed — it
styles). Regrouping into surface-pure sheets is a possible post-wedding follow-up; it was out of scope
here because proving a reshuffled cascade produces pixel-identical output is a materially bigger
verification problem than proving a contiguous cut does. Similarly, `src/routes/admin.js`'s 29 non-test
prose pointers ("src/routes/admin.js's guest-delete route", etc.) were left as one-hop-not-dead-end
degradations rather than rewritten file-by-file — the mount file's own area-map comment is the recorded
answer for a reader who follows one of those pointers and finds no handler bodies there — and the
omission is parked as a single line on #588 per the freeze's own finding-disposition rule.

**A fifth module joins the pattern: `src/services/photos.js` (#979).** photos.js (1,786 lines) was the
last #969-class oversized module — six concerns (pipeline constants, multer intake, HEIC detection/
pixel-cap/worker-decode/convert, thumbnail + avatar processing, path/URL builders, and takedown/restore/
hardDelete moderation) in one file. It splits the same way: a thin entry (`src/services/photos.js`,
unchanged require path and public API) plus seven internals under `src/services/photos/` —
`constants.js`, `naming.js`, `heic.js`, `intake.js`, `processing.js`, `paths.js`, `moderation.js`.

Two decisions this split needed that the original four did not:

- **The worker-path resolution.** `heic.js`'s `HEIC_WORKER_PATH` used to resolve
  `path.join(__dirname, 'heic-worker.js')` — a same-directory sibling, since both files lived directly
  under `src/services/`. `src/services/heic-worker.js` did NOT move (worker_threads workers are simplest
  left as a stable, unmoved target), but `heic.js` now lives one directory deeper at
  `src/services/photos/heic.js`, so the resolution became `path.join(__dirname, '..', 'heic-worker.js')`
  — the same pattern `HEIC_WORKER_PATH`'s own test-seam override already exercised, just with the
  production default's base directory shifted by one level. A wrong path here fails only at runtime on a
  real HEIC decode, not at require time, so the split's verification ran the real-decode suite
  (`tests/heic-conversion.test.js`) standalone rather than trusting a green full-suite run alone to prove it.
- **`heicDecodeSemaphore`'s single owner.** Tests observe the live singleton directly (the same
  "import the live instance" pattern `src/utils/upload-concurrency.js`'s `uploadSemaphore` already
  established), so it must be constructed in exactly one place and re-exported by reference everywhere
  else touches it. It is now created once in `heic.js` and re-exported unchanged by the entry —
  `photos.heicDecodeSemaphore === require('./photos/heic').heicDecodeSemaphore` is `true`, proving no
  second `new Semaphore(1)` was ever introduced along the way.

**A sixth module joins the pattern: `src/routes/guest.js` (#991).** guest.js (1,688 lines) was the
largest remaining handwritten module over the ceiling. It splits the same way: a thin entry (`src/routes/
guest.js`, unchanged require path and public API, `router.use(requireGuest)` then the area mounts) plus
seven internals under `src/routes/guest/` per its own seam table — `home.js` (`GET /`), `tasks.js`
(`GET /tasks`, `GET /tasks/:id`, `POST /tasks/:id/submit`), `pages.js` (`GET /how-to-play`,
`GET /how-points-work`), `bug-report.js`, `memories.js`, `profile.js` (`GET`/`POST /me/edit`,
`POST /me/avatar/delete`), and `recap.js` — plus `shared.js` for the four cross-area members.

**The shared-limiter invariant.** `uploadRateLimiter` and `socialRateLimiter` (issue #283) are each one
combined per-guest rate budget consumed by three different POST routes now living in three different
files (`uploadRateLimiter`: `tasks.js`'s submit route and `profile.js`'s `/me/edit`/`/me/avatar/delete`;
`socialRateLimiter`: `bug-report.js` and `recap.js`'s two routes). A split that let each consuming module
construct its own `createRateLimiter(...)` call would silently double (or triple) the budget each was
meant to enforce, without any test failing — every route would still 429 eventually, just at the wrong
threshold. `shared.js` constructs both exactly once at module load, exporting the single instances;
Node's `require.cache` guarantees every consumer gets the same object, so the split cannot introduce a
second budget the way a careless per-file construction would.

Same treatment as #969's own stale-pointer note: this split's prose pointers elsewhere in the repo
naming `src/routes/guest.js`'s routes degrade gracefully through the entry's own area-map comment; the
omission is parked as one line on #588 per the freeze's finding-disposition rule.

## Lint is a ratchet (#973)

**Date:** 2026-08-01. **Status:** shipped.

`npm run lint` now runs `eslint . --max-warnings=0`, so the required `lint` status check on `main`
blocks on any warning, not only an error — a warning introduced by future work is a blocking signal
instead of noise buried under a standing count of tolerated ones. `no-unused-vars` (both the server and
browser blocks in `eslint.config.js`) and `no-useless-escape` (back to its `recommended` default,
the config's own `'warn'` override deleted) are recorded at `error` to match: once any warning is fatal,
recording an unused-variable or useless-escape rule as merely `'warn'` would mislead a reader of the
config into thinking it advisory when it in fact blocks a merge.

Browser-shipped files under `src/public/js/` keep their `catch (x) {}` bindings, `_`-prefixed and
cleared by the browser block's new `caughtErrorsIgnorePattern: '^_'` (matching the arg/var patterns it
already declared) — the repo declares no browser baseline and ships no other ES2019-only syntax there,
so this issue introduces nothing new to guests. Server-side files run on Node >= 20 (`package.json`
`engines`), where the parameterless optional catch binding (`catch {}`) is safe and already used
elsewhere in `src/`; the 17 formerly-unused server-side catch bindings this issue cleared all switched to
that form instead of gaining a `_`-prefix, since a server file has no browser-parity reason to keep the
now-unused identifier at all.

## Hover-only ink gated behind @media (hover: hover) (#921)

**Date:** 2026-08-01. **Status:** shipped.

The five stylesheets carried 48 `:hover` rules with no hover-capability media query anywhere, so a
phone's emulated hover (triggered by the tap itself) stuck the tapped control's hover ink until the
guest tapped elsewhere. Every `:hover` rule is now wrapped in place in `@media (hover: hover)` — same
selectors, same declarations, same cascade position — rather than stripped or replaced with `:active`,
because the desktop/mouse experience is unchanged and gating carries zero redesign risk: a hover-capable
device still gets exactly the ink it had before, and a touch device simply never triggers a rule it was
never meant to see.

`.admin-tile-actions` (the admin photo grid's per-tile action row) was the one rule that _depended_ on
the sticky behavior to be reachable on a phone at all — it defaulted to `opacity: 0`, revealed only by
`:hover`/`:focus-within`/`:has(.admin-fav-on)`. Gating its `:hover` member without a touch replacement
would have made the actions unreachable by tap. The owner settled the touch treatment live at the
2026-08-01 preview: `@media (hover: none) { .admin-tile-actions { opacity: 1; } }` — always visible on a
non-hover device, no `:active` state and no JS reveal added, keeping the fix CSS-only. The
`:focus-within` and `:has(.admin-fav-on)` members of that same selector group stay ungated on purpose:
neither is hover-dependent, and gating them would have broken the keyboard-focus reveal and the
favorited-state reveal on every device, including hover-capable ones.

`tests/hover-gating.test.js` now enforces the invariant mechanically going forward: it strips comments
and quoted strings, walks brace depth with a stack of enclosing `@media` conditions, and fails on any
`:hover` rule (across all five sheets) that doesn't carry `(hover: hover)` on that stack — a rule added
later with no gate fails CI the same way a forgotten one would have failed review here. The AC3
before/after preservation check (declarations unchanged, original relative order, wrapped in place) is a
pre-commit `git diff` comparison against `HEAD`, not a committed assertion — after merge `HEAD` becomes
the post-change file and the comparison would be vacuous, so it lives as PR-review evidence instead.

## One guest-avatar component, four call sites (#1011)

**Date:** 2026-08-02. **Status:** shipped.

Four surfaces label photos with a guest's name directly above them — the Shared Gallery By-person
section head, the guest feed card header, the admin Photos By-person section head, and the admin inline
moderation feed card header — but only one (the Shared Gallery head) ever showed the guest's real photo;
the rest were name-only or initials-only. `src/views/partials/guest-avatar.ejs` is now the single
component all four include: a 34px (`md`) or 28px (`sm`) circle rendering `<img src="/uploads/...">` when
`guests.avatar_path` is set, else `app.locals.initials(name)` (or `?` for an empty/absent name) in an
`aria-hidden` span. One component instead of a fourth hand-copied avatar-circle block is the same
standardization CLAUDE.md's "Repo conventions" names directly for this exact pair of surfaces.

**Why the admin route needed a new column and the guest surfaces did not.** `src/services/feed.js`'s
`GALLERY_COLUMNS` already selected `g.avatar_path AS guest_avatar_path` for every gallery/feed query, and
its `grouped()` helper already stamped `group.avatar_path` from each partition's first (newest) row — the
two guest surfaces render straight off data that was already there. `GET /admin/photos`'s `photosSelect`
(`src/routes/admin/moderation.js`) had never selected `avatar_path` at all: phase 1 faked the admin
avatars with a hard-coded name -> filename map purely to settle the look live, a scaffold this issue
deletes outright. The real fix adds `g.avatar_path AS guest_avatar_path` to `photosSelect` (so the inline
moderation feed card, which reads a photo row directly, has real data) and gives `groupPhotos()` an
optional `avatarFn` parameter that stamps `group.avatar_path` from the partition's first row exactly the
way `grouped()` already does — passed only on the By-person grouping call (`groupPhotos(livePhotos, keyFn,
guestLabel, (p) => p.guest_avatar_path)`), since the By-task grouping has no single guest to show an
avatar for and passes no `avatarFn` at all.

**The feed's name row and action bar now share one inset, superseding #890 AC7's flush action bar.** #890
put the guest feed's action bar flush at the photo's edge (`padding-inline: 0`) on the reasoning that the
name row above it already carried the full gutter and the action bar reading flush against the photo
looked deliberate. With an avatar now leading that name row, flush read as too tight against the phone's
glass at narrow widths (owner directive, live preview, 2026-08-01) — `.feed-by` and `.feed-actionbar` are
regrouped onto one shared `padding-inline: var(--space-3)` rule, scoped off `.admin-feed-item` the same way
the prior flush rule was, so the admin moderation feed's own `.feed-by`/`.feed-actionbar` keep their full
`--gutter` inset untouched. This is a recorded owner re-decision, not a regression from #890 —
`tests/feed-full-bleed.test.js`'s issue-#890 case now asserts the superseding shared-inset rule instead of
the retired flush one.

**Every call site derives its initials from the exact label it prints beside the circle — one rule, not
four guesses.** AC3 was amended (see the issue) after the design-philosophy gate found the original cut let
one nameless guest render four different faces: the two section heads (`gallery.ejs`'s `g.heading`,
`admin-photos.ejs`'s `g.heading`) already pass an already-resolved label — `feed.js`'s `grouped()` and this
issue's own `groupPhotos()`/`guestLabel()` resolve `row.guest_name || 'Guest'` / `'Guest #' + guest_id`
before the view ever sees it — and rendered `G`/`G#`, while the two card headers passed the raw
`guests.name` straight to the partial and rendered `?`. The fix is not a second resolution rule; it is
handing the partial the same string each call site already prints as text: `feed.ejs`'s card now passes
`p.guest_name || 'Guest'` (the exact expression its adjacent `<span>` prints), and the admin inline feed
card now passes `p._guest_label` (the same single-owner value, `guestLabel()`, its adjacent
`.admin-feed-name` span already prints). The two section heads needed no change — they already satisfied
the rule. A guest with a name renders identically before and after: `p.guest_name || 'Guest'` and
`p._guest_label` both equal the raw name whenever it is non-empty, so this only changes output for the
nameless case AC3's amendment targets.

**Hand-copied avatar circles remain outside this change, a known duplicate for a future issue to fold
in.** `.likes-row-avatar` and `.comments-dialog-avatar` (`src/views/feed.ejs`) are scope-limited by AC1
to stay byte-unchanged; `src/views/leaderboard.ejs` (two: `.podium-cluster-avatar` and `.lb-avatar`),
`src/views/public-profile.ejs`, `src/views/guest-home.ejs`, and `src/views/me-edit.ejs` each still
hand-copy their own "photo-if-set, initials-if-not, clipped to a circle" markup — `me-edit.ejs` loosely,
with an inline `charAt(0)` rather than the shared `initials()` helper. No count is given here on
purpose: a numeral in this sentence is falsified by the next surface added or folded in, and the file
list is the part worth keeping true. These are pre-existing, out of #1011's scope, and left as the
remaining known duplicates, not a defect this issue introduces.

## response compression: app-level, brotli+gzip negotiated, not the reverse proxy — and the accepted BREACH tradeoff (#1012)

**Date:** 2026-08-02. **Status:** shipped.

**Where the numbers come from.** Every byte count in this ADR was measured against the seeded `extreme`
story (`scripts/seed-story.js`'s `STORIES.extreme`) on node 24.16.0, at the commit this ADR landed in.
Rendered-page figures move whenever the markup does — rebasing this change onto #1011's guest-avatar
work shifted `/gallery?view=user` from 159,226 to 158,758 identity bytes, 0.3%, without moving its
saving off 95%. Treat the ratios as the durable claim and the absolute byte counts as a snapshot; the
acceptance criteria in #1012 assert relative savings for exactly that reason, and `tests/compression.test.js`
is what actually holds the floor over time.

The server sent every response uncompressed — measured against the seeded `extreme` preview story
(60 guests, 327 visible photos), `/admin/photos` shipped 2,342,583 bytes where gzip level 6 would have
sent 66,147 (97% smaller), and `/gallery?view=user` shipped 159,346 where gzip would have sent 9,723
(94% smaller). Modelled at 1 Mbps (a congested venue access point), that is the admin Photos wall taking
~18.7s to arrive instead of ~0.5s. This is the cheapest available move on Goal A ("fast under the whole
party at once") — it costs 0.66-6.45 ms of server CPU per response (`zlib.gzipSync` level 6, 20-iteration
mean) and helps every page, not one screen. These figures, from the issue's own pre-change measurement,
describe the size of the problem and are labelled gzip because that is what was measured; they are **not**
what production serves — see the next section.

**What actually ships is negotiated brotli/gzip, not gzip.** `compression` 1.8.1 prefers brotli over gzip
whenever the running node has brotli support (`node_modules/compression/index.js:37,44-45`,
`'createBrotliCompress' in zlib`) — true on every node version this repo targets (`package.json`'s
`engines.node` is `>=20`; brotli support landed in Node 11.7). A real browser's
`Accept-Encoding: gzip, deflate, br, zstd` therefore negotiates to `Content-Encoding: br`, not `gzip`. The
library's own brotli default is `BROTLI_PARAM_QUALITY` 4 (`index.js:65`), which is a size **regression**
against the gzip level 6 the issue measured against on this app's own terse text assets:

| File                    | gzip level 6 | brotli quality 4 |
| ----------------------- | ------------ | ---------------- |
| `css/base.css`          | 14,955 B     | 15,597 B (+4.3%) |
| `js/badge-icon-tags.js` | 27,481 B     | 28,176 B (+2.5%) |

Shipping the library default would have made a real guest's browser measurably _slower_ than every figure
in this ADR and the issue it came from. `src/app.js` section 3b now sets brotli quality explicitly instead
of taking the default, chosen from a full measurement across four representative payloads (a large
seeded-`extreme` list page, `/login` as a small page, `css/base.css`, `js/badge-icon-tags.js`), size and
mean compress time (20 iterations, matching the issue's own gzip methodology) at every brotli quality
level 4-11 against the gzip level 6 baseline:

| Level     | gallery (159,226 B raw) | login (2,982 B raw) | base.css (50,782 B raw) | badge-icon-tags.js (115,455 B raw) |
| --------- | ----------------------- | ------------------- | ----------------------- | ---------------------------------- |
| gzip 6    | 9,718 B / 0.680 ms      | 1,227 B / 0.059 ms  | 14,955 B / 0.718 ms     | 27,481 B / 1.540 ms                |
| brotli 4  | 9,142 B / 0.844 ms      | 1,137 B / 0.182 ms  | 15,597 B / 0.657 ms     | 28,176 B / 1.040 ms                |
| brotli 5  | 7,858 B / 1.346 ms      | 1,039 B / 0.401 ms  | 14,544 B / 1.056 ms     | 26,677 B / 1.833 ms                |
| brotli 6  | 7,771 B / 1.796 ms      | 1,034 B / 0.777 ms  | 14,418 B / 1.700 ms     | 26,435 B / 2.334 ms                |
| brotli 7  | 7,691 B / 3.700 ms      | 1,039 B / 1.821 ms  | 14,365 B / 4.045 ms     | 26,307 B / 5.055 ms                |
| brotli 8  | 7,588 B / 4.028 ms      | 1,039 B / 1.307 ms  | 14,303 B / 4.716 ms     | 26,203 B / 6.132 ms                |
| brotli 9  | 7,469 B / 5.863 ms      | 1,034 B / 1.398 ms  | 14,283 B / 8.370 ms     | 26,101 B / 8.819 ms                |
| brotli 10 | 6,851 B / 28.741 ms     | 934 B / 1.456 ms    | 13,196 B / 14.767 ms    | 24,224 B / 34.565 ms               |
| brotli 11 | 6,562 B / 166.398 ms    | 912 B / 2.738 ms    | 12,844 B / 40.017 ms    | 23,567 B / 92.195 ms               |

**Quality 6 was chosen — over quality 5, not over the whole range.** Quality 4, the library default,
regresses two of the four files against gzip 6, as the table above shows; that is what rules it out.
**Quality 5 is the lowest that beats gzip 6 on every file**, so the choice was between 5 and 6, and 6 wins
by 0.5-1.1% on size for 1.3-1.9x the compression time (gallery 1.796 ms vs 1.346 ms; base.css 1.700 vs
1.056). Both sit under 2.4 ms — the same order of cost as the gzip-6 baseline this change already judged
cheap enough to pay on every response — so the margin was spent on bytes. Against gzip 6 itself, quality 6
saves 3.6-20% (base.css 3.6%, badge-icon-tags.js 3.8%, login 15.7%, gallery 20.0%).

**If server CPU ever becomes the binding constraint under real party load, quality 5 is the move**, not a
retreat to the library default: it gives back ~1% of the size for ~30% of the compression time. Going the
other way is the bad trade — quality 9 buys 0-3.9% more at 1.8-4.9x the CPU, and quality 10-11 buy
8.4-15.6% at 1.9-92.6x (166 ms for one 159 KB page at quality 11), a curve that works directly against
Goal A's "fast under the whole party at once" once a hundred phones are generating concurrent requests.

Quality 6 is set via
`compression({ brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } } })` in `src/app.js`, not the
library default.

**Known, unreached edge: a `Range` request for a compressible static asset.** `compression` has no
206 guard — its filter checks `no-transform`, the size threshold, an already-set `Content-Encoding`,
and `HEAD`, but never `res.statusCode`. So `GET /css/base.css` with both `Range: bytes=0-4999` and a
browser `Accept-Encoding` comes back `206` with `Content-Range: bytes 0-4999/50782` _and_
`Content-Encoding: br` over a 1,938-byte body — a range describing the identity representation
wrapped around a compressed one. Left as-is rather than fixed: closing it means supplying a custom
`filter`, which is exactly the hand-rolled replacement this ADR argues against, and nothing reaches
it. The assets browsers range-request are media; this app serves none, and its two large
downloadables — uploaded JPEGs and the `application/zip` keepsake export — are excluded by the
`compressible` table before negotiation runs. If a future change adds a range-served text asset, the
fix is `filter: (req, res) => res.statusCode !== 206 && compression.filter(req, res)`.

**Placement: `app.use(compression(...))` in `src/app.js`, not a directive in the reverse-proxy config.**
`docs/deploy.md`'s nginx/Caddy blocks are hand-copied by whoever stands up a host and are not
version-controlled in this repo — nginx ships `gzip off` by default and Caddy v2 does not enable `encode`
unless asked, so a proxy-level fix would need to be re-applied, correctly, on every future host (Docker,
the event laptop, and prod) with no test ever catching a host that forgot it. An `app.use` inside the
module this repo owns and tests (`src/app.js`) is the only placement guaranteed present everywhere the
app runs. It sits ahead of the static mounts and every router (`src/app.js`, section 3b) so both static
assets and rendered HTML pass through it, using `compression`'s own default filter (the `compressible`
table) rather than a hand-rolled one — that table is what makes an uploaded `image/jpeg`, a thumbnail, and
the `application/zip` keepsake export (`src/services/export.js:292`) pass through unencoded (no server
CPU wasted recompressing already-incompressible bytes). The table also marks `image/svg+xml` compressible,
but that is only half the gate: `compression`'s 1 KB default `threshold` is a second filter neither this
note nor the original issue mentioned, and only 28 of the 365 bundled badge glyphs under `src/public/`
exceed it (largest: `completionist.svg`, 2,655 B) — measured directly against the running app, a request
for a small glyph like `/badges/icons/star.svg` (379 B) returns 200 with no `Content-Encoding` at all. Most
badge SVGs ship uncompressed, correctly, because compressing a response under ~1 KB costs more in HTTP
framing overhead than it saves.

**BREACH: considered, accepted for this event, follow-up filed as #1013.** Compressing a response that
carries a stable secret alongside attacker-influenced reflected input is the textbook BREACH
precondition, and both halves are present here: `src/middleware/csrf.js` issues one token per session,
not per response (its own comment at `:216` — "a returning guest/admin keeps the SAME token for their
whole session"), and the `q` search parameter is reflected into the rendered page at
`src/views/gallery.ejs:34` and `src/views/admin-photos.ejs:69`. Exploiting it needs an on-path attacker
who can observe TLS record sizes for one guest's connection AND induce that guest's browser into many
hundreds of cross-origin requests carrying attacker-chosen `q` values; the payoff is that one guest's CSRF
token, usable to forge an upload or a like as them for the duration of one wedding weekend. Weighed
against a measured 16-35x transfer-time reduction for every guest on every page all night (the gzip-6
figures above; brotli quality 6, what actually ships, measured equal-or-better on every sampled file, so
this is a floor, not an overstatement), the exposure is accepted rather than engineered around here. The
standard mitigation (per-response token masking) is filed as #1013 instead of folded into this change,
because it edits security-critical comparison logic in `csrf.js` and earns its own review rather than
riding along on a middleware addition.

**Update: #1013 shipped.** The paragraph above records the decision made at the time this compression
change landed, in present tense — "the exposure is accepted" — which reads, taken alone, as still true
today. It is not: per-response token masking landed as #1013 (see "Per-response token masking (#1013)",
CSRF tokens and security headers section, above in this file) and closes the "stable secret" half of the
BREACH precondition described here. Read this note together with that one, not in isolation.

`tests/compression.test.js` covers five of the six acceptance criteria directly: a >= 80% saving floor on
`/gallery?view=user` seeded at `extreme` scale (measured 93.9% at merge time — the ordinary one-guest
`seed()` fixture only clears 68%, which is why the test seeds the full story instead), a >= 40% floor on
`/css/base.css` (measured 70.6%), an unencoded plain request, an unencoded uploaded photo, an
unencoded-but-still-readable ZIP export, and — added in this fix pass — that a real browser's multi-value
`Accept-Encoding: gzip, deflate, br, zstd` negotiates to `Content-Encoding: br` and round-trips back to the
identity body. AC6 ("green: `npm test`, `npm run lint`, `npm run format:check` all exit 0") is a CI gate on
the whole repo, not a property the test file asserts about itself; no test file can meaningfully cover it.

**Two things this change hands forward.** First, it is not true in production until it deploys — the
evidence that opened #1012 was a live `curl` of `lillyandaxel.com/login` returning no `Content-Encoding`,
so the same curl re-run after deploy (expecting `Content-Encoding: br`) is what actually closes it, not
the merge. Second, `compression` is a prod dependency in front of every response — a bad bump to it does
not degrade one screen, it breaks or corrupts every response the app produces. At the time this change
merged it sat on none of the three wedding-critical mirrors, so a Dependabot bump to it would have
classified `auto` — the tier a human triager may merge on green CI with no separate review. That gap was
closed by #1018 (merged `37b0cdf`, owner-approved frozen-surface change, authorised 2026-08-02): `compression`
is now on all three wedding-critical mirrors and the drift guard, and the classifier returns `review` for it,
not `auto`.

**Prizes (#469) gets its own settings-accessor pair, deliberately beside — not inside —
`getEventConfig`/`setEventConfig`.** `src/db/event-config.js` already owned one reader/writer pair over the
generic `settings` key/value table (`ensureSettingsTable`, shipped with #681) for the event's timezone and
wedding date range, consumed by every date-aware feature. The hosts' prizes blurb (Goal B's "visible
stakes" outcome) needed the exact same storage shape — one more string key in the same table — but folding
it into `getEventConfig`'s returned object, or `setEventConfig`'s parameter object, would have widened that
pair's contract to cover an unrelated concern for every existing caller (day chips, daily challenges, the
dashboard checklist), none of which have anything to do with prizes. `getPrizes(db)`/`setPrizes(db, text)`
are a second, independent pair in the same file, built on the file's existing private
`readSetting`/`writeSetting` helpers, re-exported from `src/db.js` the same way the timezone pair already
is. The one place both pairs meet is `POST /admin/config` (`src/routes/admin/config.js`): the same
handler normalizes the prizes text up front and calls `setPrizes` only once the timezone/date trio has
passed — so a rejected save still leaves every setting, prizes included, exactly as it was (the same
"nothing persists unless the whole form passes" rule `setEventConfig` already got). The key stays in the
one file that owns admin-config settings keys; no new migration was needed since `ensureSettingsTable()`
already guarantees the table.

**Design-philosophy review of #469 (round 1) caught the length cap living in two ungoverned places.**
`src/routes/admin/config.js`'s server-side clamp and `src/views/admin-config.ejs`'s textarea `maxlength`
both hand-typed the literal `500` with nothing tying them together. The fix folds the cap into the same
`src/db/event-config.js` pair described above: `PRIZES_MAX_LENGTH` is the one constant both sides now
read (the route passes it through as the `prizesMaxLength` render local, the view interpolates it into
`maxlength`), and `normalizePrizes(text)` — trim, cap at `PRIZES_MAX_LENGTH`, drop a UTF-16 lead surrogate
left dangling by the cut, mirroring `normalizeCaption` in `src/services/submissions.js` — is the one
function that decides what a stored prizes value looks like. The route reduces to one variable,
`const prizes = typeof req.body.prizes === 'string' ? normalizePrizes(req.body.prizes) : null`, gated by
`if (prizes !== null) setPrizes(prizes)` — `null` distinguishes an absent `prizes` key (an old cached
form posting nothing) from a present-but-empty one, which is the deliberate "clear the prizes" case AC3
covers.

## Comment keep test: single-owner review check for comments that restate the code (#1026)

**Date:** 2026-08-02. **Status:** shipped.

**Why `standards/design-philosophy.md` owns it.** The comment-doctrine rule already lived, in part, in this standard's "Obvious code" principle ("If you need a comment to explain what it does (not why), redesign it") — the other two homes (`agents/reviewer-design-philosophy.md`'s checklist item and `agents/implementation-agent.md`'s "Comments: meaningful, not decorative.") were downstream citations that had drifted into restating the doctrine instead of pointing at it. A fourth home was on the table — folding the check into the `information leakage` red flag, since a comment that restates code duplicates a fact the code already asserts — but that red flag's job is a duplicated fact shared between two modules, not a comment's relationship to the single line it sits beside; forcing the keep test through that shape would blur a defect class that already has six real precedents (#89, #87, #80, #78, #86, #88) with a different one. The "Obvious code" principle already owned the doctrine's spirit, so it becomes the one full-text owner; `agents/implementation-agent.md` now carries a one-line citation, and `agents/reviewer-design-philosophy.md` carries a citation plus its own required-input rule (the diff the verdict is bound to) rather than restated prong text.

**Why severity is a minor ceiling.** A comment failing the keep test is noise, not a correctness, security, or data-loss defect — the code underneath is unaffected either way. `standards/adversarial-review-protocol.md`'s severity vocabulary reserves `major` for crash, data-loss, or security defects; stacking a comment-style nit on top of that bar would inflate it. Capping the finding at `minor` routes it through the protocol's `## One-round stop rule`: fixed inline, no re-check round, no blocked merge — proportionate to what the defect actually costs.

**Why a principle, not a red-flag row.** `standards/design-philosophy.md`'s red-flag table carries a stated invariant: a match is at least `major` and can never be downgraded. A ceiling of `minor` directly contradicts a floor of `major` — the two rules cannot coexist on the same row. Extending the existing "Obvious code" principle instead of adding a row keeps the red-flag table's never-downgrade guarantee intact for the patterns that actually earn it (shallow module, information leakage, temporal decomposition, pass-through, vague name) while giving comment noise the lighter disposition it deserves.

## One shared backdrop-dismiss owner: press target must agree with click target (#879)

**Date:** 2026-08-02. **Status:** shipped.

**The bug.** `src/public/js/admin-tasks.js`, `src/public/js/badge-picker.js`, and `src/public/js/slideshow-launch.js` each independently dismissed their `<dialog>` on `if (event.target === dialogEl) dialogEl.close()`, reasoning that a click's `target` is the dialog element itself only when the click lands on the dialog's own `::backdrop`. That reasoning covers a genuine backdrop press-and-release, but misses a second, more common path to the same `target`: when a click's press and release land on different elements, the browser dispatches the `click` on their nearest common ancestor. For a modal `<dialog>`, the backdrop is owned by the dialog element itself, so a press that starts inside the dialog (e.g. a host drag-selecting text in a field) and releases past the dialog's edge is retargeted to the dialog — a click the old handlers could not distinguish from a real backdrop click. The dialog closed and discarded whatever the host had half-typed. The owner reproduced this live on the seeded preview 2026-07-24 and confirmed the desired fix: a drag-out leaves the dialog open, a genuine backdrop press-and-release still closes it.

**Why the click target alone can never be the right check.** `event.target` on the `click` only tells you where the release (and the browser's retargeting) landed — it says nothing about where the gesture started. Distinguishing "backdrop press-and-release" from "press-inside, release-outside" requires a second data point: where the immediately preceding press landed. `src/public/js/dialog-dismiss.js` records that on `pointerdown` (Pointer Events, not mouse events, matching `admin-tasks.js`'s existing drag-to-reorder code and the admin surface's phone-first design) and only closes when both the recorded press target and the click target are the dialog element itself. A stale `true` left over from a previous cycle is cleared on the dialog's own `close` event, so a dialog closed by Escape, a Cancel button, or this handler itself never leaks a "press was on the dialog" fact into its next open.

**Why one shared module, not four copies of the fixed check.** All four backdrop-dismissing dialogs in the app (`task-edit-dialog`, `task-create-dialog`, `badge-picker`, `slideshow-dialog`) shared the identical bug because they shared the identical (wrong) one-line check, copy-pasted rather than owned in one place. `window.DialogDismiss.backdrop(dialogEl)` is now the single owner of "does this click really mean close the dialog," in the same single-`window.`-owner shape `src/public/js/badge-icon-mask.js` (#869) already established for a different cross-file concern. A future correction to the press/click-agreement rule now has exactly one call site to fix, not four.

**Why `src/public/js/lightbox.js` and `recap.js`'s badge-celebration backdrop close were left alone.** Both use the same superficial shape (`event.target === el`) but neither holds user input a mis-drag could discard — `lightbox.js` is a photo viewer, and the celebration dialog's own close path deliberately interacts with `badge-moment.js`'s queue fast-forward. Folding either into the shared module would be a behavior change with no defect behind it, not a fix. The inline moderation-thread dialog handler in `src/views/admin-photos.ejs` was excluded for the identical reason (hidden fields and submit buttons only, nothing to lose). The guest-facing surface has the same defect class — `src/public/js/feed.js`'s comments dialog and `src/public/js/photo-owner-menu.js`'s caption dialog — but each serves many dialog instances per page through one delegated listener rather than one dialog element a caller can hand to `backdrop()` directly; that's issue #1041, which depends on this module rather than extending it here.

## `guestPhotosPage`: a second paged reader beside `recentPage`, not a generalization of it (#1004)

**Date:** 2026-08-02. **Status:** shipped.

`/u/:guestId` rendered a guest's entire visible photo history in one response with no `LIMIT` — a
profile carrying dozens of submissions built an unbounded page before it painted, on a surface every
gallery grouping and leaderboard link points at. `src/services/feed.js`'s `recentPage` (`/gallery`'s
own paged reader) already owns a floor-and-clamp block for exactly this shape of problem — a page
argument from the route that may be `NaN`, zero, negative, or a float floors to page 1, and anything
past the last page clamps down to it — so the fix mirrors that block into a new `guestPhotosPage(guestId,
page)`, rather than reshaping `recentPage` to also take an optional guest id.

The two readers are not the same query with one extra predicate: `recentPage`'s `galleryQuery` builds a
gallery row (`guest_id`, `name`, an optional `task_id = ?` filter) for the everyone-wall and its by-task
filter, while `guestPhotosPage` builds a profile row (no `guest_id`/`name` — the caller already has the
one guest) with no task filter at all, always scoped by `guest_id = ?`. Threading a guest-scope option
through `galleryQuery`/`recentPage` would have added a third WHERE shape and a third column list to a
function that already carries two, for a caller (the profile) the owner scoped to its own surface at the
phase-1 loop — no shared abstraction was requested, and none is taken speculatively here.

What the two paged reads DO share is the clamp arithmetic, and that is owned in one place rather than
duplicated: `clampToPage(page, total)` returns `{ page, totalPages, offset }` for both `recentPage` and
`guestPhotosPage`. The first cut of this change hand-copied those nine lines and defended the copy as
cheaper than a helper; both PR review and design-philosophy review landed on the same objection, and
they were right — the copy meant a later correction to what an out-of-range page means (floor to 1
versus clamp to the last page) could be applied to `/gallery` and missed on `/u/:guestId`, two surfaces
a guest reaches from the same tile, with the divergence invisible until someone hand-typed a URL. The
query shape is what differs between these readers; the clamp rule is not, so it gets one owner.

The SQL is shared the same way, on the same reasoning. `GUEST_PHOTOS_SELECT_BODY` is the one place the
profile's column list and `LEFT JOIN tasks` predicate live, and `GUEST_PHOTOS_WHERE` is the one place its
row-set rule lives — both reused by the pre-existing unpaged `stmtGuestPhotos` and by the new
`stmtGuestPhotosCount` / `stmtGuestPhotosPage` pair, mirroring what `GALLERY_SELECT_BODY` already models
for `PHOTO_DETAIL_SELECT` and what `galleryQuery` already does for `recentPage`'s own count/page pair. The
WHERE in particular has to be single-owner rather than merely tidy: the count statement decides
`totalPages` and the page statement fills the grid, so if a later change narrows one and misses the other,
the profile offers a "Show more" link to a page that comes back empty — precisely the state AC4 exists to
rule out, and one every current test would miss, since they all seed a single uniform kind of row.

`guestPhotos` itself is kept, exported, and now has no production caller: `src/routes/community.js` was its
only one and is now repointed. It survives for `tests/feed.test.js`'s visibility assertion alone, and its
export carries a comment saying so — an unbounded read left on the interface of the module whose job is to
bound reads is a trap for the next surface that needs one guest's photos (a keepsake export, a printable
profile), which would otherwise reach for the obvious name and reintroduce exactly what #1004 removed.

## One date-field component, styled native `<input type="date">` (#875)

**Date:** 2026-08-02. **Status:** shipped.

`src/views/partials/date-field.ejs` is a new reusable view component: one labelled
`<input type="date">` plus a green line-drawn calendar-glyph button, wired by
`src/public/js/date-field.js` and styled by a shared rule set promoted into
`src/public/css/guest.css`. `/admin/config`'s "Wedding starts" and "Wedding ends" fields are its
first two call sites, each passing `id`/`name`/`label`/`value` and (the end field only) `min` and
a `rangeRole` that tags the pair for the range-wiring script.

**Why a styled native `<input type="date">` rather than a custom calendar widget.** A custom widget
means shipping and maintaining date-grid markup, keyboard handling, and locale-aware month/day
formatting ourselves, and it opts every guest-facing host out of whatever accessibility settings
their own device already applies (larger touch targets, a screen reader's own date-picker
narration, right-to-left layout). The native control gets all of that for free — "every phone
contributes its own OS picker" — at the cost of not controlling how that picker looks, which is a
cost this issue's approved screen accepts: the picker itself is unstyled, only the field and its
opener button carry the wedding's look.

**Why the calendar button is ours rather than a restyled
`::-webkit-calendar-picker-indicator`.** That pseudo-element is Chrome/Edge-only and, more to the
point, Safari on macOS draws no picker indicator at all for a bare `type="date"` field — a
plausible planner's machine per the issue's report — so there is nothing there to restyle on that
engine. Standing up our own button is the only approach that puts an affordance on every engine.
`date-field.js` collapses the browser's own indicator
(`.date-field.js-date .date-input::-webkit-calendar-picker-indicator`) only for a field whose own
button has actually rendered — the `js-date` class is added to that field's own `.date-field`
wrapper, not the document, so a scripts-off page (or a field whose button lookup somehow failed)
never loses the native affordance with nothing put back in its place (AC6), and a scripts-on page
never shows two glyphs at once.

**Shared CSS, not a second copy.** The 48px icon well, the 10px inset, and the `--color-primary`
glyph treatment already existed for the PIN-reveal eye on `/me/edit` (issue #243,
`.pin-field`/`.pin-reveal`). Rather than repeat that property list for `.date-field`/`.date-open`,
`guest.css`'s "Icon-in-field controls" block groups both pairs onto one selector list — any future
consumer of this idiom adds its two class names to that list rather than restating the block. The
48px well itself is gated behind `.date-field.js-date` rather than the bare `.date-field`, for the
same scripts-off reason as the indicator collapse above: with scripts off, nothing sits in that
48px on the right, so nothing should be reserved for it. The one exception is `.date-open[hidden]`,
which is `.date-open`-only: `.pin-reveal` is never rendered `hidden` (`me-edit.ejs` always emits it
live), so giving it a `[hidden]` companion it does not need would be dead CSS.

**The `[hidden]` companion is load-bearing, not decorative.** The shared rule's `display: flex`
beats the UA stylesheet's plain `[hidden] { display: none }` on an engine that does not mark its
own rule `!important` (WebKit; pre-"until-found" Firefox) — without `.date-open[hidden] { display:
none !important; }`, a scripts-off page would render the server-hidden calendar button as a
_visible, inert_ control beside the browser's own indicator on exactly those engines, which is what
AC6 rules out. The same cascade gap recurs across the codebase's pre-existing author-`[hidden]`
restatements, such as `.badge-picker-cell[hidden]` (`admin-tasks.css:359`, over `display: grid`),
`.wizard-step[hidden]` (`admin-tasks.css:1040`, over `display: flex`), `.feed-edge[hidden]`
(`guest.css`, over `display: flex` — cited without a line because this change edits that same
sheet, and a pin into it is falsified by the next one), `.guest-card[hidden]` (`feed.css:1189`, over
`display: flex`), and `.rank-award-foot .btn[hidden]` (`admin.css:945`, over `.btn`'s own
`display`) — of those, only `.guest-card[hidden]` reaches for `!important`, matching
`.date-open[hidden]` here; the rest restate a bare `display: none` and rely on the `[hidden]`
attribute selector's own specificity edge over the class rule it overrides.
`tests/admin-config.test.js` asserts the `.date-open[hidden]` companion at the CSS-text level (via
`tests/helpers/theme-css.js`) rather than the markup level, because neither supertest nor jsdom
resolves the UA stylesheet or the cascade — a `hidden` attribute present in a response body proves
nothing about whether the element it sits on is actually invisible.

**The partial's range contract needs two pieces the partial itself does not render.**
`rangeRole` alone does nothing: `date-field.js`'s `wireRange()` also requires `data-date-range` on
the enclosing `<form>` and a `[data-range-error]` element inside it, and returns silently when
either is absent — a future adopter that passes `rangeRole` without both would get no client-side
message and no warning, just the server round-trip. `src/views/admin-config.ejs` is the reference
call site: it sets `data-date-range` on its own `<form>` and renders the
`<p class="form-error date-range-error" role="alert" data-range-error hidden></p>` that both
partial includes share. `tests/admin-config.test.js` asserts all four hooks
(`data-date-range`, `data-range-start`, `data-range-end`, `data-range-error`) plus the
`<script src="/js/date-field.js">` tag against the served HTML, not just against
`tests/date-field-script.test.js`'s own fixture markup — so an edit that drops a hook from the view
itself fails a test, rather than leaving every test green while the live page silently loses its
client-side message.

**The server stays the one gate that decides what persists.** `date-field.js` only pins the end
field's `min` to the start field's current value and blocks a submit whose pair is inverted,
naming the problem in place; `src/routes/admin/config.js`'s existing `startDate > endDate`
rejection is untouched and is still what a crafted POST that bypasses the client entirely has to
get past. Client-side range checking is steering, not the gate.

**`novalidate` trades away the browser's `badInput` block too, and only partly gets it back.** The
form carries `novalidate` so a stale server-rendered `min` on the end field can never veto a submit
the host is in the middle of fixing: `min` renders from the STORED start date and is only re-pinned
by `date-field.js`, so with scripts off a host moving the whole weekend earlier would otherwise be
blocked against a bound they are in the middle of replacing — an edit that worked before this issue
added `min` at all. `min` still bounds what the calendar OFFERS, which is the steering the issue
wanted; it simply no longer holds a veto. Note the attribute is form-wide: it switches off native
validation for the timezone `<select>` and the prizes `<textarea>` as well, not only the date pair.
And `novalidate` also switches off the browser's native block on a half-typed
date (e.g. `08/07/` with the year left blank), which used to stop that submit in place before it
ever reached the server. `date-field.js`'s submit handler restores that block itself: it checks
`validity.badInput` on both fields before running the range check, and on a hit calls
`preventDefault()`, focuses the field, and calls `reportValidity()` (which still reports under a
form-level `novalidate`) if the engine offers it. The residual: with scripts OFF, a half-typed date
now round-trips to the server instead of being blocked in place there too — `start_date` posts as
`''`, the server's own check treats an empty value as not-inverted, and the host loses the page and
has to re-enter anything else on the form. Accepted, because the server still names the problem in
its flash message, and the alternative — leaving the stale `min` bubble in place — vetoes a
legitimate edit for every scripts-on host to save the scripts-off case, which is the wrong trade
for the more common path.
