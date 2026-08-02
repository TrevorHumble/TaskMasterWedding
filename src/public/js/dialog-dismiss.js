// src/public/js/dialog-dismiss.js
//
// Issue #879: the SINGLE owner of "does this click really mean close the
// dialog" for a modal <dialog>'s backdrop. Before this file existed,
// src/public/js/admin-tasks.js, src/public/js/badge-picker.js, and
// src/public/js/slideshow-launch.js each hand-wrote the same one-line check
// — `if (event.target === dialogEl) dialogEl.close()` — reasoning that a
// click's target is the dialog ELEMENT itself only when it lands on the
// dialog's own ::backdrop, outside every child. That reasoning has a hole: a
// click's target is decided by where the PRESS and RELEASE agree, and when
// they land on different elements the browser dispatches the click on their
// nearest common ancestor. For a modal <dialog>, the backdrop is owned by
// the dialog element, so a press inside the dialog (e.g. starting a
// text-drag-select in a field) released past the dialog's edge is
// retargeted to the dialog itself — indistinguishable, to the old handlers,
// from a genuine backdrop press-and-release. The dialog closed and
// discarded whatever the host had half-typed.
//
// The fix: track where the PRESS landed too, and only close when both the
// press and the click agree the dialog element itself was hit.
//
// Plain ES5-style browser script, no bundler — same convention as every
// other file under src/public/js/, loaded via a bare <script defer> tag
// before its consumers (src/views/admin-tasks.ejs, src/views/admin-dashboard.ejs).
(function (global) {
  'use strict';

  /**
   * Register backdrop-dismiss behavior on `dialogEl`: a genuine
   * press-and-release on the dialog's own ::backdrop closes it; a press that
   * started on a descendant (e.g. a drag-select inside a text field) and
   * released past the dialog's edge does not, even though the browser
   * retargets that click's `target` to the dialog element the same way.
   *
   * No-ops on a null/missing dialog, so a caller can pass through an
   * optional dialog it may not have found on the page without its own guard.
   *
   * @param {Element|null|undefined} dialogEl
   */
  function backdrop(dialogEl) {
    if (!dialogEl) return;

    var pressWasOnDialog = false;

    dialogEl.addEventListener('pointerdown', function (event) {
      // Ignore a non-primary pointer (a second simultaneous touch) — this
      // flag is a single shared boolean, not keyed by pointerId, so letting
      // a second finger's pointerdown overwrite it could record a press that
      // never happened on the SAME touch that later triggers the retargeted
      // click. `isPrimary` is undefined on a plain Event, which is what
      // jsdom dispatches for 'pointerdown' (it implements no PointerEvent
      // constructor) — treat undefined as primary so the real-browser
      // behavior below is unaffected in a test environment.
      if (event.isPrimary === false) return;
      pressWasOnDialog = event.target === dialogEl;
    });

    dialogEl.addEventListener('click', function (event) {
      if (pressWasOnDialog && event.target === dialogEl) {
        if (dialogEl.open && typeof dialogEl.close === 'function') dialogEl.close();
      }
    });

    // A closed dialog (by Escape, a Cancel button, or this handler itself)
    // must not leave a stale `true` sitting around for the next open — that
    // would let a NEXT press that starts on some other element's click,
    // retargeted to the dialog for unrelated reasons, read as "the press was
    // on the dialog" when it never happened this cycle.
    dialogEl.addEventListener('close', function () {
      pressWasOnDialog = false;
    });
  }

  global.DialogDismiss = {
    backdrop: backdrop,
  };
})(typeof window !== 'undefined' ? window : this);
