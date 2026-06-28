// tests/single-main.test.js
// AC3 + AC4: assert exactly one <main in the rendered HTML for two routes.
'use strict';

const { loadApp, seed } = require('./helpers/testApp');
const request = require('supertest');

let app;
let db;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  seed(db);
});

describe('single <main> per page', () => {
  it('AC3: GET /admin/login returns 200 with exactly one <main', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    const count = (res.text.match(/<main/g) || []).length;
    expect(count).toBe(1);
  });

  it('AC4: seeded guest GET / returns 200 with exactly one <main and the guest name', async () => {
    // Use a persistent agent so the session cookie from /j/seedtoken is kept.
    const agent = request.agent(app);
    // Step 1: consume the join link WITHOUT following the redirect.
    await agent.get('/j/seedtoken');
    // Step 2: now fetch the home page — the agent has the gsid cookie.
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    const count = (res.text.match(/<main/g) || []).length;
    expect(count).toBe(1);
    expect(res.text).toContain('Seed Guest');
  });
});
