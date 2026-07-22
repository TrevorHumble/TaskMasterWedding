// tests/task-countdown.test.js
// Issue #754 review fix, MINOR H: no test drove src/public/js/task-countdown.js
// itself (the client-side half of AC3's "correct on load, JS off; ticking
// with JS on" promise). Mirrors the jsdom-driven pattern in
// tests/lightbox.test.js: install window/document/navigator as globals so
// the real script's bare `document` references resolve to a real jsdom
// document, then require it fresh.
'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const TASK_COUNTDOWN_JS_PATH = path.join(
  __dirname,
  '..',
  'src',
  'public',
  'js',
  'task-countdown.js'
);

const TASK_TODO_ROW_EJS_PATH = path.join(
  __dirname,
  '..',
  'src',
  'views',
  'partials',
  'task-todo-row.ejs'
);
const TASK_TODO_ROW_EJS_SOURCE = fs.readFileSync(TASK_TODO_ROW_EJS_PATH, 'utf8');

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

/**
 * One flash row's markup, matching src/views/partials/task-todo-row.ejs's
 * real shape closely enough for the script's selectors and DOM traversal
 * (`.task-flash-flag[data-ends-at]`, `flag.closest('.task-row')`,
 * `row.querySelector('.task-points[data-base-label]')`) to exercise the
 * real code paths -- issue #762 criteria 5-6.
 * @param {{id: number, endsAtIso: string, totalMs: number, worth: number, flashBonus: number}} opts
 * @returns {string}
 */
function flashRowMarkup({ id, endsAtIso, totalMs, worth, flashBonus }) {
  return (
    '<li class="task-row task-todo task-flash task-flash-drain">' +
    '<a class="task-link" href="/tasks/' +
    id +
    '">' +
    '<span class="task-body">' +
    '<span class="task-flash-flag" data-ends-at="' +
    endsAtIso +
    '" data-total-ms="' +
    totalMs +
    '" style="--flash-left: 99%">' +
    '<span class="task-flash-bolt" aria-hidden="true"></span>' +
    '<span class="task-flash-copy">+' +
    flashBonus +
    ' pts right now</span>' +
    '<span class="task-flash-clock">00:00</span>' +
    '</span>' +
    '<span class="task-title-text">Flash Task ' +
    id +
    '</span>' +
    '</span>' +
    '<span class="task-points task-points-raised" data-base-label="+' +
    worth +
    ' pt">' +
    '<span class="task-points-was">+' +
    worth +
    '</span>' +
    '+' +
    (worth + flashBonus) +
    ' pts' +
    '</span>' +
    '</a>' +
    '</li>'
  );
}

/**
 * Render the REAL src/views/partials/task-todo-row.ejs for an active flash
 * row with `msRemaining` left on the window, and return the clock text it
 * paints server-side. `nowMs` must be the exact instant the fake system
 * clock is pinned to when this is called (issue #762 criterion 4's binding
 * test below) -- the template's own `Date.now()` call resolves against
 * vitest's faked global Date, so there is no real-clock skew between this
 * and renderClientFlashClock() below for the same nowMs/msRemaining pair.
 * @param {number} nowMs
 * @param {number} msRemaining
 * @returns {string}
 */
