// src/services/export.js
'use strict';

const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const ExcelJS = require('exceljs');

const config = require('../../config');
const { db } = require('../db');
const scoring = require('./scoring');
const { parseSqliteDatetime } = require('./relative-time');

/**
 * Prepend an apostrophe to any string value whose first character would be
 * interpreted as a spreadsheet formula trigger (=, +, -, @, tab, CR). Numbers
 * and non-string values pass through unchanged.
 * Reference: OWASP CSV Injection — https://owasp.org/www-community/attacks/CSV_Injection
 */
function neutralizeCell(value) {
  if (typeof value === 'string' && value.length > 0 && /^[=+@\t\r-]/.test(value)) {
    return "'" + value;
  }
  return value;
}

/**
 * Turn any guest name / task title into something safe to use as a file or
 * folder name on Windows (and everywhere else).
 *  - keeps letters, numbers, space, dash, underscore, dot
 *  - replaces every other character with a dash
 *  - collapses runs of dashes/spaces, trims them off the ends
 *  - falls back to a default if the result is empty
 */
function safeName(input, fallback) {
  const raw = input == null ? '' : String(input);
  let cleaned = raw
    .replace(/[^A-Za-z0-9 _.-]+/g, '-') // disallowed chars -> dash
    .replace(/[\s-]+/g, '-') // collapse spaces/dashes
    .replace(/^[.\-]+|[.\-]+$/g, ''); // trim leading/trailing dot or dash
  if (!cleaned) cleaned = fallback;
  // Keep names short enough to avoid Windows path-length problems.
  if (cleaned.length > 60) cleaned = cleaned.slice(0, 60);
  return cleaned;
}

/**
 * Get a file extension (including the leading dot, lowercased) from a stored
 * photo filename. Defaults to .jpg because sharp writes JPEGs.
 */
function extOf(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return ext || '.jpg';
}

/**
 * Format an ISO-ish datetime string (stored as datetime('now')) for display.
 * If parsing fails we just return the raw stored string. The SQLite-datetime
 * -> UTC-Date conversion is owned by src/services/relative-time.js
 * (parseSqliteDatetime) so this storage-format rule lives in exactly one place.
 */
