// src/public/js/admin-tasks.js
//
// Issue #682 (PHASE-2 wiring): drives the redesigned Tasks admin page — the
// tap-to-edit popup, the step-through create wizard, worth/special controls,
// drag-to-reorder, and badge-picker reflection. The edit/create dialogs are
// now REAL form posts (task-edit-form/task-create-form, method="post" in
// their partials) — this file's job is filling in the per-task `action` URL
// and the hidden badge_icon/badge_name fields the routes read, plus
// persisting a drag-reorder via one small fetch (see "Drag to reorder"
// below). The dialog open/close idiom follows src/public/js/photo-owner-menu.js.
(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  var editDialog = document.getElementById('task-edit-dialog');
  var createDialog = document.getElementById('task-create-dialog');
  var picker = document.getElementById('badge-picker');
  var editForm = editDialog && editDialog.querySelector('#task-edit-form');

  // Which of our dialogs opened the shared badge picker, so its submit
  // reflects the pick into that dialog's preview (and hidden badge_icon/
  // badge_name fields) instead of running the picker's own POST.
  var pickerMode = null;
  var createStep = 1; // which step of the create wizard is showing (1..3)

  function openDialog(d) {
    if (d && !d.open && typeof d.showModal === 'function') d.showModal();
  }
  function closeDialog(d) {
    if (d && d.open && typeof d.close === 'function') d.close();
  }

  // ---- Edit popup: fill from the tapped card's data-* attributes ----
  function openEdit(card) {
    if (!editDialog) return;
    var g = function (k) {
      return card.getAttribute('data-' + k) || '';
    };
    var taskId = g('task-id');

    if (editForm) editForm.setAttribute('action', '/admin/tasks/' + taskId + '/edit');

    editDialog.querySelector('#task-edit-title-input').value = g('title');
    editDialog.querySelector('#task-edit-desc-input').value = g('description');

    var worth = g('worth') || '1';
    var worthRadio = editDialog.querySelector('.worth-chip input[value="' + worth + '"]');
    if (worthRadio) worthRadio.checked = true;

    var mode = g('mode') || 'none';
    var modeRadio = editDialog.querySelector('.special-option input[value="' + mode + '"]');
    if (modeRadio) modeRadio.checked = true;

    reflectBadge(
      editDialog.querySelector('#task-edit-badge-preview'),
      editDialog.querySelector('#task-edit-badge-icon'),
      editDialog.querySelector('#task-edit-badge-name'),
      g('badge-art'),
      g('badge-name')
    );
    // Hidden badge_icon/badge_name reset to blank on every open — they only
    // gain a value if the host actually picks a NEW badge below (a save with
    // both blank means "leave the task's current badge alone", the server's
    // own contract), so a stale pick from a PREVIOUSLY edited task can never
    // leak onto this one.
    setHiddenBadgeFields(editDialog, '', '');

    var badgeBtn = editDialog.querySelector('#task-edit-badge-btn');
    if (badgeBtn) {
      badgeBtn.setAttribute('data-task-id', taskId);
      badgeBtn.setAttribute('data-task-title', g('title'));
      badgeBtn.setAttribute('data-badge-name', g('badge-name'));
    }
    var del = editDialog.querySelector('[data-delete-task]');
    if (del) del.setAttribute('data-task-id', taskId);

    openDialog(editDialog);
  }

  // Set the hidden badge_icon/badge_name inputs a dialog's form posts —
  // shared by the reset-on-open above and the picker-reflection handler
  // below, so the two never disagree about which ids those hidden fields use.
  function setHiddenBadgeFields(dialog, iconId, name) {
    if (!dialog) return;
    var iconInput = dialog.querySelector('input[name="badge_icon"]');
    var nameInput = dialog.querySelector('input[name="badge_name"]');
    if (iconInput) iconInput.value = iconId || '';
    if (nameInput) nameInput.value = name || '';
  }

  function reflectBadge(previewEl, iconEl, nameEl, artPath, name) {
    if (!previewEl || !iconEl || !nameEl) return;
    if (artPath) {
      iconEl.src = artPath;
      iconEl.hidden = false;
      previewEl.classList.remove('badge-medallion-empty');
      nameEl.textContent = name || 'Badge';
      nameEl.classList.remove('muted');
    } else {
      iconEl.hidden = true;
      iconEl.removeAttribute('src');
      previewEl.classList.add('badge-medallion-empty');
      nameEl.textContent = 'No badge chosen yet';
      nameEl.classList.add('muted');
    }
  }

  // ---- Create wizard: three steps (Details / Special / Badge) ----
  function resetCreate() {
    if (!createDialog) return;
    showStep(1);
    var t = createDialog.querySelector('#task-create-title-input');
    var d = createDialog.querySelector('#task-create-desc-input');
    if (t) t.value = '';
    if (d) d.value = '';
    var w1 = createDialog.querySelector('.worth-chip input[value="1"]');
    if (w1) w1.checked = true;
    var none = createDialog.querySelector('.special-option input[value="none"]');
    if (none) none.checked = true;
    reflectBadge(
      createDialog.querySelector('#task-create-badge-preview'),
      createDialog.querySelector('#task-create-badge-icon'),
      createDialog.querySelector('#task-create-badge-name'),
      '',
      ''
    );
    setHiddenBadgeFields(createDialog, '', '');
    var submit = createDialog.querySelector('#task-create-submit');
    if (submit) submit.disabled = true;
  }

  function showStep(n) {
    if (!createDialog) return;
    createStep = n;
    createDialog.querySelectorAll('.wizard-step').forEach(function (s) {
      s.hidden = Number(s.getAttribute('data-step')) !== n;
    });
    createDialog.querySelectorAll('.wizard-dot').forEach(function (dot) {
      dot.classList.toggle('is-current', Number(dot.getAttribute('data-dot')) === n);
    });
  }

  // ---- Delegated clicks ----
  document.addEventListener('click', function (event) {
    var t = event.target;

    var opener = t.closest('[data-edit-task]');
    if (opener) {
      openEdit(opener.closest('.admin-task-card'));
      return;
    }

    if (t.closest('[data-open-create]')) {
      resetCreate();
      openDialog(createDialog);
      return;
    }

    var closer = t.closest('[data-dialog-close]');
    if (closer) {
      closeDialog(closer.closest('dialog'));
      return;
    }

    if (t.closest('[data-wizard-next]')) {
      if (createStep === 1) {
        var title = createDialog.querySelector('#task-create-title-input');
        if (title && !title.value.trim()) {
          title.focus();
          return;
        }
      }
      showStep(Math.min(createStep + 1, 3));
      return;
    }
    if (t.closest('[data-wizard-back]')) {
      showStep(Math.max(createStep - 1, 1));
      return;
    }

    // Delete (issue #59/#682): the popup carries no form of its own for
    // this — it triggers the TAPPED task's own real, hidden delete form
    // (admin-tasks.ejs's `.admin-task-delete-form`, one per card, real
    // action + data-confirm baked in server-side) via requestSubmit(), which
    // fires a genuine 'submit' event admin.js's delegated data-confirm
    // listener can intercept (form.submit() would bypass it entirely). If
    // the host cancels that confirm(), the event is prevented and nothing
    // navigates — the popup is simply left open, no separate handling needed.
    var del = t.closest('[data-delete-task]');
    if (del) {
      var delTaskId = del.getAttribute('data-task-id');
      var targetForm = delTaskId
        ? document.querySelector('.admin-task-delete-form[data-task-id="' + delTaskId + '"]')
        : null;
      if (targetForm) {
        if (typeof targetForm.requestSubmit === 'function') {
          targetForm.requestSubmit();
        } else {
          // Very old browser fallback with no confirm — requestSubmit is
          // the only submission path that fires a real 'submit' event.
          targetForm.submit();
        }
      }
      return;
    }

    // Track which dialog opened the badge picker (for reflect-on-submit).
    if (t.closest('#task-create-badge-btn')) {
      pickerMode = 'create';
      return;
    }
    if (t.closest('#task-edit-badge-btn')) {
      pickerMode = 'edit';
      return;
    }
  });

  // Backdrop click closes our dialogs (native <dialog> reports itself as the
  // target only when the click lands on the ::backdrop).
  [editDialog, createDialog].forEach(function (d) {
    if (!d) return;
    d.addEventListener('click', function (event) {
      if (event.target === d) closeDialog(d);
    });
  });

  // ---- Badge picker reflection: reflect the pick into whichever dialog
  // opened it, AND stash the icon id + name into that dialog's hidden
  // badge_icon/badge_name inputs so its real form POST carries the pick
  // (the picker's OWN form still posts straight to POST /admin/tasks/:id/badge
  // for any other opener — pickerMode is null in that case and this handler
  // steps aside via the early return below). ----
  if (picker) {
    var pForm = document.getElementById('badge-picker-form');
    pForm.addEventListener('submit', function (event) {
      if (pickerMode !== 'create' && pickerMode !== 'edit') return; // let #410's real POST run
      event.preventDefault();
      var checked = pForm.querySelector('.badge-picker-radio:checked');
      var nameInput = document.getElementById('badge-picker-name');
      var iconId = checked ? checked.value : '';
      var artPath = checked ? checked.getAttribute('data-art-path') : '';
      var name =
        (nameInput && nameInput.value) || (checked && checked.getAttribute('data-name')) || '';
      if (pickerMode === 'create') {
        reflectBadge(
          createDialog.querySelector('#task-create-badge-preview'),
          createDialog.querySelector('#task-create-badge-icon'),
          createDialog.querySelector('#task-create-badge-name'),
          artPath,
          name
        );
        setHiddenBadgeFields(createDialog, iconId, name);
        var submit = createDialog.querySelector('#task-create-submit');
        if (submit) submit.disabled = !artPath;
      } else {
        reflectBadge(
          editDialog.querySelector('#task-edit-badge-preview'),
          editDialog.querySelector('#task-edit-badge-icon'),
          editDialog.querySelector('#task-edit-badge-name'),
          artPath,
          name
        );
        setHiddenBadgeFields(editDialog, iconId, name);
      }
      pickerMode = null;
      closeDialog(picker);
    });
  }

  // ---- Drag to reorder ----
  // Pointer Events (not HTML5 drag-and-drop) so the handle works with touch as
  // well as mouse — the admin is phone-first, and DnD never fires on a
  // touchscreen. The grabbed card LIFTS and follows the pointer (transform),
  // and the cards it displaces SLIDE into place via a First-Last-Invert-Play
  // transition, so the reorder reads the way the old native drag ghost did.
  // setPointerCapture keeps move/up on the handle even as the finger travels
  // over other cards; touch-action:none on .admin-task-drag (theme.css) stops
  // the page scrolling mid-drag.
  //
  // On drop (endDrag below), the DOM's current card order — already correct,
  // the reorder() function above kept it live during the drag — is posted to
  // POST /admin/tasks/reorder-all so it survives a reload. A pure reorder
  // never changes which tasks are active, so no recompute runs (issue #682
  // AC-C).
  //
  // A NON-ok response (review fix) is NOT silently discarded: the route's
  // set-integrity guard refuses a stale/partial post (e.g. a second host
  // added or deleted a task while this host was mid-drag), and in that case
  // the DOM the drag just settled into is now WRONG relative to the server —
  // left alone, it would look saved until the next real navigation silently
  // reverted it. Reloading with an explanatory `?msg=` immediately, instead
  // of leaving a misleading on-screen order, re-syncs the card list from the
  // server's true state and reuses the page's own existing flash-message
  // rendering (admin-tasks.ejs's `<% if (msg) %>` block) rather than
  // inventing a second error-display mechanism. A network-level failure
  // (caught below) is left alone — reloading on a real connectivity problem
  // would compound it, not fix it.
  var list = document.getElementById('admin-task-list');
  if (list) {
    var dragCard = null;
    var grabDy = 0; // pointer offset within the grabbed card at grab time

    function cards() {
      return Array.prototype.slice.call(list.querySelectorAll('.admin-task-card'));
    }

    function persistOrder() {
      var ids = cards().map(function (c) {
        return c.getAttribute('data-task-id');
      });
      fetch('/admin/tasks/reorder-all', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: ids }),
      })
        .then(function (res) {
          if (!res.ok) {
            window.location.href =
              '/admin/tasks?msg=' +
              encodeURIComponent('Reorder could not be saved — the task list changed. Refreshed.');
          }
        })
        .catch(function () {
          // Network failure, not a set-mismatch refusal — see the file
          // comment above this block for why this stays silent.
        });
    }

    // Move the grabbed card to the slot under `y`, animating each displaced
    // card with a FLIP transform so it glides rather than jumps.
    function reorder(y) {
      var all = cards();
      var firstTop = {};
      all.forEach(function (c) {
        firstTop[c.id] = c.getBoundingClientRect().top;
      });

      var others = all.filter(function (c) {
        return c !== dragCard;
      });
      var after = null;
      for (var i = 0; i < others.length; i++) {
        var box = others[i].getBoundingClientRect();
        if (y < box.top + box.height / 2) {
          after = others[i];
          break;
        }
      }
      if (after) list.insertBefore(dragCard, after);
      else list.appendChild(dragCard);

      others.forEach(function (c) {
        var delta = firstTop[c.id] - c.getBoundingClientRect().top;
        if (!delta) return;
        c.style.transition = 'none';
        c.style.transform = 'translateY(' + delta + 'px)';
        c.getBoundingClientRect(); // force reflow, locking the start frame
        c.style.transition = '';
        c.style.transform = '';
      });
    }

    // Position the grabbed card so it sits under the pointer, lifted.
    function follow(y) {
      dragCard.style.transform = '';
      var top = dragCard.getBoundingClientRect().top;
      dragCard.style.transform = 'translateY(' + (y - grabDy - top) + 'px) scale(1.02)';
    }

    list.querySelectorAll('.admin-task-drag').forEach(function (handle) {
      handle.addEventListener('pointerdown', function (event) {
        var card = handle.closest('.admin-task-card');
        if (!card) return;
        dragCard = card;
        grabDy = event.clientY - card.getBoundingClientRect().top;
        card.classList.add('is-dragging');
        follow(event.clientY);
        try {
          handle.setPointerCapture(event.pointerId);
        } catch (_) {
          // Non-fatal — the drag still tracks via the move/up listeners below.
        }
        event.preventDefault();
      });
      handle.addEventListener('pointermove', function (event) {
        if (!dragCard) return;
        event.preventDefault();
        reorder(event.clientY);
        follow(event.clientY);
      });
      function endDrag(event) {
        if (!dragCard) return;
        var card = dragCard;
        dragCard = null;
        // Drop: removing .is-dragging restores the card's transform transition,
        // and clearing the follow transform lets it settle into its slot with a
        // glide instead of snapping.
        card.classList.remove('is-dragging');
        card.style.transform = '';
        try {
          handle.releasePointerCapture(event.pointerId);
        } catch (_) {
          // Non-fatal — the pointer capture may already be gone (e.g. cancel).
        }
        persistOrder();
      }
      handle.addEventListener('pointerup', endDrag);
      handle.addEventListener('pointercancel', endDrag);
    });
  }
})();
