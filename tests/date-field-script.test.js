// tests/date-field-script.test.js
// Issue #875 implementation plan, step 5: src/public/js/date-field.js has two
// independent jobs (the calendar-button opener, and the start/end range
// wiring) that only server-rendered markup tests never exercise. Mirrors the
// jsdom-driven pattern already established by tests/badge-moment-script.test.js
// and tests/badge-picker-script.test.js: build a fixture document matching
// what src/views/admin-config.ejs + src/views/partials/date-field.ejs really
// render, install window/document/navigator as globals, require the real
// script fresh, and drive it with dispatched events.
//
// Covers:
//   - on load, each calendar button is unhidden and .js-date is added to
//     THAT field's own .date-field wrapper (the CSS gate that collapses the
//     browser's own indicator) -- per field, not document-wide, and a field
//     whose .date-input lookup fails is left alone rather than losing its
//     native indicator with nothing put back.
//   - clicking a button calls showPicker() on ITS OWN field, and still
//     focuses the field when showPicker is absent or throws (so the button
//     is never inert on an engine without it — Safari on macOS).
//   - AC3's primary route: a change event producing an inverted pair
//     re-pins the end field's min and reveals the message; a change event
//     that resolves the pair hides it again.
//   - the submit handler: with `novalidate` on the form (src/views/
//     admin-config.ejs) the browser no longer vetoes an inverted submit, so
//     this handler is the last client-side stop — it calls preventDefault
//     and leaves the message visible for an inverted pair, and lets a valid
//     pair submit with the message hidden. It also restores the browser's
//     own badInput block (also switched off by novalidate) for a half-typed
//     date, checked before the range logic runs.
'use strict';

const { JSDOM } = require('jsdom');

const DATE_FIELD_JS_PATH = require.resolve('../src/public/js/date-field.js');

const CALENDAR_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="5" width="18" height="16" rx="2.5"></rect>' +
  '<path d="M3 10h18M8 3v4M16 3v4"></path></svg>';

// Mirrors src/views/admin-config.ejs's real <form data-date-range novalidate>
// wrapping two src/views/partials/date-field.ejs renders (start/end) plus
// the shared .date-range-error paragraph — the exact shape date-field.js's
// wireRange()/enhanceButtons() query against on the real page.
function pageMarkup(startValue, endValue, endMin) {
  function field(id, label, value, rangeRole, min) {
    return (
      '<div class="form-row">' +
      '<label class="form-label" for="' +
      id +
      '">' +
      label +
      '</label>' +
      '<div class="date-field">' +
      '<input class="form-input date-input" type="date" id="' +
      id +
      '" name="' +
      id +
      '" value="' +
      value +
      '"' +
      (min ? ' min="' + min + '"' : '') +
      ' data-range-' +
      rangeRole +
      '>' +
      '<button class="date-open" type="button" hidden aria-label="Open the calendar for ' +
      label +
      '">' +
      CALENDAR_SVG +
      '</button>' +
      '</div>' +
      '</div>'
    );
  }

  return (
    '<form action="/admin/config" method="POST" autocomplete="off" novalidate data-date-range>' +
    field('start_date', 'Wedding starts', startValue, 'start', null) +
    field('end_date', 'Wedding ends', endValue, 'end', endMin) +
    '<p class="form-error date-range-error" role="alert" data-range-error hidden></p>' +
    '<button class="btn--primary" type="submit">Save configuration</button>' +
    '</form>'
  );
}

/**
 * Build a fresh jsdom document from a body-markup string, install
 * window/document/navigator as globals, then require the real
 * date-field.js fresh so its listeners bind to THIS document.
 *
 * Unlike tests/badge-moment-script.test.js's script (which has no
 * readyState guard, since header.ejs loads it with `defer`), date-field.js
 * mirrors src/public/js/pin-field.js's pattern: `if (document.readyState
 * === 'loading') document.addEventListener('DOMContentLoaded', init); else
 * init();`. jsdom parses an inline HTML string SYNCHRONOUSLY but still
 * queues its 'DOMContentLoaded' dispatch as an asynchronous task —
 * `document.readyState` reads 'loading' at the moment this function
 * requires the script, so init() does not run until that later task fires.
 * This loader awaits that same event (registering its own listener AFTER
 * date-field.js's own, so init() has already run by the time this resolves)
 * rather than assuming synchronous execution.
 *
 * @param {string} bodyHtml - markup to install as <body>'s innerHTML
 * @returns {Promise<{dom: object, doc: Document, restore: Function}>}
 */
