/**
 * Every e-mail the site sends goes through website/app/lib/mail-transport.js.
 * The switch between Resend (live today) and the Tallrig platform API is
 * deliberate (MAIL_PROVIDER), never automatic, so a half-finished cutover
 * cannot leave the MCP key e-mail dark; and no secret can ever leak into a
 * return value.
 *
 * The platform was renamed Vapron → Tallrig (2026-09-14). `tallrig` is the
 * canonical provider name; `vapron` is accepted as a deprecated alias so a box
 * whose env file predates the rename keeps sending, and the VAPRON_* key names
 * are still read through platform-config's precedence.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const T = require(path.join(__dirname, '..', 'website', 'app', 'lib', 'mail-transport.js'));

const RESEND = { RESEND_API_KEY: 're_test_secret' };
const TALLRIG = { TALLRIG_API_KEY: 'tpk_test_secret' };
/** The pre-rename key name — still honoured. */
const VAPRON = { VAPRON_API_KEY: 'vpk_test_secret' };

function capture(reply = { status: 200, body: JSON.stringify({ id: 'msg_1' }) }) {
  const calls = [];
  return { calls, request: async (target, bearer, payload) => { calls.push({ target, bearer, payload }); return reply; } };
}

/** Run fn with console.warn captured; returns the warnings it emitted. */
function withWarnings(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try { fn(); } finally { console.warn = orig; }
  return warnings;
}

describe('mail-transport: provider selection', () => {
  it('stays on Resend while it is configured and no flag is set', () => {
    assert.strictEqual(T.mailProvider({ ...RESEND, ...TALLRIG }), 'resend');
  });
  it('MAIL_PROVIDER=tallrig selects the platform explicitly', () => {
    assert.strictEqual(T.PLATFORM_PROVIDER, 'tallrig');
    assert.strictEqual(T.mailProvider({ ...RESEND, ...TALLRIG, MAIL_PROVIDER: 'tallrig' }), 'tallrig');
  });
  it('MAIL_PROVIDER=vapron (the old name) is a deprecated alias: same provider, reported as tallrig, one warning', () => {
    let first; let second;
    const warnings = withWarnings(() => {
      first = T.mailProvider({ ...RESEND, ...VAPRON, MAIL_PROVIDER: 'vapron' });
      second = T.mailProvider({ ...RESEND, ...VAPRON, MAIL_PROVIDER: 'vapron' });
    });
    assert.strictEqual(first, 'tallrig');
    assert.strictEqual(second, 'tallrig');
    assert.ok(warnings.length <= 1, `expected at most one deprecation warning per process, got ${warnings.length}`);
    for (const w of warnings) assert.match(w, /MAIL_PROVIDER=vapron/);
    assert.strictEqual(T.mailConfigured({ ...VAPRON, MAIL_PROVIDER: 'vapron' }), true);
  });
  it('falls back to the platform only when Resend is absent and a platform key exists', () => {
    assert.strictEqual(T.mailProvider(TALLRIG), 'tallrig');
    assert.strictEqual(T.mailProvider(VAPRON), 'tallrig', 'the VAPRON_API_KEY name is still read');
    assert.strictEqual(T.mailProvider({ TALLRIG_BASE_URL: 'https://api.tallrig.com/api/platform' }), 'none');
    assert.strictEqual(T.mailProvider({}), 'none');
  });
  it('the dispatch key name (TALLRIG_API_TOKEN / VAPRON_API_TOKEN) is the same credential', () => {
    assert.strictEqual(T.mailProvider({ TALLRIG_API_TOKEN: 'x' }), 'tallrig');
    assert.strictEqual(T.mailProvider({ VAPRON_API_TOKEN: 'x' }), 'tallrig');
    assert.strictEqual(T.mailConfigured({ MAIL_PROVIDER: 'tallrig', TALLRIG_API_TOKEN: 'x' }), true);
    assert.strictEqual(T.mailConfigured({ MAIL_PROVIDER: 'tallrig', VAPRON_API_TOKEN: 'x' }), true);
  });
  it('mailConfigured is false when the selected provider lacks its key', () => {
    assert.strictEqual(T.mailConfigured({ MAIL_PROVIDER: 'tallrig', ...RESEND }), false);
    assert.strictEqual(T.mailConfigured({ MAIL_PROVIDER: 'resend', ...TALLRIG }), false);
    assert.strictEqual(T.mailConfigured(RESEND), true);
    assert.strictEqual(T.mailConfigured({ ...TALLRIG, MAIL_PROVIDER: 'tallrig' }), true);
  });
  it('the From address is on the live domain by default', () => {
    assert.match(T.fromAddress({}), /@gatetest\.io>$/);
    assert.strictEqual(T.fromAddress({ RESEND_FROM: 'X <x@gatetest.io>' }), 'X <x@gatetest.io>');
  });
});

