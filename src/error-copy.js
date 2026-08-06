// src/error-copy.js
// Neutral home for the guest-facing copy on src/views/error.ejs's shared
// card (issue #1020, defect fix). Both the outermost 500 handler
// (src/app.js) and the leaf POST /error-report route
// (src/routes/guest/error-report.js) need the SAME server-error copy: the
// 500 handler renders it on the way in, and error-report.js re-renders it on
// the confirmation page. Before this file existed, error-report.js (a leaf,
// optional feature route) owned this copy and src/app.js's
// global handler imported it from there -- an ownership inversion, since
// deleting or renaming that one feature route would have silently broken
// the app-wide 500 page every other crash in the app depends on. Putting
// the copy here instead, in a module neither side is a feature of, means
// src/app.js never needs a require edge into a route module to render its
// own error page, and a leaf route never has to keep copy the outermost
// handler depends on.
'use strict';

// The shared error page's body copy (src/views/error.ejs's `paragraphs:
// [message]`). Named for what it IS -- the card's body text -- not for the
// 500 site alone: error-report.js's own 200 confirmation re-renders this same
// card, on a 200 response, so a name that claimed "server error" would be
// wrong on that render. See error-report.js's own file comment for why it
// re-renders the same copy rather than a distinct "thanks" message.
const ERROR_PAGE_MESSAGE = 'Something went wrong on our end. Please try again.';

// The 400 rejection on POST /error-report when `code` is missing or fails
// isReqId (src/routes/guest/error-report.js). Distinct from
// ERROR_PAGE_MESSAGE: this request did not fail on the server, so telling
// the guest "something went wrong on our end" would be status-inaccurate --
// every other rejection site (413/429/403) already carries copy specific to
// what was actually rejected, and this path should too.
const ERROR_REPORT_REJECTED_MESSAGE = 'That report could not be sent. Please try again.';

module.exports = {
  ERROR_PAGE_MESSAGE,
  ERROR_REPORT_REJECTED_MESSAGE,
};