async function loadMarkup(bodyHtml) {
  const dom = new JSDOM('<!doctype html><html><body>' + bodyHtml + '</body></html>', {
    url: 'http://localhost/admin/config',
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

  const doc = dom.window.document;
  const ready =
    doc.readyState === 'loading'
      ? new Promise((resolve) => doc.addEventListener('DOMContentLoaded', resolve, { once: true }))
      : Promise.resolve();

  delete require.cache[DATE_FIELD_JS_PATH];
  require(DATE_FIELD_JS_PATH);

  await ready;

  function restore() {
    keys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
  }

  return { dom, doc, restore };
}

/**
 * loadMarkup() specialized to the real admin-config.ejs shape (via
 * pageMarkup()) -- the loader most of this file's tests want.
 *
 * @param {string} startValue - start field's initial value ('YYYY-MM-DD')
 * @param {string} endValue - end field's initial value ('YYYY-MM-DD')
 * @param {string} [endMin] - end field's server-rendered min; defaults to startValue
 * @returns {Promise<{dom: object, doc: Document, restore: Function}>}
 */
function loadDateField(startValue, endValue, endMin) {
  const min = endMin === undefined ? startValue : endMin;
  return loadMarkup(pageMarkup(startValue, endValue, min));
}

function click(doc, el) {
  el.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true, cancelable: true }));
}

function change(doc, el) {
  el.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
}

function submit(doc, form) {
  const event = new doc.defaultView.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

describe('date-field.js: calendar button (issue #875 AC1)', () => {
  it("unhides both calendar buttons on load and adds .js-date to each field's OWN wrapper", async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const buttons = doc.querySelectorAll('.date-field .date-open');
      expect(buttons.length).toBe(2);
      expect(buttons[0].hidden).toBe(false);
      expect(buttons[1].hidden).toBe(false);

      const fields = doc.querySelectorAll('.date-field');
      expect(fields.length).toBe(2);
      fields.forEach((field) => {
        expect(field.classList.contains('js-date')).toBe(true);
      });
      // Not a document-wide flag (review MINOR 3) -- the CSS gate the class
      // controls is per-field, so the promise the class makes must be too.
      expect(doc.documentElement.classList.contains('js-date')).toBe(false);
    } finally {
      restore();
    }
  });

  it('scopes .js-date to each field independently: a field whose .date-input lookup fails is left alone, a normal sibling field still gets enhanced', async () => {
    const brokenField =
      '<div class="date-field">' +
      '<button class="date-open" type="button" hidden aria-label="Broken (no sibling input)">' +
      CALENDAR_SVG +
      '</button>' +
      '</div>';
    const { doc, restore } = await loadMarkup(brokenField + pageMarkup('2026-08-07', '2026-08-09'));
    try {
      const fields = doc.querySelectorAll('.date-field');
      expect(fields.length).toBe(3);

      // The broken field: enhanceButtons()'s `.date-input` lookup finds
      // nothing, so it must be left exactly as rendered -- button still
      // hidden, wrapper without .js-date, native indicator (if any) intact.
      expect(fields[0].querySelector('.date-open').hidden).toBe(true);
      expect(fields[0].classList.contains('js-date')).toBe(false);

      // Both real fields are unaffected by the broken one.
      expect(fields[1].querySelector('.date-open').hidden).toBe(false);
      expect(fields[1].classList.contains('js-date')).toBe(true);
      expect(fields[2].querySelector('.date-open').hidden).toBe(false);
      expect(fields[2].classList.contains('js-date')).toBe(true);
    } finally {
      restore();
    }
  });

  it('clicking the button calls showPicker on its OWN field and focuses it', async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const startInput = doc.getElementById('start_date');
      const endInput = doc.getElementById('end_date');
      const startButton = startInput.parentNode.querySelector('.date-open');

      let calledOn = null;
      startInput.showPicker = function () {
        calledOn = this;
      };
      endInput.showPicker = function () {
        throw new Error('should never be called — this is the OTHER field');
      };

      click(doc, startButton);

      expect(calledOn).toBe(startInput);
      expect(doc.activeElement).toBe(startInput);
    } finally {
      restore();
    }
  });

  it('still focuses the field when showPicker is absent (no function on the element)', async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const startInput = doc.getElementById('start_date');
      const startButton = startInput.parentNode.querySelector('.date-open');
      delete startInput.showPicker; // engine with no showPicker support at all

      expect(() => click(doc, startButton)).not.toThrow();
      expect(doc.activeElement).toBe(startInput);
    } finally {
      restore();
    }
  });

  it('still focuses the field when showPicker throws (engine judges the call not user-initiated)', async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const startInput = doc.getElementById('start_date');
      const startButton = startInput.parentNode.querySelector('.date-open');
      startInput.showPicker = function () {
        throw new Error('not allowed');
      };

      expect(() => click(doc, startButton)).not.toThrow();
      expect(doc.activeElement).toBe(startInput);
    } finally {
      restore();
    }
  });
});

