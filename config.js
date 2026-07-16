/* config.js */
// Central configuration. Every other file imports this and reads paths/keys
// from it. Nothing else in the app should hard-code a path or a port.
//
// CANONICAL CASING: every key is exported in UPPER_SNAKE_CASE because that is
// what db.js, auth.js, photos.js, export.js, admin.js and the community module
// all read. A few lowercase aliases are added at the bottom for backwards
// compatibility only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Tiny .env loader (no dependency needed) -------------------------------
// Reads KEY=VALUE lines from a .env file in the project root and copies any
// that are not already set into process.env. Lines starting with # are ignored.
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

// ---- Resolve the cookie secret --------------------------------------------
// Prefer the value from the environment. In production a missing secret is a
// hard boot failure (issue #242): a regenerated secret invalidates every
// signed cookie on restart, silently signing out every guest and admin at
// once, mid-event. Everywhere else (dev/test), generate a random one so the
// app still boots, and warn that sessions will reset on restart.
let cookieSecret = process.env.COOKIE_SECRET;
if (!cookieSecret || cookieSecret.trim() === '') {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[config] COOKIE_SECRET is not set. Refusing to boot in production: without a fixed ' +
        'secret, every restart would generate a new one and silently sign every guest and ' +
        'admin out at once. Set COOKIE_SECRET in the environment (or .env) before starting.'
    );
  }
  cookieSecret = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[config] WARNING: COOKIE_SECRET is not set. Generated a temporary random ' +
      'secret. Guests and admin will be signed out on every restart. ' +
      'Set COOKIE_SECRET in your .env file to fix this.'
  );
}

// ---- Resolve whether cookies should use the Secure flag -------------------
// Set COOKIE_SECURE=true in .env to force Secure cookies even outside NODE_ENV
// production (e.g. an ngrok/Cloudflare tunnel in development). In production,
// Secure is always on so browsers refuse to send cookies over plain HTTP.
const cookieSecure =
  process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production';

// ---- Absolute base directories --------------------------------------------
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

// ---- Resolve the trust-proxy hop count -------------------------------------
// Hosted deployment (DESIGN.md § Hosted deployment) puts a reverse proxy in
// front of the app. Express must be told how many proxy hops to trust so it
// reads the real guest IP from X-Forwarded-For instead of the proxy's own
// address. Unset/empty -> false (Express default: trust nothing). The literal
// string 'true' -> 1 (trust exactly one hop -- never pass boolean `true` to
// Express, which would trust an arbitrary, spoofable forwarded-for chain).
// A parseable non-negative integer -> that many hops (TRUST_PROXY='0' parses
// to 0, which is falsy-equivalent to "no proxy" and is intentionally treated
// as `false` below). Anything else -> false.
function resolveTrustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw.trim() === '') return false;
  if (raw === 'true') return 1;
  const n = parseInt(raw, 10);
  if (Number.isInteger(n) && n > 0) return n;
  return false;
}
const TRUST_PROXY = resolveTrustProxy();

