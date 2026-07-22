// tests/admin-tasks-script.test.js
// Issue #755 PR review fix (MAJOR): the client-side half of the one-day-only
// HOST surface — src/public/js/admin-tasks.js's openEdit() day/bonus chip
// sync, the stale-date hidden input, the promote-to-oneday default, and
// resetCreate()'s create-flow default — had no test that could fail; every
// line of it could be deleted with all other tests still green.
//
// Mirrors tests/lightbox.test.js's jsdom-driven pattern (also cited as
// precedent by tests/task-countdown.test.js and used by
// tests/admin-guests-ui.test.js's DOM-wiring describe block): build a
// synthetic document with the markup admin-tasks.js's real selectors expect
// (mirroring what src/views/admin-tasks.ejs + the dialog partials render —
// see those files for the real shape), install window/document/navigator as
// globals, require the real script fresh, then drive it with dispatched
// events. Not a fetch-and-drive-real-HTML approach (that pattern also exists
// in this repo, e.g. tests/oneday-admin-surface.test.js's markup assertions)
// — a hand-built fixture keeps this file independent of unrelated markup
// churn elsewhere on the page, same tradeoff lightbox.test.js/
// task-countdown.test.js already made for their own scripts.
'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const ADMIN_TASKS_JS_PATH = path.join(__dirname, '..', 'src', 'public', 'js', 'admin-tasks.js');

const DAY1 = '2026-08-07';
const DAY2 = '2026-08-08';
const DAY3 = '2026-08-09';
const STALE_DATE = '2026-12-25';

// Day/bonus accordion markup — mirrors the shape
// src/views/partials/special-oneday-option.ejs renders once `eventDays` is
// [Aug 7, Aug 8, Aug 9] (the default configured wedding range), including
// the hidden stale-date input task-edit-dialog.ejs adds around it for the
// EDIT dialog only (never the create dialog — see that partial's own
// comment on why).
function specialAccordion(idPrefix) {
  return (
    '<div class="special-option-group">' +
    '<label class="special-option">' +
    '<input type="radio" name="special_mode" value="oneday" />' +
    '</label>' +
    '<div class="special-panel">' +
    '<div class="day-chips">' +
    '<label class="worth-chip day-chip"><input type="radio" name="special_date" value="' +
    DAY1 +
    '" /></label>' +
    '<label class="worth-chip day-chip"><input type="radio" name="special_date" value="' +
    DAY2 +
    '" /></label>' +
    '<label class="worth-chip day-chip"><input type="radio" name="special_date" value="' +
    DAY3 +
    '" /></label>' +
    '</div>' +
    '<div class="worth-chips">' +
    '<label class="worth-chip"><input type="radio" name="special_bonus" value="1" /></label>' +
    '<label class="worth-chip"><input type="radio" name="special_bonus" value="2" /></label>' +
    '<label class="worth-chip"><input type="radio" name="special_bonus" value="3" /></label>' +
    '</div>' +
    '</div>' +
    '</div>' +
    (idPrefix === 'task-edit'
      ? '<input type="hidden" name="special_date" id="task-edit-special-date-stale" disabled />'
      : '')
  );
}

