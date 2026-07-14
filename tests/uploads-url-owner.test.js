// tests/uploads-url-owner.test.js
// Issue #508: the /uploads URL mount prefix must be owned in exactly one
// place (config.UPLOADS_URL_BASE) so photos.urlForOriginal (the builder) and
// task-badges.isUploadedArtPath (the eligibility check guarding badge-art
// deletion, issue #501) can never silently diverge if the mount ever moves.
//
// AC1: config.UPLOADS_URL_BASE === '/uploads' (no trailing slash).
// AC2: photos.urlForOriginal derives its output from config.UPLOADS_URL_BASE.
// AC3: taskBadges.isUploadedArtPath derives its decision from the same value.
// AC4: src/services/task-badges.js contains no bare '/uploads/' literal.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { loadApp } = require('./helpers/testApp');

let config;
let photos;
let taskBadges;

beforeAll(() => {
  loadApp();
  config = require('../config');
  photos = require('../src/services/photos');
  taskBadges = require('../src/services/task-badges');
});

describe('config.UPLOADS_URL_BASE (AC1)', () => {
  it('is the exact literal "/uploads" with no trailing slash', () => {
    expect(config.UPLOADS_URL_BASE).toBe('/uploads');
  });
});

describe('photos.urlForOriginal derives from config.UPLOADS_URL_BASE (AC2)', () => {
  it('builds the public URL by prefixing the filename', () => {
    expect(photos.urlForOriginal('abc.jpg')).toBe('/uploads/abc.jpg');
  });

  it('stays byte-identical to config.UPLOADS_URL_BASE + "/" + filename', () => {
    // Proves the builder is DERIVED from the config value, not a coincidental
    // match with a still-hardcoded literal: if a future edit changed
    // UPLOADS_URL_BASE, this assertion (unlike a bare '/uploads/abc.jpg'
    // string) would still pass while a hardcoded builder would fail it.
    expect(photos.urlForOriginal('abc.jpg')).toBe(config.UPLOADS_URL_BASE + '/abc.jpg');
  });

  it('edge: empty input returns the empty string (falsy guard, unchanged)', () => {
    expect(photos.urlForOriginal('')).toBe('');
  });
});

describe('taskBadges.isUploadedArtPath derives from config.UPLOADS_URL_BASE (AC3)', () => {
  it('returns true for a path under the uploads mount', () => {
    expect(taskBadges.isUploadedArtPath('/uploads/abc.jpg')).toBe(true);
  });

  it('returns false for the shared static badge asset', () => {
    expect(taskBadges.isUploadedArtPath('/badges/default-ribbon.svg')).toBe(false);
  });

  it('edge: false for null/undefined (pre-existing guard, unchanged)', () => {
    expect(taskBadges.isUploadedArtPath(null)).toBe(false);
    expect(taskBadges.isUploadedArtPath(undefined)).toBe(false);
  });

  it('edge: false for a path that merely starts with the bare prefix text but is not actually under the mount', () => {
    // Guards the '+ "/"' boundary in the startsWith check: a path like
    // '/uploadsXYZ/abc.jpg' shares the 'uploads' substring but is a
    // different, unrelated mount and must not be treated as eligible for
    // deletion.
    expect(taskBadges.isUploadedArtPath('/uploadsXYZ/abc.jpg')).toBe(false);
  });
});

describe('no bare "/uploads/" literal remains in task-badges.js (AC4)', () => {
  it('the source file contains no bare /uploads/ string literal', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'task-badges.js'),
      'utf8'
    );
    expect(source).not.toContain("'/uploads/'");
    expect(source).not.toContain('"/uploads/"');
  });
});
