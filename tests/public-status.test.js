// =============================================================================
// /status — the public summary mapper never lies, never leaks, never throws
// =============================================================================
// website/app/lib/public-status.js turns the readings the internal probes
// already produce into the four-state summary that /status and
// GET /api/status/public render. This pins three properties:
//
//   1. CONTROL PAIRS per state — the reading that MUST flip a component, and
//      the neighbouring reading that must leave it green (Doctrine #3).
//   2. NO LEAK — hostile readings carrying env var names, hostnames, IPs, key
//      prefixes and error text go in; none of it comes out in any string.
//   3. NEVER THROWS — null, garbage, getters that throw, a Proxy that throws
//      on every access: each yields "unknown" for what it broke and the rest
//      of the summary still computes.
//
// And the one hand-written record, website/app/data/incidents.json, validates
// against the schema the page renders.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const lib = require('../website/app/lib/public-status.js');
const {
  COMPONENT_NAMES, STATES, OVERALLS, QUEUE_STALE_SECONDS, WORKER_STALE_SECONDS, UNKNOWN_DETAIL,
  summarisePublicStatus, validateIncidents, recentIncidents, redactIfLeaky, formatAge,
} = lib;

const NOW = Date.parse('2026-09-16T10:00:00Z');
const byName = (summary, name) => {
  const c = summary.components.find((x) => x.name === name);
  assert.ok(c, `component "${name}" missing from summary`);
  return c;
};

/** A fully healthy set of readings — the baseline every control pair starts from. */
function healthy(overrides = {}) {
  return {
    now: NOW,
    build: { version: '1.61.1', commit: 'e101d517abcdef0123456789abcdef0123456789', builtAt: '2026-09-15T01:00:00Z' },
    readiness: { ready: true, missing_required: [], missing_important: [], invalid_placeholders: [], stripe: { mode: 'live' } },
    queue: { queued: 2, running: 1, done: 500, dead: 0, oldest_queued_age_s: 40 },
    worker: { lastActivityAt: '2026-09-16T09:58:00Z' },
    webhooks: { configured: true, lastDeliveryAt: '2026-09-16T09:57:00Z' },
    mcp: { reachable: true, status: 405 },
    payments: { mode: 'live', webhookConfigured: true, production: true },
    ...overrides,
  };
}

