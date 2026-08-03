// src/middleware/request-log.js
// Structured per-request JSON logging to stdout (issue #1019). Full design
// rationale (mount-first vs. later, single finish-hook emit site, finish-time
// guestId read, app-log vs. proxy-log ownership of static evidence):
// DESIGN.md § "Structured per-request JSON logging (#1019)". This header
// documents only what the code itself needs to be read correctly.
//
// One line per request comes from the 'finish' hook, plus a 'close' hook that
// covers a client-aborted request 'finish' never fires for. The one other
// emit site is logRequestError below, called once by src/app.js's global
// error handler for a SECOND, supplementary line (message + stack)
// correlated to the finish/close line by req.reqId.
//
// A fast, successful app-route request is silent on purpose -- this is a
// trouble/diagnosis log, not an access log.

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const config = require('../../config');

// Prefixes this app itself serves as static files or exempts from logging.
// The public-asset half (css/js/badges/fonts/robots.txt today) is derived
// from the real directory at module load, not hand-mirrored, so a new
// top-level entry under config.PUBLIC_DIR is skipped automatically -- no
// edit needed here when one is added. /uploads and /thumbs come from the
// same config keys src/app.js's own static mounts read, so the two can never
// drift apart. /favicon.ico and /healthz are not directory entries (browsers
// request the former unprompted with no page ever linking to it; the latter
// is a platform liveness probe), so they stay as explicit literals.
const PUBLIC_ASSET_PREFIXES = fs.readdirSync(config.PUBLIC_DIR).map((entry) => '/' + entry);

const SKIP_PREFIXES = [
  config.UPLOADS_URL_BASE,
  config.THUMBS_URL_BASE,
  ...PUBLIC_ASSET_PREFIXES,
  '/favicon.ico',
  '/healthz',
];

/**
 * True when `path` falls under one of SKIP_PREFIXES -- either the prefix
 * itself (an exact file, e.g. '/robots.txt') or anything nested under it
 * (e.g. '/badges/completionist.svg').
 * @param {string} path
 * @returns {boolean}
 */
function isSkippedPath(path) {
  return SKIP_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
}

/**
 * Single owner of stringify-and-emit for every log line this module (and
 * logRequestError, below) produces. A serialization failure here (a future
 * field that turns out to be circular, for instance) must never affect the
 * response already sent or crash the process -- the worst case is one
 * missing log line, not a broken request.
 * @param {object} obj
 */
function emitLine(obj) {
  try {
    console.log(JSON.stringify(obj));
  } catch (err) {
    console.error('[request-log] failed to serialize a log line:', err);
  }
}

/**
 * The four fields every line this module (and logRequestError, below) emits
 * shares. Single owner of that field set, so the finish, close (abort), and
 * error lines can never drift apart on which of the four they carry.
 * @param {import('express').Request} req
 */
function baseFields(req) {
  return {
    reqId: req.reqId,
    method: req.method,
    path: req.logPath,
    guestId: req.guest?.id ?? null,
  };
}

/**
 * Express middleware. Mount FIRST in src/app.js so req.reqId and req.logPath
 * exist for every request this app receives, including one the body parsers
 * reject with a 413 before any later middleware runs.
 */
