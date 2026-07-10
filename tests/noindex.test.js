// tests/noindex.test.js
'use strict';

const { loadApp, seed } = require('./helpers/testApp');
const request = require('supertest');

let agent;

beforeAll(async () => {
  const { app, db } = loadApp();
  seed(db);
  agent = request.agent(app);
  await agent.get('/j/seedtoken');
});

describe('search-engine indexing is blocked site-wide', () => {
  it('AC1: GET /robots.txt returns 200 with the disallow-all body', async () => {
    const res = await agent.get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.text).toContain('User-agent: *');
    expect(res.text).toContain('Disallow: /');
  });

  it('AC2: GET /gallery and /leaderboard carry X-Robots-Tag: noindex, nofollow', async () => {
    const gallery = await agent.get('/gallery');
    expect(gallery.headers['x-robots-tag']).toBe('noindex, nofollow');

    const leaderboard = await agent.get('/leaderboard');
    expect(leaderboard.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('AC3: GET /leaderboard renders the noindex meta tag in the HTML body', async () => {
    const res = await agent.get('/leaderboard');
    expect(res.text).toContain('<meta name="robots" content="noindex, nofollow">');
  });
});
