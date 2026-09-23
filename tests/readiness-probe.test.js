/**
 * Readiness probe — proves the CUSTOMER JOURNEY works against a live
 * deployment, rather than proving the code compiles.
 *
 * It exists because on 2026-07-27/28 the suite was green — 6,700+ tests,
 * clean build, self-scan PASSED — while production was 102 commits stale,
 * `/billing` 404'd, `POST /api/watches/tick` 405'd, and paid MCP customers
 * got no key. None of that is visible to a test. All of it is obvious to
 * something that asks the live site a question.
 *
 * These tests use an injected fetch, so the probe's LOGIC is verified
 * without a network — including the failure paths, which are the ones that
 * matter and the ones a live run rarely exercises.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runReadinessProbe, DEFAULT_SURFACES } = require('../src/core/readiness-probe');

/** Build a fetch stub from a map of path -> {status, body}. */
function stubFetch(routes, opts = {}) {
  return async (url, init = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const key = `${init.method || 'GET'} ${path}`;
    const hit = routes[key] ?? routes[path];
    if (hit === undefined) {
      if (opts.throwOnMiss) throw new Error(`unstubbed ${key}`);
      return { status: 200, text: async () => opts.defaultBody ?? '<html>id="pricing"</html>' };
    }
    if (hit.throws) throw new Error(hit.throws);
    return { status: hit.status, text: async () => hit.body ?? '' };
  };
}

const HEALTHY = {
  '/api/platform-status': { status: 200, body: JSON.stringify({ commit: 'abc123def4567', version: '1.60.0' }) },
  '/api/status': { status: 200, body: JSON.stringify({ missing_required: [], missing_important: [] }) },
  '/': { status: 200, body: '<html><section id="pricing"></section></html>' },
  '/billing': { status: 200, body: 'ok' },
  '/checkout': { status: 200, body: 'ok' },
  '/mcp': { status: 200, body: 'ok' },
  'GET /api/watches/tick': { status: 401, body: '' },
  'POST /api/watches/tick': { status: 401, body: '' },
  'GET /api/scan/worker/tick': { status: 401, body: '' },
  'POST /api/scan/worker/tick': { status: 401, body: '' },
  'POST /api/scan/preview': { status: 200, body: JSON.stringify({ ok: true, modules: [{ name: 'secret' }], filesScanned: 42 }) },
};

const run = (routes, extra = {}) =>
  runReadinessProbe({ baseUrl: 'https://example.test', fetchFn: stubFetch(routes), ...extra });

const stepNamed = (report, name) => report.steps.find((s) => s.name === name);

describe('readiness probe — a healthy deployment', () => {
  it('reports ready with no failures', async () => {
    const report = await run(HEALTHY);
    assert.strictEqual(report.ready, true, JSON.stringify(report.failures, null, 2));
    assert.strictEqual(report.summary.failed, 0);
    assert.ok(report.summary.total >= 10, 'the probe must actually check things');
  });

  it('accepts a matching expected commit', async () => {
    const report = await run(HEALTHY, { expectedCommit: 'abc123def4567' });
    assert.strictEqual(report.ready, true);
  });
});

describe('readiness probe — the stale deploy it was built for', () => {
  it('fails when the live commit differs from the expected one', async () => {
    const report = await run(HEALTHY, { expectedCommit: '770654bbcae6' });
    assert.strictEqual(report.ready, false);
    const step = stepNamed(report, 'deploy/fresh');
    assert.strictEqual(step.ok, false);
    assert.match(step.fix, /deploy did not take/i);
    assert.match(step.fix, /OLD build/,
      'the operator must be told the rest of the report describes the wrong build');
  });

  it('fails when the build is not commit-stamped at all', async () => {
    const report = await run({ ...HEALTHY, '/api/platform-status': { status: 200, body: JSON.stringify({ commit: 'unknown' }) } });
    assert.strictEqual(report.ready, false);
    assert.match(stepNamed(report, 'deploy/stamped').fix, /npm run build|GIT_COMMIT/);
  });

  it('fails when a customer surface 404s', async () => {
    const report = await run({ ...HEALTHY, '/billing': { status: 404, body: '' } });
    assert.strictEqual(report.ready, false);
    assert.match(stepNamed(report, 'surface/billing').fix, /stale deploy/i);
  });
});

