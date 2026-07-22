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
function taskCardMarkup(taskId, { title, worth, mode, specialDate, specialBonus }) {
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
    '" data-badge-name="" data-badge-art="" data-badge-default="1">' +
    '<button type="button" data-edit-task="' +
    taskId +
    '"></button>' +
    '</li>'
  );
}

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
    }) +
    taskCardMarkup(2, { title: 'Ordinary Task', worth: 1, mode: 'none' }) +
    taskCardMarkup(3, {
      title: 'Stale Dated Task',
      worth: 1,
      mode: 'oneday',
      specialDate: STALE_DATE,
      specialBonus: 2,
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
});
