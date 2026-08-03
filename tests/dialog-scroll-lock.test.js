// tests/dialog-scroll-lock.test.js
//
// Issue #922 AC5: src/public/js/dialog-scroll-lock.js is the single owner of
// "is any <dialog> open anywhere on this page" — a MutationObserver watching
// the whole document for `open`-attribute changes, replacing feed.css's old
// `body:has(dialog[open])` rule (deleted, #922), which fails closed on an
// engine without :has() support.
//
// The observer must catch a <dialog> created AFTER the script has already
// run — the lightbox's own lazy-creation pattern (document.createElement in
// build(), src/public/js/lightbox.js) — since no dialog in this app is
// server-rendered `open`; every one opens via showModal(). A MutationObserver
// callback fires as a microtask, not synchronously with the attribute
// mutation, so each assertion below awaits one microtask turn first.
'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const DIALOG_SCROLL_LOCK_JS_PATH = path.join(
  __dirname,
  '..',
  'src',
  'public',
  'js',
  'dialog-scroll-lock.js'
);

const LOCK_CLASS = 'dialog-scroll-lock';

/** Flush one microtask turn so a queued MutationObserver callback runs. */
function flushMicrotasks() {
  return Promise.resolve();
}

/**
 * Build a fresh jsdom document with an empty <body>, install window/document
 * as globals, and require the real dialog-scroll-lock.js fresh — so its
 * MutationObserver is bound to THIS document, watching from before any
 * dialog (lazy or not) exists.
 */
function loadDialogScrollLock() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });

  // MutationObserver belongs on the list: the script guards on it being a
  // function before observing anything, and Node's own global scope has no
  // MutationObserver. Install jsdom's, or the script returns early and every
  // assertion below fails against a correct implementation.
  const keys = ['window', 'document', 'MutationObserver'];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    Object.defineProperty(global, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  });

  delete require.cache[require.resolve(DIALOG_SCROLL_LOCK_JS_PATH)];
  require(DIALOG_SCROLL_LOCK_JS_PATH);

  function restore() {
    keys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
  }

  return { dom, doc: dom.window.document, restore };
}

describe('dialog-scroll-lock.js (issue #922 AC5)', () => {
  test('a dialog created and inserted AFTER the script has run still gets caught when it gains `open`', async () => {
    const { doc, restore } = loadDialogScrollLock();

    expect(doc.body.classList.contains(LOCK_CLASS)).toBe(false);

    // Mirrors lightbox.js's own lazy pattern: created well after this script
    // has already started observing, not present at first paint.
    const lazyDialog = doc.createElement('dialog');
    doc.body.appendChild(lazyDialog);
    lazyDialog.setAttribute('open', '');

    await flushMicrotasks();
    expect(doc.body.classList.contains(LOCK_CLASS)).toBe(true);

    restore();
  });

  test('the lock is removed the moment the sole open dialog closes', async () => {
    const { doc, restore } = loadDialogScrollLock();

    const dialogEl = doc.createElement('dialog');
    doc.body.appendChild(dialogEl);
    dialogEl.setAttribute('open', '');
    await flushMicrotasks();
    expect(doc.body.classList.contains(LOCK_CLASS)).toBe(true);

    dialogEl.removeAttribute('open');
    await flushMicrotasks();
    expect(doc.body.classList.contains(LOCK_CLASS)).toBe(false);

    restore();
  });

  test('with two dialogs open, closing one leaves the lock in place; only closing the LAST removes it', async () => {
    const { doc, restore } = loadDialogScrollLock();

    const first = doc.createElement('dialog');
    const second = doc.createElement('dialog');
    doc.body.appendChild(first);
    doc.body.appendChild(second);

    first.setAttribute('open', '');
    await flushMicrotasks();
    expect(doc.body.classList.contains(LOCK_CLASS)).toBe(true);

    second.setAttribute('open', '');
    await flushMicrotasks();
    expect(doc.body.classList.contains(LOCK_CLASS)).toBe(true);

    first.removeAttribute('open');
    await flushMicrotasks();
    expect(doc.body.classList.contains(LOCK_CLASS)).toBe(true);

    second.removeAttribute('open');
    await flushMicrotasks();
    expect(doc.body.classList.contains(LOCK_CLASS)).toBe(false);

    restore();
  });

  test('feed.css locks scroll via that class, not a :has() selector', () => {
    const fs = require('fs');
    const cssPath = path.join(__dirname, '..', 'src', 'public', 'css', 'feed.css');
    // Comments stripped first via the shared owner of that rule (#922): the
    // replacement rule left a comment behind naming the `:has()` selector it
    // is NOT, and a raw read would match that prose and fail on correct code.
    const { stripCssComments } = require('./helpers/source-text');
    const css = stripCssComments(fs.readFileSync(cssPath, 'utf8'));
    expect(css).toMatch(/body\.dialog-scroll-lock\s*\{[^}]*overflow:\s*hidden/);
    expect(css).not.toMatch(/:has\(dialog\[open\]\)/);
  });
});
