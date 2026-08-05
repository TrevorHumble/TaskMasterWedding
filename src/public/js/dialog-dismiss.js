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
//
// Issue #1041 adds a second, DELEGATED variant of the same press-target rule
// for the guest surface (src/public/js/feed.js's comments dialog,
// src/public/js/photo-owner-menu.js's caption dialog).
//
// Full rationale (why delegation, not per-element registration, is
// load-bearing here; the fail-safe shape; the load-order resolution) lives
// in DESIGN.md, "One shared backdrop-dismiss owner" ADR, #1041 paragraphs.
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

  // ------------------------------------------------------------------
  // Delegated variant (issue #1041): same press-target rule, document-level
  // rather than per dialog element, for a page that opens dialogs the
  // module could not have registered against individually at load time.
  // ------------------------------------------------------------------

  // Raw target of the most recent primary-pointer press, tracked at the
  // document level. There is exactly one press between a dialog's own click
  // and the click that follows it, so this reflects the press that led to
  // the CURRENT click by construction — no per-dialog reset is needed the
  // way backdrop()'s per-dialog boolean needs one, because a raw target
  // reference (not a "was it on THIS dialog" boolean) is meaningless until
  // compared against a specific click's own target below.
  var delegatedPressTarget = null;

  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', function (event) {
      // Same non-primary-pointer guard backdrop() documents above: a second
      // simultaneous touch must not overwrite the press that the primary
      // touch's later click will be checked against.
      if (event.isPrimary === false) return;
      delegatedPressTarget = event.target;
    });
  }

  /**
   * True only when the most recently recorded primary-pointer press target
   * is the same element as `clickEvent`'s own target — the delegated
   * equivalent of `backdrop()`'s `pressWasOnDialog && event.target ===
   * dialogEl` check. A caller's own click handler has already established
   * that `clickEvent.target` is the dialog element it cares about (e.g. via
   * a `classList.contains('comments-dialog')` check); this predicate only
   * answers whether the PRESS agreed with that same target, so a
   * press-inside/release-outside drag (retargeted click, but a different
   * press target) returns false.
   *
   * @param {Event|null|undefined} clickEvent
   * @returns {boolean}
   */
  function pressAllowsDelegatedClose(clickEvent) {
    return !!clickEvent && !!delegatedPressTarget && delegatedPressTarget === clickEvent.target;
  }

  global.DialogDismiss = {
    backdrop: backdrop,
    pressAllowsDelegatedClose: pressAllowsDelegatedClose,
  };
})(typeof window !== 'undefined' ? window : this);
