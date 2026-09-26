// ============================================================================
// CRAWL LOOP CONVERGENCE TEST
// ============================================================================
// Covers `crawlFindingIds` (src/modules/live-crawler-report.js) — the finding
// ids `bin/gatetest.js`'s `--crawl-loop` feeds to the shared convergence
// guard (src/core/convergence-guard.js, complaint C23). `bin/gatetest.js`
// itself runs `main()` at import time and exports nothing (see its own
// header comment), so the loop's convergence DECISION is exercised directly
// through `createConvergenceGuard`, fed by these ids, exactly as
// `runCrawlLoop` calls it round to round.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { crawlFindingIds, buildCrawlFindings } = require('../src/modules/live-crawler-report.js');
const { createConvergenceGuard, REASONS } = require('../src/core/convergence-guard.js');

function crawlData(overrides = {}) {
  return {
    baseUrl: 'https://example.test', pagesScanned: 3, maxPages: 10,
    errors: [], brokenLinks: [], brokenImages: [], brokenScripts: [], brokenStylesheets: [],
    timedOutPages: [], budgetExhausted: false, warnings: [],
    ...overrides,
  };
}

test('crawlFindingIds is empty for a clean crawl (feeds the guard to CONVERGED)', () => {
  const ids = crawlFindingIds(crawlData());
  assert.deepEqual(ids, []);

  const guard = createConvergenceGuard({ maxIterations: 20 });
  const step = guard.step({ findingIds: ids });
  assert.equal(step.done, true);
  assert.equal(step.reason, REASONS.CONVERGED);
});

test('crawlFindingIds matches buildCrawlFindings 1:1 — never a second finding count', () => {
  const data = crawlData({
    brokenLinks: [{ status: 404, link: '/dead', page: '/home' }],
    timedOutPages: [{ url: '/slow', elapsedMs: 9000 }],
  });
  assert.equal(crawlFindingIds(data).length, buildCrawlFindings(data).length);
});

test('crawl loop — the SAME broken link every round is no-progress, not max-iterations', () => {
  const guard = createConvergenceGuard({ maxIterations: 20 });
  const data = crawlData({ brokenLinks: [{ status: 404, link: '/dead', page: '/home' }] });

  const first = guard.step({ findingIds: crawlFindingIds(data) });
  assert.equal(first.done, false);
  const second = guard.step({ findingIds: crawlFindingIds(data) }); // nobody fixed it
  assert.equal(second.done, true);
  assert.equal(second.reason, REASONS.NO_PROGRESS);
});

test('control: a DIFFERENT broken link each round keeps the loop going (real progress being made)', () => {
  const guard = createConvergenceGuard({ maxIterations: 20 });
  const round1 = crawlData({ brokenLinks: [{ status: 404, link: '/dead-1', page: '/home' }] });
  const round2 = crawlData({ brokenLinks: [{ status: 404, link: '/dead-2', page: '/about' }] });

  const first = guard.step({ findingIds: crawlFindingIds(round1) });
  assert.equal(first.done, false);
  const second = guard.step({ findingIds: crawlFindingIds(round2) });
  assert.equal(second.done, false, 'a genuinely different broken link must not read as no-progress');
});

test('crawl loop — flapping between two broken-link states is reported as oscillating', () => {
  const guard = createConvergenceGuard({ maxIterations: 20 });
  const a = crawlData({ brokenLinks: [{ status: 404, link: '/dead-a', page: '/home' }] });
  const b = crawlData({ brokenLinks: [{ status: 404, link: '/dead-b', page: '/home' }] });

  guard.step({ findingIds: crawlFindingIds(a) });
  guard.step({ findingIds: crawlFindingIds(b) });
  const third = guard.step({ findingIds: crawlFindingIds(a) });
  assert.equal(third.done, true);
  assert.equal(third.reason, REASONS.OSCILLATING);
});

test('crawl loop — a persistent, never-resolving issue hits max-iterations with a stated reason', () => {
  const guard = createConvergenceGuard({ maxIterations: 3 });
  let n = 0;
  let step = { done: false };
  while (!step.done) {
    n++;
    // A different link each round, so it never reads as no-progress/oscillating —
    // this isolates the max-iterations path.
    const data = crawlData({ brokenLinks: [{ status: 404, link: `/dead-${n}`, page: '/home' }] });
    step = guard.step({ findingIds: crawlFindingIds(data) });
  }
  assert.equal(step.reason, REASONS.MAX_ITERATIONS);
  assert.equal(n, 3);
  assert.match(step.message, /^stopped: /);
});