// ---- The exported config object (UPPER_SNAKE_CASE = canonical) -------------
const config = {
  // Server
  PORT: parseInt(process.env.PORT, 10) || 3000,
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
  // Express `trust proxy` setting. false = Express default (trust nothing);
  // a positive integer = number of proxy hops to trust. See resolveTrustProxy
  // above for the parsing rule.
  TRUST_PROXY: TRUST_PROXY,
  COOKIE_SECRET: cookieSecret,
  // True when cookies must carry the Secure flag. On by default in production
  // and when COOKIE_SECURE=true; off in test/dev so plain-HTTP supertest works.
  COOKIE_SECURE: cookieSecure,

  // Cookie lifetimes, in milliseconds (issue #242). The single owner of both
  // numbers -- src/middleware/session.js's cookieOpts() reads these rather
  // than either cookie carrying its own literal, so the guest and admin
  // lifetimes cannot drift apart by editing the wrong call site.
  //
  // GUEST_COOKIE_MAX_AGE_MS: 400 days -- the longest Max-Age Chrome will honor
  // (it caps/truncates anything longer rather than erroring, so 400 is a
  // ceiling, not a round default). Guests sign up as early as invitations go
  // out, weeks before the event pays it off (Goal A); attachGuest re-issues
  // this cookie on every authenticated request (a rolling refresh), so an
  // active guest never approaches the ceiling -- it only bounds an inactive one.
  GUEST_COOKIE_MAX_AGE_MS: parseInt(process.env.GUEST_COOKIE_MAX_AGE_MS, 10) || 34560000000,
  // ADMIN_COOKIE_MAX_AGE_MS: 14 days -- unchanged from the single
  // COOKIE_MAX_AGE_MS both cookies shared before #242 split them. The admin
  // cookie is not rolling-refreshed and has no reason to be as sticky as the
  // guest cookie.
  ADMIN_COOKIE_MAX_AGE_MS: parseInt(process.env.ADMIN_COOKIE_MAX_AGE_MS, 10) || 1209600000,

  // Project root
  ROOT: ROOT,

  // Data directories (absolute paths)
  DATA_DIR: DATA_DIR,
  DB_PATH: process.env.DB_PATH || path.join(DATA_DIR, 'app.db'),
  UPLOADS_DIR: path.join(DATA_DIR, 'uploads'),
  THUMBS_DIR: path.join(DATA_DIR, 'thumbs'),
  // Single owner of the public /uploads URL mount prefix (issue #508). Both
  // the app.js static mount and every URL-shape decision that depends on it
  // (photos.urlForOriginal building the URL, task-badges.isUploadedArtPath
  // deciding whether a badge-art file is eligible for deletion) read this
  // instead of carrying their own '/uploads' literal, so the two can never
  // silently diverge if the mount ever moves. NO trailing slash — consumers
  // append '/' + filename themselves, and app.js's express.static mount
  // string must stay byte-identical to the pre-#508 literal.
  UPLOADS_URL_BASE: '/uploads',
  EXPORTS_DIR: path.join(DATA_DIR, 'exports'),
  ADMIN_HASH_PATH: path.join(DATA_DIR, 'admin.hash'),
  // Deliberately OUTSIDE DATA_DIR: a backup that lives inside the same
  // directory a disk failure or accidental `rm -rf data/` takes out offers no
  // protection. The default resolves to <ROOT>/backups -- a sibling of
  // <ROOT>/data, i.e. outside data/, not a subfolder of it. Override with the
  // BACKUP_DIR env var to point at a second disk/location entirely.
  BACKUP_DIR: process.env.BACKUP_DIR || path.join(DATA_DIR, '..', 'backups'),
  // Optional override (issue #457): when set, scripts/sample-photo-pool.js
  // draws every seed script's gallery/submission photo pool from this
  // directory instead of the bundled CC0 placeholders in
  // fixtures/sample-photos/ -- lets an operator seed a demo with real photos
  // without ever risking one landing in this PUBLIC repo's git history.
  // Empty by default; never resolves to a path inside this repo's own tree.
  LOCAL_PHOTOS_DIR: process.env.LOCAL_PHOTOS_DIR || '',
  // How many snapshot folders under BACKUP_DIR a scheduled backup run keeps
  // (issue #287). 0 (the default) means keep everything -- a host must opt in
  // to pruning by setting this once it has a schedule running; a laptop doing
  // occasional manual backups should never lose one to an unset env var.
  BACKUP_RETENTION_COUNT: parseInt(process.env.BACKUP_RETENTION_COUNT, 10) || 0,

  // Static source directories (css / js / badges, and EJS views)
  PUBLIC_DIR: path.join(ROOT, 'src', 'public'),
  VIEWS_DIR: path.join(ROOT, 'src', 'views'),

  // Maintenance mode — set MAINTENANCE=1 or MAINTENANCE=true in the environment
  // to serve a 503 page to guests while /admin remains reachable.
  MAINTENANCE: process.env.MAINTENANCE === '1' || process.env.MAINTENANCE === 'true',

  // Admin login throttling
  ADMIN_LOGIN_MAX_ATTEMPTS: parseInt(process.env.ADMIN_LOGIN_MAX_ATTEMPTS, 10) || 10,
  ADMIN_LOGIN_LOCKOUT_MS: parseInt(process.env.ADMIN_LOGIN_LOCKOUT_MS, 10) || 15 * 60 * 1000,

  // Guest re-entry (login) throttling (issue #241). Keyed per-normalized-contact
  // in src/routes/auth.js, not globally like the admin counters above — one
  // guest guessing wrong should never lock out a different guest's contact.
  GUEST_LOGIN_MAX_ATTEMPTS: parseInt(process.env.GUEST_LOGIN_MAX_ATTEMPTS, 10) || 5,
  GUEST_LOGIN_LOCKOUT_MS: parseInt(process.env.GUEST_LOGIN_LOCKOUT_MS, 10) || 5 * 60 * 1000,

  // GUEST_LOGIN_TRACKED_MAX: hard cap on how many distinct normalized contacts
  // src/routes/auth.js's guest-login lockout Map holds at once (issue #464,
  // absorbed into #283). Sweep-on-write eviction keeps this bounded in the
  // common case (a stale entry is dropped the next time a NEW contact fails);
  // this cap is the backstop against a flood of thousands of distinct
  // made-up contacts each guessed once, which sweeping alone would not catch
  // inside a single window. A contact currently serving an active lockout is
  // never evicted to make room (see src/routes/auth.js) — the cap can never
  // be used to un-lock an account early by flooding.
  GUEST_LOGIN_TRACKED_MAX: parseInt(process.env.GUEST_LOGIN_TRACKED_MAX, 10) || 5000,

  // Route-level rate limiting (issue #283) via src/middleware/rate-limit.js —
  // DISTINCT from the per-guest limiters above and from
  // src/services/rate-limit.js (the #247/#281 service, which keeps owning
  // POST /memories and the HEIC-decode throttle; this config block backs
  // POST /join, POST /login, POST /tasks/:id/submit, POST /me/edit,
  // POST /bug-report, POST /p/:id/like, and POST /p/:id/comments instead —
  // see each route file's own comment for the wiring).
  //
  // RATE_LIMIT_WINDOW_MS: the fixed window every limiter below shares, in
  // milliseconds. Default 600000 (10 minutes) — the same order of magnitude
  // as the existing MEMORY_RATE_WINDOW_MS/HEIC_DECODE_RATE_WINDOW_MS windows
  // above, so an operator tuning "how fast abuse gets throttled" reasons
  // about one scale across the whole app.
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 600000,

  // RATE_LIMIT_UPLOAD_MAX: per-GUEST cap, shared across POST /tasks/:id/submit
  // and POST /me/edit (one guest-keyed counter for both — a guest editing
  // their profile a few times while also working through tasks draws from
  // the same budget). 20 per RATE_LIMIT_WINDOW_MS comfortably covers a guest
  // working through every task plus a couple of profile edits in one
  // sitting, while a scripted flood of either route trips it quickly.
  RATE_LIMIT_UPLOAD_MAX: parseInt(process.env.RATE_LIMIT_UPLOAD_MAX, 10) || 20,

  // RATE_LIMIT_SOCIAL_MAX: per-GUEST cap on the lighter-weight social writes.
  // Two SEPARATE counters share this same limit value: POST /bug-report (its
  // own budget, src/routes/guest.js) and POST /p/:id/like + POST
  // /p/:id/comments (a second, shared budget, src/routes/community.js). 60
  // per RATE_LIMIT_WINDOW_MS is generous for real browsing-and-reacting
  // behavior (liking/commenting through a whole gallery scroll) while still
  // bounding a comment-spam or bug-report-spam script.
  RATE_LIMIT_SOCIAL_MAX: parseInt(process.env.RATE_LIMIT_SOCIAL_MAX, 10) || 60,

  // RATE_LIMIT_TRACKED_MAX: hard cap on how many distinct keys ONE limiter
  // instance from src/middleware/rate-limit.js tracks at a time. The same
  // bound, for the same reason, as GUEST_LOGIN_TRACKED_MAX above — and it
  // matters most on the two IP-keyed limiters (POST /join, POST /login),
  // whose keys come from unauthenticated callers: a flood from many distinct
  // source IPs mints a new key per IP, and inside a single
  // RATE_LIMIT_WINDOW_MS nothing has expired for a sweep to reclaim, so
  // without this cap the map grows without limit AND every new-key insert
  // pays an O(map size) scan on the single Node process. 5000 keys is far
  // past any real event (a ~100-guest list, even one phone per guest plus the
  // hosts' own devices) while bounding both the memory and that per-request
  // scan. Eviction takes the entry closest to its window expiring, so a
  // legitimate guest's in-flight count is the last thing dropped.
  RATE_LIMIT_TRACKED_MAX: parseInt(process.env.RATE_LIMIT_TRACKED_MAX, 10) || 5000,

  // RATE_LIMIT_IP_MAX: per-IP cap on POST /join and POST /login. Each route
  // gets its OWN counter (src/routes/auth.js) — a signup flood must never
  // also lock out a returning guest's login attempt from the same
  // venue-NAT IP, and vice versa. Default 300 per RATE_LIMIT_WINDOW_MS.
  //
  // Why 300: the guest list is ~100 people (docs/north-star.md scope) and the
  // design case this must clear is all of them scanning the shared poster
  // from ONE venue-NAT IP within one 10-minute window at the reception
  // opening — 100 signups (or 100 logins) plus a realistic share of honest
  // retries fits under 300 with roughly 3x headroom, while a scripted flood
  // (thousands of requests per window) still trips it. This targets scripts,
  // not the receiving line — see docs/north-star.md Goal A.
  RATE_LIMIT_IP_MAX: parseInt(process.env.RATE_LIMIT_IP_MAX, 10) || 300,

  // Leaderboard display — the maximum number of badge icons rendered on a
  // single leaderboard row. Beyond this the row shows the first N icons plus a
  // "+K" overflow chip, so a guest with a large collection never overflows the
  // fixed-height row. Display-only; does not affect how many badges a guest holds.
  LEADERBOARD_BADGE_CAP: parseInt(process.env.LEADERBOARD_BADGE_CAP, 10) || 8,

  // Memory upload abuse guardrails (issue #247). Memories are the first upload
  // path with no per-guest count bound, so without these a single guest could
  // loop POST /memories and fill the host's disk mid-event. Neither guard caps
  // a guest's lifetime memory total (unlimited count is intentional — Goal D);
  // they bound the RATE and protect the shared disk.
  //
  // MEMORY_RATE_MAX: most memory batches one guest may submit within
  //   MEMORY_RATE_WINDOW_MS. Default 30 batches per 10 minutes.
  MEMORY_RATE_MAX: parseInt(process.env.MEMORY_RATE_MAX, 10) || 30,
  // MEMORY_RATE_WINDOW_MS: the sliding window, in milliseconds. Default 600000
  //   (10 minutes).
  MEMORY_RATE_WINDOW_MS: parseInt(process.env.MEMORY_RATE_WINDOW_MS, 10) || 600000,
  // MIN_FREE_DISK_BYTES: reject a memory batch if free space on the data volume
  //   is below this. Default 524288000 (500 MB).
  MIN_FREE_DISK_BYTES: parseInt(process.env.MIN_FREE_DISK_BYTES, 10) || 524288000,

  // Per-guest HEIC-DECODE rate limit (issue #281). A HEIC decode is expensive
  // (a full raw-frame allocation, serialized one-at-a-time on a shared chain,
  // and a crafted hang can burn the 20s decode timeout), so a hostile guest
  // flooding hang-crafted HEICs could monopolize the single global decode chain
  // and deny every guest's HEIC uploads. This throttle is checked BEFORE the
  // decode, for files that actually sniff as HEIC only, across all three upload
  // paths (task submit, memory batch, avatar). It NEVER touches JPEG/PNG/WebP.
  //
  // Tuned GENEROUS — it must never fire for a real guest, only stop a
  // pathological rapid flood:
  //   HEIC_DECODE_RATE_MAX: 60 HEIC decodes per HEIC_DECODE_RATE_WINDOW_MS.
  //   HEIC_DECODE_RATE_WINDOW_MS: 120000 (2 minutes).
  // 60 decodes / 2 min is ~6 full 10-file memory batches back-to-back in two
  // minutes — far past any human selecting and uploading real photos through
  // the picker, while a scripted flood trips it in seconds. Combined with the
  // pixel cap, 20s decode timeout, one-at-a-time serialization, and worker
  // isolation, it bounds how much of the shared decode chain any single guest
  // can command.
  HEIC_DECODE_RATE_MAX: parseInt(process.env.HEIC_DECODE_RATE_MAX, 10) || 60,
  HEIC_DECODE_RATE_WINDOW_MS: parseInt(process.env.HEIC_DECODE_RATE_WINDOW_MS, 10) || 120000,

  // Global cap on the number of PENDING (queued + in-flight) HEIC decodes
  // across ALL guests (issue #281). HEIC decodes are serialized one-at-a-time,
  // and each pending decode PINS its source buffer (up to MAX_UPLOAD_BYTES =
  // 15 MB) in the main process until its turn. The per-guest rate limit bounds
  // how fast one guest enqueues, but not the total queue DEPTH: many
  // self-onboarding guests (or one guest over many connections) flooding
  // hang-crafted HEICs — each draining slowly against the 20s decode timeout —
  // could grow the queue and its held buffers without bound and OOM the ~2 GB
  // host. This cap bounds total held decode memory to MAX_PENDING_HEIC_DECODES
  // x 15 MB regardless of how many guests flood.
  //
  // 8: worst-case ~120 MB of held source buffers, comfortably within the ~2 GB
  // host's headroom alongside Node + SQLite + sharp (sharp itself can spike
  // during thumbnailing). 8 is also far more depth than the one-at-a-time drain
  // needs under normal load (a normal HEIC decodes in ~1-3s, so a healthy burst
  // clears in seconds); beyond 8 pending, "give it a moment" is the honest
  // response. Env-overridable if a specific event wants more concurrent-upload
  // headroom.
  MAX_PENDING_HEIC_DECODES: parseInt(process.env.MAX_PENDING_HEIC_DECODES, 10) || 8,

  // Cap on how many photo submissions (src/routes/guest.js POST
  // /tasks/:id/submit) may run their HEAVY pipeline -- sharp thumbnailing +
  // the synchronous better-sqlite3 write, submissions.submitPhoto -- at once
  // (issue #311 AC3). A guest whose submit lands over the cap is QUEUED, not
  // rejected: src/utils/upload-concurrency.js's Semaphore holds it until a
  // slot frees, so a peak burst costs a slightly longer wait rather than a
  // dropped connection.
  //
  // Why this exists: the #311 load test recorded 0.1-0.2% of connections
  // reset at the socket layer under 100 concurrent uploads (0% on a
  // read-only run at the same concurrency, and zero HTTP 5xx throughout) --
  // too many of these synchronous heavy pipelines running back-to-back can
  // occupy the single JS thread long enough that the OS-level accept
  // backlog sheds a few brand-new incoming connections before Express ever
  // sees them.
  //
  // 6: same order of magnitude as MAX_PENDING_HEIC_DECODES above (this
  // host's ~2 GB headroom bounds how much concurrent sharp/SQLite work is
  // safe), while still letting several guests' uploads make real progress
  // together rather than fully serializing to one-at-a-time, which would be
  // needlessly slow for the common case of a handful of simultaneous
  // uploads. Env-overridable per event/host.
  MAX_CONCURRENT_UPLOADS: parseInt(process.env.MAX_CONCURRENT_UPLOADS, 10) || 6,
};

// ---- Lowercase aliases (backwards compatibility ONLY) ----------------------
// New code should read the UPPER_SNAKE_CASE keys above. These aliases exist so
// any stray lowercase reference still resolves to the same value.
config.port = config.PORT;
config.baseUrl = config.BASE_URL;
config.trustProxy = config.TRUST_PROXY;
config.cookieSecret = config.COOKIE_SECRET;
config.root = config.ROOT;
config.dataDir = config.DATA_DIR;
config.dbPath = config.DB_PATH;
config.uploadsDir = config.UPLOADS_DIR;
config.thumbsDir = config.THUMBS_DIR;
config.exportsDir = config.EXPORTS_DIR;
config.adminHashPath = config.ADMIN_HASH_PATH;
config.backupDir = config.BACKUP_DIR;
config.localPhotosDir = config.LOCAL_PHOTOS_DIR;
config.backupRetentionCount = config.BACKUP_RETENTION_COUNT;
config.publicDir = config.PUBLIC_DIR;
config.viewsDir = config.VIEWS_DIR;
config.maintenance = config.MAINTENANCE;

module.exports = config;
