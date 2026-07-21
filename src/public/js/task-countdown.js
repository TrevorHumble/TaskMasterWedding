// src/public/js/task-countdown.js
//
// Issue #624: keeps the "Unlocks in 2d 14h 07m" clock on a locked one-day-only
// challenge card ticking.
//
// The server already renders the correct starting values (see
// src/views/partials/task-todo-row.ejs), so this script is pure enhancement —
// with JavaScript off the card still shows a correct countdown, it just stops
// advancing. Each card carries an ABSOLUTE unlock instant in data-unlock-at
// (event-local midnight, with its UTC offset), so the arithmetic below is
// correct regardless of the timezone the guest's phone is set to.
(function () {
  'use strict';

  var cards = document.querySelectorAll('.task-countdown[data-unlock-at]');
  if (!cards.length) return;

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
  }

  tick();
  setInterval(tick, 1000);
})();
