// src/public/js/feed.js
// Progressive enhancement for the feed's like button (issue #194 AC3, option
// b): intercept the like form's submit and toggle via fetch — the server
// answers { liked, likeCount } to an Accept: application/json request — then
// update the count and the button's pressed state in place. The highest-
// frequency tap in the app must not cost a full page re-download. Any
// failure falls back to the plain form POST (redirect to the bounded page),
// which is also the no-JS path.
'use strict';

(function () {
  if (typeof document === 'undefined') {
    return;
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form.classList || !form.classList.contains('like-form') || !window.fetch) {
      return;
    }
    event.preventDefault();

    fetch(form.getAttribute('action'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('like toggle failed: ' + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        var article = form.closest('.feed-item');
        if (!article) {
          return;
        }
        var count = article.querySelector('.like-count');
        if (count) {
          count.textContent = data.likeCount + ' ' + (data.likeCount === 1 ? 'like' : 'likes');
        }
        var button = form.querySelector('.like-button');
        if (button) {
          button.classList.toggle('like-button-liked', data.liked);
          button.setAttribute('aria-pressed', data.liked ? 'true' : 'false');
          // The pop animation belongs to the TOGGLE, not the liked state —
          // animating the state class would make every already-liked heart
          // pop once on page load. Re-adding after a reflow restarts the
          // animation on rapid repeat taps.
          button.classList.remove('like-button-pop');
          if (data.liked) {
            void button.offsetWidth;
            button.classList.add('like-button-pop');
          }
        }
      })
      .catch(function () {
        // Network hiccup or unexpected response — let the ordinary form POST
        // do its redirect-based round trip instead.
        form.submit();
      });
  });
})();
