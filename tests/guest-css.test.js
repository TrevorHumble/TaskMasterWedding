// tests/guest-css.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const { loadApp, seed } = require('./helpers/testApp');
const request = require('supertest');

let app;
let agent;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  seed(loaded.db);
  agent = request.agent(app);
  await agent.get('/j/seedtoken');
});

describe('guest-css class reconnection', () => {
  it('AC1: GET /admin/login contains btn and form-group, not form-row or btn--primary', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="btn"');
    expect(res.text).toContain('class="form-group"');
    expect(res.text).not.toContain('form-row');
    expect(res.text).not.toContain('btn--primary');
  });

  it('AC2: GET /onboard contains btn, form-group, field-hint, not form-row/btn--primary/form-help', async () => {
    const res = await agent.get('/onboard');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="btn"');
    expect(res.text).toContain('class="form-group"');
    expect(res.text).toContain('field-hint');
    expect(res.text).not.toContain('form-row');
    expect(res.text).not.toContain('btn--primary');
    expect(res.text).not.toContain('form-help');
  });

  it('AC3: GET /gallery contains class="page gallery-page", not class="container"', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="page gallery-page"');
    expect(res.text).not.toContain('class="container"');
  });

  it('AC4: tasks.ejs uses task-item and task-title, not task-row/task-title-text/task-done', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'tasks.ejs'), 'utf8');
    expect(src).toContain('class="task-item');
    expect(src).toContain('class="task-title"');
    expect(src).not.toContain('task-row');
    expect(src).not.toContain('task-title-text');
    expect(src).not.toContain('task-done');
  });
});
