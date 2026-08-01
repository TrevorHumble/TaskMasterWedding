// src/routes/admin/config.js
// Event timezone + wedding dates (issue #681) — seam table area "config".

const express = require('express');
const { getEventConfig, setEventConfig } = require('../../db');
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
  redirectWithMsg(res, '/admin/config', 'Configuration saved.');
});

module.exports = router;
