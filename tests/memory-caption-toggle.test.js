// tests/memory-caption-toggle.test.js
// Issue #364 AC7 + AC8: a single shared caption only makes sense for one
// photo, so the memory form's caption box hides/disables once the batch
// picker selects 2+ files, and stays visible/enabled at 0 or 1.
//
//   AC7 — pure captionState(fileCount) helper: 2+ files hides+disables the
//         caption and shows the note; 0 or 1 files shows+enables the caption
//         and hides the note.
//   AC8 (no-JS baseline) — the server-rendered memory form has the caption
//         <input> present and NOT disabled, and the note hidden by default.
'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');
const captionState = require('../src/public/js/memory-caption');

let app;
let db;

function ensureApp() {
  if (!app) {
    const loaded = loadApp();
    app = loaded.app;
    db = loaded.db;
  }
  return { app, db };
}

function insertGuest() {
  const { db: theDb } = ensureApp();
  const token = `caption-toggle-${crypto.randomUUID()}`;
  theDb
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Caption Toggle Guest');
  return token;
}

async function makeGuestAgent(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

// ---------------------------------------------------------------------------
// AC7: the pure captionState() helper.
// ---------------------------------------------------------------------------
describe('captionState() helper', () => {
  it('0 files: caption shown/enabled, note hidden', () => {
    expect(captionState(0)).toEqual({
      captionHidden: false,
      captionDisabled: false,
      noteHidden: true,
    });
  });

  it('1 file: caption shown/enabled, note hidden', () => {
    expect(captionState(1)).toEqual({
      captionHidden: false,
      captionDisabled: false,
      noteHidden: true,
    });
  });

  it('2 files: caption hidden/disabled, note shown', () => {
    expect(captionState(2)).toEqual({
      captionHidden: true,
      captionDisabled: true,
      noteHidden: false,
    });
  });

  it('3 files: caption hidden/disabled, note shown', () => {
    expect(captionState(3)).toEqual({
      captionHidden: true,
      captionDisabled: true,
      noteHidden: false,
    });
  });

  // Confirms the 1-vs-2+ boundary actually matters: an inverted or collapsed
  // implementation fails this.
  it('the 1-vs-2+ boundary flips all three fields', () => {
    const one = captionState(1);
    const two = captionState(2);
    expect(one.captionHidden).not.toBe(two.captionHidden);
    expect(one.captionDisabled).not.toBe(two.captionDisabled);
    expect(one.noteHidden).not.toBe(two.noteHidden);
  });
});

// ---------------------------------------------------------------------------
// AC8 (no-JS baseline): the rendered memory form.
// ---------------------------------------------------------------------------
describe('AC8: memory form caption baseline (no JS)', () => {
  it('the caption <input> is present and NOT disabled, and the note is hidden by default', async () => {
    ensureApp();
    const token = insertGuest();
    const agent = await makeGuestAgent(token);

    const res = await agent.get('/memories/new');
    expect(res.status).toBe(200);

    const formMatch = res.text.match(/<form[^>]*action="\/memories"[\s\S]*?<\/form>/);
    expect(formMatch).not.toBeNull();
    const formHtml = formMatch[0];

    const captionMatch = formHtml.match(/<input[^>]*id="caption"[^>]*>/);
    expect(captionMatch).not.toBeNull();
    expect(captionMatch[0]).not.toMatch(/\bdisabled\b/);

    // The note's exact literal copy, present in the page and hidden by
    // default (the [hidden] attribute — a pure JS enhancement toggles it).
    expect(res.text).toContain('To add a caption, please choose one photo at a time.');
    const noteMatch = res.text.match(/<p[^>]*id="caption-batch-note"[^>]*>/);
    expect(noteMatch).not.toBeNull();
    expect(noteMatch[0]).toMatch(/\bhidden\b/);
  });
});