// Internal names that must never appear on the public surface. Some are
// planted in the hostile readings below; the rest are here so a future
// template that interpolates the wrong field is caught by name.
const INTERNAL_NAMES = [
  'TALLRIG_API_TOKEN', 'TALLRIG_BASE_URL', 'TALLRIG_DISPATCH_SECRET', 'VAPRON_API_TOKEN',
  'CRON_SECRET', 'DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SESSION_SECRET',
  'GATETEST_PRIVATE_KEY', 'GATETEST_APP_ID', 'GITHUB_WEBHOOK_SECRET', 'GATETEST_INTERNAL_TOKEN',
  'RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'AI_PROVIDER_API_KEY', 'NEXT_PUBLIC_BASE_URL',
  '66.42.', '10.0.1.1', '127.0.0.1', 'neon.tech', 'api.tallrig.com', 'gluecron.com',
  'sk_live_', 'sk_test_', 'whsec_', 're_', '/opt/gatetest', '.env.local', 'ECONNREFUSED', 'timed out',
];

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------
describe('public status — shape', () => {
  it('names every component once, in the documented order, with a valid state and a checkedAt', () => {
    const s = summarisePublicStatus(healthy());
    assert.deepStrictEqual(s.components.map((c) => c.name), [...COMPONENT_NAMES]);
    for (const c of s.components) {
      assert.ok(STATES.includes(c.state), `${c.name}: state "${c.state}"`);
      assert.strictEqual(typeof c.detail, 'string');
      assert.ok(c.detail.length > 0, `${c.name}: empty detail`);
      assert.strictEqual(c.checkedAt, new Date(NOW).toISOString());
    }
    assert.ok(OVERALLS.includes(s.overall));
    assert.strictEqual(s.checkedAt, new Date(NOW).toISOString());
  });

  it('healthy readings → every component operational, overall operational', () => {
    const s = summarisePublicStatus(healthy());
    assert.deepStrictEqual(s.components.map((c) => c.state), COMPONENT_NAMES.map(() => 'operational'));
    assert.strictEqual(s.overall, 'operational');
    assert.match(s.headline, /^All systems operational\.$/);
  });

  it('carries the build stamp: version, SHORT commit, ISO builtAt', () => {
    const s = summarisePublicStatus(healthy());
    assert.strictEqual(s.version, '1.61.1');
    assert.strictEqual(s.commit, 'e101d517');
    assert.strictEqual(s.builtAt, '2026-09-15T01:00:00.000Z');
  });

  it('a commit that is not hex, or missing, reads "unknown" — never echoed', () => {
    assert.strictEqual(summarisePublicStatus(healthy({ build: { version: '1.0.0', commit: 'TALLRIG_API_TOKEN=abc' } })).commit, 'unknown');
    assert.strictEqual(summarisePublicStatus(healthy({ build: {} })).commit, 'unknown');
    assert.strictEqual(summarisePublicStatus(healthy({ build: {} })).version, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// Control pairs
// ---------------------------------------------------------------------------
describe('Hosted scans — queue posture', () => {
  it('dead > 0 → degraded; dead = 0 → operational', () => {
    assert.strictEqual(byName(summarisePublicStatus(healthy({ queue: { queued: 0, running: 0, dead: 1, oldest_queued_age_s: null } })), 'Hosted scans').state, 'degraded');
    assert.strictEqual(byName(summarisePublicStatus(healthy({ queue: { queued: 0, running: 0, dead: 0, oldest_queued_age_s: null } })), 'Hosted scans').state, 'operational');
  });

  it(`oldest_queued_age_s > ${QUEUE_STALE_SECONDS} → degraded; exactly at the ceiling → operational`, () => {
    assert.strictEqual(byName(summarisePublicStatus(healthy({ queue: { queued: 3, running: 0, dead: 0, oldest_queued_age_s: QUEUE_STALE_SECONDS + 1 } })), 'Hosted scans').state, 'degraded');
    assert.strictEqual(byName(summarisePublicStatus(healthy({ queue: { queued: 3, running: 0, dead: 0, oldest_queued_age_s: QUEUE_STALE_SECONDS } })), 'Hosted scans').state, 'operational');
  });

  it('the detail carries the counts a customer can act on, and nothing else', () => {
    const c = byName(summarisePublicStatus(healthy({ queue: { queued: 4, running: 2, dead: 0, oldest_queued_age_s: 10 } })), 'Hosted scans');
    assert.strictEqual(c.detail, '4 queued, 2 running, none stuck.');
  });

  it('queue reading errored → unknown, with the generic sentence (no error text)', () => {
    const c = byName(summarisePublicStatus(healthy({ queue: { error: 'queue stats timed out (2s) DATABASE_URL 66.42.1.2' } })), 'Hosted scans');
    assert.strictEqual(c.state, 'unknown');
    assert.strictEqual(c.detail, UNKNOWN_DETAIL);
  });
});

describe('Scan worker — heartbeat inferred from the queue', () => {
  it('jobs waiting past the ceiling → down (even with recent activity); the same queue with a fresh oldest job → operational', () => {
    const stuck = healthy({ queue: { queued: 2, running: 0, dead: 0, oldest_queued_age_s: QUEUE_STALE_SECONDS + 60 } });
    assert.strictEqual(byName(summarisePublicStatus(stuck), 'Scan worker').state, 'down');
    const fresh = healthy({ queue: { queued: 2, running: 0, dead: 0, oldest_queued_age_s: 30 } });
    assert.strictEqual(byName(summarisePublicStatus(fresh), 'Scan worker').state, 'operational');
    assert.match(byName(summarisePublicStatus(fresh), 'Scan worker').detail, /^Processing — last job activity 2 min ago\.$/);
  });

  it('an empty queue with past activity → operational (idle); no activity ever → unknown, said plainly', () => {
    const idle = healthy({ queue: { queued: 0, running: 0, dead: 0, oldest_queued_age_s: null } });
    assert.strictEqual(byName(summarisePublicStatus(idle), 'Scan worker').state, 'operational');
    assert.match(byName(summarisePublicStatus(idle), 'Scan worker').detail, /^Idle — last job activity/);
    const never = healthy({ queue: { queued: 0, running: 0, dead: 0, oldest_queued_age_s: null }, worker: { lastActivityAt: null } });
    assert.strictEqual(byName(summarisePublicStatus(never), 'Scan worker').state, 'unknown');
    assert.strictEqual(byName(summarisePublicStatus(never), 'Scan worker').detail, 'No jobs processed yet on this deployment.');
  });

  it('worker reading errored → unknown', () => {
    assert.strictEqual(byName(summarisePublicStatus(healthy({ worker: { error: true } })), 'Scan worker').state, 'unknown');
  });

  it('issue #678 defect 4: an empty queue with NO activity for 12 days reads unknown, never a confident operational', () => {
    const twelveDaysAgo = new Date(NOW - 12 * 24 * 60 * 60 * 1000).toISOString();
    const stale = healthy({
      queue: { queued: 0, running: 0, dead: 0, oldest_queued_age_s: null },
      worker: { lastActivityAt: twelveDaysAgo },
    });
    const c = byName(summarisePublicStatus(stale), 'Scan worker');
    assert.strictEqual(c.state, 'unknown');
    assert.match(c.detail, /cannot tell a quiet period from a stopped worker/);
    // Control: just under the ceiling, with an otherwise-empty queue, still reads operational.
    const justUnderCeiling = new Date(NOW - (WORKER_STALE_SECONDS - 60) * 1000).toISOString();
    const stillIdle = healthy({
      queue: { queued: 0, running: 0, dead: 0, oldest_queued_age_s: null },
      worker: { lastActivityAt: justUnderCeiling },
    });
    assert.strictEqual(byName(summarisePublicStatus(stillIdle), 'Scan worker').state, 'operational');
  });
});

describe('GitHub App webhooks — last-delivery signal', () => {
  it('a recorded delivery → operational with its age; configured but nothing recorded → unknown (never green on faith)', () => {
    const seen = byName(summarisePublicStatus(healthy()), 'GitHub App webhooks');
    assert.strictEqual(seen.state, 'operational');
    assert.strictEqual(seen.detail, 'Last delivery accepted 3 min ago.');
    const none = byName(summarisePublicStatus(healthy({ webhooks: { configured: true, lastDeliveryAt: null } })), 'GitHub App webhooks');
    assert.strictEqual(none.state, 'unknown');
    assert.strictEqual(none.detail, 'Configured; no deliveries recorded yet.');
  });

  it('not configured → degraded', () => {
    assert.strictEqual(byName(summarisePublicStatus(healthy({ webhooks: { configured: false, lastDeliveryAt: null } })), 'GitHub App webhooks').state, 'degraded');
  });
});

describe('API — configuration readiness', () => {
  it('missing_required non-empty → down; empty → operational', () => {
    const down = healthy({ readiness: { ready: false, missing_required: [{ name: 'DATABASE_URL', why: 'no scan results persist' }], missing_important: [], invalid_placeholders: [] } });
    const c = byName(summarisePublicStatus(down), 'API');
    assert.strictEqual(c.state, 'down');
    assert.ok(!c.detail.includes('DATABASE_URL'), c.detail);
    assert.strictEqual(byName(summarisePublicStatus(healthy()), 'API').state, 'operational');
  });

  it('only important vars missing or placeholders present → degraded with a COUNT, no names', () => {
    const r = healthy({ readiness: { ready: true, missing_required: [], missing_important: [{ name: 'TALLRIG_API_TOKEN' }, { name: 'CRON_SECRET' }], invalid_placeholders: [{ name: 'GATETEST_PRIVATE_KEY', reason: 'documentation example' }] } });
    const c = byName(summarisePublicStatus(r), 'API');
    assert.strictEqual(c.state, 'degraded');
    assert.strictEqual(c.detail, 'Responding; 3 optional integrations are not fully configured.');
  });

  it('readiness errored or malformed → unknown', () => {
    assert.strictEqual(byName(summarisePublicStatus(healthy({ readiness: { error: 'HTTP 502' } })), 'API').state, 'unknown');
    assert.strictEqual(byName(summarisePublicStatus(healthy({ readiness: { ready: true } })), 'API').state, 'unknown');
  });
});

describe('MCP hosted endpoint — reachability', () => {
  it('reachable (405 with the JSON body) → operational; 5xx → down; 404 → down; other → degraded', () => {
    assert.strictEqual(byName(summarisePublicStatus(healthy({ mcp: { reachable: true, status: 405 } })), 'MCP hosted endpoint').state, 'operational');
    assert.strictEqual(byName(summarisePublicStatus(healthy({ mcp: { reachable: false, status: 502 } })), 'MCP hosted endpoint').state, 'down');
    assert.strictEqual(byName(summarisePublicStatus(healthy({ mcp: { reachable: false, status: 404 } })), 'MCP hosted endpoint').state, 'down');
    assert.strictEqual(byName(summarisePublicStatus(healthy({ mcp: { reachable: false, status: 401 } })), 'MCP hosted endpoint').state, 'degraded');
  });
  it('network failure → unknown, not down (we could not reach it from here; a client might)', () => {
    assert.strictEqual(byName(summarisePublicStatus(healthy({ mcp: { error: 'fetch failed ECONNREFUSED 10.0.1.1:3000' } })), 'MCP hosted endpoint').state, 'unknown');
  });
});

describe('Payments — Stripe mode, never a key', () => {
  it('live + webhook → operational', () => {
    const c = byName(summarisePublicStatus(healthy()), 'Payments');
    assert.strictEqual(c.state, 'operational');
    assert.strictEqual(c.detail, 'Checkout and subscription updates working.');
  });
  it('live without webhook → degraded (subscription updates)', () => {
    assert.strictEqual(byName(summarisePublicStatus(healthy({ payments: { mode: 'live', webhookConfigured: false, production: true } })), 'Payments').state, 'degraded');
  });
  it('test mode in production → degraded; test mode outside production → operational', () => {
    assert.strictEqual(byName(summarisePublicStatus(healthy({ payments: { mode: 'test', webhookConfigured: true, production: true } })), 'Payments').state, 'degraded');
    assert.strictEqual(byName(summarisePublicStatus(healthy({ payments: { mode: 'test', webhookConfigured: true, production: false } })), 'Payments').state, 'operational');
  });
  it('unset → down; unrecognised mode → unknown', () => {
    assert.strictEqual(byName(summarisePublicStatus(healthy({ payments: { mode: 'unset', webhookConfigured: false, production: true } })), 'Payments').state, 'down');
    assert.strictEqual(byName(summarisePublicStatus(healthy({ payments: { mode: 'sk_live_abc', webhookConfigured: true, production: true } })), 'Payments').state, 'unknown');
  });
});

describe('overall', () => {
  it('any down → major; else any degraded → partial; else operational; all unknown → unknown', () => {
    assert.strictEqual(summarisePublicStatus(healthy({ payments: { mode: 'unset' }, queue: { dead: 3 } })).overall, 'major');
    assert.strictEqual(summarisePublicStatus(healthy({ queue: { queued: 0, running: 0, dead: 3 } })).overall, 'partial');
    assert.strictEqual(summarisePublicStatus(healthy()).overall, 'operational');
    assert.strictEqual(summarisePublicStatus(null).overall, 'unknown');
  });
  it('unknown components do not downgrade the overall but are counted in the headline', () => {
    const s = summarisePublicStatus(healthy({ mcp: { error: true }, worker: { error: true } }));
    assert.strictEqual(s.overall, 'operational');
    assert.strictEqual(s.headline, 'All systems operational. 2 components could not be verified.');
  });
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------
describe('never throws', () => {
  it('null / undefined / a string / an array → an all-unknown summary, still shaped', () => {
    for (const input of [null, undefined, 'status', 42, [], () => {}]) {
      const s = summarisePublicStatus(input);
      assert.strictEqual(s.components.length, COMPONENT_NAMES.length, `input ${String(input)}`);
      // Website is the one component whose evidence is "this code ran".
      for (const c of s.components) {
        if (c.name === 'Website') assert.strictEqual(c.state, 'operational');
        else assert.strictEqual(c.state, 'unknown', `${c.name} on input ${String(input)}`);
      }
      assert.strictEqual(s.commit, 'unknown');
    }
  });

  it('a getter that throws on one reading poisons only that component', () => {
    const readings = healthy();
    Object.defineProperty(readings, 'queue', { get() { throw new Error('boom DATABASE_URL'); }, enumerable: true });
    const s = summarisePublicStatus(readings);
    assert.strictEqual(byName(s, 'Hosted scans').state, 'unknown');
    assert.strictEqual(byName(s, 'Payments').state, 'operational');
    assert.strictEqual(byName(s, 'API').state, 'operational');
  });

  it('a Proxy that throws on EVERY access still yields a summary', () => {
    const hostile = new Proxy({}, { get() { throw new Error('TALLRIG_API_TOKEN leaked'); }, has() { throw new Error('no'); }, ownKeys() { throw new Error('no'); } });
    let s;
    assert.doesNotThrow(() => { s = summarisePublicStatus(hostile); });
    assert.strictEqual(s.components.length, COMPONENT_NAMES.length);
    assert.ok(!JSON.stringify(s).includes('TALLRIG'));
  });

  it('a reading whose fields throw on access → that component unknown, no exception', () => {
    const poison = new Proxy({}, { get() { throw new Error('CRON_SECRET'); }, has() { return true; } });
    const s = summarisePublicStatus(healthy({ queue: poison, payments: poison, readiness: poison }));
    assert.strictEqual(byName(s, 'Hosted scans').state, 'unknown');
    assert.strictEqual(byName(s, 'Payments').state, 'unknown');
    assert.strictEqual(byName(s, 'API').state, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// No leak
// ---------------------------------------------------------------------------
describe('no internal name or hostname leaves the mapper', () => {
  const hostile = {
    now: NOW,
    build: { version: '1.61.1 TALLRIG_API_TOKEN=abc', commit: 'sk_live_51H TALLRIG_API_TOKEN', builtAt: 'https://api.tallrig.com/opt/gatetest/.env.local' },
    readiness: {
      ready: false,
      missing_required: [{ name: 'DATABASE_URL', why: 'postgres://user:pw@ep-x.neon.tech/db' }, { name: 'SESSION_SECRET' }],
      missing_important: [{ name: 'TALLRIG_API_TOKEN' }, { name: 'CRON_SECRET' }, { name: 'RESEND_API_KEY' }],
      invalid_placeholders: [{ name: 'GATETEST_PRIVATE_KEY', reason: 'documentation example' }],
      stripe: { mode: 'test', warning: 'Stripe is in TEST mode in production — swap to sk_live_ keys' },
      queue: { error: 'queue stats timed out (2s) — 66.42.1.2:5432' },
    },
    queue: { queued: 'TALLRIG_API_TOKEN', running: '10.0.1.1', dead: 'CRON_SECRET', oldest_queued_age_s: 'whsec_x' },
    worker: { lastActivityAt: 'GATETEST_INTERNAL_TOKEN' },
    webhooks: { configured: 'GITHUB_WEBHOOK_SECRET', lastDeliveryAt: '66.42.1.2' },
    mcp: { reachable: false, status: 'https://gatetest.io/api/mcp ECONNREFUSED 127.0.0.1' },
    payments: { mode: 'sk_test_51Hxxxxx', webhookConfigured: 'whsec_abc', production: 're_ibePuM73' },
  };

  it('every detail, the headline, the version and the commit are free of the planted names', () => {
    const s = summarisePublicStatus(hostile);
    const surface = JSON.stringify(s);
    for (const name of INTERNAL_NAMES) {
      assert.ok(!surface.includes(name), `"${name}" leaked into the public summary: ${surface}`);
    }
    for (const c of s.components) {
      assert.doesNotMatch(c.detail, /[A-Z][A-Z0-9]*_[A-Z0-9_]+/, `${c.name}: env-var-shaped token in "${c.detail}"`);
      assert.doesNotMatch(c.detail, /\d{1,3}(?:\.\d{1,3}){3}/, `${c.name}: IPv4 in "${c.detail}"`);
      assert.doesNotMatch(c.detail, /https?:\/\//, `${c.name}: URL in "${c.detail}"`);
    }
  });

  it('with the hostile readings the states still make sense (down/unknown, never green)', () => {
    const s = summarisePublicStatus(hostile);
    assert.strictEqual(byName(s, 'API').state, 'down');
    for (const name of ['Hosted scans', 'Scan worker', 'GitHub App webhooks', 'Payments']) {
      assert.notStrictEqual(byName(s, name).state, 'operational', `${name} must not be green on garbage`);
    }
  });

  it('POSITIVE CONTROL: redactIfLeaky replaces the shapes the guard exists for, and passes real sentences', () => {
    for (const bad of ['missing TALLRIG_API_TOKEN', 'box 66.42.1.2 unreachable', 'see api.tallrig.com', 'https://x.y/z', 'key sk_live_abc', 'Error: boom', 'read /opt/gatetest/.env']) {
      assert.strictEqual(redactIfLeaky(bad), UNKNOWN_DETAIL, `must redact: ${bad}`);
    }
    for (const good of ['4 queued, 2 running, none stuck.', 'Serving requests on version 1.61.1.', 'Last delivery accepted 3 min ago.', 'Checkout and subscription updates working.']) {
      assert.strictEqual(redactIfLeaky(good), good, `must pass: ${good}`);
    }
    assert.strictEqual(redactIfLeaky(''), UNKNOWN_DETAIL);
    assert.strictEqual(redactIfLeaky(undefined), UNKNOWN_DETAIL);
  });
});

describe('formatAge', () => {
  it('rounds down and never goes negative', () => {
    assert.strictEqual(formatAge(-5000), 'just now');
    assert.strictEqual(formatAge(59_000), 'just now');
    assert.strictEqual(formatAge(60_000), '1 min ago');
    assert.strictEqual(formatAge(3_600_000), '1 h ago');
    assert.strictEqual(formatAge(47 * 3_600_000), '47 h ago');
    assert.strictEqual(formatAge(48 * 3_600_000), '2 days ago');
  });
});

// ---------------------------------------------------------------------------
// incidents.json
// ---------------------------------------------------------------------------
describe('website/app/data/incidents.json', () => {
  const file = path.join(ROOT, 'website', 'app', 'data', 'incidents.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  it('validates: ISO dates, required fields, known components, impact enum, boolean resolved', () => {
    assert.deepStrictEqual(validateIncidents(data), []);
  });

  it('is newest first and every summary is customer-safe', () => {
    const dates = data.incidents.map((i) => Date.parse(i.date));
    for (let i = 1; i < dates.length; i++) assert.ok(dates[i - 1] >= dates[i], 'incidents must be newest first');
    for (const inc of data.incidents) {
      const text = `${inc.title} ${inc.summary}`;
      for (const name of INTERNAL_NAMES) assert.ok(!text.includes(name), `incident "${inc.title}" names "${name}"`);
      assert.doesNotMatch(text, /[A-Z][A-Z0-9]*_[A-Z0-9_]+/, `incident "${inc.title}" carries an env-var-shaped token`);
    }
  });

  it('seeds the two real September 2026 events, both bystander / no-impact', () => {
    const titles = data.incidents.map((i) => i.title.toLowerCase());
    assert.ok(titles.some((t) => t.includes('phishing')), 'the 2026-09-15 e-mail-provider abuse must be recorded');
    assert.ok(titles.some((t) => t.includes('deploy')), 'the 2026-09-16 deploy pause must be recorded');
    for (const inc of data.incidents) {
      assert.strictEqual(inc.impact, 'none');
      assert.strictEqual(inc.resolved, true);
      assert.deepStrictEqual(inc.components, []);
    }
    const phishing = data.incidents.find((i) => i.title.toLowerCase().includes('phishing'));
    assert.match(phishing.summary, /bystander/i, 'the record must say GateTest was a bystander');
  });

  it('POSITIVE CONTROL: the validator rejects each malformed shape', () => {
    const good = { date: '2026-09-15', title: 't', components: ['API'], impact: 'none', resolved: true, summary: 's' };
    assert.deepStrictEqual(validateIncidents([good]), []);
    assert.ok(validateIncidents([{ ...good, date: '15/09/2026' }]).some((p) => /date/.test(p)));
    assert.ok(validateIncidents([{ ...good, components: ['Mail server'] }]).some((p) => /not a known component/.test(p)));
    assert.ok(validateIncidents([{ ...good, impact: 'catastrophic' }]).some((p) => /impact/.test(p)));
    assert.ok(validateIncidents([{ ...good, resolved: 'yes' }]).some((p) => /resolved/.test(p)));
    assert.ok(validateIncidents([{ ...good, summary: '' }]).some((p) => /summary/.test(p)));
    assert.ok(validateIncidents([{ ...good, title: undefined }]).some((p) => /title/.test(p)));
    assert.ok(validateIncidents('nope').length > 0);
    assert.ok(validateIncidents([null]).length > 0);
  });

  it('recentIncidents: inside the 14-day window, newest first; older and malformed entries dropped', () => {
    const list = [
      { date: '2026-08-01', title: 'old' },
      { date: '2026-09-10', title: 'mid' },
      { date: '2026-09-15T00:00:00Z', title: 'new' },
      { date: 'garbage', title: 'bad' },
      null,
    ];
    assert.deepStrictEqual(recentIncidents(list, NOW).map((i) => i.title), ['new', 'mid']);
    assert.deepStrictEqual(recentIncidents({ incidents: list }, NOW).map((i) => i.title), ['new', 'mid']);
    assert.deepStrictEqual(recentIncidents(null, NOW), []);
    assert.deepStrictEqual(recentIncidents(data, Date.parse('2026-12-01T00:00:00Z')), [], 'the seeds age out of the window');
  });
});

// ---------------------------------------------------------------------------
// Wiring — the page and route consume the mapper, the nav and footer link it
// ---------------------------------------------------------------------------
describe('wiring', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('the route and the page both read the ONE cached collector, and the route never 500s', () => {
    const route = read('website/app/api/status/public/route.ts');
    const page = read('website/app/status/page.tsx');
    assert.match(route, /getPublicStatus/);
    assert.match(page, /getPublicStatus/);
    assert.match(route, /catch\s*\{/);
    assert.match(route, /cache-control/i);
  });

  it('the collector calls the readiness route in-process rather than re-typing the REQUIRED list', () => {
    const collector = read('website/app/lib/public-status-collect.ts');
    assert.match(collector, /from "@\/app\/api\/status\/route"/);
    assert.doesNotMatch(collector, /REQUIRED\s*[:=]\s*\[/);
    assert.match(collector, /siteUrl\(/, 'the MCP probe must resolve the origin through site-url');
    assert.doesNotMatch(collector, /https:\/\/gatetest\.(io|ai)/);
  });

  it('/status is in the footer, the Product nav (with the agreed desc) and the sitemap; metadata is "GateTest Status" on /status', () => {
    assert.match(read('website/app/components/Footer.tsx'), /href="\/status"/);
    assert.match(read('website/app/components/site-nav.ts'), /label:\s*"Status",\s*href:\s*"\/status",\s*desc:\s*"Live health of every surface\."/);
    assert.match(read('website/app/sitemap.ts'), /\/status`/);
    const page = read('website/app/status/page.tsx');
    assert.match(page, /title:\s*"GateTest Status"/);
    assert.match(page, /path:\s*"\/status"/);
    assert.match(page, /force-dynamic/);
  });
});
