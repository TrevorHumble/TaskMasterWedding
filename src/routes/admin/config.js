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
const scoring = require('../../services/scoring');
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
      // Issue #1042: the ceremony photo-notice toggle + date.
      ceremonyNotice: eventConfig.ceremonyNotice,
      ceremonyDate: eventConfig.ceremonyDate,
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
    // Issue #1094: one row per currently-seeded 'auto' badge (BLOOM/BOUQUET/
    // GARDEN on the wedding instance, BLOOM/BOUQUET on stag — no code change
    // needed for either, since scoring.autoBadgeRows() reads whatever the
    // catalog actually seeded). Read fresh on every GET, same as eventConfig/
    // prizes above, so a rejected POST's redirect-then-GET always shows the
    // last SAVED thresholds (AC4/AC5), never a value from the failed
    // submission.
    autoBadges: scoring.autoBadgeRows(),
    // Issue #1094 (PR review): the same min/max the POST handler below
    // validates against (scoring.BADGE_THRESHOLD_MIN/MAX, owned once in
    // src/services/scoring/badge-engine.js) — same pattern as prizesMaxLength
    // above, so the browser-enforced input bounds and the server-enforced
    // ones can never independently drift apart.
    badgeThresholdMin: scoring.BADGE_THRESHOLD_MIN,
    badgeThresholdMax: scoring.BADGE_THRESHOLD_MAX,
    // Issue #1094 (PR review): the clean-sweep badge's display name, owned
    // once by scoring.cleanSweepBadgeName() (src/services/scoring/
    // badge-engine.js) rather than hand-typed per variant or re-derived here
    // — the catalog upsert (scripts/badge-catalog.js) already re-syncs
    // `name` on every boot, so this stays correct on both the wedding and
    // stag instance with no isStag branch here.
    cleanSweepName: scoring.cleanSweepBadgeName(),
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
  // Issue #1042: an unchecked checkbox sends no key at all, and absent must
  // mean false here, never "leave the stored value alone" — otherwise the
  // box can be ticked but never unticked.
  const ceremonyNotice = Boolean(req.body.ceremony_notice);
  // ceremony_date: absent, or present but empty after trim, means "keep the
  // stored value" and skip validation entirely — the same treatment the
  // `prizes` field above already takes for an absent key, and for the same
  // reason (a stale cached form, or a host who clears the input, must not
  // erase stored state or block the rest of the form).
  const ceremonyDateRaw =
    typeof req.body.ceremony_date === 'string' ? req.body.ceremony_date.trim() : '';

  // Issue #1094: milestone badge thresholds, one `threshold_<CODE>` field per
  // currently-seeded 'auto' badge row — scoring.autoBadgeRows() is the single
  // source of which codes exist and the order they render in, matching the
  // GET handler's own render local above. Threshold keys are all-or-none
  // (AC4): a form posting none of them (a stale cached form) leaves the
  // stored thresholds untouched (AC5, the same absent-key rule `prizes`/
  // `ceremony_date` already follow above); a form posting some but not all,
  // an unrecognized code, a non-integer/out-of-range value, or a
  // non-ascending order is rejected before ANYTHING in this request persists
  // (validated below, alongside every other rejection branch, before
  // setEventConfig ever runs).
  const autoBadgeCodes = scoring.autoBadgeRows().map((b) => b.code);
  const submittedThresholdKeys = Object.keys(req.body).filter((k) => k.startsWith('threshold_'));
  let thresholdUpdates = null;
  if (submittedThresholdKeys.length > 0) {
    const submittedCodes = new Set(submittedThresholdKeys.map((k) => k.slice('threshold_'.length)));
    // Issue #1094 (PR review): an unrecognized threshold_<CODE> key (a
    // code that isn't any currently-seeded auto badge) is a distinct failure
    // from a recognized code simply missing from the submit — each gets its
    // own accurate message rather than sharing the partial-set one below.
    const hasUnknownCode = [...submittedCodes].some((code) => !autoBadgeCodes.includes(code));
    if (hasUnknownCode) {
      return redirectWithMsg(
        res,
        '/admin/config?err=1',
        "One of the submitted badge codes doesn't match a current milestone badge."
      );
    }
    const hasMissingCode = autoBadgeCodes.some((code) => !submittedCodes.has(code));
    if (hasMissingCode) {
      return redirectWithMsg(
        res,
        '/admin/config?err=1',
        'Please set every badge threshold shown, all together.'
      );
    }

    const parsed = [];
    let allValid = true;
    for (const code of autoBadgeCodes) {
      const raw = req.body['threshold_' + code];
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      const n = parseInt(trimmed, 10);
      if (
        !/^\d+$/.test(trimmed) ||
        n < scoring.BADGE_THRESHOLD_MIN ||
        n > scoring.BADGE_THRESHOLD_MAX
      ) {
        allValid = false;
        break;
      }
      parsed.push({ code, n });
    }
    if (!allValid) {
      return redirectWithMsg(
        res,
        '/admin/config?err=1',
        `Badge thresholds must be whole numbers from ${scoring.BADGE_THRESHOLD_MIN} to ${scoring.BADGE_THRESHOLD_MAX}.`
      );
    }

    const strictlyAscending = parsed.every((entry, i) => i === 0 || entry.n > parsed[i - 1].n);
    if (!strictlyAscending) {
      return redirectWithMsg(
        res,
        '/admin/config?err=1',
        'Badge thresholds must increase from one badge to the next.'
      );
    }

    thresholdUpdates = parsed;
  }

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
  // Validated against the dates SUBMITTED in this same request (already
  // parsed above), not the stored ones — a save that moves the wedding
  // dates and the ceremony day together is judged coherently (issue #1042
  // AC2).
  if (
    ceremonyDateRaw &&
    (!tasks.isRealDateString(ceremonyDateRaw) ||
      ceremonyDateRaw < startDate ||
      ceremonyDateRaw > endDate)
  ) {
    return redirectWithMsg(
      res,
      '/admin/config?err=1',
      'Please enter a valid ceremony day within the wedding dates.'
    );
  }

  setEventConfig({
    timezone,
    startDate,
    endDate,
    ceremonyNotice,
    ceremonyDate: ceremonyDateRaw || undefined,
  });
  // Issue #469 AC6: a rejected save (any branch above) returns before this
  // line runs, so setPrizes is never called and the stored prizes text is
  // left exactly as it was — same "nothing persists unless every field
  // passes" rule setEventConfig already gets, just for one more key.
  if (prizes !== null) setPrizes(prizes);
  // Issue #1094 AC2: after the other writes, so a threshold change and a
  // date/prizes change in the same submit land together — recomputes every
  // guest's threshold badges (revokeKind 'badge_revoked_threshold', AC3)
  // before this response redirects.
  if (thresholdUpdates !== null) scoring.setAutoBadgeThresholds(thresholdUpdates);
  redirectWithMsg(res, '/admin/config', 'Configuration saved.');
});

module.exports = router;
