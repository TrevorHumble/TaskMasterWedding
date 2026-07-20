// tests/submit-crash-safety.test.js
// Issue #311 AC1: a throw inside submissions.submitPhoto (unguarded
// synchronous better-sqlite3 writes) must be caught by
// src/routes/guest.js's POST /tasks/:id/submit handler, not escape as an
// unhandled rejection. Forces submitPhoto to reject (mirroring
// tests/admin-export-route-errors.test.js's "stub a service call to throw"
// pattern and tests/submission-intake.test.js's AC7 monkeypatch of
// scoring.recomputeAfterSubmissionChange), then asserts the full AC1
// contract: 302 redirect to /tasks/:id, the thumb_failed-mirroring error
// flash, a `[submit]` stderr log line naming the error, and that the process
// is still alive and answering requests afterward.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config,
// db, or the services below (see tests/helpers/testApp.js).
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let submissions;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  submissions = require('../src/services/submissions');
});

describe('POST /tasks/:id/submit — submitPhoto throws (issue #311 AC1)', () => {
  it('302-redirects with the error flash, logs "[submit]" + the error, and the process keeps serving requests', async () => {
    const token = `submit-crash-${Date.now()}`;
    db.prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`).run(
      token,
      'Crash Guest'
    );
    const taskId = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run('Crash Task').lastInsertRowid;

    const agent = request.agent(app);
    signInGuest(app, token, agent);

    const originalSubmitPhoto = submissions.submitPhoto;
    const forcedError = new Error('boom: forced submitPhoto failure');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Monkeypatch the shared submissions module (guest.js required the SAME
    // cached module object) so the route's await rejects, exactly the "a
    // stubbed statement that rejects" shape AC1 describes -- no real DB
    // fault needs to be engineered, the throw surface is submitPhoto itself.
    submissions.submitPhoto = vi.fn().mockRejectedValue(forcedError);

    try {
      const res = await agent
        .post(`/tasks/${taskId}/submit`)
        .attach('photo', Buffer.from('irrelevant bytes -- submitPhoto is mocked before any read'), {
          filename: 'crash.jpg',
          contentType: 'image/jpeg',
        });

      // 302 redirect back to the task, same as every other submit outcome.
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/tasks/' + taskId);

      // The error flash mirrors the thumb_failed branch's exact copy (AC1).
      const page = await agent.get(res.headers.location);
      expect(page.text).toContain('Sorry, we could not save that photo. Please try again.');
      expect(page.text).toContain('flash-err');

      // A stderr log line containing "[submit]" and the forced error.
      const loggedSubmitLine = consoleErrorSpy.mock.calls.some(
        (args) =>
          args.some((a) => typeof a === 'string' && a.includes('[submit]')) &&
          args.some((a) => a === forcedError)
      );
      expect(loggedSubmitLine).toBe(true);

      // The process did not exit: a second, unrelated request still answers.
      const health = await request(app).get('/healthz');
      expect(health.status).toBe(200);
    } finally {
      submissions.submitPhoto = originalSubmitPhoto;
      consoleErrorSpy.mockRestore();
    }
  });

  it('the success path is unaffected: a real submit still creates a row and redirects (no behavior change)', async () => {
    const token = `submit-ok-${Date.now()}`;
    db.prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`).run(
      token,
      'OK Guest'
    );
    const taskId = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run('OK Task').lastInsertRowid;

    const agent = request.agent(app);
    signInGuest(app, token, agent);

    const sharp = require('sharp');
    const validJpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();

    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', validJpeg, { filename: 'ok.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tasks/' + taskId);

    const row = db.prepare('SELECT * FROM submissions WHERE task_id = ?').get(taskId);
    expect(row).toBeDefined();
  });
});
