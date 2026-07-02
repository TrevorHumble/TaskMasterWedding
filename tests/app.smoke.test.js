// tests/app.smoke.test.js
// Behavioral smoke tests: proves the app is importable without binding a port,
// that env overrides land in config, and that the temp DB is actually used.
'use strict';

const fs = require('fs');
const { loadApp, seed } = require('./helpers/testApp');
const request = require('supertest');

let app;
let db;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
});

describe('app smoke', () => {
  it('GET /admin/login returns 200 (importable, no port bound)', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
  });

  it('config.DB_PATH equals process.env.DB_PATH (env override lands in config)', () => {
    const config = require('../config');
    expect(config.DB_PATH).toBe(process.env.DB_PATH);
  });

  it('seed inserts a submission and the temp DB file exists', () => {
    seed(db);
    const row = db
      .prepare('SELECT t.title AS title FROM submissions s JOIN tasks t ON t.id = s.task_id')
      .get();
    expect(row.title).toBe('Selfie with the cake');
    expect(fs.existsSync(process.env.DB_PATH)).toBe(true);
  });
});
