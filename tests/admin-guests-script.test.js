// tests/admin-guests-script.test.js
// Issue #1093 criterion 6: the guest-edit popup's photos link and Delete
// proxy, driven against the REAL src/public/js/admin-guests.js (not a
// re-typed description of what it should do), the same jsdom-fixture pattern
// tests/admin-tasks-script.test.js already established for admin-tasks.js.
//
// The fixture markup below mirrors what src/views/admin-guests.ejs and
// src/views/partials/guest-edit-dialog.ejs actually render: a .guest-card
// carrying data-guest-id/data-name/data-contact/data-pin/data-couple/
// data-blocked/data-stats, its opener carrying data-edit-guest/
// data-photos-url, and the row's own hidden .guest-delete-form.
'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const ADMIN_GUESTS_JS_PATH = path.join(__dirname, '..', 'src', 'public', 'js', 'admin-guests.js');

function guestCardMarkup(id, { name, contact, pin, couple, blocked, stats, photosUrl }) {
  return (
    '<li class="guest-card" data-guest-id="' +
    id +
    '" data-name="' +
    name +
    '" data-contact="' +
    (contact || '') +
    '" data-pin="' +
    (pin || '') +
    '" data-couple="' +
    (couple ? '1' : '0') +
    '" data-blocked="' +
    (blocked ? '1' : '0') +
    '" data-stats="' +
    stats +
    '">' +
    '<button type="button" class="guest-open" data-edit-guest="' +
    id +
    '" data-photos-url="' +
    photosUrl +
    '"></button>' +
    '<form class="guest-delete-form" data-guest-id="' +
    id +
    '"></form>' +
    '</li>'
  );
}

function dialogMarkup() {
  return (
    '<dialog id="guest-edit-dialog">' +
    '<form id="guest-edit-form">' +
    '<h2 id="guest-edit-title"></h2>' +
    '<p id="guest-edit-stats"></p>' +
    '<a id="guest-edit-photos-link" href="/admin/photos?view=user"></a>' +
    '<input id="guest-edit-name-input" name="name" />' +
    '<input id="guest-edit-contact-input" name="contact" />' +
    '<input id="guest-edit-pin-input" name="pin" />' +
    '<input type="checkbox" id="guest-edit-couple-input" name="is_couple" value="1" />' +
    '<input type="checkbox" id="guest-edit-blocked-input" name="blocked" value="1" />' +
    '<button type="button" data-dialog-close></button>' +
    '<button type="button" data-delete-guest></button>' +
    '<button type="submit"></button>' +
    '</form>' +
    '</dialog>'
  );
}

function pageMarkup() {
  return (
    '<ul id="guest-list">' +
    guestCardMarkup(9, {
      name: 'Ada Lovelace',
      contact: 'ada@example.com',
      pin: '1234',
      couple: false,
      blocked: false,
      stats: '10 pts &middot; 2 of 5 tasks',
      photosUrl: '/admin/photos?view=user&q=Ada%20Lovelace',
    }) +
    guestCardMarkup(10, {
      name: 'Other Guest',
      contact: '',
      pin: '',
      couple: true,
      blocked: true,
      stats: '0 pts &middot; 0 of 5 tasks',
      photosUrl: '/admin/photos?view=user&q=Other%20Guest',
    }) +
    '</ul>' +
    dialogMarkup()
  );
}

function loadAdminGuests() {
  const dom = new JSDOM('<!doctype html><html><body>' + pageMarkup() + '</body></html>', {
    url: 'http://localhost/admin/guests',
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

  // jsdom implements neither showModal nor close on <dialog> (same gap
  // tests/admin-tasks-script.test.js's own fixture works around).
  const dialogEl = dom.window.document.getElementById('guest-edit-dialog');
  dialogEl.showModal = function () {
    this.open = true;
  };
  dialogEl.close = function () {
    this.open = false;
  };

  delete require.cache[require.resolve(ADMIN_GUESTS_JS_PATH)];
  require(ADMIN_GUESTS_JS_PATH);

  function restore() {
    keys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
  }

  return { doc: dom.window.document, restore };
}

function click(doc, el) {
  el.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true, cancelable: true }));
}