// ---------------------------------------------------------------------------
// The 2026-08-16 outage: everything green, product dead.
// ---------------------------------------------------------------------------
// For ten days and ~480 scheduled runs this probe reported production 10/11
// healthy while the free scan returned "appears to be empty or unreachable"
// for every repo on earth. Three separate blind spots let that through, and
// each one gets a test here so it cannot reopen.

describe('readiness probe — a set-but-wrong secret (the 401 that hid for 10 days)', () => {
  it('fails on invalid_placeholders even when nothing is MISSING', async () => {
    // The precise shape of the miss: `missing_required` is empty because the
    // var IS set — it just holds the documentation example. The old probe
    // printed "all required env vars set" and moved on.
    const report = await run({
      ...HEALTHY,
      '/api/status': {
        status: 200,
        body: JSON.stringify({
          missing_required: [], missing_important: [],
          invalid_placeholders: [{ name: 'GATETEST_PRIVATE_KEY', reason: 'contains documentation filler' }],
        }),
      },
    });
    assert.strictEqual(report.ready, false, 'a placeholder secret must fail the probe');
    assert.strictEqual(stepNamed(report, 'config/required').ok, true, 'nothing is missing — that is the trap');
    const step = stepNamed(report, 'config/placeholders');
    assert.strictEqual(step.ok, false);
    assert.strictEqual(step.severity, 'critical');
    assert.match(step.detail, /GATETEST_PRIVATE_KEY/);
    assert.match(step.fix, /SET but holds the example value/i);
  });

  it('passes when the field is present and empty', async () => {
    const report = await run({
      ...HEALTHY,
      '/api/status': { status: 200, body: JSON.stringify({ missing_required: [], missing_important: [], invalid_placeholders: [] }) },
    });
    assert.strictEqual(stepNamed(report, 'config/placeholders').ok, true);
  });
});

describe('readiness probe — build age (a 10-day-old build is not "fresh")', () => {
  const stamped = (daysAgo) => ({
    ...HEALTHY,
    '/api/platform-status': {
      status: 200,
      body: JSON.stringify({
        commit: 'abc123def4567', version: '1.61.0',
        builtAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      }),
    },
  });

  it('fails a build older than the critical ceiling', async () => {
    // The real number on 2026-08-16 was 9.6 days, reported green.
    const report = await run(stamped(9.6));
    assert.strictEqual(report.ready, false);
    const step = stepNamed(report, 'deploy/fresh');
    assert.strictEqual(step.ok, false);
    assert.strictEqual(step.severity, 'critical');
    assert.match(step.detail, /9\.6 days old/);
    assert.match(step.fix, /BOX_SSH_KEY/, 'name the actual reason deploys stopped landing');
  });

  it('warns — but does not fail — in the grey zone', async () => {
    const report = await run(stamped(3));
    assert.strictEqual(report.ready, true, 'a quiet few days is not an outage');
    const step = stepNamed(report, 'deploy/fresh');
    assert.strictEqual(step.ok, false);
    assert.strictEqual(step.severity, 'warning');
  });

  it('passes a recent build and reports its age', async () => {
    const report = await run(stamped(0.2));
    assert.strictEqual(stepNamed(report, 'deploy/fresh').ok, true);
    assert.match(stepNamed(report, 'deploy/fresh').detail, /0\.2d old/);
  });

  it('does not invent an age when the build carries no timestamp', async () => {
    const report = await run(HEALTHY); // no builtAt at all
    assert.strictEqual(stepNamed(report, 'deploy/fresh').ok, true);
  });
});

