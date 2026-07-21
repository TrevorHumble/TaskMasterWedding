// tests/task-countdown.test.js
// Issue #754 review fix, MINOR H: no test drove src/public/js/task-countdown.js
// itself (the client-side half of AC3's "correct on load, JS off; ticking
// with JS on" promise). Mirrors the jsdom-driven pattern in
// tests/lightbox.test.js: install window/document/navigator as globals so
// the real script's bare `document` references resolve to a real jsdom
// document, then require it fresh.
'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const TASK_COUNTDOWN_JS_PATH = path.join(
  __dirname,
  '..',
  'src',
  'public',
  'js',
  'task-countdown.js'
);

function countdownMarkup(unlockAtIso) {
  return (
    '<span class="task-countdown" data-unlock-at="' +
    unlockAtIso +
    '">' +
    '<span class="task-countdown-label">Unlocks in</span>' +
    '<span class="task-countdown-clock">' +
    '<span class="cd-part"><span class="cd-num" data-cd="d">0</span></span>' +
    '<span class="cd-part"><span class="cd-num" data-cd="h">00</span></span>' +
    '<span class="cd-part"><span class="cd-num" data-cd="m">00</span></span>' +
    '<span class="cd-part"><span class="cd-num" data-cd="s">00</span></span>' +
    '</span>' +
    '</span>'
  );
}

/**
 * Build a jsdom document from the given body markup, install
 * window/document/navigator as globals, then require the real
 * task-countdown.js fresh (it is a self-executing IIFE — requiring it runs
 * it immediately, same as a real <script defer> load).
 * @param {string} bodyHtml
 * @returns {{dom: JSDOM, doc: Document, restore: () => void}}
 */
function loadTaskCountdown(bodyHtml) {
  const dom = new JSDOM('<!doctype html><html><body>' + bodyHtml + '</body></html>', {
    url: 'http://localhost/tasks',
  });

  const keys = ['window', 'document', 'navigator'];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    Object.defineProperty(global, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  });

  delete require.cache[require.resolve(TASK_COUNTDOWN_JS_PATH)];
  require(TASK_COUNTDOWN_JS_PATH);

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

describe('task-countdown.js (issue #754 review fix, MINOR H)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a past data-unlock-at settles on "any moment now", sets is-unlocking, and never navigates across repeated ticks', () => {
    vi.useFakeTimers();
    const past = new Date(Date.now() - 5000).toISOString();
    const { dom, doc, restore } = loadTaskCountdown(countdownMarkup(past));
    try {
      const card = doc.querySelector('.task-countdown');
      expect(card.classList.contains('is-unlocking')).toBe(true);
      expect(doc.querySelector('.task-countdown-clock').textContent).toBe('any moment now');

      // Deliberately does NOT reload/navigate once settled (see the file's
      // own comment on why: a clock-skewed device or server would otherwise
      // reload the whole party's task list in a loop at the one moment
      // everyone is looking at it). Advance several ticks past the unlock
      // instant and confirm the page never navigated.
      const hrefBefore = dom.window.location.href;
      vi.advanceTimersByTime(5000);
      expect(dom.window.location.href).toBe(hrefBefore);
      expect(card.classList.contains('is-unlocking')).toBe(true);
      expect(doc.querySelector('.task-countdown-clock').textContent).toBe('any moment now');
    } finally {
      restore();
    }
  });

  test('a future data-unlock-at repaints the d/h/m/s digits as time elapses, without touching untouched digits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'));
    const future = new Date('2026-08-07T00:00:05.000Z').toISOString(); // 5s out
    const { doc, restore } = loadTaskCountdown(countdownMarkup(future));
    try {
      const secondsEl = doc.querySelector('[data-cd="s"]');
      const minutesEl = doc.querySelector('[data-cd="m"]');
      expect(secondsEl.textContent).toBe('05');
      expect(minutesEl.textContent).toBe('00');

      vi.advanceTimersByTime(3000);
      expect(secondsEl.textContent).toBe('02');
      expect(minutesEl.textContent).toBe('00');
      expect(doc.querySelector('.task-countdown').classList.contains('is-unlocking')).toBe(false);
    } finally {
      restore();
    }
  });
});
