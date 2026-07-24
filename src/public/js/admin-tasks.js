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

  // The approved default (issue #755 criterion 2): first configured day,
  // +1 bonus — applied when a host promotes an undated task to One day only
  // (both create and edit), so the accordion never opens blank. Read from
  // the FIRST day-chip DOM node rather than hard-coded, so it always matches
  // whatever src/routes/admin.js's GET /admin/tasks actually rendered — the
  // one owner of "what is the first configured day" stays server-side.
  //
  // Scoped to `.day-chips` (review fix, issue #755) — the hidden stale-date
  // input (`#task-edit-special-date-stale`) shares the exact same
  // `name="special_date"`, and an unqualified `dialog.querySelector` would
  // only avoid matching it by document order (it happens to render AFTER
  // the day chips) — the same fragility plan step 4 banned for the
  // `.worth-chip` lookups elsewhere in this file. `.day-chips` never
  // contains that hidden input, so this is correct regardless of markup
  // order.
  function firstDayChipValue(dialog) {
    var chip = dialog && dialog.querySelector('.day-chips input[name="special_date"]');
    return chip ? chip.value : '';
  }

  // The lucky pick's own approved default (issue #650 plan step 6): first
  // configured day, +2 — deliberately the MIDPOINT of the 1-3 range, unlike
  // the one-day option's floor of +1 (firstDayChipValue's own default
  // above), since a lucky bonus is a surprise rather than a guaranteed
  // minimum. Scoped to `.day-chips input[name="lucky_date"]` for the exact
  // same reason firstDayChipValue is scoped — the lucky stale-date input
  // (`#task-edit-lucky-date-stale`) shares the `name="lucky_date"` name, and
  // `.day-chips` never contains it.
  function firstLuckyDayChipValue(dialog) {
    var chip = dialog && dialog.querySelector('.day-chips input[name="lucky_date"]');
    return chip ? chip.value : '';
  }

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

  // Disables every field inside a NOT-selected special option's accordion
  // panel (issue #763 PR review, minor 8). The panel is hidden by CSS alone
  // (`.special-option-group:has(.special-option input:checked)`), but a
  // CSS-hidden field still participates in native constraint validation —
  // the flash minutes field's `min="1"` blocks Save on ANY out-of-range
  // value left in it even while its panel is collapsed, the browser cannot
  // focus a control it cannot see, and nothing on screen tells the host why
  // Save did nothing. Disabling a control is the standard's own escape
  // hatch: it drops out of constraint validation and out of the submitted
  // form data entirely, without touching anything the host can see
  // (visibility is still owned by CSS alone). Applied to every
  // `.special-option-group` uniformly (one-day, flash, lucky), not
  // special-cased to flash, since the hazard is generic to "a field with a
  // constraint inside a CSS-hidden accordion panel."
  //
  // Excludes `input[type="hidden"]` deliberately: a hidden input is NEVER a
  // candidate for constraint validation regardless of its disabled state, so
  // toggling it here would serve no purpose for the hazard above — and both
  // the flash panel's `flash_cancel` field and the lucky panel's stale-date
  // hidden input (`#task-edit-lucky-date-stale`) already have their OWN
  // disabled-state owner elsewhere in this file (openEdit()'s chip-matching
  // logic, resetCreate()'s default) that must not be clobbered by a blanket
  // "the panel is active, enable everything inside it" pass.
  function syncSpecialPanels(dialog) {
    if (!dialog) return;
    dialog.querySelectorAll('.special-option-group').forEach(function (group) {
      var radio = group.querySelector('.special-option input[type="radio"]');
      var panel = group.querySelector('.special-panel');
      if (!radio || !panel) return;
      var active = radio.checked;
      panel.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach(function (el) {
        el.disabled = !active;
      });
    });
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
    // Scoped by `name`, not by class (issue #755 review note): the day and
    // bonus chips both reuse class="worth-chip", and the bonus chips carry
    // the same 1/2/3 values the worth chips do — a bare first-match query
    // here would silently grab a bonus chip if the accordion ever preceded
    // the Worth fieldset in document order.
    var worthRadio = editDialog.querySelector('input[name="worth"][value="' + worth + '"]');
    if (worthRadio) worthRadio.checked = true;

    var mode = g('mode') || 'none';
    var modeRadio = editDialog.querySelector('.special-option input[value="' + mode + '"]');
    if (modeRadio) modeRadio.checked = true;

    // The server-derived answer to "which Special radio does this task's
    // edit popup open on" (tasks.whatSpecial(), emitted as data-special-kind
    // by GET /admin/tasks — see that route's own comment). Hoisted here
    // (issue #763) so both the flash override below AND the lucky override
    // further down can read the SAME value; previously only the lucky block
    // computed it.
    var specialKind = g('special-kind');

    // Day/bonus chips (issue #755 criteria 1-3b): clear BOTH groups first,
    // exactly the same reason the badge fields are reset on every open below
    // — without this a previously edited task's Aug 9 / +3 selection leaks
    // onto the next task opened and gets written on save (criterion 2).
    editDialog.querySelectorAll('input[name="special_date"]').forEach(function (r) {
      r.checked = false;
    });
    editDialog.querySelectorAll('input[name="special_bonus"]').forEach(function (r) {
      r.checked = false;
    });
    var staleDateInput = editDialog.querySelector('#task-edit-special-date-stale');
    if (staleDateInput) {
      staleDateInput.value = '';
      staleDateInput.disabled = true;
    }

    var storedDate = g('special-date');
    var storedBonus = g('special-bonus');
    if (storedDate) {
      var dateChip = editDialog.querySelector(
        'input[name="special_date"][value="' + storedDate + '"]'
      );
      if (dateChip) {
        dateChip.checked = true;
      } else if (staleDateInput) {
        // Stored date matches no rendered chip (criterion 3b — the host
        // narrowed the wedding dates after dating this task). Carry it
        // through a disabled-by-default hidden input so a title-only edit
        // re-posts the SAME stale date rather than posting nothing, which
        // would read as a pair CHANGE (criterion 3's own reasoning for why
        // this input exists).
        staleDateInput.value = storedDate;
        staleDateInput.disabled = false;
      }
    }
    if (storedBonus) {
      var bonusChip = editDialog.querySelector(
        'input[name="special_bonus"][value="' + storedBonus + '"]'
      );
      if (bonusChip) bonusChip.checked = true;
    }

    // Flash fields (issue #763 plan step 7) — cleared first, same
    // leak-prevention reason as the one-day pair above: a previously edited
    // task's bonus/duration selection must never carry onto the next task
    // opened. No approved "first day / midpoint bonus" default exists for
    // flash the way it does for one-day/lucky (the static markup itself
    // ships with no worth-chip pre-checked and the minutes field's
    // placeholder, "15", is the only hint) — so an UNARMED task's flash
    // panel opens exactly as blank as its first paint.
    editDialog.querySelectorAll('input[name="flash_bonus"]').forEach(function (r) {
      r.checked = false;
    });
    var flashMinutesInput = editDialog.querySelector('input[name="flash_minutes"]');
    if (flashMinutesInput) flashMinutesInput.value = '';
    // Starts always reopens on Now (the approved screen's own default) —
    // never on a stale "Pick a time" left over from a previous task, and
    // never pre-filled toward "later" for an already-scheduled task either:
    // Now is what makes the no-op rule work at all (src/routes/admin.js's
    // resolveFlashWrite doc comment) — a title-only resave of a SCHEDULED
    // task must post Starts=Now so the server can recognise it as a no-op
    // and leave the scheduled instant untouched.
    var flashNowRadio = editDialog.querySelector('input[name="flash_start_mode"][value="now"]');
    if (flashNowRadio) flashNowRadio.checked = true;
    editDialog.querySelectorAll('input[name="flash_date"]').forEach(function (r) {
      r.checked = false;
    });
    var flashTimeInput = editDialog.querySelector('input[name="flash_time"]');
    if (flashTimeInput) flashTimeInput.value = '';
    var flashCancelInput = editDialog.querySelector('[data-flash-cancel-input]');
    if (flashCancelInput) flashCancelInput.value = '';

    var storedFlashBonus = g('flash-bonus');
    if (storedFlashBonus) {
      var flashBonusChip = editDialog.querySelector(
        'input[name="flash_bonus"][value="' + storedFlashBonus + '"]'
      );
      if (flashBonusChip) flashBonusChip.checked = true;
    }
    var storedFlashMinutes = g('flash-minutes');
    if (storedFlashMinutes && flashMinutesInput) {
      flashMinutesInput.value = storedFlashMinutes;
    }

    // The Flash radio's checked state is derived from data-special-kind
    // (issue #763), the SAME server-computed tasks.whatSpecial() answer the
    // Lucky radio's own override reads below — flash is never a stored
    // special_mode value (src/services/tasks.js's MODES comment), so the raw
    // `modeRadio` line above can never check it on its own. Flash and lucky
    // can never both be true here (whatSpecial answers exactly one kind), so
    // this and the lucky override below never fight over the same radio.
    if (specialKind === 'flash') {
      var flashRadio = editDialog.querySelector('.special-option input[value="flash"]');
      if (flashRadio) flashRadio.checked = true;
    }

    // The status strip (issue #763 criterion 6) — truthful per task, filled
    // from the SAME server-computed labels the board chip reads
    // (data-flash-state / data-flash-strip-label, GET /admin/tasks's own
    // projection). This dialog is shared across every card, so its markup
    // reflects "nothing armed" until this fills it in; scoped to
    // `.flash-state-strip` (there is exactly one, inside this dialog) rather
    // than a page-wide query, since a future page could add another.
    //
    // "Is the strip visible" has exactly ONE owner (issue #763 PR review,
    // M3): the server's `flashStripLabel` (src/routes/admin.js's GET
    // /admin/tasks projection) is non-empty precisely when the state is
    // `active` or `scheduled` — so this reads data-flash-strip-label being
    // non-empty rather than re-deriving that same active/scheduled test a
    // second time from data-flash-state. data-flash-state is still read for
    // the dot's filled-vs-hollow CSS class (`.flash-state-scheduled
    // .flash-state-dot`), which is a presentation detail with no second
    // owner to collapse, unlike the visibility question.
    //
    // Visibility is an INLINE style (`element.style.display`), not the
    // `hidden` property/attribute: special-flash-option.ejs's own initial
    // render uses the identical inline-style technique for the SAME reason
    // (see that partial's own comment) — theme.css's `.flash-state-strip {
    // display: flex }` class rule would otherwise outrank the low-priority
    // `[hidden]` UA style, and an inline style needs no accompanying CSS
    // change to win that fight either way.
    var flashStrip = editDialog.querySelector('.flash-state-strip');
    if (flashStrip) {
      var flashState = g('flash-state') || 'none';
      var flashStripLabel = g('flash-strip-label');
      flashStrip.classList.remove(
        'flash-state-none',
        'flash-state-scheduled',
        'flash-state-active',
        'flash-state-expired'
      );
      flashStrip.classList.add('flash-state-' + flashState);
      var flashVisible = !!flashStripLabel;
      flashStrip.style.display = flashVisible ? '' : 'none';
      var flashStripText = flashStrip.querySelector('.flash-state-text');
      if (flashStripText) flashStripText.textContent = flashStripLabel;
    }

    // Lucky day/bonus chips (issue #650 plan step 6) — cleared first, same
    // leak-prevention reason as the one-day pair above.
    editDialog.querySelectorAll('input[name="lucky_date"]').forEach(function (r) {
      r.checked = false;
    });
    editDialog.querySelectorAll('input[name="lucky_bonus"]').forEach(function (r) {
      r.checked = false;
    });
    var staleLuckyDateInput = editDialog.querySelector('#task-edit-lucky-date-stale');
    if (staleLuckyDateInput) {
      staleLuckyDateInput.value = '';
      staleLuckyDateInput.disabled = true;
    }

    var storedLuckyDate = g('lucky-date');
    var storedLuckyBonus = g('lucky-bonus');
    if (storedLuckyDate) {
      var luckyDateChip = editDialog.querySelector(
        'input[name="lucky_date"][value="' + storedLuckyDate + '"]'
      );
      if (luckyDateChip) {
        luckyDateChip.checked = true;
      } else if (staleLuckyDateInput) {
        // Stored lucky day matches no rendered chip — the host narrowed the
        // wedding dates after picking it. Same stale-date carry-through as
        // the one-day pair above (issue #650 plan step 6).
        staleLuckyDateInput.value = storedLuckyDate;
        staleLuckyDateInput.disabled = false;
      }
    }
    if (storedLuckyBonus) {
      var luckyBonusChip = editDialog.querySelector(
        'input[name="lucky_bonus"][value="' + storedLuckyBonus + '"]'
      );
      if (luckyBonusChip) luckyBonusChip.checked = true;
    }

    // The Lucky radio's checked state is derived from data-lucky-date, NOT
    // from the card's data-mode (issue #650 plan step 6) — a lucky task
    // stores special_mode='none' (or 'hidden'), so the `modeRadio` line
    // above never checks Lucky on its own. A stored special_date wins the
    // radio over the lucky pick, though, whenever daily currently owns the
    // task. issue #650 PR review fix (Finding A): this used to hand-copy the
    // daily rule's spokenFor predicate here (isSealed||isOnDay, computed
    // against a data-today attribute) — a second owner of a rule
    // src/services/tasks.js's whatSpecial() already owns, and one that could
    // not see a live flash window at all. The server now does that walk once
    // (GET /admin/tasks, tasks.whatSpecial(t, clock)) and emits its answer as
    // data-special-kind; this script only reads it back, so "which rule owns
    // this task" has exactly one owner.
    //
    // The test below is a WHITELIST, not a "not daily" blacklist (issue #650
    // re-check finding): whatSpecial() can answer 'daily', 'flash', 'lucky' or
    // null, which the board emits as an empty data-special-kind (see
    // src/views/admin-tasks.ejs's `t.specialKind || ''`). A blacklist naming
    // only 'daily' lets EVERY other kind fall through to
    // "check Lucky" — so a row owned by a live flash window would open on the
    // Lucky radio, the host's title-only save would post special_mode=lucky,
    // and the server's exclusivity guard would refuse it over a control the
    // host never touched. That is the exact failure this whole fix exists to
    // prevent, and a blacklist reintroduces it for every special type added
    // after this one. A whitelist fails safe instead: an unrecognised kind
    // falls back to the data-mode radio, which is always saveable.
    //
    // A task whose lucky_date has PASSED and carries no special_date opens
    // with the Lucky radio selected too (data-special-kind is '' — nothing
    // presently owns it) — accepted, not a bug to "fix": the row is free again
    // as far as whatSpecial() is concerned, and picking a new day or None
    // overwrites it (see the issue's implementation plan step 6 and DESIGN.md's
    // lucky-task ADR). `specialKind` was already read near the top of this
    // function (issue #763 — the flash override needs it too).
    if (storedLuckyDate && (specialKind === '' || specialKind === 'lucky')) {
      var luckyRadio = editDialog.querySelector('.special-option input[value="lucky"]');
      if (luckyRadio) luckyRadio.checked = true;
    }

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

    // After every radio above has settled into its final checked state for
    // THIS task (issue #763 PR review, minor 8) — syncing any earlier would
    // disable/enable panels against a state the flash/lucky overrides above
    // still had left to change.
    syncSpecialPanels(editDialog);

    openDialog(editDialog);
  }

  // Any day-chip click disables the stale-date input again (issue #755
  // criterion 3b) — the chips become the only source of special_date the
  // moment the host picks one, so the body never carries two values for that
  // field. Registered ONCE via delegation on the dialog (not inside
  // openEdit, which runs on every popup open) so this never accumulates a
  // fresh listener per open.
  if (editDialog) {
    editDialog.addEventListener('change', function (event) {
      // Keep the disabled-panel-fields invariant in sync the moment the
      // host switches which Special option is picked (issue #763 PR
      // review, minor 8) — no early return, so the branches below (which
      // fill in day/bonus defaults for the newly-picked option) still run
      // against the same event.
      if (event.target.matches && event.target.matches('input[name="special_mode"]')) {
        syncSpecialPanels(editDialog);
      }
      if (event.target.matches && event.target.matches('input[name="special_date"]')) {
        var staleDateInput = editDialog.querySelector('#task-edit-special-date-stale');
        if (staleDateInput) staleDateInput.disabled = true;
        return;
      }
      // Any lucky day-chip click disables the lucky stale-date input again
      // (issue #650 plan step 6), mirroring the one-day pair's own rule
      // immediately above.
      if (event.target.matches && event.target.matches('input[name="lucky_date"]')) {
        var staleLuckyInput = editDialog.querySelector('#task-edit-lucky-date-stale');
        if (staleLuckyInput) staleLuckyInput.disabled = true;
        return;
      }
      // Promoting an UNDATED task to Lucky in the EDIT popup (issue #650
      // plan step 6): apply the approved default (first configured day, +2
      // — the midpoint, not the one-day floor of +1) the same way
      // resetCreate() does for the create flow. Only fires when nothing is
      // already selected — a task openEdit() already populated with its own
      // stored lucky day/bonus (or the stale-date hidden input) is left
      // exactly as it is.
      if (
        event.target.matches &&
        event.target.matches('input[name="special_mode"][value="lucky"]') &&
        event.target.checked
      ) {
        var staleLucky = editDialog.querySelector('#task-edit-lucky-date-stale');
        var hasLuckyDay =
          editDialog.querySelector('input[name="lucky_date"]:checked') ||
          (staleLucky && !staleLucky.disabled && staleLucky.value);
        if (!hasLuckyDay) {
          var firstLuckyDay = firstLuckyDayChipValue(editDialog);
          if (firstLuckyDay) {
            var luckyDayChip = editDialog.querySelector(
              'input[name="lucky_date"][value="' + firstLuckyDay + '"]'
            );
            if (luckyDayChip) luckyDayChip.checked = true;
          }
        }
        if (!editDialog.querySelector('input[name="lucky_bonus"]:checked')) {
          var luckyBonus2 = editDialog.querySelector('input[name="lucky_bonus"][value="2"]');
          if (luckyBonus2) luckyBonus2.checked = true;
        }
        return;
      }
      // Promoting an UNDATED task to One day only in the EDIT popup (issue
      // #755 criterion 2): apply the approved default (first configured day,
      // +1) the same way resetCreate() does for the create flow, rather than
      // leaving the accordion blank. Only fires when nothing is already
      // selected — a task openEdit() already populated with its own stored
      // day/bonus (or the stale-date hidden input) is left exactly as it is.
      if (
        event.target.matches &&
        event.target.matches('input[name="special_mode"][value="oneday"]') &&
        event.target.checked
      ) {
        var staleInput = editDialog.querySelector('#task-edit-special-date-stale');
        var hasDay =
          editDialog.querySelector('input[name="special_date"]:checked') ||
          (staleInput && !staleInput.disabled && staleInput.value);
        if (!hasDay) {
          var firstDay = firstDayChipValue(editDialog);
          if (firstDay) {
            var dayChip = editDialog.querySelector(
              'input[name="special_date"][value="' + firstDay + '"]'
            );
            if (dayChip) dayChip.checked = true;
          }
        }
        if (!editDialog.querySelector('input[name="special_bonus"]:checked')) {
          var bonus1 = editDialog.querySelector('input[name="special_bonus"][value="1"]');
          if (bonus1) bonus1.checked = true;
        }
      }
    });
  }

  // The create dialog's own Special radio needs the identical sync (issue
  // #763 PR review, minor 8) — resetCreate() only sets it up for the
  // dialog's OPENING state (always None); this keeps it correct as the host
  // clicks between options while it stays open, mirroring the editDialog
  // listener just above.
  if (createDialog) {
    createDialog.addEventListener('change', function (event) {
      if (event.target.matches && event.target.matches('input[name="special_mode"]')) {
        syncSpecialPanels(createDialog);
      }
    });
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
    var w1 = createDialog.querySelector('input[name="worth"][value="1"]');
    if (w1) w1.checked = true;
    var none = createDialog.querySelector('.special-option input[value="none"]');
    if (none) none.checked = true;
    // The approved One day only default (issue #755 criterion 2): first
    // configured day, +1 bonus — set even while None is the checked mode
    // (the accordion stays closed by CSS alone until the host picks One day
    // only) so the FIRST time they do, it opens on the default rather than
    // blank, and their first Save is not bounced by criterion 3's
    // missing-date rule.
    var firstDay = firstDayChipValue(createDialog);
    if (firstDay) {
      var dayChip = createDialog.querySelector(
        'input[name="special_date"][value="' + firstDay + '"]'
      );
      if (dayChip) dayChip.checked = true;
    }
    var bonus1 = createDialog.querySelector('input[name="special_bonus"][value="1"]');
    if (bonus1) bonus1.checked = true;
    // The approved Lucky default (issue #650 plan step 6): first configured
    // day, +2 — the midpoint of the 1-3 range, deliberately different from
    // the one-day option's floor of +1 above, since a lucky bonus is a
    // surprise rather than a guaranteed minimum. Set for the identical
    // "never opens blank" reason as the one-day default just above.
    var firstLuckyDay = firstLuckyDayChipValue(createDialog);
    if (firstLuckyDay) {
      var luckyDayChip = createDialog.querySelector(
        'input[name="lucky_date"][value="' + firstLuckyDay + '"]'
      );
      if (luckyDayChip) luckyDayChip.checked = true;
    }
    var luckyBonus2 = createDialog.querySelector('input[name="lucky_bonus"][value="2"]');
    if (luckyBonus2) luckyBonus2.checked = true;
    // Flash fields (issue #763) — the create dialog is reused across every
    // "New task" click in the same page session, so a value left over from
    // an abandoned earlier create must not leak into the next one. No
    // approved default bonus/duration exists for flash (see openEdit()'s own
    // comment on this) — cleared to blank, matching the static markup's own
    // unchecked-chips/placeholder-only first paint.
    createDialog.querySelectorAll('input[name="flash_bonus"]').forEach(function (r) {
      r.checked = false;
    });
    var createFlashMinutes = createDialog.querySelector('input[name="flash_minutes"]');
    if (createFlashMinutes) createFlashMinutes.value = '';
    var createFlashNow = createDialog.querySelector('input[name="flash_start_mode"][value="now"]');
    if (createFlashNow) createFlashNow.checked = true;
    createDialog.querySelectorAll('input[name="flash_date"]').forEach(function (r) {
      r.checked = false;
    });
    var createFlashTime = createDialog.querySelector('input[name="flash_time"]');
    if (createFlashTime) createFlashTime.value = '';
    // The create dialog never shows the status strip (a brand-new task can
    // never already have a flash to cancel), but the hidden flash_cancel
    // field this partial always renders alongside it must still be cleared
    // (issue #763 PR review, minor 7 — openEdit() already does this; a
    // stray '1' left over from a previous dialog session would otherwise
    // clear the trio on a task that was never touched).
    var createFlashCancelInput = createDialog.querySelector('[data-flash-cancel-input]');
    if (createFlashCancelInput) createFlashCancelInput.value = '';
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
    // After every default above has settled (issue #763 PR review, minor 8)
    // — None is checked by this point, so this disables every field in the
    // one-day/flash/lucky panels, none of which are visible until the host
    // picks one.
    syncSpecialPanels(createDialog);
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

    // Flash duration stepper (issue #649): the minus/plus buttons flanking the
    // minutes field. Steps by whatever the button declares, clamps at the
    // field's own `min` so a tap can never drive it to zero or negative, and
    // starts from the placeholder when the field is still empty. The field
    // stays freely typable — this is the thumb-friendly path to a value, not
    // the only one.
    var step = t.closest('[data-flash-step]');
    if (step) {
      var field = document.getElementById(step.getAttribute('aria-controls'));
      if (field) {
        var floor = parseInt(field.getAttribute('min'), 10) || 1;
        var current = parseInt(field.value, 10);
        if (!Number.isInteger(current)) current = parseInt(field.placeholder, 10) || floor;
        field.value = Math.max(floor, current + parseInt(step.getAttribute('data-flash-step'), 10));
      }
      return;
    }

    // Flash cancel (issue #763): the status strip's Cancel button submits
    // the SAME form as Save — it sets the hidden flash_cancel=1 field this
    // dialog's own special-flash-option.ejs include already renders
    // (data-flash-cancel-input) and requestSubmit()s, so admin.js's
    // resolveFlashWrite (src/routes/admin.js) sees it and short-circuits
    // every other flash field/refusal (the wire-format table's own words).
    // requestSubmit(), not submit(), for the same reason the delete flow
    // above uses it: it fires a real 'submit' event, which matters here
    // because the form still carries the browser's native `required`
    // validation on the title field — submit() would bypass that.
    var cancelBtn = t.closest('[data-flash-cancel]');
    if (cancelBtn) {
      var cancelForm = cancelBtn.closest('form');
      var cancelField = cancelForm && cancelForm.querySelector('[data-flash-cancel-input]');
      if (cancelField) cancelField.value = '1';
      if (cancelForm) {
        if (typeof cancelForm.requestSubmit === 'function') {
          cancelForm.requestSubmit();
        } else {
          cancelForm.submit();
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
        // Issue #284: Object.assign merges the CSRF header in without
        // clobbering Content-Type.
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          window.csrfHeader ? window.csrfHeader() : {}
        ),
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