describe('admin-guests.js (issue #1093 criterion 6)', () => {
  let doc;
  let restore;

  beforeEach(() => {
    const loaded = loadAdminGuests();
    doc = loaded.doc;
    restore = loaded.restore;
  });

  afterEach(() => {
    restore();
  });

  it("opening Ada Lovelace's row points the photos link at ?view=user&q=Ada%20Lovelace", () => {
    click(doc, doc.querySelector('[data-edit-guest="9"]'));

    expect(doc.getElementById('guest-edit-photos-link').getAttribute('href')).toBe(
      '/admin/photos?view=user&q=Ada%20Lovelace'
    );
    expect(doc.getElementById('guest-edit-name-input').value).toBe('Ada Lovelace');
    expect(doc.getElementById('guest-edit-contact-input').value).toBe('ada@example.com');
    expect(doc.getElementById('guest-edit-pin-input').value).toBe('1234');
    expect(doc.getElementById('guest-edit-couple-input').checked).toBe(false);
    expect(doc.getElementById('guest-edit-blocked-input').checked).toBe(false);
  });

  // The stats line used to be assigned with innerHTML, purely because the
  // view writes the separator as the &middot; entity. That made a DOM
  // attribute an HTML sink for no gain: the parser decodes the entity when it
  // builds the attribute, so the value arriving here is already a literal
  // middot and renders identically as text. These assert the rendered text is
  // unchanged AND that no markup can come through the same door.
  it('fills the stats line as text, entity already decoded, with the middot intact', () => {
    click(doc, doc.querySelector('[data-edit-guest="9"]'));

    const stats = doc.getElementById('guest-edit-stats');
    expect(stats.textContent).toBe('10 pts · 2 of 5 tasks');
    expect(stats.innerHTML).toBe('10 pts · 2 of 5 tasks');
    expect(stats.querySelector('*')).toBeNull();
  });

  it('does not point the form or the photos link anywhere off-shape', () => {
    const row = doc.querySelector('.guest-card[data-guest-id="9"]');
    const opener = row.querySelector('[data-edit-guest]');
    const form = doc.getElementById('guest-edit-form');
    const actionBefore = form.getAttribute('action');

    row.setAttribute('data-guest-id', 'javascript:alert(1)');
    opener.setAttribute('data-photos-url', 'javascript:alert(1)');
    doc.getElementById('guest-edit-photos-link').setAttribute('href', '/admin/photos?view=user');

    click(doc, opener);

    expect(form.getAttribute('action')).toBe(actionBefore);
    expect(doc.getElementById('guest-edit-photos-link').getAttribute('href')).toBe(
      '/admin/photos?view=user'
    );
  });

  it('switching to a second row leaves no data from the first row behind (no leak)', () => {
    click(doc, doc.querySelector('[data-edit-guest="9"]'));
    click(doc, doc.querySelector('[data-edit-guest="10"]'));

    expect(doc.getElementById('guest-edit-photos-link').getAttribute('href')).toBe(
      '/admin/photos?view=user&q=Other%20Guest'
    );
    expect(doc.getElementById('guest-edit-contact-input').value).toBe('');
    expect(doc.getElementById('guest-edit-pin-input').value).toBe('');
    expect(doc.getElementById('guest-edit-couple-input').checked).toBe(true);
    expect(doc.getElementById('guest-edit-blocked-input').checked).toBe(true);
  });

  it("Delete fires THAT guest's own hidden delete form, not any other row's", () => {
    click(doc, doc.querySelector('[data-edit-guest="9"]'));

    const form9 = doc.querySelector('.guest-delete-form[data-guest-id="9"]');
    const form10 = doc.querySelector('.guest-delete-form[data-guest-id="10"]');
    let submitted9 = false;
    let submitted10 = false;
    form9.requestSubmit = function () {
      submitted9 = true;
    };
    form10.requestSubmit = function () {
      submitted10 = true;
    };

    click(doc, doc.querySelector('[data-delete-guest]'));

    expect(submitted9).toBe(true);
    expect(submitted10).toBe(false);
  });
});