// ---------------------------------------------------------------------------
// issue #683: a stale deploy that LOOKS fresh — production sat five merges
// behind origin/main and reported "commit 7026fbec, 0.4d old" because the
// build genuinely was young; the box just never redeployed for the ten
// hours after. Age cannot see that. The probe runs in Actions with the
// repo checked out, so deploy/fresh now compares the live commit against
// origin/main via a stubbed git adapter here — no real git or network.
// ---------------------------------------------------------------------------
describe('readiness probe — deploy/fresh compares against origin/main (issue #683)', () => {
  /**
   * Stub deployAdapter(args) -> trimmed stdout, or throws.
   * `mainSha` answers `rev-parse origin/main`; `ancestor: false` makes the
   * cat-file/merge-base checks fail (a hotfix or rollback not reachable
   * from main); `commits` are the unshipped commits, OLDEST FIRST, as
   * { sha, subject, minutesAgo }.
   */
  function stubDeployAdapter({ mainSha, ancestor = true, commits = [] } = {}) {
    return (args) => {
      const cmd = args[0];
      if (cmd === 'fetch') return '';
      if (cmd === 'rev-parse' && args[1] === 'origin/main') return mainSha;
      if (cmd === 'cat-file') {
        if (!ancestor) throw new Error('unknown revision');
        return '';
      }
      if (cmd === 'merge-base') {
        if (!ancestor) throw new Error('not an ancestor');
        return '';
      }
      if (cmd === 'log') {
        return commits
          .map((c) => `${c.sha}\x1f${c.subject}\x1f${new Date(Date.now() - c.minutesAgo * 60_000).toISOString()}`)
          .join('\n');
      }
      throw new Error(`unstubbed adapter call: ${args.join(' ')}`);
    };
  }

  it('passes when the live commit equals origin/main', async () => {
    const report = await run(HEALTHY, {
      deployAdapter: stubDeployAdapter({ mainSha: 'abc123def4567' }),
    });
    assert.strictEqual(report.ready, true);
    const step = stepNamed(report, 'deploy/fresh');
    assert.strictEqual(step.ok, true);
    assert.match(step.detail, /matches origin\/main/);
  });

  it('passes when one commit behind and it merged minutes ago (grace window)', async () => {
    const report = await run(HEALTHY, {
      deployAdapter: stubDeployAdapter({
        mainSha: 'fff000111222',
        commits: [{ sha: 'fff000111222', subject: 'Bump version', minutesAgo: 5 }],
      }),
    });
    assert.strictEqual(report.ready, true);
    const step = stepNamed(report, 'deploy/fresh');
    assert.strictEqual(step.ok, true);
    assert.match(step.detail, /1 commit behind main \(within grace\)/);
  });

  it('warns when behind by a few commits but not yet a long outage', async () => {
    const report = await run(HEALTHY, {
      deployAdapter: stubDeployAdapter({
        mainSha: 'zzz999888777',
        commits: [
          { sha: 'aaa111222333', subject: 'Fix typo in footer', minutesAgo: 45 },
          { sha: 'bbb222333444', subject: 'Add pricing anchor test', minutesAgo: 20 },
          { sha: 'zzz999888777', subject: 'Bump changelog', minutesAgo: 5 },
        ],
      }),
    });
    assert.strictEqual(report.ready, true, 'a warning must not fail the probe');
    const step = stepNamed(report, 'deploy/fresh');
    assert.strictEqual(step.ok, false);
    assert.strictEqual(step.severity, 'warning');
    assert.match(step.detail, /production is 3 commits behind main/);
    assert.match(step.detail, /oldest unshipped: aaa111222333 Fix typo in footer, merged 45 minutes ago/);
  });

  it('is critical for the exact issue #683 scenario — a young build that is five merges behind', async () => {
    const routes = {
      ...HEALTHY,
      '/api/platform-status': {
        status: 200,
        body: JSON.stringify({
          commit: '7026fbecaaaa', version: '1.61.1',
          builtAt: new Date(Date.now() - 0.4 * 86_400_000).toISOString(),
        }),
      },
    };
    const commits = [];
    for (let i = 0; i < 5; i++) {
      commits.push({ sha: `merge${i}00000000`, subject: `Merge PR #${500 + i}`, minutesAgo: 600 - i * 10 });
    }
    const report = await run(routes, {
      deployAdapter: stubDeployAdapter({ mainSha: commits[commits.length - 1].sha, commits }),
    });
    assert.strictEqual(report.ready, false);
    const step = stepNamed(report, 'deploy/fresh');
    assert.strictEqual(step.ok, false);
    assert.strictEqual(step.severity, 'critical');
    assert.match(step.detail, /production is 5 commits behind main/);
    assert.match(step.detail, /0\.4d old/, 'the age fact must still be printed as a second fact');
    assert.match(step.fix, /Merge PR #500/, 'the operator needs the list of unshipped merges');
  });

  it('says "not an ancestor" instead of counting when live is a hotfix or rollback', async () => {
    const report = await run(HEALTHY, {
      deployAdapter: stubDeployAdapter({ mainSha: 'deadbeef0000', ancestor: false }),
    });
    assert.strictEqual(report.ready, true, 'a hotfix/rollback ambiguity is a warning, not a probe failure');
    const step = stepNamed(report, 'deploy/fresh');
    assert.strictEqual(step.ok, false);
    assert.strictEqual(step.severity, 'warning');
    assert.match(step.detail, /is not an ancestor of origin\/main/);
    assert.match(step.fix, /hotfix/i);
    assert.match(step.fix, /rollback/i);
  });

  it('prints the last deploy time when platform-status exposes it, else says unknown', async () => {
    const withDeployedAt = await run({
      ...HEALTHY,
      '/api/platform-status': { status: 200, body: JSON.stringify({ commit: 'abc123def4567', version: '1.61.1', deployedAt: '2026-09-22T01:39:00Z' }) },
    }, { deployAdapter: stubDeployAdapter({ mainSha: 'abc123def4567' }) });
    assert.match(stepNamed(withDeployedAt, 'deploy/fresh').detail, /last deploy 2026-09-22T01:39:00Z/);

    const withoutDeployedAt = await run(HEALTHY, { deployAdapter: stubDeployAdapter({ mainSha: 'abc123def4567' }) });
    assert.match(stepNamed(withoutDeployedAt, 'deploy/fresh').detail, /last deploy time unknown/);
  });

  it('falls back to the age-only signal when no adapter is available at all', async () => {
    // No deployAdapter passed — this is the pre-#683 behaviour, still
    // exercised so a caller without a git checkout (e.g. a laptop run
    // against a raw URL) still gets a signal instead of a crash.
    const report = await run(HEALTHY);
    const step = stepNamed(report, 'deploy/fresh');
    assert.strictEqual(step.ok, true);
  });
});

describe('readiness probe — does the product actually work?', () => {
  it('fails when the free scan calls a known-good repo empty (the exact 2026-08-16 symptom)', async () => {
    const report = await run({
      ...HEALTHY,
      'POST /api/scan/preview': {
        status: 404,
        body: JSON.stringify({ ok: false, error: 'ccantynz-alt/GateTest appears to be empty or unreachable' }),
      },
    });
    assert.strictEqual(report.ready, false);
    const step = stepNamed(report, 'product/scan');
    assert.strictEqual(step.ok, false);
    assert.strictEqual(step.severity, 'critical');
    // The operator must be pointed at the credential, not at the repo.
    assert.match(step.fix, /dead GitHub credential/i);
  });

  it('passes the REAL /api/scan/preview shape — moduleSummary + findings, no "modules"/"filesScanned" keys', async () => {
    // The live endpoint answers { moduleSummary, findings, total }. Reading
    // only { modules, filesScanned } made a healthy funnel read as "scanned
    // nothing" the moment it came back (2026-08-18).
    const report = await run({
      ...HEALTHY,
      'POST /api/scan/preview': { status: 200, body: JSON.stringify({ ok: true, repo: 'ccantynz-alt/GateTest', moduleSummary: [{ module: 'syntax', status: 'passed', issues: 0 }, { module: 'codeQuality', status: 'failed', issues: 2 }], findings: [{ module: 'codeQuality', severity: 'warning', message: 'x' }], total: 2 }) },
    });
    const step = stepNamed(report, 'product/scan');
    assert.strictEqual(step.ok, true, JSON.stringify(step));
  });

  it('fails a 200 that scanned nothing — success status, empty result', async () => {
    const report = await run({
      ...HEALTHY,
      'POST /api/scan/preview': { status: 200, body: JSON.stringify({ ok: true, modules: [], filesScanned: 0 }) },
    });
    assert.strictEqual(report.ready, false);
    assert.match(stepNamed(report, 'product/scan').detail, /scanned nothing/i);
  });

  it('does NOT cry wolf when the probe merely rate-limited itself', async () => {
    // Self-inflicted throttling is not a product defect. A monitor that
    // reports its own impatience as an outage gets muted, and a muted
    // monitor is worse than none.
    const report = await run({
      ...HEALTHY,
      'POST /api/scan/preview': { status: 429, body: JSON.stringify({ error: 'rate limit — wait 10 seconds between previews' }) },
    });
    assert.strictEqual(report.ready, true);
    assert.strictEqual(stepNamed(report, 'product/scan').ok, true);
  });

  it('flags productBroken separately so a new break is legible inside a familiar red', async () => {
    // This probe has run red for 100 consecutive scheduled runs over unset
    // env vars. "10/11 passed" reads as almost-fine whether the failure is a
    // missing optional key or a dead funnel; the summary must distinguish.
    const configOnly = await run({
      ...HEALTHY,
      '/api/status': { status: 200, body: JSON.stringify({ missing_required: [], missing_important: [{ name: 'RESEND_API_KEY' }] }) },
    });
    assert.strictEqual(configOnly.ready, false);
    assert.strictEqual(configOnly.summary.productBroken, false, 'misconfigured is not the same as broken');
    assert.deepStrictEqual(configOnly.summary.brokenAreas, ['config']);

    const productDown = await run({
      ...HEALTHY,
      'POST /api/scan/preview': { status: 500, body: JSON.stringify({ ok: false, error: 'boom' }) },
    });
    assert.strictEqual(productDown.summary.productBroken, true);
    assert.ok(productDown.summary.brokenAreas.includes('product'));
  });

  it('can be skipped for environments where running a scan is not free', async () => {
    const report = await run(HEALTHY, { skipProductCheck: true });
    assert.strictEqual(stepNamed(report, 'product/scan'), undefined);
  });
});

describe('readiness probe — silent-degradation checks', () => {
  it('treats a missing IMPORTANT env var as critical, not cosmetic', async () => {
    // These do not break the site — they break a feature someone paid for,
    // while money keeps changing hands. That is worse than an outage.
    const report = await run({
      ...HEALTHY,
      '/api/status': { status: 200, body: JSON.stringify({ missing_required: [], missing_important: [{ name: 'RESEND_API_KEY' }] }) },
    });
    assert.strictEqual(report.ready, false);
    const step = stepNamed(report, 'config/important');
    assert.strictEqual(step.severity, 'critical');
    assert.match(step.detail, /RESEND_API_KEY/);
  });

  it('fails a cron endpoint that 405s the scheduler', async () => {
    const report = await run({ ...HEALTHY, 'POST /api/watches/tick': { status: 405, body: '' } });
    assert.strictEqual(report.ready, false);
    assert.match(stepNamed(report, 'cron/api/watches/tick[POST]').fix, /silently fails while reporting success/);
  });

  it('fails a cron endpoint answering 200 unauthenticated — and names BOTH causes', async () => {
    // The probe cannot tell "publicly triggerable" from "documentation stub"
    // from outside. Its first draft asserted the scarier one and was wrong
    // about /api/scan/worker/tick, which was a doc stub. Say both.
    const report = await run({ ...HEALTHY, 'GET /api/scan/worker/tick': { status: 200, body: '{"ok":true}' } });
    assert.strictEqual(report.ready, false);
    const fix = stepNamed(report, 'cron/api/scan/worker/tick[GET]').fix;
    assert.match(fix, /publicly triggerable/);
    assert.match(fix, /documentation stub/);
  });
});

describe('readiness probe — content checks, not just status codes', () => {
  it('fails a 200 page whose content has been gutted', async () => {
    // Pricing is a SECTION on the home page, not a route. A 200 alone would
    // not notice the anchor disappearing.
    const report = await run({ ...HEALTHY, '/': { status: 200, body: '<html>nothing here</html>' } });
    assert.strictEqual(report.ready, false);
    assert.match(stepNamed(report, 'surface/').detail, /missing id="pricing"/);
  });

  it('does not probe /pricing — it is an anchor, never a route', async () => {
    // The probe's own first run flagged /pricing as a stale-deploy 404. It
    // was a bug in the PROBE: website/app/pricing/ has never existed. A
    // monitor that cries wolf gets muted.
    assert.ok(!DEFAULT_SURFACES.some((s) => s.path === '/pricing'));
  });
});

describe('readiness probe — robustness', () => {
  it('a network failure is a reported step, never a crash', async () => {
    const report = await run({ ...HEALTHY, '/api/platform-status': { throws: 'ECONNREFUSED' } });
    assert.strictEqual(report.ready, false);
    assert.match(stepNamed(report, 'deploy/reachable').detail, /ECONNREFUSED/);
  });

  it('non-JSON from a JSON endpoint is reported, not parsed blindly', async () => {
    const report = await run({ ...HEALTHY, '/api/platform-status': { status: 200, body: '<html>proxy error</html>' } });
    assert.strictEqual(report.ready, false);
    assert.match(stepNamed(report, 'deploy/reachable').detail, /non-JSON/);
  });

  it('requires a baseUrl', async () => {
    await assert.rejects(() => runReadinessProbe({ fetchFn: stubFetch({}) }), /baseUrl is required/);
  });

  it('every failed step carries a fix, not just a red mark', async () => {
    const report = await run({
      ...HEALTHY,
      '/billing': { status: 404, body: '' },
      'POST /api/watches/tick': { status: 405, body: '' },
    });
    for (const f of report.failures) {
      assert.ok(f.fix && f.fix.length > 20, `${f.name} failed without telling the operator what to do`);
    }
  });
});