function renderServerFlashClock(nowMs, msRemaining) {
  const t = {
    id: 1,
    title: 'Format Binding Task',
    description: '',
    worth: 1,
    locked: false,
    isToday: false,
    flashActive: true,
    flashEndsAt: new Date(nowMs + msRemaining).toISOString(),
    flashTotalMs: 24 * 3600000, // large enough that this window is never "ended" here
    flashBonus: 2,
    badge: { name: 'Test Badge', art_path: '/badges/default-ribbon.svg' },
  };
  const html = ejs.render(
    TASK_TODO_ROW_EJS_SOURCE,
    { t: t, badgeIsIcon: () => false },
    { filename: TASK_TODO_ROW_EJS_PATH }
  );
  const match = html.match(/task-flash-clock">([^<]*)</);
  expect(match).not.toBeNull();
  return match[1];
}

/**
 * Load the REAL src/public/js/task-countdown.js against a flash row with
 * `msRemaining` left, and return the clock text it paints client-side after
 * its first tick(). Same nowMs/msRemaining pair as renderServerFlashClock()
 * above, so the two are directly comparable.
 * @param {number} nowMs
 * @param {number} msRemaining
 * @returns {string}
 */
function renderClientFlashClock(nowMs, msRemaining) {
  const endsAtIso = new Date(nowMs + msRemaining).toISOString();
  const markup = flashRowMarkup({
    id: 1,
    endsAtIso: endsAtIso,
    totalMs: 24 * 3600000,
    worth: 1,
    flashBonus: 2,
  });
  const { doc, restore } = loadTaskCountdown(markup);
  try {
    return doc.querySelector('.task-flash-clock').textContent;
  } finally {
    restore();
  }
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

describe('task-countdown.js flash extension (issue #762 criteria 5-6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('criterion 5: a page with a live flash and NO locked card still ticks -- the early-exit considers both clocks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'));
    const endsAt = new Date('2026-08-07T00:00:10.000Z').toISOString(); // 10s out
    const markup = flashRowMarkup({
      id: 1,
      endsAtIso: endsAt,
      totalMs: 600000,
      worth: 1,
      flashBonus: 2,
    });
    const { doc, restore } = loadTaskCountdown(markup);
    try {
      // No locked card anywhere on this page -- proves the script did not
      // exit early because `cards.length` alone was zero.
      expect(doc.querySelector('.task-countdown')).toBeNull();

      const clockEl = doc.querySelector('.task-flash-clock');
      expect(clockEl.textContent).toBe('00:10');

      vi.advanceTimersByTime(3000);
      expect(clockEl.textContent).toBe('00:07');
    } finally {
      restore();
    }
  });

  test("criterion 6: the ended branch retracts the correct row's pill AND price tag when two flashed rows are present, leaving the other row untouched", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'));
    const soonEndsAt = new Date('2026-08-07T00:00:01.000Z').toISOString(); // ends in 1s
    const laterEndsAt = new Date('2026-08-07T00:10:00.000Z').toISOString(); // ends in 10 min
    const soonRow = flashRowMarkup({
      id: 1,
      endsAtIso: soonEndsAt,
      totalMs: 60000,
      worth: 1,
      flashBonus: 2,
    });
    const laterRow = flashRowMarkup({
      id: 2,
      endsAtIso: laterEndsAt,
      totalMs: 600000,
      worth: 2,
      flashBonus: 3,
    });
    const { doc, restore } = loadTaskCountdown(soonRow + laterRow);
    try {
      // Past the first row's end instant, well before the second's.
      vi.advanceTimersByTime(2000);

      const rows = doc.querySelectorAll('.task-row');
      expect(rows.length).toBe(2);
      const soon = rows[0];
      const later = rows[1];

      // The ended row: pill retracts entirely -- copy, clock, fill, and class.
      const soonFlag = soon.querySelector('.task-flash-flag');
      expect(soonFlag.classList.contains('is-ended')).toBe(true);
      expect(soonFlag.querySelector('.task-flash-copy').textContent).toBe('Flash ended');
      expect(soonFlag.querySelector('.task-flash-clock').textContent).toBe('');
      expect(soonFlag.style.getPropertyValue('--flash-left')).toBe('0%');

      // The price tag beside it falls back to the plain base worth -- the
      // struck-through raised total is gone.
      const soonPrice = soon.querySelector('.task-points');
      expect(soonPrice.textContent).toBe('+1 pt');
      expect(soonPrice.classList.contains('task-points-raised')).toBe(false);

      // The OTHER row, still well inside its own window, is untouched --
      // proving the retraction resolved through the ended pill's own row,
      // never a document-wide query.
      const laterFlag = later.querySelector('.task-flash-flag');
      expect(laterFlag.classList.contains('is-ended')).toBe(false);
      expect(laterFlag.querySelector('.task-flash-copy').textContent).toBe('+3 pts right now');
      expect(laterFlag.querySelector('.task-flash-clock').textContent).not.toBe('');
      const laterPrice = later.querySelector('.task-points');
      expect(laterPrice.classList.contains('task-points-raised')).toBe(true);
      expect(laterPrice.textContent).toContain('+5 pts');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Review fix (architecture gate, MINOR): criterion 4 requires the server's
// first paint (src/views/partials/task-todo-row.ejs) and the ticking script
// (paintFlash() above) to format the flash clock IDENTICALLY -- mm:ss under
// an hour, h:mm:ss over it -- so the clock never visibly jumps the instant
// the script takes over. Before this test, that guarantee was comment-only:
// each side had its own hand-written copy of the format rule and nothing
// bound them together. This test drives the SAME set of remaining-millisecond
// values through the REAL server template (via ejs.render) and the REAL
// client script (via loadTaskCountdown), for the SAME pinned instant (vitest
// fake timers, so there is no real-clock skew between the two renders), and
// asserts the two produce byte-identical clock text. It fails if either side
// changes its format rule without the other -- e.g. the client always
// rendering hours while the server keeps mm:ss under an hour.
// ---------------------------------------------------------------------------
describe('issue #762 review fix: the server first paint and the client script format the flash clock identically', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const NOW_MS = Date.parse('2026-08-07T12:00:00.000Z');

  const cases = [
    ['a few seconds', 5000, '00:05'],
    ['over a minute, under an hour', 65000, '01:05'],
    ['just under an hour (no hours digit)', 3599000, '59:59'],
    ['exactly one hour (hours digit appears)', 3600000, '1:00:00'],
    ['an hour, a minute, and a second', 3661000, '1:01:01'],
    ['multiple hours', 7384000, '2:03:04'],
  ];

  it.each(cases)(
    '%s (%dms remaining): server and client agree on "%s"',
    (_label, msRemaining, expected) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW_MS));

      const serverText = renderServerFlashClock(NOW_MS, msRemaining);
      const clientText = renderClientFlashClock(NOW_MS, msRemaining);

      expect(serverText).toBe(expected);
      expect(clientText).toBe(expected);
      expect(serverText).toBe(clientText);
    }
  );
});
