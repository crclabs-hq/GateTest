// =============================================================================
// CUSTOMER FEEDBACK LOOPS — POST /api/feedback, GET /api/admin/feedback
// =============================================================================
// Craig 2026-09-16: "bad feedback must reach us before it reaches a review
// site." Two loops with no human on our side needed to start them:
//   A. "Was this scan useful?" under every hosted result (ScanFeedback.tsx)
//   B. "Wrong?" on a finding row (FindingWrong.tsx)
// Both POST to /api/feedback; a down rating with text opens a GitHub issue.
//
// Covered here, against the same control-pair discipline as the engine:
//   - redaction: a token and an e-mail are removed, prose is untouched
//   - validation: missing surface / rating → 400
//   - rate-limit decision: the Postgres count feeds lib/rate-limit.js
//   - escalation decision table, row by row
//   - escalation I/O against a fake git host (issue, comment, no credential)
//   - route shape: the API returns 400/503, the admin route returns 401
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { redactFeedbackText, validateFeedbackBody, MAX_TEXT_LEN } = require('../website/app/lib/feedback-redact');
const store = require('../website/app/lib/feedback-store');
const esc = require('../website/app/lib/feedback-escalation');
const { RateLimiter, PRESETS } = require('../lib/rate-limit');

/** Neon-shaped tagged template that records calls and replays canned rows. */
function makeFakeSql(responses = []) {
  const calls = [];
  const queue = [...responses];
  const sql = (strings, ...values) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(queue.length ? queue.shift() : []);
  };
  return { sql, calls };
}

/** fetch-shaped fake git host; `handler(url, opts)` returns { status, data }. */
function makeFakeGithub(handler) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method || 'GET', body, headers: opts.headers || {} });
    const { status, data } = handler(url, opts, body);
    return { status, json: async () => data };
  };
  return { calls, fetchImpl };
}