describe('mail-transport: request shaping', () => {
  it('Tallrig: POST https://tallrig.com/api/platform/email/send with the platform key and a single-recipient string', async () => {
    const c = capture();
    const r = await T.deliver({ to: 'a@b.c', subject: 'S', html: '<p>h</p>', text: 't' }, { env: { ...TALLRIG, MAIL_PROVIDER: 'tallrig' }, request: c.request });
    assert.deepStrictEqual({ ok: r.ok, id: r.id, provider: r.provider }, { ok: true, id: 'msg_1', provider: 'tallrig' });
    assert.strictEqual(c.calls[0].target.hostname, 'tallrig.com');
    assert.strictEqual(c.calls[0].target.path, '/api/platform/email/send');
    assert.strictEqual(T.PLATFORM_MAIL_URL, 'https://tallrig.com/api/platform/email/send');
    assert.strictEqual(T.VAPRON_MAIL_URL, T.PLATFORM_MAIL_URL, 'the pre-rename export name is kept as an alias');
    assert.strictEqual(c.calls[0].bearer, 'tpk_test_secret');
    assert.strictEqual(c.calls[0].payload.to, 'a@b.c');
    assert.match(c.calls[0].payload.from, /@gatetest\.io/);
  });
  it('the vapron alias sends through the SAME endpoint with the pre-rename key', async () => {
    const c = capture();
    const r = await T.deliver({ to: 'a@b.c', subject: 'S' }, { env: { ...VAPRON, MAIL_PROVIDER: 'vapron' }, request: c.request });
    assert.strictEqual(r.provider, 'tallrig');
    assert.strictEqual(c.calls[0].target.hostname, 'tallrig.com');
    assert.strictEqual(c.calls[0].bearer, 'vpk_test_secret');
  });
  it('TALLRIG_MAIL_URL overrides the endpoint (VAPRON_MAIL_URL after it); TALLRIG_BASE_URL (dispatch, path-prefixed) never leaks in', async () => {
    const c = capture();
    await T.deliver({ to: 'a@b.c', subject: 'S' }, { env: { ...TALLRIG, MAIL_PROVIDER: 'tallrig', TALLRIG_BASE_URL: 'https://api.tallrig.com/api/platform', TALLRIG_MAIL_URL: 'https://mail.example/v1/send', VAPRON_MAIL_URL: 'https://old.example/v0/send' }, request: c.request });
    assert.strictEqual(c.calls[0].target.hostname, 'mail.example');
    assert.strictEqual(c.calls[0].target.path, '/v1/send');
    const d = capture();
    await T.deliver({ to: 'a@b.c', subject: 'S' }, { env: { ...TALLRIG, MAIL_PROVIDER: 'tallrig', VAPRON_MAIL_URL: 'https://old.example/v0/send' }, request: d.request });
    assert.strictEqual(d.calls[0].target.hostname, 'old.example', 'an un-renamed box\'s VAPRON_MAIL_URL still repoints the endpoint');
  });
  it('Resend: POST api.resend.com/emails with the Resend key and a recipient array', async () => {
    const c = capture();
    const r = await T.deliver({ to: 'a@b.c', subject: 'S', html: '<p>h</p>' }, { env: RESEND, request: c.request });
    assert.strictEqual(r.provider, 'resend');
    assert.strictEqual(c.calls[0].target.hostname, 'api.resend.com');
    assert.strictEqual(c.calls[0].bearer, 're_test_secret');
    assert.deepStrictEqual(c.calls[0].payload.to, ['a@b.c']);
  });
  it('refuses cleanly when nothing is configured, without touching the network', async () => {
    const c = capture();
    const r = await T.deliver({ to: 'a@b.c', subject: 'S' }, { env: {}, request: c.request });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(c.calls.length, 0);
  });
  it('surfaces the provider error and never the secret', async () => {
    const c = capture({ status: 401, body: JSON.stringify({ message: 'invalid api key' }) });
    const r = await T.deliver({ to: 'a@b.c', subject: 'S' }, { env: { ...TALLRIG, MAIL_PROVIDER: 'tallrig' }, request: c.request });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'invalid api key');
    assert.ok(!JSON.stringify(r).includes('tpk_test_secret'));
  });
  it('the mailer module routes all three e-mails through deliver()', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'website', 'app', 'lib', 'digest-mailer.js'), 'utf8');
    assert.ok(!src.includes('api.resend.com'), 'digest-mailer must not talk to a provider directly');
    assert.strictEqual((src.match(/return deliver\(/g) || []).length, 3);
    assert.ok(!/RESEND_API_KEY not set/.test(src));
  });
});
