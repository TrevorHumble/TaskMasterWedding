// tests/admin-pw.test.js
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadApp } = require('./helpers/testApp');
const request = require('supertest');

describe('admin password security', () => {
  it('AC1: POST /admin/login with no hash does not leak ButtMonster or set-admin-password', async () => {
    const { app } = loadApp();
    const res = await request(app).post('/admin/login').type('form').send({ password: 'x' });
    expect(res.text).not.toContain('ButtMonster');
    expect(res.text).not.toContain('set-admin-password');
  });

  it('AC2: running set-admin-password.js with no argument exits non-zero and writes no hash', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-pw-ac2-'));
    let threw = false;
    try {
      execFileSync('node', ['scripts/set-admin-password.js'], {
        env: { ...process.env, DATA_DIR: tmp, DB_PATH: path.join(tmp, 't.db') },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'admin.hash'))).toBe(false);
  });

  it('AC3: running set-admin-password.js with a password exits 0 and writes admin.hash', () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-pw-ac3-'));
    execFileSync('node', ['scripts/set-admin-password.js', 'Hunter2Strong!'], {
      env: { ...process.env, DATA_DIR: tmp2, DB_PATH: path.join(tmp2, 't.db') },
    });
    expect(fs.existsSync(path.join(tmp2, 'admin.hash'))).toBe(true);
  });
});
