// src/public/js/pin-field.js
// Progressive enhancement for the "Your PIN" field on /me/edit (issue #243).
// The server always renders #pin as plain visible text — the no-JS baseline
// (AC1) requires a locked-out guest can always read and edit their own PIN
// with scripts off. This script only ADDS the green-dot mask and the
// eye-toggle on top of that baseline; if either element is missing
// (guest.pin was falsy, so the view rendered no row at all) it no-ops.
'use strict';

// The closed-eye SVG is owned by the EJS resting state (see the button's
// markup in src/views/me-edit.ejs) — init() below captures it from the DOM
// rather than re-declaring it here, so there is exactly one copy of that
// markup in the codebase. Only the open-eye SVG, which the EJS never
// renders, needs a JS-side constant.
var EYE_OPEN_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>' +
  '<circle cx="12" cy="12" r="3"></circle></svg>';

// Feature-detect the CSS masking property rather than sniffing UA strings —
// any engine that implements it (WebKit- and Blink-based browsers) gets the
// green-dot treatment; everything else falls back to a real
// type="password" swap (dots render, just not green).
function supportsTextSecurity() {
  return typeof document !== 'undefined' && 'webkitTextSecurity' in document.body.style;
}

function maskInput(input, useTextSecurity) {
  if (useTextSecurity) {
    input.style.webkitTextSecurity = 'disc';
    input.style.textSecurity = 'disc';
    input.style.color = 'var(--color-primary)';
  } else {
    input.type = 'password';
  }
}

function revealInput(input, useTextSecurity) {
  if (useTextSecurity) {
    input.style.webkitTextSecurity = 'none';
    input.style.textSecurity = 'none';
    input.style.color = '';
  } else {
    input.type = 'text';
  }
}

function init() {
  var input = document.getElementById('pin');
  var button = document.querySelector('.pin-reveal');
  if (!input || !button) return; // no pin row rendered (guest has no pin yet)

  var useTextSecurity = supportsTextSecurity();
  var revealed = false;

  // Capture the server-rendered closed-eye markup before it is ever
  // overwritten, so toggling back to "hidden" restores the exact same
  // markup the EJS shipped rather than a second hardcoded copy of it.
  var closedEyeSvg = button.innerHTML;

  // Default state on load: masked. The server rendered the input as plain
  // text (no-JS baseline); this is the point where JS takes over.
  maskInput(input, useTextSecurity);

  button.addEventListener('click', function () {
    revealed = !revealed;
    if (revealed) {
      revealInput(input, useTextSecurity);
      button.innerHTML = EYE_OPEN_SVG;
      button.setAttribute('aria-pressed', 'true');
      button.setAttribute('aria-label', 'Hide my PIN');
    } else {
      maskInput(input, useTextSecurity);
      button.innerHTML = closedEyeSvg;
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', 'Show my PIN');
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
