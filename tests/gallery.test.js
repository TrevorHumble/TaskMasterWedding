// tests/gallery.test.js
'use strict';

const { loadApp, seed, signInGuest } = require('./helpers/testApp');
const request = require('supertest');

let agent;
let ids;

beforeAll(async () => {
  const { app, db } = loadApp();
  ids = seed(db);
  agent = request.agent(app);
  signInGuest(app, 'seedtoken', agent);
});

describe('gallery page', () => {
  it('AC1: GET /gallery returns 200 with real thumbnail src, photo-page link, and task title', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    expect(res.text).toContain('src="/thumbs/t.jpg"');
    // Thumbnails open the feed at that photo, with the server-resolved
    // ?from anchor so the bounded page always contains it (issue #194).
    expect(res.text).toContain(
      'href="/feed?from=' + ids.submissionId + '#photo-' + ids.submissionId + '"'
    );
    expect(res.text).toContain('Selfie with the cake');
  });

  it('AC2: GET /gallery does not contain data-src="/thumbs/', async () => {
    const res = await agent.get('/gallery');
    expect(res.text).not.toContain('data-src="/thumbs/');
  });

  it('AC3: GET /u/:guestId returns 200 with real thumbnail src and a feed link scoped to this profile', async () => {
    const p = await agent.get('/u/' + ids.guestId);
    expect(p.status).toBe(200);
    expect(p.text).toContain('src="/thumbs/t.jpg"');
    // Thumbnails open the feed scoped to this profile's own photos (issue
    // #952, gallery parity), not the old /p/<id> dead end, carrying
    // origin=profile (issue #954) so the scoped feed's back link returns to
    // this exact profile page. The rendered anchor HTML-escapes the query
    // separators to &amp; (approved markup).
    expect(p.text).toContain(
      'href="/feed?from=' +
        ids.submissionId +
        '&amp;scope=u' +
        ids.guestId +
        '&amp;origin=profile' +
        '#photo-' +
        ids.submissionId +
        '"'
    );
  });
});
