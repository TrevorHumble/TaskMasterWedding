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
// Prefer the value from the environment. If it is missing, generate a random
// one so the app still boots, and warn that sessions will reset on restart.
let cookieSecret = process.env.COOKIE_SECRET;
if (!cookieSecret || cookieSecret.trim() === '') {
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

  // Project root
  ROOT: ROOT,

  // Data directories (absolute paths)
  DATA_DIR: DATA_DIR,
  DB_PATH: process.env.DB_PATH || path.join(DATA_DIR, 'app.db'),
  UPLOADS_DIR: path.join(DATA_DIR, 'uploads'),
  THUMBS_DIR: path.join(DATA_DIR, 'thumbs'),
  EXPORTS_DIR: path.join(DATA_DIR, 'exports'),
  ADMIN_HASH_PATH: path.join(DATA_DIR, 'admin.hash'),
  // Deliberately OUTSIDE DATA_DIR: a backup that lives inside the same
  // directory a disk failure or accidental `rm -rf data/` takes out offers no
  // protection. The default resolves to <ROOT>/backups -- a sibling of
  // <ROOT>/data, i.e. outside data/, not a subfolder of it. Override with the
  // BACKUP_DIR env var to point at a second disk/location entirely.
  BACKUP_DIR: process.env.BACKUP_DIR || path.join(DATA_DIR, '..', 'backups'),

  // Static source directories (css / js / badges, and EJS views)
  PUBLIC_DIR: path.join(ROOT, 'src', 'public'),
  VIEWS_DIR: path.join(ROOT, 'src', 'views'),

  // Maintenance mode — set MAINTENANCE=1 or MAINTENANCE=true in the environment
  // to serve a 503 page to guests while /admin remains reachable.
  MAINTENANCE: process.env.MAINTENANCE === '1' || process.env.MAINTENANCE === 'true',

  // Admin login throttling
  ADMIN_LOGIN_MAX_ATTEMPTS: parseInt(process.env.ADMIN_LOGIN_MAX_ATTEMPTS, 10) || 10,
  ADMIN_LOGIN_LOCKOUT_MS: parseInt(process.env.ADMIN_LOGIN_LOCKOUT_MS, 10) || 15 * 60 * 1000,

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
config.publicDir = config.PUBLIC_DIR;
config.viewsDir = config.VIEWS_DIR;
config.maintenance = config.MAINTENANCE;

module.exports = config;
