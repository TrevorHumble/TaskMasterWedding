// src/public/js/task-countdown.js
//
// Issue #624: keeps the "Unlocks in 2d 14h 07m" clock on a locked one-day-only
// challenge card ticking. Issue #762 extends the SAME script (criterion 5:
// "the countdown has one implementation" — no second ticking script) to also
// keep a live flash marker's clock and drain fill ticking.
//
// The server already renders the correct starting values (see
// src/views/partials/task-todo-row.ejs), so this script is pure enhancement —
// with JavaScript off both clocks still show correct figures on load, they
// just stop advancing. Each card/flag carries an ABSOLUTE instant
// (data-unlock-at / data-ends-at, event-local midnight or the flash window's
// end, with its UTC offset), so the arithmetic below is correct regardless of
// the timezone the guest's phone is set to.
(function () {
  'use strict';

  var cards = document.querySelectorAll('.task-countdown[data-unlock-at]');
  var flashFlags = document.querySelectorAll('.task-flash-flag[data-ends-at]');
  // The early-exit has to consider BOTH clocks (issue #762 criterion 5): a
  // page with a live flash but no locked card must still tick.
  if (!cards.length && !flashFlags.length) return;

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function paint(card) {
    var target = new Date(card.getAttribute('data-unlock-at')).getTime();
    if (isNaN(target)) return;

    var left = target - Date.now();
    if (left <= 0) {
      card.classList.add('is-unlocking');
      var clock = card.querySelector('.task-countdown-clock');
      if (clock) clock.textContent = 'any moment now';
      return;
    }

    var parts = {
      d: String(Math.floor(left / 86400000)),
      h: pad(Math.floor(left / 3600000) % 24),
      m: pad(Math.floor(left / 60000) % 60),
      s: pad(Math.floor(left / 1000) % 60),
    };
    Object.keys(parts).forEach(function (key) {
      var el = card.querySelector('[data-cd="' + key + '"]');
      // Only touch the DOM when the digits actually change: the seconds node
      // repaints every tick, but days/hours/minutes stay untouched for
      // minutes or hours at a stretch.
      if (el && el.textContent !== parts[key]) el.textContent = parts[key];
    });
  }

  // Issue #762 criterion 4: the flash marker's mm:ss / h:mm:ss clock. Same
  // absolute-instant discipline as paint() above, and the same format rule
  // as the server-side first paint in src/views/partials/task-todo-row.ejs —
  // the two must agree, or the clock would visibly jump the instant this
  // script takes over.
  function paintFlash(flag) {
    var target = new Date(flag.getAttribute('data-ends-at')).getTime();
    if (isNaN(target)) return;

    var left = target - Date.now();
    var clock = flag.querySelector('.task-flash-clock');
    if (left <= 0) {
      // Issue #762 criterion 6: the ended state retracts the WHOLE offer,
      // not just the clock. Leaving "+N pts right now" beside a cleared
      // clock claims a bonus the guest can no longer earn, so the copy
      // changes, the clock clears, and the pill drops to the thinned-ember
      // spent treatment. Deliberately no self-reload here — see paint()'s
      // own comment above on why a clock-skewed device reloading the
      // primary guest screen in a loop is the defect to avoid.
      var copy = flag.querySelector('.task-flash-copy');
      if (copy) copy.textContent = 'Flash ended';
      if (clock) clock.textContent = '';
      flag.classList.add('is-ended');
      flag.style.setProperty('--flash-left', '0%');

      // The price tag beside it has to come down with it (issue #762
      // criterion 6, "and the price tag beside it falls back to the plain
      // base worth"): left alone it would go on quoting the raised total
      // right next to a pill that just said the flash is over. Resolved
      // through the pill's OWN row (not a document-wide query) so two
      // flashed rows on one page retract independently.
      var row = flag.closest('.task-row');
      var price = row && row.querySelector('.task-points[data-base-label]');
      if (price) {
        price.textContent = price.getAttribute('data-base-label');
        price.classList.remove('task-points-raised');
      }
      return;
    }

    var hrs = Math.floor(left / 3600000);
    var mins = Math.floor(left / 60000) % 60;
    var secs = Math.floor(left / 1000) % 60;
    var text = hrs > 0 ? hrs + ':' + pad(mins) + ':' + pad(secs) : pad(mins) + ':' + pad(secs);
    if (clock && clock.textContent !== text) clock.textContent = text;

    // Drain fill: how much of the window is left, as a percentage the
    // stylesheet paints the pill's fill from. No floor (owner, 2026-07-21):
    // the fill runs the full range to empty, and it going quiet as the
    // window closes is fine — the clock beside it carries the last stretch.
    var totalMs = Number(flag.getAttribute('data-total-ms'));
    if (totalMs > 0) {
      var pct = Math.max(0, Math.min(100, Math.round((left / totalMs) * 100)));
      flag.style.setProperty('--flash-left', pct + '%');
    }
  }

  // When a challenge's moment arrives the card settles on "any moment now" and
  // stays there until the guest navigates. It deliberately does NOT reload the
  // page itself: a reload restarts this script, which resets any in-memory
  // "only once" latch, so a device or server whose clock is off by a minute
  // would reload the guest's task list over and over — on the primary guest
  // screen, at the one moment the whole party is looking at it. The reveal is
  // one tap away instead.
  function tick() {
    Array.prototype.forEach.call(cards, function (card) {
      paint(card);
    });
    Array.prototype.forEach.call(flashFlags, function (flag) {
      paintFlash(flag);
    });
  }

  tick();
  setInterval(tick, 1000);
})();