const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // fixture, not a credential

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('feedback redaction', () => {
  it('removes a token and an e-mail address from free text', () => {
    const out = redactFeedbackText(`the CSP rule is wrong, key ${TOKEN} — mail me at craig@example.com please`);
    assert.ok(!out.includes('ghp_'), `token survived: ${out}`);
    assert.ok(!out.includes('@example.com'), `e-mail survived: ${out}`);
    assert.match(out, /\[redacted\]/);
    assert.match(out, /\[redacted-email\]/);
    assert.match(out, /^the CSP rule is wrong/);
  });

  it('removes the other credential shapes the secrets module knows by value', () => {
    for (const secret of [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'sk_live_' + 'abcdefghijklmnopqrstuvwx',
      'AKIA' + 'ABCDEFGHIJKLMNOP',
      'xoxb-' + '123456789012-abcdefghijkl',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'github_pat_' + '11ABCDEFG0abcdefghijklmnopqrstuvwxyz',
    ]) {
      const out = redactFeedbackText(`see ${secret} here`);
      assert.strictEqual(out, 'see [redacted] here', secret);
    }
  });

  it('redacts identifier-keyed values, URL userinfo and PEM blocks', () => {
    assert.strictEqual(redactFeedbackText('password=hunter22 broke'), 'password=[redacted] broke');
    assert.strictEqual(redactFeedbackText('db is postgres://admin:s3cret@db.internal/x'), 'db is postgres://[redacted]@db.internal/x');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----';
    assert.strictEqual(redactFeedbackText(`key ${pem} end`), 'key [redacted] end');
  });

  it('CONTROL: ordinary feedback is untouched', () => {
    const prose = 'The missing-csp finding is wrong, we set frame-ancestors on every page since v2.';
    assert.strictEqual(redactFeedbackText(prose), prose);
    assert.strictEqual(redactFeedbackText('Scan took 40s on a 3-file repo, felt slow.'), 'Scan took 40s on a 3-file repo, felt slow.');
  });

  it('caps at 1,000 chars and returns null for empty / non-string input', () => {
    assert.ok(redactFeedbackText('word '.repeat(600)).length <= MAX_TEXT_LEN);
    assert.strictEqual(redactFeedbackText('   '), null);
    assert.strictEqual(redactFeedbackText(42), null);
    assert.strictEqual(redactFeedbackText(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// Validation — the 400s
// ---------------------------------------------------------------------------

describe('feedback body validation', () => {
  it('rejects a missing surface with 400', () => {
    const r = validateFeedbackBody({ rating: 'up' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400);
    assert.match(r.error, /surface/);
  });

  it('rejects a missing rating with 400', () => {
    const r = validateFeedbackBody({ surface: 'web' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400);
    assert.match(r.error, /rating/);
  });

  it('rejects an unknown rating, a bad surface and a non-object body', () => {
    assert.strictEqual(validateFeedbackBody({ surface: 'web', rating: 'meh' }).ok, false);
    assert.strictEqual(validateFeedbackBody({ surface: 'Web Scan!', rating: 'up' }).ok, false);
    assert.strictEqual(validateFeedbackBody(null).status, 400);
    assert.strictEqual(validateFeedbackBody([]).status, 400);
    assert.strictEqual(validateFeedbackBody('up').status, 400);
  });

  it('CONTROL: a valid body is normalised, redacted and stripped of the query string', () => {
    const r = validateFeedbackBody({
      surface: 'Finding', rating: 'DOWN', tier: 'quick', scanId: 'scn_1',
      rule: 'security:eval', text: `wrong, ${TOKEN}`, page: '/scan/status?session_id=cs_test_123',
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(
      { ...r.event, text: undefined },
      { surface: 'finding', rating: 'down', tier: 'quick', scanId: 'scn_1', rule: 'security:eval', page: '/scan/status', text: undefined },
    );
    assert.ok(!r.event.text.includes('ghp_'));
  });

  it('drops a rule that is not module / module:rule instead of rejecting the event', () => {
    const r = validateFeedbackBody({ surface: 'finding', rating: 'down', rule: '../etc/passwd', text: 'x' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.event.rule, null);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit decision — Postgres count layered on lib/rate-limit.js
// ---------------------------------------------------------------------------

describe('feedback rate limit', () => {
  it('has a preset that stays below publicApi', () => {
    assert.ok(PRESETS.feedback && PRESETS.feedback.maxRequests > 0);
    assert.ok(PRESETS.feedback.maxRequests < PRESETS.publicApi.maxRequests);
  });

  it('blocks when the database count is over the limit even on a cold instance', async () => {
    const rl = new RateLimiter({ ...PRESETS.feedback, now: () => 1_000, dbBackedFn: async () => ({ count: PRESETS.feedback.maxRequests + 1, ttl: 5_000 }) });
    const r = await rl.check('203.0.113.9');
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.source, 'merged');
  });

  it('CONTROL: allows when the database count is under the limit', async () => {
    const rl = new RateLimiter({ ...PRESETS.feedback, now: () => 1_000, dbBackedFn: async () => ({ count: 3, ttl: 5_000 }) });
    assert.strictEqual((await rl.check('203.0.113.9')).allowed, true);
  });

  it('falls back to the in-process count when the database is unavailable', async () => {
    const rl = new RateLimiter({ ...PRESETS.feedback, now: () => 1_000, dbBackedFn: async () => { throw new Error('no db'); } });
    const r = await rl.check('203.0.113.9');
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.source, 'memory');
  });

  it('countRecentByIp counts this IP in feedback_events and includes the request in flight', async () => {
    const oldest = new Date(Date.now() - 30_000).toISOString();
    const { sql, calls } = makeFakeSql([[{ n: 4, oldest }]]);
    const r = await store.countRecentByIp(sql, '203.0.113.9', 60_000);
    assert.strictEqual(r.count, 5);
    assert.ok(r.ttl > 25_000 && r.ttl <= 30_000, `ttl ${r.ttl}`);
    assert.match(calls[0].text, /FROM feedback_events WHERE ip = \?/);
    assert.ok(calls[0].values.includes('203.0.113.9'));
  });
});

// ---------------------------------------------------------------------------
// Escalation decision table
// ---------------------------------------------------------------------------

describe('escalation decision table', () => {
  const base = { surface: 'web', tier: 'preview', rating: 'down', text: 'the CSP finding is wrong', rule: null };

  it('up → none', () => {
    assert.strictEqual(esc.escalationDecision({ ...base, rating: 'up' }).kind, 'none');
  });

  it('down without text → none', () => {
    assert.strictEqual(esc.escalationDecision({ ...base, text: null }).kind, 'none');
  });

  it('down with text → customer-feedback issue titled by surface and tier', () => {
    const d = esc.escalationDecision(base);
    assert.deepStrictEqual(d, { kind: 'issue', title: 'Customer feedback: web preview', label: 'customer-feedback' });
    assert.strictEqual(esc.escalationDecision({ ...base, tier: null }).title, 'Customer feedback: web untiered');
  });

  it('finding-wrong → false-positive issue titled by rule', () => {
    const d = esc.escalationDecision({ ...base, surface: 'finding', rule: 'security:eval', text: 'security:eval reported wrong on src/a.js' });
    assert.deepStrictEqual(d, { kind: 'issue', title: 'Possible false positive: security:eval', label: 'false-positive' });
  });

  it('finding-wrong with an open issue for the rule inside 7 days → comment on it', () => {
    const d = esc.escalationDecision({ ...base, surface: 'finding', rule: 'security:eval' }, { issueNumber: 42 });
    assert.deepStrictEqual(d, { kind: 'comment', title: 'Possible false positive: security:eval', label: 'false-positive', issueNumber: 42 });
  });

  it('finding surface without a parseable rule falls back to a customer-feedback issue', () => {
    const d = esc.escalationDecision({ ...base, surface: 'finding', rule: null, tier: 'quick' });
    assert.strictEqual(d.label, 'customer-feedback');
    assert.strictEqual(d.title, 'Customer feedback: finding quick');
  });

  it('DEDUPE_DAYS is the 7-day window the store looks back over', () => {
    assert.strictEqual(esc.DEDUPE_DAYS, 7);
  });
});

// ---------------------------------------------------------------------------
// Escalation I/O
// ---------------------------------------------------------------------------

describe('escalation against the git host', () => {
  const event = { surface: 'web', tier: 'preview', rating: 'down', text: 'the CSP finding is wrong', rule: null, scanId: 'scn_1', page: '/web' };

  it('opens the issue with the label and a body carrying surface, tier, page, text and the triage link', async () => {
    const gh = makeFakeGithub(() => ({ status: 201, data: { number: 7, html_url: 'https://github.com/crclabs-hq/GateTest/issues/7' } }));
    const r = await esc.escalate({ decision: esc.escalationDecision(event), event, rowId: '9', token: TOKEN, fetchImpl: gh.fetchImpl });
    assert.deepStrictEqual(r, { escalated: true, kind: 'issue', issueNumber: 7, ref: 'https://github.com/crclabs-hq/GateTest/issues/7' });
    assert.strictEqual(gh.calls.length, 1);
    assert.strictEqual(gh.calls[0].url, 'https://api.github.com/repos/crclabs-hq/GateTest/issues');
    assert.strictEqual(gh.calls[0].method, 'POST');
    assert.strictEqual(gh.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    const { title, labels, body } = gh.calls[0].body;
    assert.strictEqual(title, 'Customer feedback: web preview');
    assert.deepStrictEqual(labels, ['customer-feedback']);
    for (const needle of ['Surface: `web`', 'Tier: `preview`', 'Page: `/web`', 'Scan id: `scn_1`', '> the CSP finding is wrong', '/admin/feedback', 'row 9']) {
      assert.ok(body.includes(needle), `body missing ${needle}\n${body}`);
    }
  });

  it('comments on the existing issue for a repeat finding-wrong', async () => {
    const gh = makeFakeGithub(() => ({ status: 201, data: { html_url: 'https://github.com/crclabs-hq/GateTest/issues/42#issuecomment-1' } }));
    const fev = { ...event, surface: 'finding', rule: 'security:eval', text: 'security:eval reported wrong on src/a.js' };
    const decision = esc.escalationDecision(fev, { issueNumber: 42 });
    const r = await esc.escalate({ decision, event: fev, rowId: '10', token: TOKEN, fetchImpl: gh.fetchImpl });
    assert.strictEqual(r.escalated, true);
    assert.strictEqual(r.issueNumber, 42);
    assert.strictEqual(gh.calls[0].url, 'https://api.github.com/repos/crclabs-hq/GateTest/issues/42/comments');
    assert.match(gh.calls[0].body.body, /Reported again/);
    assert.match(gh.calls[0].body.body, /Rule: `security:eval`/);
  });

  it('without a credential: stored but not escalated, says so, and never calls out', async () => {
    const gh = makeFakeGithub(() => ({ status: 201, data: {} }));
    const r = await esc.escalate({ decision: esc.escalationDecision(event), event, rowId: '9', token: null, fetchImpl: gh.fetchImpl });
    assert.deepStrictEqual(r, { escalated: false, reason: 'no git host credential configured' });
    assert.strictEqual(gh.calls.length, 0);
  });

  it('a none decision and a rejected call both report escalated: false with a reason', async () => {
    const none = await esc.escalate({ decision: esc.escalationDecision({ ...event, rating: 'up' }), event, rowId: '1', token: TOKEN, fetchImpl: makeFakeGithub(() => ({ status: 201, data: {} })).fetchImpl });
    assert.deepStrictEqual(none, { escalated: false, reason: 'rating is not down' });
    const forbidden = await esc.escalate({ decision: esc.escalationDecision(event), event, rowId: '1', token: TOKEN, fetchImpl: makeFakeGithub(() => ({ status: 403, data: {} })).fetchImpl });
    assert.deepStrictEqual(forbidden, { escalated: false, reason: 'git host returned 403' });
    const down = await esc.escalate({ decision: esc.escalationDecision(event), event, rowId: '1', token: TOKEN, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    assert.strictEqual(down.escalated, false);
    assert.match(down.reason, /ECONNRESET/);
  });

  it('isIssueOpen is true only for an open issue', async () => {
    const open = makeFakeGithub(() => ({ status: 200, data: { state: 'open' } }));
    const closed = makeFakeGithub(() => ({ status: 200, data: { state: 'closed' } }));
    const gone = makeFakeGithub(() => ({ status: 404, data: {} }));
    assert.strictEqual(await esc.isIssueOpen({ token: TOKEN, issueNumber: 42, fetchImpl: open.fetchImpl }), true);
    assert.strictEqual(await esc.isIssueOpen({ token: TOKEN, issueNumber: 42, fetchImpl: closed.fetchImpl }), false);
    assert.strictEqual(await esc.isIssueOpen({ token: TOKEN, issueNumber: 42, fetchImpl: gone.fetchImpl }), false);
    assert.strictEqual(open.calls[0].url, 'https://api.github.com/repos/crclabs-hq/GateTest/issues/42');
  });

  it('the issue body never carries what redaction removed', () => {
    const v = validateFeedbackBody({ surface: 'web', rating: 'down', text: `broken, ${TOKEN}, craig@example.com` });
    const body = esc.composeIssueBody(v.event, '3');
    assert.ok(!body.includes('ghp_') && !body.includes('@example.com'), body);
  });
});

// ---------------------------------------------------------------------------
// Store — SQL shape against the fake tagged template
// ---------------------------------------------------------------------------

describe('feedback store', () => {
  it('recordFeedback creates the table, inserts the event and returns the id', async () => {
    const { sql, calls } = makeFakeSql([[], [], [], [], [{ id: 9 }]]);
    const id = await store.recordFeedback(sql, { surface: 'web', rating: 'down', tier: 'preview', scanId: 'scn_1', text: 'slow', page: '/web', ip: '203.0.113.9' });
    assert.strictEqual(id, '9');
    assert.match(calls[0].text, /CREATE TABLE IF NOT EXISTS feedback_events/);
    const insert = calls.find((c) => /INSERT INTO feedback_events/.test(c.text));
    assert.ok(insert);
    assert.deepStrictEqual(insert.values, ['scn_1', 'web', 'preview', 'down', null, 'slow', '/web', '203.0.113.9']);
  });

  it('findRecentEscalation returns the issue a repeat report should comment on, or null', async () => {
    const hit = makeFakeSql([[{ issue_number: 42, escalation_ref: 'https://github.com/crclabs-hq/GateTest/issues/42' }]]);
    assert.deepStrictEqual(await store.findRecentEscalation(hit.sql, 'security:eval', 7), { issueNumber: 42, ref: 'https://github.com/crclabs-hq/GateTest/issues/42' });
    assert.match(hit.calls[0].text, /issue_number IS NOT NULL/);
    assert.ok(hit.calls[0].values.includes('security:eval'));
    const miss = makeFakeSql([[]]);
    assert.strictEqual(await store.findRecentEscalation(miss.sql, 'security:eval', 7), null);
    assert.strictEqual(await store.findRecentEscalation(miss.sql, null, 7), null);
  });

  it('markEscalated stamps the row; countsBySurface groups up/down per surface', async () => {
    const m = makeFakeSql([[]]);
    await store.markEscalated(m.sql, '9', { issueNumber: 7, ref: 'u' });
    assert.match(m.calls[0].text, /UPDATE feedback_events\s+SET escalated = TRUE/);
    assert.deepStrictEqual(m.calls[0].values, [7, 'u', '9']);
    const c = makeFakeSql([[{ surface: 'web', up: '3', down: 1 }]]);
    assert.deepStrictEqual(await store.countsBySurface(c.sql, 7), [{ surface: 'web', up: 3, down: 1 }]);
    assert.match(c.calls[0].text, /GROUP BY surface/);
  });

  it('every helper refuses to run without sql (contract guard)', async () => {
    for (const fn of [() => store.recordFeedback(null, { surface: 'web', rating: 'up' }), () => store.countRecentByIp(null, 'ip'), () => store.listRecentFeedback(null), () => store.countsBySurface(null, 7)]) {
      await assert.rejects(fn, /sql is required/);
    }
  });
});

// ---------------------------------------------------------------------------
// Route shape — the TypeScript handlers cannot be loaded here, so their
// contract is pinned at source level, as the other route tests do.
// ---------------------------------------------------------------------------

describe('POST /api/feedback — route shape', () => {
  const src = read('website/app/api/feedback/route.ts');

  it('exports POST, validates through feedback-redact and answers 400 / 503', () => {
    assert.match(src, /export\s+async\s+function\s+POST/);
    assert.match(src, /validateFeedbackBody/);
    assert.match(src, /require\(["']@\/app\/lib\/feedback-redact["']\)/);
    assert.match(src, /status:\s*400/);
    assert.match(src, /status:\s*503/);
    assert.match(src, /persistence unavailable/);
  });

  it('is per-IP rate limited with the feedback preset and the Postgres count', () => {
    assert.match(src, /createLimiter\(/);
    assert.match(src, /PRESETS\.feedback/);
    assert.match(src, /dbBackedFn/);
    assert.match(src, /countRecentByIp/);
  });

  it('escalates with the server-side git host credential and never fails the request over it', () => {
    assert.match(src, /resolveGithubToken\(FEEDBACK_REPO\.owner, FEEDBACK_REPO\.repo\)/);
    assert.match(src, /stored:\s*true/);
    assert.match(src, /escalated:\s*false/);
    assert.match(src, /no git host credential configured/);
    assert.match(src, /findRecentEscalation/);
    assert.match(src, /isIssueOpen/);
    assert.match(src, /markEscalated/);
  });
});

describe('GET /api/admin/feedback — route shape', () => {
  const src = read('website/app/api/admin/feedback/route.ts');

  it('rejects unauthenticated callers with 401 using the canonical admin check', () => {
    assert.match(src, /export\s+async\s+function\s+GET/);
    assert.match(src, /from\s+["']@\/app\/lib\/admin-session["']/);
    assert.match(src, /from\s+["']@\/app\/lib\/admin-auth["']/);
    assert.match(src, /isAuthenticatedAdmin/);
    assert.match(src, /timingSafeEqual/);
    assert.match(src, /\{ error: "Unauthorized" \}, \{ status: 401 \}/);
  });

  it('returns the last 200 rows and 7 / 30-day counts per surface', () => {
    assert.match(src, /RECENT_ROWS = 200/);
    assert.match(src, /listRecentFeedback\(sql, RECENT_ROWS\)/);
    assert.match(src, /countsBySurface\(sql, 7\)/);
    assert.match(src, /countsBySurface\(sql, 30\)/);
  });
});

describe('the two loops are wired onto every hosted result surface', () => {
  it('ScanFeedback asks one question, remembers the answer per scan, and uses plain copy', () => {
    const src = read('website/app/components/ScanFeedback.tsx');
    assert.match(src, /Was this scan useful\?/);
    assert.match(src, /What was wrong or missing\?/);
    assert.match(src, /localStorage/);
    assert.match(src, /fetch\("\/api\/feedback"/);
    assert.ok(!/Oops/.test(src));
    assert.ok(!/>[^<{]*![^<{]*</.test(src), 'no exclamation marks in rendered copy');
  });

  it('FindingWrong posts rating down on surface finding with the rule and no code content', () => {
    const src = read('website/app/components/FindingWrong.tsx');
    assert.match(src, /surface: "finding"/);
    assert.match(src, /rating: "down"/);
    assert.match(src, /reported wrong on/);
    assert.match(src, /Thanks — recorded/);
    assert.ok(!/message|body:\s*finding/.test(src), 'finding text never leaves the browser');
  });

  it('repo result, web/wp result and the free preview all mount both components', () => {
    assert.match(read('website/app/scan/status/page.tsx'), /<ScanFeedback surface="repo"/);
    assert.match(read('website/app/components/FindingsPanel.tsx'), /<FindingWrong/);
    assert.match(read('website/app/components/UrlScanFlow.tsx'), /<ScanFeedback surface=\{suite\}/);
    assert.match(read('website/app/components/url-scan-flow-cards.tsx'), /<FindingWrong rule=\{ruleId\}/);
    const preview = read('website/app/scan/preview/PreviewResults.tsx');
    assert.match(preview, /<ScanFeedback surface="preview"/);
    assert.match(preview, /<FindingWrong rule=\{f\.module\}/);
  });
});
