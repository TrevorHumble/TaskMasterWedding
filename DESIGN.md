# DESIGN.md — Architecture decisions and rationale

Why the app is built the way it is. Decisions and tradeoffs, not getting-started instructions (those are in `README.md`) and not agent rules (those are in `CLAUDE.md`).

**North Star / goals:** confirmed. The product goals live in [`docs/north-star.md`](docs/north-star.md) (one-screen summary in [`CLAUDE.md`](CLAUDE.md)). The decisions recorded below serve those goals — most directly getting any guest in fast and keeping the app standing under the whole guest list at once (Goal A). One goal-driven decision is still **open and unbuilt**: Goal C's contained sharing (scoping content to the right audience). Moderation today is takedown-only (see "Photos: … takedown over delete" below); the audience-split design will be recorded here once chosen. The app must be live for guests by **Friday, Aug 7, 2026**.

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

### HEIC accepted and converted to JPEG at intake (#281, supersedes #188's rejection)

An iPhone (and a recent Samsung) hands over HEIC/HEIF photos by default. The prebuilt `sharp`/libvips binaries this app runs on cannot decode real HEVC-encoded HEIC — their bundled libheif has only an AV1 decoder (`sharp.format.heif.input.fileSuffix === ['.avif']`), and HEVC is excluded from the prebuilt binary for patent-licensing reasons. Issue #188 made the honest call at the time: reject HEIC at intake with actionable copy ("take a screenshot, or switch to Most Compatible") rather than store an original that could never be thumbnailed.

**What we do now:** `src/services/photos.js` detects HEIC by sniffing the ISO-BMFF `ftyp` box's major brand (`heic`/`heix`/`heif`/`mif1`/`msf1`) from a file's leading bytes — not by declared mimetype, since the iOS/Android "Files" picker (and some third-party browsers) hand over a real HEIC under the generic `application/octet-stream` mimetype. A detected HEIC is decoded with `heic-convert` (a pure-JavaScript HEVC decoder — no native build tools, no external/paid service) and re-encoded to JPEG before the stored original, the thumbnail, the gallery, or the export ZIP ever see it. It is in-license and in-process: `heic-convert` is ISC-licensed and pulls in `libheif-js` (LGPL-3.0, dynamically linked as a normal npm dependency) and `jpeg-js` (BSD-3-Clause) — all permissive/LGPL, all running in-process, with no external or paid API. HEIC is invisible to the rest of the system: `ORIGINAL_RE`/`THUMB_RE` (the static-mount allowlist patterns) still match only `.jpg`/`.png`/`.webp`, because nothing else is ever written under those directories.

**Why `heic-convert` over rebuilding libvips:** the alternative — building or sourcing a libvips binary with an HEVC-capable libheif — means either compiling native code for the Windows host (no build tools on the event laptop, and the exact kind of native-binary fragility `DESIGN.md`'s "sharp 0.35.2 SAC block" entry above already burned a build on) or sourcing a third-party prebuilt binary of uncertain provenance days before the wedding. `heic-convert` is pure JS: `npm install` and it works, with no new binary surface for Smart App Control or any other Windows gatekeeper to block.

**Decode runs off the main thread (worker offload):** `heic-convert` → `heic-decode` → `libheif-js/wasm-bundle` has no worker offload of its own and decodes **synchronously**, so running it on the Node main thread would block the entire event loop — freezing every route for every guest — for the full decode duration. Unlike the JPEG/PNG/WebP path, where `sharp` runs off-thread natively, this would be a new main-thread stall, and because HEIC is the iPhone default it is the expected load (a reception-night burst of uploads), not an edge — directly at odds with Goal A ("fast under the whole party at once"). So the decode is dispatched to a `worker_threads` worker (`src/services/heic-worker.js`) and awaited; `convertHeicToJpeg` still returns `Promise<Buffer>` and its call sites are unchanged. A **fresh worker is spawned per decode** and terminated when it finishes: the worker exits after one image, so its WASM heap and raw frame are fully reclaimed each time, and the large allocation is isolated in a short-lived child process — a worst-case decode cannot OOM (or leak into) the main app. A worker crash, error, or non-zero exit is caught on the main side and surfaces as the same guest-safe `BAD_IMAGE_TYPE` "couldn't be read" rejection; it never crashes or hangs the main process.

The decode is also bounded in **time** by `HEIC_DECODE_TIMEOUT_MS` (20s; a legitimate large HEIC decodes in ~1–3s). The pixel cap bounds how much a decode allocates but not how long it runs — a crafted small-`ispe` HEIC with a pathological bitstream can drive libheif into a non-terminating decode, so the worker would post no result and never exit. Without a timeout that decode would never settle, and because the serialization chain advances only on settle, every later HEIC upload would queue behind it forever (a process-wide denial of the iPhone-default path until restart — squarely against Goal A). The timeout turns that hang into a single failed request that also frees the chain: the next upload proceeds normally.

A **per-guest HEIC-decode rate limit** (`HEIC_DECODE_RATE_MAX` per `HEIC_DECODE_RATE_WINDOW_MS`, in `src/services/rate-limit.js`) is checked BEFORE the decode, for files that actually sniff as HEIC, across all three upload paths (task submit, memory batch, avatar). Without it a single hostile guest could flood hang-crafted HEICs — each burning the 20s timeout — and, since the decode chain is one-at-a-time and global, monopolize it and deny every guest's HEIC uploads (Goals A/D). The limit is tuned generously (60 decodes / 2 min per guest — far above any human's real upload rate) so it only ever stops a pathological flood; JPEG/PNG/WebP uploads never consume it.

