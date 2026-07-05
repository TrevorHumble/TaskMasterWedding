// tests/loadtest.test.js
// Unit tests for the pure measurement helpers in scripts/loadtest.js (AC1-AC3).
// scripts/loadtest.js guards its CLI behind `require.main === module`, so
// requiring it here has no side effects (no network calls, no process.exit) —
// these tests need no live server.
'use strict';

const {
  percentile,
  summarize,
  evaluate,
  captureSignedCookie,
  extractActiveTaskIds,
  chooseTaskId,
} = require('../scripts/loadtest');

// A snippet matching src/views/tasks.ejs's rendered markup (task list v2,
// issue #250): one done row (photo thumb + check badge), one to-do row
// (title/description + points). Kept faithful to the template so
// extractActiveTaskIds is tested against the actual shape the harness will
// parse at runtime.
const TASKS_HTML = `
  <ul class="task-list">
    <li class="task-row task-done">
      <a class="task-link" href="/tasks/7">
        <span class="task-thumb-wrap">
          <img src="/thumbs/t7.jpg" alt="" class="task-thumb" width="40" height="40" />
          <span class="task-thumb-check" aria-label="Completed">&#10003;</span>
        </span>
        <span class="task-body">
          <span class="task-title-text">Find the guestbook</span>
        </span>
      </a>
    </li>
    <li class="task-row task-todo">
      <a class="task-link" href="/tasks/12">
        <span class="task-body">
          <span class="task-title-text">Toast the newlyweds</span>
          <span class="task-desc">Raise a glass and catch the moment.</span>
        </span>
        <span class="task-points">+1 pt</span>
      </a>
    </li>
  </ul>
`;

describe('percentile', () => {
  // AC1: nearest-rank percentile on a copy-sorted array.
  it('returns 100 for p95 of [10..100 by 10s]', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(samples, 95)).toBe(100);
  });

  it('returns 50 for p50 of [10..100 by 10s]', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(samples, 50)).toBe(50);
  });

  it('does not mutate the input array (copy-sorted)', () => {
    const samples = [100, 10, 50];
    const original = samples.slice();
    percentile(samples, 50);
    expect(samples).toEqual(original);
  });

  it('sorts out-of-order input before ranking', () => {
    // Same values as the AC1 fixture, but shuffled — should still rank 95th as 100.
    const samples = [70, 10, 100, 40, 20, 90, 60, 30, 80, 50];
    expect(percentile(samples, 95)).toBe(100);
    expect(percentile(samples, 50)).toBe(50);
  });
});

describe('summarize', () => {
  // AC2: 10 samples, 2 marked status >= 500 -> errorRate === 0.2.
  it('computes count/errors/errorRate for 10 samples with 2 failures', () => {
    const samples = [
      { ms: 5, status: 200 },
      { ms: 5, status: 200 },
      { ms: 5, status: 200 },
      { ms: 5, status: 200 },
      { ms: 5, status: 200 },
      { ms: 5, status: 200 },
      { ms: 5, status: 200 },
      { ms: 5, status: 200 },
      { ms: 5, status: 500 },
      { ms: 5, status: 503 },
    ];
    const summary = summarize(samples);
    expect(summary.count).toBe(10);
    expect(summary.errors).toBe(2);
    expect(summary.errorRate).toBe(0.2);
  });

  it('does not count 4xx statuses as errors', () => {
    const samples = [
      { ms: 5, status: 200 },
      { ms: 5, status: 404 },
      { ms: 5, status: 403 },
    ];
    const summary = summarize(samples);
    expect(summary.errors).toBe(0);
    expect(summary.errorRate).toBe(0);
  });

  it('returns errorRate 0 for an empty sample set (no divide-by-zero)', () => {
    const summary = summarize([]);
    expect(summary.count).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.errorRate).toBe(0);
  });
});

describe('evaluate', () => {
  const thresholds = { p95Ms: 2000 };

  // AC3: errorRate === 0 AND p95 <= threshold -> pass true.
  it('passes when errorRate is 0 and p95 is within threshold', () => {
    const summary = { errorRate: 0, p95: 1500, count: 10, errors: 0 };
    const result = evaluate(summary, thresholds);
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  // AC3: errorRate > 0 -> pass false, with a reason.
  it('fails when errorRate is greater than 0, even if p95 is within threshold', () => {
    const summary = { errorRate: 0.1, p95: 1000, count: 10, errors: 1 };
    const result = evaluate(summary, thresholds);
    expect(result.pass).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  // AC3: p95 > threshold -> pass false, even with a clean error rate.
  it('fails when p95 exceeds the threshold, even if errorRate is 0', () => {
    const summary = { errorRate: 0, p95: 2500, count: 10, errors: 0 };
    const result = evaluate(summary, thresholds);
    expect(result.pass).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('passes at the exact p95 boundary (<=, not <)', () => {
    const summary = { errorRate: 0, p95: 2000, count: 10, errors: 0 };
    const result = evaluate(summary, thresholds);
    expect(result.pass).toBe(true);
  });
});

describe('captureSignedCookie', () => {
  it('extracts the gsid=... pair and drops cookie attributes', () => {
    const header = 'gsid=s%3Aevent-guest-token-0.abc123; Path=/; HttpOnly; SameSite=Lax';
    expect(captureSignedCookie(header)).toBe('gsid=s%3Aevent-guest-token-0.abc123');
  });

  it('returns null when there is no gsid cookie', () => {
    expect(captureSignedCookie('other=value; Path=/')).toBeNull();
  });

  it('returns null for a missing header', () => {
    expect(captureSignedCookie(null)).toBeNull();
  });
});

describe('extractActiveTaskIds', () => {
  it('parses id and done-state from the rendered /tasks markup', () => {
    expect(extractActiveTaskIds(TASKS_HTML)).toEqual([
      { id: 7, done: true },
      { id: 12, done: false },
    ]);
  });

  it('yields exactly one result per task row (no stray anchors leak in)', () => {
    // The v2 page (#250) dropped the per-row "See photos" gallery links, so
    // each row holds a single task-link; exactly two results proves nothing
    // else in the row markup is mistaken for one.
    expect(extractActiveTaskIds(TASKS_HTML)).toHaveLength(2);
  });

  it('returns an empty array for the empty-task-list page', () => {
    const emptyHtml = '<p class="muted">No tasks have been posted yet. Check back soon!</p>';
    expect(extractActiveTaskIds(emptyHtml)).toEqual([]);
  });

  it('returns an empty array for a non-string input', () => {
    expect(extractActiveTaskIds(null)).toEqual([]);
  });
});

describe('chooseTaskId', () => {
  it('prefers a not-done task over a done one', () => {
    const chosen = chooseTaskId([
      { id: 7, done: true },
      { id: 12, done: false },
    ]);
    expect(chosen).toBe(12);
  });

  it('falls back to the first task when every task is done', () => {
    const chosen = chooseTaskId([
      { id: 7, done: true },
      { id: 9, done: true },
    ]);
    expect(chosen).toBe(7);
  });

  it('returns null when there are no tasks', () => {
    expect(chooseTaskId([])).toBeNull();
  });
});
