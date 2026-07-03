// tests/brand.test.js
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

describe('brand name', () => {
  it('AC1: GET /gallery carries the new brand and never the old', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    const text = res.text.toLowerCase();
    expect(text).toContain('lilly');
    expect(text).toContain('axel');
    expect(text).not.toContain('lillian');
  });

  it('AC1: the 404 page carries the new brand and never the old', async () => {
    const res = await agent.get('/this-route-does-not-exist');
    expect(res.status).toBe(404);
    const text = res.text.toLowerCase();
    expect(text).toContain('lilly');
    expect(text).toContain('axel');
    expect(text).not.toContain('lillian');
  });
});