// Lucky accordion markup (issue #650) — mirrors
// src/views/partials/special-lucky-option.ejs, including the hidden
// stale-date input task-edit-dialog.ejs's own sibling adds for the EDIT
// dialog only (special-lucky-option.ejs owns this one directly, unlike the
// one-day sibling above, per plan step 6 — see that partial's own comment).
function luckyAccordion(idPrefix) {
  return (
    '<div class="special-option-group">' +
    '<label class="special-option">' +
    '<input type="radio" name="special_mode" value="lucky" />' +
    '</label>' +
    '<div class="special-panel">' +
    '<div class="day-chips">' +
    '<label class="worth-chip day-chip"><input type="radio" name="lucky_date" value="' +
    DAY1 +
    '" /></label>' +
    '<label class="worth-chip day-chip"><input type="radio" name="lucky_date" value="' +
    DAY2 +
    '" /></label>' +
    '<label class="worth-chip day-chip"><input type="radio" name="lucky_date" value="' +
    DAY3 +
    '" /></label>' +
    '</div>' +
    '<div class="worth-chips">' +
    '<label class="worth-chip"><input type="radio" name="lucky_bonus" value="1" /></label>' +
    '<label class="worth-chip"><input type="radio" name="lucky_bonus" value="2" /></label>' +
    '<label class="worth-chip"><input type="radio" name="lucky_bonus" value="3" /></label>' +
    '</div>' +
    // Nested INSIDE .special-panel (issue #650 PR review fix, Finding G) —
    // matches src/views/partials/special-lucky-option.ejs's real nesting
    // exactly (the hidden input is the panel's last child, after both
    // .special-panel-field divs, still before the panel's own closing tag).
    // Before this fix the fixture appended it AFTER the closing
    // .special-panel/.special-option-group divs, a markup shape the real
    // partial never produces.
    (idPrefix === 'task-edit'
      ? '<input type="hidden" name="lucky_date" id="task-edit-lucky-date-stale" disabled />'
      : '') +
    '</div>' +
    '</div>'
  );
}

function editDialogMarkup() {
  return (
    '<dialog id="task-edit-dialog">' +
    '<form id="task-edit-form">' +
    '<input id="task-edit-title-input" />' +
    '<textarea id="task-edit-desc-input"></textarea>' +
    '<div class="worth-field">' +
    '<label class="worth-chip"><input type="radio" name="worth" value="1" /></label>' +
    '<label class="worth-chip"><input type="radio" name="worth" value="2" /></label>' +
    '<label class="worth-chip"><input type="radio" name="worth" value="3" /></label>' +
    '</div>' +
    '<div class="special-radio">' +
    '<label class="special-option"><input type="radio" name="special_mode" value="none" /></label>' +
    '<label class="special-option"><input type="radio" name="special_mode" value="hidden" /></label>' +
    specialAccordion('task-edit') +
    luckyAccordion('task-edit') +
    '</div>' +
    '<span id="task-edit-badge-preview" class="badge-medallion-empty">' +
    '<img id="task-edit-badge-icon" hidden /></span>' +
    '<span id="task-edit-badge-name"></span>' +
    '<button type="button" id="task-edit-badge-btn"></button>' +
    '<input type="hidden" name="badge_icon" />' +
    '<input type="hidden" name="badge_name" />' +
    '<button type="button" data-delete-task></button>' +
    '</form>' +
    '</dialog>'
  );
}

function createDialogMarkup() {
  return (
    '<dialog id="task-create-dialog">' +
    '<form id="task-create-form">' +
    '<input id="task-create-title-input" />' +
    '<textarea id="task-create-desc-input"></textarea>' +
    '<div class="worth-field">' +
    '<label class="worth-chip"><input type="radio" name="worth" value="1" /></label>' +
    '<label class="worth-chip"><input type="radio" name="worth" value="2" /></label>' +
    '<label class="worth-chip"><input type="radio" name="worth" value="3" /></label>' +
    '</div>' +
    '<div class="special-radio">' +
    '<label class="special-option"><input type="radio" name="special_mode" value="none" checked /></label>' +
    '<label class="special-option"><input type="radio" name="special_mode" value="hidden" /></label>' +
    specialAccordion('task-create') +
    luckyAccordion('task-create') +
    '</div>' +
    '<span id="task-create-badge-preview" class="badge-medallion-empty">' +
    '<img id="task-create-badge-icon" hidden /></span>' +
    '<span id="task-create-badge-name"></span>' +
    '<input type="hidden" name="badge_icon" />' +
    '<input type="hidden" name="badge_name" />' +
    '<button type="submit" id="task-create-submit" disabled></button>' +
    '</form>' +
    '</dialog>'
  );
}

