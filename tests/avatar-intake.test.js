// tests/avatar-intake.test.js
// Issue #122: onboarding (POST /onboard) and profile-edit (POST /me/edit) used
// to save avatars through two different mechanisms — onboarding via multer
// memoryStorage straight to a Buffer, profile-edit via multer diskStorage
// followed by fs.readFileSync + fs.unlinkSync to reconstruct one. Both routes
// now share one memory-storage middleware (photos.uploadAvatar, field
// "avatar"), so req.file.buffer is available directly on both paths.
//
// AC2: an onboarding avatar upload sets guests.avatar_path to a stored .jpg
// filename and that file exists on disk.
// AC3: a profile-edit avatar replacement removes the previous avatar file
// from disk and points avatar_path at the new file.
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or
// photos (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp } = require('./helpers/testApp');

let app;
let db;
let config;

// Two distinct valid JPEGs (different pixel color) so their encoded bytes —
// and therefore their stored filenames — differ, which lets AC3 assert the
// avatar_path actually changed on replacement rather than coincidentally
// matching.
let jpegOne;
let jpegTwo;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so config resolves against the temp DATA_DIR.
  config = require('../config');

  jpegOne = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .jpeg()
    .toBuffer();

  jpegTwo = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 30, g: 30, b: 200 } },
  })
    .jpeg()
    .toBuffer();
});

function insertGuest(name) {
  const token = `avatar-intake-${crypto.randomUUID()}`;
  const id = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 0)')
    .run(token, name).lastInsertRowid;
  return { id, token };
}

async function makeGuestAgent(token) {
  const agent = request.agent(app);
  await agent.get('/j/' + token).redirects(1);
  return agent;
}

function avatarAbsPath(filename) {
  return path.join(config.UPLOADS_DIR, filename);
}

describe('AC2: onboarding avatar upload stores a real file and sets avatar_path', () => {
  it('sets guests.avatar_path to a stored .jpg filename that exists on disk', async () => {
    const guest = insertGuest('');
    const agent = await makeGuestAgent(guest.token);

    const res = await agent
      .post('/onboard')
      .field('name', 'Onboard Avatar Guest')
      .attach('avatar', jpegOne, { filename: 'me.jpg', contentType: 'image/jpeg' });

    expect([301, 302, 303]).toContain(res.status);

    const row = db.prepare('SELECT avatar_path, onboarded FROM guests WHERE id = ?').get(guest.id);
    expect(row.onboarded).toBe(1);
    expect(row.avatar_path).toMatch(/\.jpg$/);
    expect(fs.existsSync(avatarAbsPath(row.avatar_path))).toBe(true);
  });
});

describe('AC3: profile-edit avatar replacement removes the old file and updates avatar_path', () => {
  it('deletes the previous avatar file and points avatar_path at the new one', async () => {
    // Seed a guest with an existing avatar via onboarding first.
    const guest = insertGuest('');
    const agent = await makeGuestAgent(guest.token);

    const onboardRes = await agent
      .post('/onboard')
      .field('name', 'Replace Avatar Guest')
      .attach('avatar', jpegOne, { filename: 'first.jpg', contentType: 'image/jpeg' });
    expect([301, 302, 303]).toContain(onboardRes.status);

    const before = db.prepare('SELECT avatar_path FROM guests WHERE id = ?').get(guest.id);
    const oldAvatarPath = before.avatar_path;
    expect(oldAvatarPath).toMatch(/\.jpg$/);
    const oldAbsPath = avatarAbsPath(oldAvatarPath);
    expect(fs.existsSync(oldAbsPath)).toBe(true);

    // Replace it via profile-edit with a different image.
    const editRes = await agent
      .post('/me/edit')
      .field('name', 'Replace Avatar Guest')
      .attach('avatar', jpegTwo, { filename: 'second.jpg', contentType: 'image/jpeg' });
    expect([301, 302, 303]).toContain(editRes.status);

    const after = db.prepare('SELECT avatar_path FROM guests WHERE id = ?').get(guest.id);
    const newAvatarPath = after.avatar_path;

    // The value actually changed to a new stored file, not a no-op.
    expect(newAvatarPath).toMatch(/\.jpg$/);
    expect(newAvatarPath).not.toBe(oldAvatarPath);

    // The new file exists; the old one was removed from disk.
    expect(fs.existsSync(avatarAbsPath(newAvatarPath))).toBe(true);
    expect(fs.existsSync(oldAbsPath)).toBe(false);
  });
});
