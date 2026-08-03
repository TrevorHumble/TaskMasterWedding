// src/routes/admin/stats.js
// GET /admin/stats (issue #1022) — the host's live read on how the event is
// going. This route owns no data rule of its own: every count comes from
// src/services/event-stats.js's five plain exports, this file only turns
// those numbers into the approved screen's --v percentages and copy strings.

const express = require('express');
const eventStats = require('../../services/event-stats');
const feed = require('../../services/feed');
const { relativeTime } = require('../../services/relative-time');
const { weekdayLabels, singleDayLabel, dayRangeLabel } = require('../../services/event-days');

const router = express.Router();

// Hour-axis labels (issue #1022, pinned copy table): every third hour gets a
// label, the other sixteen render an EMPTY label element (never omitted —
// .chart-col-label's min-height reserves the line so the columns stay on one
// baseline, AC6).
const HOUR_AXIS_LABELS = {
  0: '12a',
  3: '3a',
  6: '6a',
  9: '9a',
  12: '12p',
  15: '3p',
  18: '6p',
  21: '9p',
};

// The one --v percentage rule this page uses: value/max, rounded to the
// nearest integer, 0 when max is falsy (0, NaN — a zero denominator renders
// every bar at --v:0% rather than --v:NaN%, issue #1022's bar-length rule).
function pct(value, max) {
  if (!max) return 0;
  return Math.round((value / max) * 100);
}

// The dense hour chart leaves 16 of 24 .chart-col-label elements empty (the
// pinned copy table) and drops .chart-col-val too (AC6), so at that density
// a column carries no visible text at all -- an unlabelled bar with no
// accessible name. This gives every hour a full, unabbreviated name for the
// li's aria-label, independent of whether HOUR_AXIS_LABELS prints anything
// for it; ARIA attributes don't paint, so adding it cannot move a pixel.
function hourAriaLabel(hour) {
  const period = hour < 12 ? 'a.m.' : 'p.m.';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${period}`;
}

// Own-max-normalized columns for a day/hour series: the tallest bar in the
// series is always --v:100%, the rest scale against it (issue #1022's "Day
// chart, hour chart and Task-by-task normalize against that series' own
// maximum" rule). `val` carries the raw count so the view can render/omit
// the value label per section (AC6 drops it at hour density). `aria` is a
// full-text column identifier for the accessible name (see hourAriaLabel
// above) -- day columns pass their own already-full label back unchanged.
function ownMaxColumns(rows, valueKey, labelFor, ariaFor) {
  const max = rows.reduce((m, r) => Math.max(m, r[valueKey]), 0);
  return rows.map((r, i) => ({
    val: r[valueKey],
    pct: pct(r[valueKey], max),
    label: labelFor(r, i),
    aria: ariaFor(r, i),
  }));
}

router.get('/stats', (req, res) => {
  const daySeries = eventStats.eventDaySeries();
  const validDay = daySeries.some((d) => d.iso === req.query.day);
  const selectedDay = validDay ? req.query.day : null;

  const engagement = eventStats.engagementTotals();
  const bands = eventStats.participationBands();
  const perTask = eventStats.perTaskCompletion();

  // Read straight off VISIBLE_WHERE rather than summing daySeries' per-day
  // `photos` column: that column silently drops any row whose created_at
  // fails to parse, which would otherwise quietly under-report this headline
  // total for the same photo the pulse line's relative-time half still dates.
  const totalPhotos = eventStats.totalVisiblePhotoCount();

  const newestVisible = feed.newestVisibleSubmission();
  const lastPhotoRel = newestVisible ? relativeTime(newestVisible.created_at) : '';

  let pulseLine;
  if (totalPhotos === 0) {
    pulseLine = 'No photos yet.';
  } else {
    const first = daySeries[0];
    const last = daySeries[daySeries.length - 1];
    const dayRange = dayRangeLabel(first.iso, last.iso);
    pulseLine = `${dayRange} · ${totalPhotos} photo${totalPhotos === 1 ? '' : 's'} · last one ${lastPhotoRel}`;
  }

  const dayOptions = daySeries.map((d) => ({
    iso: d.iso,
    label: `${weekdayLabels(d.iso).long}, ${singleDayLabel(d.iso)}`,
  }));

  // Through-the-weekend chart: one dropdown, one dense-vs-few pair of charts
  // that switch mode with the selection (never both at once, AC6/AC7).
  const chartDense = !!selectedDay;
  let joinCols;
  let photoCols;
  if (chartDense) {
    const hours = eventStats.hourSeries(selectedDay);
    joinCols = ownMaxColumns(
      hours,
      'joins',
      (h) => HOUR_AXIS_LABELS[h.hour] || '',
      (h) => hourAriaLabel(h.hour)
    );
    photoCols = ownMaxColumns(
      hours,
      'photos',
      (h) => HOUR_AXIS_LABELS[h.hour] || '',
      (h) => hourAriaLabel(h.hour)
    );
  } else {
    joinCols = ownMaxColumns(
      daySeries,
      'joins',
      (d) => d.label,
      (d) => d.label
    );
    photoCols = ownMaxColumns(
      daySeries,
      'photos',
      (d) => d.label,
      (d) => d.label
    );
  }

  // Participation bands: total-normalized (never own-max — the three bands
  // are parts of one whole, so a total-normalized bar is the only shape that
  // can read less than 100% at the largest band, issue #1022's bar-length
  // rule).
  const bandRows = [
    {
      label: 'Posting photos',
      sub: 'Put up at least one photo',
      val: bands.posting,
      pct: pct(bands.posting, bands.total),
    },
    {
      label: 'Liking & commenting only',
      sub: "Joined in, but hasn't posted",
      val: bands.engagingOnly,
      pct: pct(bands.engagingOnly, bands.total),
    },
    {
      label: 'Signed up, nothing yet',
      sub: 'No photo, no like, no comment',
      val: bands.idle,
      pct: pct(bands.idle, bands.total),
    },
  ];

  const maxTaskCount = perTask.reduce((m, t) => Math.max(m, t.count), 0);
  const taskRows = perTask.map((t) => ({
    title: t.title,
    val: t.count,
    pct: pct(t.count, maxTaskCount),
  }));

  res.render('admin-stats', {
    title: 'Stats',
    pulseLine,
    stats: {
      guests: bands.total,
      photos: totalPhotos,
      likes: engagement.likes,
      comments: engagement.comments,
    },
    bandRows,
    dayOptions,
    selectedDay,
    chartDense,
    joinCols,
    photoCols,
    taskRows,
    isAdmin: true,
    pageScript: 'admin-stats.js',
  });
});

module.exports = router;