// Card fixture: task 1 is dated Aug 9 / +3 (matches a rendered day chip),
// task 2 is an ordinary task (no date), task 3 is dated but STALE — its
// stored date matches no rendered chip (criterion 3b), the way a task's date
// falls outside the range after the host later narrows the configured
// wedding dates.
//
// `specialKind` (issue #650 PR review fix, Finding A) stands in for what
// GET /admin/tasks now computes server-side via tasks.whatSpecial(t, clock)
// and emits as data-special-kind — this hand-built fixture has no server
// behind it, so each card's value below is the same answer whatSpecial()
// would give for that row's dates against "today" = DAY2 (see the per-task
// comments at each call site further down).
function taskCardMarkup(
  taskId,
  { title, worth, mode, specialDate, specialBonus, luckyDate, luckyBonus, specialKind }
) {
  return (
    '<li class="admin-task-card" data-task-id="' +
    taskId +
    '" data-title="' +
    title +
    '" data-description="" data-worth="' +
    worth +
    '" data-mode="' +
    mode +
    '" data-special-date="' +
    (specialDate || '') +
    '" data-special-bonus="' +
    (specialBonus || '') +
    '" data-lucky-date="' +
    (luckyDate || '') +
    '" data-lucky-bonus="' +
    (luckyBonus || '') +
    '" data-special-kind="' +
    (specialKind || '') +
    '" data-badge-name="" data-badge-art="" data-badge-default="1">' +
    '<button type="button" data-edit-task="' +
    taskId +
    '"></button>' +
    '</li>'
  );
}

// "Today" for the precedence test below (task 6) is DAY2 — no longer carried
// on the board as data-today (Finding A retired that attribute); each card's
// specialKind below already bakes in the answer against that same "today".
// DAY1 is therefore PAST, DAY3 is FUTURE, relative to this board.
function pageMarkup() {
  return (
    '<button type="button" data-open-create></button>' +
    '<ul id="admin-task-list">' +
    taskCardMarkup(1, {
      title: 'Dated Task',
      worth: 3,
      mode: 'oneday',
      specialDate: DAY3,
      specialBonus: 3,
      specialKind: 'daily', // special_date (DAY3) is FUTURE -- sealed
    }) +
    taskCardMarkup(2, { title: 'Ordinary Task', worth: 1, mode: 'none', specialKind: '' }) +
    taskCardMarkup(3, {
      title: 'Stale Dated Task',
      worth: 1,
      mode: 'oneday',
      specialDate: STALE_DATE,
      specialBonus: 2,
      specialKind: 'daily', // STALE_DATE is still a FUTURE date -- sealed
    }) +
    taskCardMarkup(4, {
      title: 'Lucky Task',
      worth: 1,
      mode: 'none',
      luckyDate: DAY2,
      luckyBonus: 2,
      specialKind: 'lucky', // lucky_date === today
    }) +
    taskCardMarkup(5, {
      title: 'Hidden Lucky Task',
      worth: 1,
      mode: 'hidden',
      luckyDate: DAY1,
      luckyBonus: 1,
      specialKind: '', // lucky_date (DAY1) is PAST -- not spoken for by anyone
    }) +
    taskCardMarkup(6, {
      title: 'Precedence Task',
      worth: 1,
      mode: 'oneday',
      specialDate: DAY3, // future -- daily IS spoken for
      specialBonus: 1,
      luckyDate: DAY1, // past -- must lose the radio to special_date
      luckyBonus: 2,
      specialKind: 'daily', // daily wins the walk when both could apply
    }) +
    taskCardMarkup(7, {
      title: 'Stale Lucky Task',
      worth: 1,
      mode: 'none',
      luckyDate: STALE_DATE,
      luckyBonus: 2,
      specialKind: 'lucky', // STALE_DATE is a FUTURE date -- spoken for
    }) +
    // Tasks 8 and 9 exist for the re-check finding on issue #650's Finding A
    // fix: the first attempt gated the Lucky radio on `specialKind !== 'daily'`
    // -- a BLACKLIST naming one kind, so every OTHER kind fell through to
    // "check Lucky", reintroducing for flash the exact bounced-save failure
    // Finding A was raised to remove. These two cards are the kinds a
    // blacklist misses.
    taskCardMarkup(8, {
      title: 'Flashed Task With A Dead Lucky Pick',
      worth: 1,
      mode: 'none',
      luckyDate: DAY1, // PAST -- lucky no longer owns this row
      luckyBonus: 2,
      specialKind: 'flash', // a LIVE flash window owns it instead
    }) +
    taskCardMarkup(9, {
      title: 'Task Owned By A Future Special Type',
      worth: 1,
      mode: 'none',
      luckyDate: DAY2,
      luckyBonus: 2,
      // A kind this build does not know -- stands in for the fifth special
      // type. The radio must fail SAFE (fall back to data-mode), never
      // assume Lucky.
      specialKind: 'somefuturekind',
    }) +
    '</ul>' +
    editDialogMarkup() +
    createDialogMarkup()
  );
}