function fmtDate(value) {
  if (!value) return '';
  const d = parseSqliteDatetime(value);
  if (!d) return String(value);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Build the summary.xlsx workbook entirely in memory and return it as a Buffer.
 * Four sheets: Guests, Submissions, Badges, Comments.
 */
async function buildSummaryBuffer() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Wedding Master';
  workbook.created = new Date();

  // ---- Pull data once -----------------------------------------------------

  const guests = db
    .prepare('SELECT id, name, bonus_points, social_links, created_at FROM guests ORDER BY id')
    .all();

  const tasks = db.prepare('SELECT id, title, sort_order FROM tasks ORDER BY sort_order, id').all();
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const submissions = db
    .prepare(
      'SELECT s.id, s.guest_id, s.task_id, s.caption, s.photo_bonus, s.taken_down, s.created_at ' +
        'FROM submissions s ORDER BY s.guest_id, s.task_id'
    )
    .all();

  const badges = db
    .prepare('SELECT id, code, name, type, threshold, description FROM badges ORDER BY id')
    .all();
  const badgeById = new Map(badges.map((b) => [b.id, b]));

  const guestBadges = db.prepare('SELECT guest_id, badge_id, awarded_by FROM guest_badges').all();

  // Like counts per submission, one grouped query rather than a per-row query
  // in the Submissions loop below.
  const likeCounts = db
    .prepare('SELECT submission_id, COUNT(*) AS c FROM likes GROUP BY submission_id')
    .all();
  const likeCountBySubmission = new Map(likeCounts.map((r) => [r.submission_id, r.c]));

  // ALL comments (taken_down included, same "nothing is lost" rule as
  // submissions), joined to guest/task/photo-owner names for display.
  const comments = db
    .prepare(
      `SELECT c.id, c.body, c.taken_down, c.created_at,
              c.guest_id AS commenterId, s.task_id AS taskId, s.guest_id AS ownerId
         FROM comments c
         JOIN submissions s ON s.id = c.submission_id
        ORDER BY c.created_at, c.id`
    )
    .all();

  // ---- Pre-compute per-guest aggregates -----------------------------------

  const badgeNamesByGuest = new Map(); // guestId -> [badge name, ...]
  for (const gb of guestBadges) {
    const badge = badgeById.get(gb.badge_id);
    if (!badge) continue;
    if (!badgeNamesByGuest.has(gb.guest_id)) badgeNamesByGuest.set(gb.guest_id, []);
    badgeNamesByGuest.get(gb.guest_id).push(badge.name);
  }

  // ---- Sheet 1: Guests ----------------------------------------------------

  const guestsSheet = workbook.addWorksheet('Guests');
  guestsSheet.columns = [
    { header: 'Guest ID', key: 'id', width: 10 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Completed Tasks', key: 'completed', width: 16 },
    { header: 'Bonus Points', key: 'bonus', width: 14 },
    { header: 'Total Points', key: 'total', width: 14 },
    { header: 'Badges', key: 'badges', width: 50 },
    { header: 'Social Links', key: 'social', width: 40 },
  ];
  guestsSheet.getRow(1).font = { bold: true };

  for (const g of guests) {
    // Completed-count and total points come from scoring.js (issue #104) —
    // the single authority for the rule, so this sheet can never drift from
    // the admin guests page or a guest's own home-page count.
    const completed = scoring.getCompletedCount(g.id);
    const bonus = g.bonus_points || 0;
    const total = scoring.getPoints(g.id);
    const names = (badgeNamesByGuest.get(g.id) || []).join(', ');

    // social_links is a JSON object string; show it as "key: value" pairs.
    let socialText;
    try {
      const obj = JSON.parse(g.social_links || '{}');
      socialText = Object.keys(obj)
        .filter((k) => obj[k])
        .map((k) => `${k}: ${obj[k]}`)
        .join('; ');
    } catch (e) {
      socialText = '';
    }

    guestsSheet.addRow({
      id: g.id,
      name: neutralizeCell(g.name || '(no name yet)'),
      completed,
      bonus,
      total,
      badges: neutralizeCell(names),
      social: neutralizeCell(socialText),
    });
  }

  // ---- Sheet 2: Submissions ----------------------------------------------

  const subsSheet = workbook.addWorksheet('Submissions');
  subsSheet.columns = [
    { header: 'Guest ID', key: 'guestId', width: 10 },
    { header: 'Guest', key: 'guest', width: 28 },
    { header: 'Task', key: 'task', width: 40 },
    { header: 'Caption', key: 'caption', width: 40 },
    { header: 'Date', key: 'date', width: 22 },
    { header: 'Taken Down', key: 'takenDown', width: 12 },
    { header: 'Likes', key: 'likes', width: 10 },
    { header: 'Photo Bonus', key: 'photoBonus', width: 12 },
  ];
  subsSheet.getRow(1).font = { bold: true };

  const guestById = new Map(guests.map((g) => [g.id, g]));

  for (const s of submissions) {
    const g = guestById.get(s.guest_id);
    const t = taskById.get(s.task_id);
    subsSheet.addRow({
      guestId: s.guest_id,
      guest: neutralizeCell(g ? g.name || '(no name yet)' : `#${s.guest_id}`),
      task: neutralizeCell(s.task_id === null ? 'Memory' : t ? t.title : `Task #${s.task_id}`),
      caption: neutralizeCell(s.caption || ''),
      date: fmtDate(s.created_at),
      takenDown: s.taken_down === 1 ? 'YES' : 'no',
      likes: likeCountBySubmission.get(s.id) || 0,
      photoBonus: s.photo_bonus || 0,
    });
  }

  // ---- Sheet 3: Badges ----------------------------------------------------

  const badgesSheet = workbook.addWorksheet('Badges');
  badgesSheet.columns = [
    { header: 'Code', key: 'code', width: 14 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Type', key: 'type', width: 10 },
    { header: 'Threshold', key: 'threshold', width: 12 },
    { header: 'Description', key: 'description', width: 50 },
  ];
  badgesSheet.getRow(1).font = { bold: true };

  for (const b of badges) {
    badgesSheet.addRow({
      code: neutralizeCell(b.code),
      name: neutralizeCell(b.name),
      type: b.type,
      threshold: b.threshold == null ? '' : b.threshold,
      description: neutralizeCell(b.description || ''),
    });
  }

  // ---- Sheet 4: Comments --------------------------------------------------
  // ALL comments, including taken_down (hidden) ones — labeled the same way
  // the Submissions sheet labels a taken-down photo, so nothing guests wrote
  // is lost even if an admin hid it before the export ran.

  const commentsSheet = workbook.addWorksheet('Comments');
  commentsSheet.columns = [
    { header: 'Guest', key: 'guest', width: 28 },
    { header: 'Task', key: 'task', width: 40 },
    { header: 'Photo Owner', key: 'photoOwner', width: 28 },
    { header: 'Comment', key: 'comment', width: 50 },
    { header: 'Date', key: 'date', width: 22 },
    { header: 'Hidden', key: 'hidden', width: 10 },
  ];
  commentsSheet.getRow(1).font = { bold: true };

  for (const c of comments) {
    const commenter = guestById.get(c.commenterId);
    const owner = guestById.get(c.ownerId);
    const t = taskById.get(c.taskId);
    commentsSheet.addRow({
      guest: neutralizeCell(commenter ? commenter.name || '(no name yet)' : `#${c.commenterId}`),
      task: neutralizeCell(t ? t.title : `Task #${c.taskId}`),
      photoOwner: neutralizeCell(owner ? owner.name || '(no name yet)' : `#${c.ownerId}`),
      comment: neutralizeCell(c.body || ''),
      date: fmtDate(c.created_at),
      hidden: c.taken_down === 1 ? 'YES' : 'no',
    });
  }

  // ---- Serialize to a Buffer ---------------------------------------------

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Build the export ZIP and stream it to the Express response as a download.
 * The response gets Content-Disposition: attachment so the browser saves it.
 *
 * Layout inside the ZIP:
 *   summary.xlsx
 *   <SafeName>-<id>/task-<sortorder>-<safeTaskTitle>.<ext>
 *   <SafeName>-<id>/memory-<submissionId>.<ext>   (issue #247, task_id IS NULL)
 *   ...
 *
 * ALL originals are included (taken-down photos too) so nothing is lost.
 */
async function streamExportZip(res) {
  // Filename like weddingmaster-export-2026-06-27.zip
  const stamp = new Date().toISOString().slice(0, 10);
  const zipName = `weddingmaster-export-${stamp}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });

  // If archiving fails, surface it. Once headers/data have started streaming we
  // can't send a clean error page, so we just destroy the socket; if it fails
  // before any bytes were sent, send a 500.
  archive.on('error', (err) => {
    console.error('[export] archive error:', err);
    if (res.headersSent) {
      res.destroy(err);
    } else {
      res.status(500).send('Export failed. See server console.');
    }
  });

  // 'warning' fires for non-fatal issues (e.g. a stat failure). Log and continue.
  archive.on('warning', (err) => {
    console.warn('[export] archive warning:', err);
  });

  // Pipe the archive bytes straight into the HTTP response.
  archive.pipe(res);

  // 1) Build the spreadsheet first and add it at the top level.
  const summaryBuffer = await buildSummaryBuffer();
  archive.append(summaryBuffer, { name: 'summary.xlsx' });

  // 2) Add every guest's original photos into a per-guest folder.
  const guests = db.prepare('SELECT id, name, avatar_path FROM guests ORDER BY id').all();

  const tasks = db.prepare('SELECT id, title, sort_order FROM tasks ORDER BY sort_order, id').all();
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Pull ALL submissions (taken-down included) grouped by guest.
  const subsStmt = db.prepare(
    'SELECT id, task_id, photo_path FROM submissions WHERE guest_id = ? ORDER BY task_id'
  );

  for (const g of guests) {
    const folder = `${safeName(g.name, 'guest')}-${g.id}`;
    const subs = subsStmt.all(g.id);

    for (const s of subs) {
      const sourcePath = path.join(config.UPLOADS_DIR, s.photo_path);

      // Skip silently if the file is missing on disk (keeps export robust).
      if (!fs.existsSync(sourcePath)) {
        console.warn(`[export] missing original on disk, skipping: ${sourcePath}`);
        continue;
      }

      const ext = extOf(s.photo_path);

      // A memory (issue #247, task_id IS NULL) has no task to derive a name
      // from — name it by submission id instead, which is unique per row, so
      // memory entries never collide with each other or with any task entry.
      let entryName;
      if (s.task_id === null) {
        entryName = `${folder}/memory-${s.id}${ext}`;
      } else {
        const task = taskById.get(s.task_id);
        const sortOrder = task ? task.sort_order : 0;
        const titlePart = safeName(task ? task.title : `task-${s.task_id}`, `task-${s.task_id}`);
        // e.g. Lilly-Sckeiky-3/task-2-Find-the-cake.jpg
        entryName = `${folder}/task-${sortOrder}-${titlePart}${ext}`;
      }

      archive.append(fs.createReadStream(sourcePath), { name: entryName });
    }

    // Avatar (issue #192): one file per guest, alongside their task photos.
    if (g.avatar_path) {
      const avatarSourcePath = path.join(config.UPLOADS_DIR, g.avatar_path);
      if (fs.existsSync(avatarSourcePath)) {
        const avatarExt = extOf(g.avatar_path);
        archive.append(fs.createReadStream(avatarSourcePath), {
          name: `${folder}/avatar${avatarExt}`,
        });
      } else {
        console.warn(`[export] missing avatar on disk, skipping: ${avatarSourcePath}`);
      }
    }
  }

  // 3) Done adding entries — finalize. This flushes the rest to the response.
  await archive.finalize();
}

module.exports = { streamExportZip, buildSummaryBuffer, safeName, neutralizeCell };