describe('date-field.js: range wiring (issue #875 AC3 primary route)', () => {
  it('a valid pair on load leaves the message hidden', async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const error = doc.querySelector('[data-range-error]');
      expect(error.hidden).toBe(true);
      expect(error.textContent).toBe('');
    } finally {
      restore();
    }
  });

  it('an already-inverted STORED pair reveals the message immediately on load, before any event', async () => {
    const { doc, restore } = await loadDateField('2026-08-09', '2026-08-07');
    try {
      const error = doc.querySelector('[data-range-error]');
      expect(error.hidden).toBe(false);
      expect(error.textContent).toBe('The wedding has to end on or after it starts.');
    } finally {
      restore();
    }
  });

  it("changing the start date past the end date re-pins the end field's min and reveals the message", async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const start = doc.getElementById('start_date');
      const end = doc.getElementById('end_date');
      const error = doc.querySelector('[data-range-error]');

      start.value = '2026-08-10';
      change(doc, start);

      expect(end.min).toBe('2026-08-10');
      expect(error.hidden).toBe(false);
      expect(error.textContent).toBe('The wedding has to end on or after it starts.');
    } finally {
      restore();
    }
  });

  it('unhides the message before writing its text on the inverted branch, so a live-region mutation actually occurs (review NIT 13)', async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const start = doc.getElementById('start_date');
      const error = doc.querySelector('[data-range-error]');

      // MutationObserver records mutations in the order they happened;
      // takeRecords() drains the queue synchronously regardless of the
      // microtask delivery timing, so this doesn't need to await anything.
      // `hidden` reflects to the attribute (an 'attributes' record);
      // `textContent` replaces the text node (a 'childList' record) --
      // if unhide-then-text is reversed, this records ['childList',
      // 'attributes'] instead.
      const observer = new doc.defaultView.MutationObserver(function () {});
      observer.observe(error, { attributes: true, attributeFilter: ['hidden'], childList: true });

      start.value = '2026-08-10';
      change(doc, start);

      const order = observer.takeRecords().map((r) => r.type);
      expect(order).toEqual(['attributes', 'childList']);
    } finally {
      restore();
    }
  });

  it('changing the end date back to on-or-after the (moved) start date hides the message again', async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const start = doc.getElementById('start_date');
      const end = doc.getElementById('end_date');
      const error = doc.querySelector('[data-range-error]');

      start.value = '2026-08-10';
      change(doc, start);
      expect(error.hidden).toBe(false);

      end.value = '2026-08-11';
      change(doc, end);

      expect(error.hidden).toBe(true);
      expect(error.textContent).toBe('');
    } finally {
      restore();
    }
  });
});

describe('date-field.js: submit handler (issue #875 — the last client-side stop under novalidate)', () => {
  it('a valid pair submits normally: preventDefault is not called and the message stays hidden', async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const form = doc.querySelector('[data-date-range]');
      const error = doc.querySelector('[data-range-error]');

      const event = submit(doc, form);

      expect(event.defaultPrevented).toBe(false);
      expect(error.hidden).toBe(true);
    } finally {
      restore();
    }
  });

  it('an inverted pair blocks submit: preventDefault is called, the end field is focused, and the message stays visible', async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const start = doc.getElementById('start_date');
      const end = doc.getElementById('end_date');
      const error = doc.querySelector('[data-range-error]');
      const form = doc.querySelector('[data-date-range]');

      start.value = '2026-08-10';
      change(doc, start); // matches a real host: the field change fires before Save is pressed

      const event = submit(doc, form);

      expect(event.defaultPrevented).toBe(true);
      expect(doc.activeElement).toBe(end);
      expect(error.hidden).toBe(false);
      expect(error.textContent).toBe('The wedding has to end on or after it starts.');
    } finally {
      restore();
    }
  });

  it('a badInput start field blocks submit before the range check runs: preventDefault is called, the field is focused, and reportValidity is called on it (review MAJOR 2)', async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const start = doc.getElementById('start_date');
      const form = doc.querySelector('[data-date-range]');
      const error = doc.querySelector('[data-range-error]');

      // jsdom implements neither validity.badInput nor reportValidity --
      // stand in for an engine (e.g. Chrome) that does, the way a host
      // typing "08/07/" with the year left blank would leave the field.
      Object.defineProperty(start, 'validity', {
        value: { badInput: true },
        configurable: true,
      });
      let reportedOn = null;
      start.reportValidity = function () {
        reportedOn = this;
      };

      const event = submit(doc, form);

      expect(event.defaultPrevented).toBe(true);
      expect(doc.activeElement).toBe(start);
      expect(reportedOn).toBe(start);
      // The range check must never have run -- the message stays exactly as
      // it was before submit (hidden, from the valid on-load pair), proving
      // badInput is checked BEFORE check(), not folded into it.
      expect(error.hidden).toBe(true);
    } finally {
      restore();
    }
  });

  it('a badInput end field blocks submit and focuses the end field, without requiring reportValidity to exist on the element (older engine)', async () => {
    const { doc, restore } = await loadDateField('2026-08-07', '2026-08-09');
    try {
      const end = doc.getElementById('end_date');
      const form = doc.querySelector('[data-date-range]');

      Object.defineProperty(end, 'validity', {
        value: { badInput: true },
        configurable: true,
      });
      // No reportValidity function on this element at all -- the guard must
      // not throw trying to call it.

      let event;
      expect(() => {
        event = submit(doc, form);
      }).not.toThrow();

      expect(event.defaultPrevented).toBe(true);
      expect(doc.activeElement).toBe(end);
    } finally {
      restore();
    }
  });
});