Finally, a **global pending-decode cap** (`MAX_PENDING_HEIC_DECODES`, default 8) bounds total held-buffer memory. The per-guest rate limit bounds enqueue RATE, but not queue DEPTH: because decodes are serialized one-at-a-time and a hang-crafted decode drains only as fast as the 20s timeout, many self-onboarding guests (or one guest over many connections) flooding could grow the queue without bound — and each pending decode PINS its ~15 MB source buffer (`MAX_UPLOAD_BYTES`) in the main process until its turn, so unbounded queue depth means unbounded held memory and an OOM of the ~2 GB host in minutes. `convertHeicToJpeg` (the single funnel every HEIC decode passes through) admits a decode only while the global pending count is below the cap — incrementing on admission, decrementing on settle (either outcome) — and rejects an over-cap upload with the rate-limit copy BEFORE its buffer is pinned onto the chain. Held decode memory is therefore capped at `MAX_PENDING_HEIC_DECODES × 15 MB` (~120 MB at the default) no matter how many guests flood. This completes the decode-DoS defenses: the pixel cap (per-decode allocation), the 20s timeout (per-decode time), the per-guest rate limit (per-guest enqueue rate), the global pending cap (total held memory), one-at-a-time serialization, and worker isolation.

**Memory constraint — one decode at a time:** a single HEIC decodes a full RGBA frame into memory and can transiently want a few hundred MB. Decodes are serialized behind a module-level promise chain (`src/services/photos.js`'s `heicDecodeChain`) so at most one decode worker runs at once, regardless of how many guests upload HEIC photos in the same moment. This matters because the app is sized for a small (~2 GB) host per the "Constraints that shaped the design" section above, and a move off the single event laptop to a small VPS is under consideration — a future host-sizing decision should account for this one-decode-at-a-time ceiling rather than assuming photo intake is memory-cheap.

**Pixel-dimension cap — defense against a HEIC pixel bomb:** serializing decodes bounds _how many_ run at once, but not _how big_ each one is. `heic-decode` allocates a full raw RGBA frame (`new Uint8ClampedArray(width*height*4)`) sized from libheif's decoded-image `get_width()`/`get_height()`, and it does so _before_ `sharp` — and `sharp`'s default input-pixel guard — ever runs, so the HEIC path bypasses the protection the JPEG/PNG/WebP path gets for free. A crafted few-MB HEIC (a uniform image compresses to almost nothing under HEVC, well within the 15 MB upload cap) could carry huge dimensions and force a ~1 GB allocation that OOMs the ~2 GB host. Anything over `MAX_HEIC_PIXELS` (100 megapixels) is refused. 100 MP sits above any default-camera phone HEIC (a 48 MP iPhone ProRAW frame, a 50 MP flagship) with headroom while a 100 MP RGBA decode is ~400 MB — the largest single transient the one-at-a-time gate permits — and is deliberately tighter than `sharp`'s ~268 MP default AND than libheif's own ~1-gigapixel default limit, neither of which this host can safely absorb.

**The cap uses libheif's AUTHORITATIVE dimensions, not the `ispe` box (#281 round-8 finding).** An earlier version gated only on the ISO-BMFF `ispe` box (`heicPixelDimensions`). That is a parser differential: **libheif does not size the allocation from `ispe`.** Verified empirically — patching a HEIC's primary-image `ispe` to 4000×4000 leaves libheif's decoded `get_width()`/`get_height()` unchanged (they come from the coded HEVC stream, not the `ispe`), and declaring a non-standard-size `ispe` (e.g. 24 bytes) makes libheif reject the file outright. So a "24-byte `ispe` declaring huge dims → huge allocation" bypass is a **false positive** (the `ispe` cannot drive the allocation), but the same evidence shows an `ispe`-only cap could diverge from the real allocation size. The cap is therefore enforced at two points: (1) a cheap **main-thread pre-check** on `ispe` (`assertHeicPixelsWithinCap`) that avoids spawning a worker for an honestly-huge HEIC, and (2) the **authoritative gate inside the worker** (`heic-worker.js`) on libheif's real `get_width()`/`get_height()`, obtained via `heic-decode`'s `.all()` (which exposes dimensions after the container parse but **before** the raster is allocated — measured: `.all()` ~0.2 MB, the raster only materializes at `.decode()`). Over-cap in the worker aborts and signals oversize, mapped to the same guest-safe `BAD_IMAGE_TYPE` copy; the giant allocation never happens. (worker_threads share the process address space, so this gate — not the worker "isolation" — is what prevents the OOM.) The worker decodes with `heic-decode` + `jpeg-js` directly at `Math.floor(0.9*100)=90` quality, byte-identical to the prior `heic-convert` path.

**EXIF/orientation of the converted original:** libheif-js (1.19.8) applies the HEIF spatial transforms — including `irot`/`imir` orientation — during decode by default (`ignore_transformations=false`), so the decoded raster it hands back is already upright and the JPEG written to `data/uploads/` needs no further rotation. No extra rotation is applied to the converted full-size original; the thumbnail continues to go through `makeThumb`'s `sharp().rotate()` as before.

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

**Amended (issue #761): the flash engine settles four decisions the "daily/flash/lucky bonus" source above left open, and corrects two claims above.** **Correction 1:** #753's point (1) said the future exclusivity guard would read `special_mode` to see a task is spoken for; the guard that actually shipped (`tasks.whatSpecial()`) reads `special_date` and the flash columns directly, and never reads `special_mode` — the rest of #753's entry stands unchanged. **Correction 2:** this entry also corrects the #753 paragraph above, which had #649 and #650's labels transposed — #649 is flash, #650 is lucky, matching `docs/game-design-points-badges.md`'s "Flash: #649 · Lucky: #650"; the labels in that paragraph are already corrected in place, this note only records that the correction happened. The four decisions: (1) `special_mode` gains **no** `'flash'` value. A stored enum marker cannot expire on its own, and the owner's rule (#649 comment, 2026-07-19) is that a task reverts to no-special automatically the instant its flash window ends, with no stale state — keeping a marker truthful would need either a scheduler (this app has none; read-time evaluation is the accepted shape, settled on #624) or a write on every read. It also sidesteps the `CHECK`-widen table rebuild `ensureTaskSpecialDayColumns()` documents at length (`src/db.js`) and the FK-cascade data-loss hazard that rebuild carries — a rebuild #650's implementer would otherwise be sent to repeat for no behavioural gain. (2) The window rule (`tasks.flashState`) has a JS-only owner with **no SQL-fragment counterpart**, unlike `sealedTaskWhere`: no query anywhere needs to filter or suppress a row on window state — a flashed task is never hidden from a list, only decorated onto an already-loaded row — so there is nothing for a second, SQL-side owner to do, and SQLite's `datetime(...)` text output (space-separated, no `Z`) cannot correctly express the half-open `[S, S+D)` window's end-instant arithmetic regardless. (3) The three flash columns (`flash_start_at`/`flash_minutes`/`flash_bonus`) carry **no `CHECK`/pairing constraint**, unlike `special_date`/`special_bonus`'s `chk_special_pairing` — SQLite cannot add a `CHECK` to an existing table without the same rebuild hazard point (1) exists to avoid, so a partially-populated row is a legal database state; `tasks.flashState()` treats it as inert (`'none'`) on the read side rather than trusting the schema to have refused it. (4) **On-day wins the banking tie-break** when a task is somehow both on-day and in-window, decided by one ordered rule list — `tasks.js`'s `SPECIAL_RULES` — rather than two independent hand-restatements of the same daily-before-flash precedence. `whatSpecial()` answers "who is this task spoken for by;" each `SPECIAL_RULES` entry's own `paying` predicate answers the strict-subset question "is this rule paying right now" (`'daily'` is spoken-for by sealed-or-on-day but only _pays_ on-day; `'flash'` is spoken-for by scheduled-or-active but only pays active), and each `SPECIAL_RULES` entry also carries `bonusColumn`/`reason`, so `tasks.js`'s `bonusForTask()` reads the paying rule's bonus column and `bonus_reason` literal straight off the same list — `submissions.js` never hand-maps a kind string to a bonus column or reason itself. Concretely, this is what keeps exclusivity, paying, and banking from drifting apart: a task sealed for a **future** day with a simultaneously active flash window, submitted by a guest who already holds a row on it (the only way to reach the seal gate's existing-row fall-through), is spoken-for by `'daily'` (sealed) — so `'flash'`'s paying condition is never even consulted, and nothing banks until `'daily'` itself starts paying (on-day). Review caught the duplicated precedence (and, in a second pass, the separate hand-written kind-to-column mapping) before merge; one ordered list owning all three questions is what lets `#650` add `'lucky'` as a single new entry, not a hand-edit kept in step elsewhere.

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

**Amended (issue #706): the award model above is superseded by ranked five-photo awards, owner-settled 2026-07-19/20.** This section's `awardTaskBadge(taskId, submissionId, { points, note })` awards one task's badge to one photo. The settled model instead has the host rank each task's 5 best photos: rank 1 pays 5 points and wears the badge gold, rank 2 pays 4, down to rank 5 paying 1 — all five winners wear the badge, gold sorts first on every display surface. #661's rewrite replaces the single-award call with a five-winner ranked award, consolidating onto the badge substrate this section already established (`badges` + `guest_badges`, points and submission carried on the award row) rather than the disconnected `badge_winners` picker table that also exists in the codebase. Full model: `docs/game-design-points-badges.md`.

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

**Coverage gate (#198).** The thresholds in `vitest.config.mjs` were commented out from the start — the 80% rule the owner believed was enforced never gated anything. Rather than wait for a suite that clears 80 (the "enable later" posture that had already held for months), the gate is ON at the floors measured on `main` @ 485886a (2026-07-05): statements 62, branches 53, functions 65, lines 62. The floors are a **ratchet**: raise them toward 80/80/80/80 as tests land (tracked by #181), never lower them. A change that drops coverage below any floor fails the required `test` check — that is the failure mode the gate exists to catch, and it works today, not after some future test-writing push.

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
- **Photos** are write-once (`src/services/photos.js:203-236` never rewrites an existing stored file
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
server-held state and redirects back (`POST /admin/bugs/:id/resolve`, `POST /admin/guests/:id/badge`'s
toggle case). Manual items are persisted the same way `src/services/lockout.js` persists its own
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

**CSRF deviation from the issue plan (recorded, #769).** The issue's implementation plan called the
manual-toggle POST "CSRF-protected." This app carries no CSRF middleware or token anywhere
(`grep -rni csrf src` returns nothing) — `POST /admin/checklist/:id/toggle` matches the same
session-cookie-only protection every other admin POST route already uses (`POST /admin/bugs/:id/resolve`,
`POST /admin/guests/:id/badge`, etc.), which is consistent with existing prior art but is not actually
CSRF protection. The gap is real and app-wide, not specific to this issue's one new route; it is tracked
separately as #769 rather than being invented ad hoc inside this issue's narrow Touches.
