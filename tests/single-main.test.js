// tests/single-main.test.js
// AC3 + AC4: assert exactly one <main in the rendered HTML for two routes.
'use strict';

const { loadApp, seed, signInGuest } = require('./helpers/testApp');
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
    // A persistent agent carries the gsid cookie signInGuest mints for it
    // across this request and any later ones in the same test.
    const agent = request.agent(app);
    signInGuest(app, 'seedtoken', agent);
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    const count = (res.text.match(/<main/g) || []).length;
    expect(count).toBe(1);
    expect(res.text).toContain('Seed Guest');
  });

  it('issue #119 AC3: seeded guest GET / renders guest-home, not the retired placeholder string', async () => {
    const agent = request.agent(app);
    signInGuest(app, 'seedtoken', agent);
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Garden Party Pastels server is running');
  });
});
