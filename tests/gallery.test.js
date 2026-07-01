// tests/gallery.test.js
'use strict';

const { loadApp, seed } = require('./helpers/testApp');
const request = require('supertest');

let agent;
let ids;

beforeAll(async () => {
  const { app, db } = loadApp();
  ids = seed(db);
  agent = request.agent(app);
  await agent.get('/j/seedtoken');
});

describe('gallery page', () => {
  it('AC1: GET /gallery returns 200 with real thumbnail src, photo-page link, and task title', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    expect(res.text).toContain('src="/thumbs/t.jpg"');
    // Thumbnails now link to /p/<id> (issue #42 — lightbox removed).
    expect(res.text).toContain('href="/p/' + ids.submissionId + '"');
    expect(res.text).toContain('Selfie with the cake');
  });

  it('AC2: GET /gallery does not contain data-src="/thumbs/', async () => {
    const res = await agent.get('/gallery');
    expect(res.text).not.toContain('data-src="/thumbs/');
  });

  it('AC3: GET /u/:guestId returns 200 with real thumbnail src and photo-page link', async () => {
    const p = await agent.get('/u/' + ids.guestId);
    expect(p.status).toBe(200);
    expect(p.text).toContain('src="/thumbs/t.jpg"');
    // Thumbnails now link to /p/<id> (issue #42 — lightbox removed).
    expect(p.text).toContain('href="/p/' + ids.submissionId + '"');
  });
});