function requestLog(req, res, next) {
  req.reqId = crypto.randomBytes(4).toString('hex');
  const startedAt = Date.now();
  // req.originalUrl (captured now, at mount time, before any other
  // middleware runs), not req.path read later inside 'finish': a path-
  // prefixed app.use (e.g. the /uploads and /thumbs static mounts) rewrites
  // req.url/req.path for the duration of that mount, and does not always
  // restore it before the response ends (a guard middleware that ends the
  // response itself, like photos/moderation.js's blockTakenDownOriginal,
  // never calls next() back out of that mount) -- so by the time 'finish'
  // fires, req.path can read as the STRIPPED path ('/x.jpg' instead of
  // '/uploads/x.jpg'), which would silently defeat the skip-prefix check
  // below for exactly the requests it exists to skip. originalUrl is set
  // once and never rewritten, so it stays reliable regardless of what any
  // later middleware does to req.path/req.url. Query-stripped, and stashed
  // on req.logPath so logRequestError (called from a different closure, in
  // src/app.js) can read the same value -- the query string is never part
  // of the emitted `path` field, both to keep the field's name honest and
  // because a query string can carry an identifier into the log.
  req.logPath = req.originalUrl.split('?')[0];

  let logged = false;

  res.on('finish', () => {
    if (logged) return;
    logged = true;
    if (isSkippedPath(req.logPath)) return;

    const durationMs = Date.now() - startedAt;
    const status = res.statusCode;
    const shouldLog = config.LOG_ALL_REQUESTS || status >= 400 || durationMs >= config.LOG_SLOW_MS;
    if (!shouldLog) return;

    // req.guest is read here, at 'finish' time, not at request start --
    // attachGuest (mounted later, src/app.js section 5) has already run by
    // the time a response finishes, so mounting this middleware first costs
    // nothing (design decision, issue #1019).
    const line = {
      ...baseFields(req),
      status: status,
      durationMs: durationMs,
    };
    // ip only on an error/abuse line -- a healthy line has nothing to
    // diagnose that needs it.
    if (status >= 400) {
      line.ip = req.ip;
    }
    emitLine(line);
  });

  // A client-aborted request (a guest on weak reception cancelling a slow
  // upload, a destroyed socket) never fires 'finish' -- only 'close'. Guarded
  // by the same `logged` flag as the 'finish' handler above so a normal
  // completed response (finish fires, then close fires right after) never
  // double-logs; the `res.writableFinished` check below is the second guard,
  // covering the rare case where 'close' fires first. Deliberately
  // `writableFinished`, not `writableEnded`: `writableEnded` flips to true
  // synchronously inside res.end(), before the response is actually flushed,
  // while `writableFinished` only becomes true once 'finish' itself has
  // fired. A socket destroyed in the window between those two would read
  // `writableEnded === true` and wrongly convince this guard the response
  // already finished, so this branch would decline right alongside the
  // 'finish' handler (which never fires) and the request would log nothing
  // at all -- exactly the failed-delivery case this branch exists to catch.
  // `writableFinished` stays false through that window, so this branch still
  // logs an aborted line for it (trade recorded in DESIGN.md's #1019 entry:
  // a response that completed writing but whose socket was then destroyed
  // before flush confirmation logs one line marked aborted, rather than
  // logging nothing). Always emitted (skip-prefix aside) regardless of
  // LOG_ALL_REQUESTS/LOG_SLOW_MS -- an aborted request is inherently
  // evidence a normal fast 200 is not.
  res.on('close', () => {
    if (logged || res.writableFinished) return;
    logged = true;
    if (isSkippedPath(req.logPath)) return;

    emitLine({
      ...baseFields(req),
      status: null,
      aborted: true,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
}

/**
 * Structured supplementary error line: single owner of the error line's
 * field set, emit stream, and serialize-failure guard. Called once by
 * src/app.js's global error handler -- correlated to request-log's own
 * finish/close line for the SAME request by req.reqId, which is always
 * present by the time this runs (requestLog is mounted first, ahead of every
 * other middleware including the error handler).
 * @param {import('express').Request} req
 * @param {Error} err
 */
function logRequestError(req, err) {
  emitLine({
    ...baseFields(req),
    err: err && err.message,
    stack: err && err.stack,
  });
  // A one-line stderr summary alongside the structured stdout line: a
  // host/container alerting rule watching stderr for a 500 must not go
  // silent just because the detailed record lives in a structured stdout
  // line instead.
  console.error(
    `[app] unhandled error reqId=${req.reqId} ${req.method} ${req.logPath}: ${err && err.message}`
  );
}

module.exports = { requestLog, logRequestError };
