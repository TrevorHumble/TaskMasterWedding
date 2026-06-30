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

// ---- The exported config object (UPPER_SNAKE_CASE = canonical) -------------
const config = {
  // Server
  PORT: parseInt(process.env.PORT, 10) || 3000,
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
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

  // Static source directories (css / js / badges, and EJS views)
  PUBLIC_DIR: path.join(ROOT, 'src', 'public'),
  VIEWS_DIR: path.join(ROOT, 'src', 'views'),

  // Upload / image settings (used by section 05; defined here so all config
  // lives in one place)
  MAX_UPLOAD_BYTES: 12 * 1024 * 1024, // 12 MB
  THUMB_WIDTH: 400,
  ALLOWED_MIME: ['image/jpeg', 'image/png', 'image/webp'],

  // Admin login throttling
  ADMIN_LOGIN_MAX_ATTEMPTS: parseInt(process.env.ADMIN_LOGIN_MAX_ATTEMPTS, 10) || 10,
  ADMIN_LOGIN_LOCKOUT_MS: parseInt(process.env.ADMIN_LOGIN_LOCKOUT_MS, 10) || 15 * 60 * 1000,

  // Auto-badge thresholds — THE single source of truth for these numbers.
  // scoring.js (section 06) imports BADGE_THRESHOLDS from this config instead
  // of redefining it, and guest.js (section 04) consumes the same export.
  // Shape: an ordered array of { code, n } so callers can both look a value up
  // by code and iterate thresholds in ascending order.
  BADGE_THRESHOLDS: [
    { code: 'BLOOM', n: 5 },
    { code: 'BOUQUET', n: 10 },
    { code: 'GARDEN', n: 15 },
  ],
};

// ---- Lowercase aliases (backwards compatibility ONLY) ----------------------
// New code should read the UPPER_SNAKE_CASE keys above. These aliases exist so
// any stray lowercase reference still resolves to the same value.
config.port = config.PORT;
config.baseUrl = config.BASE_URL;
config.cookieSecret = config.COOKIE_SECRET;
config.root = config.ROOT;
config.dataDir = config.DATA_DIR;
config.dbPath = config.DB_PATH;
config.uploadsDir = config.UPLOADS_DIR;
config.thumbsDir = config.THUMBS_DIR;
config.exportsDir = config.EXPORTS_DIR;
config.adminHashPath = config.ADMIN_HASH_PATH;
config.publicDir = config.PUBLIC_DIR;
config.viewsDir = config.VIEWS_DIR;
config.maxUploadBytes = config.MAX_UPLOAD_BYTES;
config.thumbWidth = config.THUMB_WIDTH;
config.allowedMime = config.ALLOWED_MIME;
config.badgeThresholds = config.BADGE_THRESHOLDS;

module.exports = config;
