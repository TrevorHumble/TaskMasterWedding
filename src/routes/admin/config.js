// src/routes/admin/config.js
// Event timezone + wedding dates (issue #681) and the hosts' prizes blurb
// (issue #469) — seam table area "config".

const express = require('express');
const {
  getEventConfig,
  setEventConfig,
  getPrizes,
  setPrizes,
  normalizePrizes,
  PRIZES_MAX_LENGTH,
} = require('../../db');
const tasks = require('../../services/tasks');
const eventDaysSvc = require('../../services/event-days');
const { timezoneOptions, isKnownTimezone, resolveSelectedZone } = eventDaysSvc;
const { redirectWithMsg } = require('./shared');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /admin/config  — event timezone + wedding dates (issue #681). Every
// date-aware feature (day chips, daily challenges, the dashboard checklist)
// reads getEventConfig() as its single owner, set exactly once here.
// ---------------------------------------------------------------------------
router.get('/config', (req, res) => {
  const eventConfig = getEventConfig();
  res.render('admin-config', {
    title: 'Configuration',
    isAdmin: true,
    msg: req.query.msg || '',
    err: Boolean(req.query.err),
    timezones: timezoneOptions(),
    config: {
      // A grouped member stored earlier (e.g. America/Boise) pre-selects its
      // group's canonical <option> (America/Denver) — same DST rule, one
      // fewer near-duplicate row in the dropdown.
      timezone: resolveSelectedZone(eventConfig.timezone),
      startDate: eventConfig.startDate,
      endDate: eventConfig.endDate,
    },
    // Issue #469: the hosts' prizes blurb, its own settings key (not part of
    // eventConfig — see src/db/event-config.js's own comment on why). Read
    // fresh on every GET, same as eventConfig above, so a rejected POST's
    // redirect-then-GET always shows the last SAVED value (AC6), never a
    // value from the failed submission.
    prizes: getPrizes(),
    // The textarea's maxlength — same constant the POST handler's clamp
    // below reads, both from event-config.js, so the browser-enforced limit
    // and the server-enforced limit can never independently drift apart.
    prizesMaxLength: PRIZES_MAX_LENGTH,
  });
});

// POST /admin/config  — validate and persist. Timezone must be a real IANA
// name the tzdb list recognizes (never a bare offset the admin typed by
// hand — there is no free-text field, but a crafted POST could still try
// one); start date must be on or before end date. On either failure, the
// stored settings are left completely unchanged (setEventConfig is never
// called) and the page re-renders with an error flash naming the problem.
router.post('/config', (req, res) => {
  const timezone = typeof req.body.timezone === 'string' ? req.body.timezone.trim() : '';
  const startDate = typeof req.body.start_date === 'string' ? req.body.start_date.trim() : '';
  const endDate = typeof req.body.end_date === 'string' ? req.body.end_date.trim() : '';
  // Issue #469: normalized (trim + PRIZES_MAX_LENGTH cap + surrogate repair,
  // see event-config.js's normalizePrizes) server-side, matching the
  // textarea's maxlength (AC5) — a crafted POST can still send more than the
  // browser control would ever submit. No further validation: any text,
  // including whitespace-only (which normalizes to '' after trim, the "no
  // prizes" state AC3 checks for), is a legal value. `prizes` is `null` when
  // the key is absent from the body at all, not merely empty — a form cached
  // from before this field existed posts no key, and erasing the stored text
  // on that submit would be silent data loss, so only a present key writes
  // (the `prizes !== null` gate below).
  const prizes = typeof req.body.prizes === 'string' ? normalizePrizes(req.body.prizes) : null;

  if (!isKnownTimezone(timezone)) {
    return redirectWithMsg(res, '/admin/config?err=1', 'Please choose a valid timezone.');
  }
  if (!tasks.isRealDateString(startDate) || !tasks.isRealDateString(endDate)) {
    return redirectWithMsg(res, '/admin/config?err=1', 'Please enter valid start and end dates.');
  }
  if (startDate > endDate) {
    return redirectWithMsg(
      res,
      '/admin/config?err=1',
      'The wedding start date must be on or before the end date.'
    );
  }

  setEventConfig({ timezone, startDate, endDate });
  // Issue #469 AC6: a rejected save (any branch above) returns before this
  // line runs, so setPrizes is never called and the stored prizes text is
  // left exactly as it was — same "nothing persists unless every field
  // passes" rule setEventConfig already gets, just for one more key.
  if (prizes !== null) setPrizes(prizes);
  redirectWithMsg(res, '/admin/config', 'Configuration saved.');
});

module.exports = router;