/**
 * Build a fresh jsdom document from pageMarkup(), install
 * window/document/navigator as globals, then require the real
 * admin-tasks.js fresh (it is a self-executing IIFE reading
 * document.getElementById at module load, same as a real <script defer>
 * load) so its listeners bind to THIS document.
 */
function loadAdminTasks() {
  const dom = new JSDOM('<!doctype html><html><body>' + pageMarkup() + '</body></html>', {
    url: 'http://localhost/admin/tasks',
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

  delete require.cache[require.resolve(ADMIN_TASKS_JS_PATH)];
  require(ADMIN_TASKS_JS_PATH);

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

function click(doc, el) {
  el.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true, cancelable: true }));
}

function change(doc, el) {
  el.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
}

function openEditFor(doc, taskId) {
  click(doc, doc.querySelector('[data-edit-task="' + taskId + '"]'));
}

function checkedValue(doc, selector) {
  const el = doc.querySelector(selector + ':checked');
  return el ? el.value : null;
}

describe('admin-tasks.js (issue #755 PR review fix — the client-side half now has a test that can fail)', () => {
  let doc;
  let restore;

  beforeEach(() => {
    const loaded = loadAdminTasks();
    doc = loaded.doc;
    restore = loaded.restore;
  });

  afterEach(() => {
    restore();
  });

  test('(a) opening a dated card checks the matching day and bonus chips', () => {
    openEditFor(doc, 1);
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_date"]')).toBe(DAY3);
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_bonus"]')).toBe('3');
  });

  test('(b) opening an ordinary card straight after a dated one leaves both groups unchecked (criterion 2 leak)', () => {
    openEditFor(doc, 1);
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_date"]')).toBe(DAY3);

    openEditFor(doc, 2);
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_date"]')).toBeNull();
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_bonus"]')).toBeNull();
  });

  test('(c) a stale-dated card leaves the hidden stale input enabled with the stored date; a matching-chip card leaves it disabled', () => {
    openEditFor(doc, 3);
    const staleInput = doc.getElementById('task-edit-special-date-stale');
    expect(staleInput.disabled).toBe(false);
    expect(staleInput.value).toBe(STALE_DATE);
    // No day chip matches the stale date — the chips stay unchecked.
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_date"]')).toBeNull();
    // The stored bonus still checks its matching chip even on a stale date.
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_bonus"]')).toBe('2');

    openEditFor(doc, 1);
    expect(staleInput.disabled).toBe(true);
    expect(staleInput.value).toBe('');
  });

  test('(d) clicking a day chip disables the hidden stale input again', () => {
    openEditFor(doc, 3);
    const staleInput = doc.getElementById('task-edit-special-date-stale');
    expect(staleInput.disabled).toBe(false);

    const dayChip = doc.querySelector(
      '#task-edit-dialog .day-chips input[name="special_date"][value="' + DAY1 + '"]'
    );
    dayChip.checked = true;
    change(doc, dayChip);

    expect(staleInput.disabled).toBe(true);
  });

  test('(e) picking One day only on an undated task in the edit popup applies the approved default (first configured day, +1)', () => {
    openEditFor(doc, 2); // ordinary task, no stored date
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_date"]')).toBeNull();

    const onedayRadio = doc.querySelector(
      '#task-edit-dialog input[name="special_mode"][value="oneday"]'
    );
    onedayRadio.checked = true;
    change(doc, onedayRadio);

    expect(checkedValue(doc, '#task-edit-dialog input[name="special_date"]')).toBe(DAY1);
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_bonus"]')).toBe('1');
  });

  test('(e-negative) picking One day only on a task openEdit() already dated leaves its own day/bonus alone', () => {
    openEditFor(doc, 1); // dated Aug 9 / +3
    const onedayRadio = doc.querySelector(
      '#task-edit-dialog input[name="special_mode"][value="oneday"]'
    );
    onedayRadio.checked = true;
    change(doc, onedayRadio);

    // Still Aug 9 / +3 — the default must NOT stomp an already-populated pair.
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_date"]')).toBe(DAY3);
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_bonus"]')).toBe('3');
  });

  test('(f) resetCreate() restores the same approved default (first configured day, +1) in the create flow', () => {
    click(doc, doc.querySelector('[data-open-create]'));

    expect(checkedValue(doc, '#task-create-dialog input[name="special_date"]')).toBe(DAY1);
    expect(checkedValue(doc, '#task-create-dialog input[name="special_bonus"]')).toBe('1');
  });

  // -------------------------------------------------------------------------
  // Issue #650 AC6 — the lucky pair's client-side round trip, mirroring
  // tests (a)-(f) above one-for-one for the Lucky radio/accordion instead of
  // One day only.
  // -------------------------------------------------------------------------

  test('(g) opening a lucky card checks the Lucky radio (derived from data-lucky-date, not data-mode) and the matching day/bonus chips', () => {
    openEditFor(doc, 4); // mode='none', lucky_date=DAY2/lucky_bonus=2
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_mode"]')).toBe('lucky');
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_date"]')).toBe(DAY2);
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_bonus"]')).toBe('2');
  });

  test('(h) a HIDDEN task with a lucky pick opens showing Lucky, not Hidden (documented, deliberate)', () => {
    openEditFor(doc, 5); // mode='hidden', lucky_date=DAY1/lucky_bonus=1
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_mode"]')).toBe('lucky');
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_date"]')).toBe(DAY1);
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_bonus"]')).toBe('1');
  });

  test('(i) a stored special_date wins the radio over a PAST lucky_date', () => {
    // Task 6: data-special-kind="daily" (special_date=DAY3 is future, so
    // daily IS spoken for) AND lucky_date=DAY1 (past) -- "One day only"
    // must win, never Lucky, or a title-only save would re-post
    // special_mode=lucky and the server's exclusivity guard would refuse it.
    openEditFor(doc, 6);
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_mode"]')).toBe('oneday');
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_date"]')).toBe(DAY3);
  });

  test('(i2) a LIVE FLASH window wins the radio over a stored lucky_date', () => {
    // Task 8: data-special-kind="flash" with lucky_date=DAY1 (past). The
    // Lucky radio must NOT be checked. This is the case the first fix's
    // `specialKind !== 'daily'` blacklist let through: the popup opened on
    // Lucky, a title-only save posted special_mode=lucky, and the server's
    // exclusivity guard refused it with "already a flash task" -- over a
    // control the host never touched, and with no flash control on the page
    // to "cancel first" with.
    openEditFor(doc, 8);
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_mode"]')).not.toBe('lucky');
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_mode"]')).toBe('none');
  });

  test('(i3) an UNRECOGNISED special kind fails safe rather than assuming Lucky', () => {
    // Task 9: a kind this build does not know. The test is a whitelist
    // ('' or 'lucky'), so a fifth special type added later cannot silently
    // inherit the Lucky radio and the bounced save that follows it. Fails
    // back to the card's own data-mode, which is always saveable.
    openEditFor(doc, 9);
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_mode"]')).not.toBe('lucky');
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_mode"]')).toBe('none');
  });

  test('(j) opening an ordinary card straight after a lucky one leaves the lucky groups unchecked (no leak)', () => {
    openEditFor(doc, 4);
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_date"]')).toBe(DAY2);

    openEditFor(doc, 2);
    // Task 2 is an ordinary task (mode='none', no lucky pick) — its OWN mode
    // radio ('none') is expected to check; what must NOT leak is the
    // PREVIOUS task's lucky day/bonus selection.
    expect(checkedValue(doc, '#task-edit-dialog input[name="special_mode"]')).toBe('none');
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_date"]')).toBeNull();
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_bonus"]')).toBeNull();
  });

  test('(k) a stale lucky day leaves the lucky hidden stale input enabled with the stored date; a matching-chip card leaves it disabled', () => {
    openEditFor(doc, 7); // lucky_date=STALE_DATE
    const staleLuckyInput = doc.getElementById('task-edit-lucky-date-stale');
    expect(staleLuckyInput.disabled).toBe(false);
    expect(staleLuckyInput.value).toBe(STALE_DATE);
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_date"]')).toBeNull();
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_bonus"]')).toBe('2');

    openEditFor(doc, 4); // a matching-chip lucky card
    expect(staleLuckyInput.disabled).toBe(true);
    expect(staleLuckyInput.value).toBe('');
  });

  test('(l) clicking a lucky day chip disables the lucky hidden stale input again', () => {
    openEditFor(doc, 7);
    const staleLuckyInput = doc.getElementById('task-edit-lucky-date-stale');
    expect(staleLuckyInput.disabled).toBe(false);

    const luckyDayChip = doc.querySelector(
      '#task-edit-dialog .day-chips input[name="lucky_date"][value="' + DAY1 + '"]'
    );
    luckyDayChip.checked = true;
    change(doc, luckyDayChip);

    expect(staleLuckyInput.disabled).toBe(true);
  });

  test('(m) picking Lucky on an undated task in the edit popup applies the approved default (first configured day, +2 — the midpoint)', () => {
    openEditFor(doc, 2); // ordinary task, no stored lucky pick
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_date"]')).toBeNull();

    const luckyRadio = doc.querySelector(
      '#task-edit-dialog input[name="special_mode"][value="lucky"]'
    );
    luckyRadio.checked = true;
    change(doc, luckyRadio);

    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_date"]')).toBe(DAY1);
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_bonus"]')).toBe('2');
  });

  test('(m-negative) picking Lucky on a task openEdit() already picked leaves its own day/bonus alone', () => {
    openEditFor(doc, 4); // lucky_date=DAY2/lucky_bonus=2
    const luckyRadio = doc.querySelector(
      '#task-edit-dialog input[name="special_mode"][value="lucky"]'
    );
    luckyRadio.checked = true;
    change(doc, luckyRadio);

    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_date"]')).toBe(DAY2);
    expect(checkedValue(doc, '#task-edit-dialog input[name="lucky_bonus"]')).toBe('2');
  });

  test('(n) resetCreate() also restores the lucky default (first configured day, +2) in the create flow', () => {
    click(doc, doc.querySelector('[data-open-create]'));

    expect(checkedValue(doc, '#task-create-dialog input[name="lucky_date"]')).toBe(DAY1);
    expect(checkedValue(doc, '#task-create-dialog input[name="lucky_bonus"]')).toBe('2');
  });
});
