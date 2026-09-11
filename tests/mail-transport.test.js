/**
 * Every e-mail the site sends goes through website/app/lib/mail-transport.js.
 * The switch between Resend (live today) and the Vapron platform API is
 * deliberate (MAIL_PROVIDER), never automatic, so a half-finished cutover
 * cannot leave the MCP key e-mail dark; and no secret can ever leak into a
 * return value.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const T = require(path.join(__dirname, '..', 'website', 'app', 'lib', 'mail-transport.js'));

const RESEND = { RESEND_API_KEY: 're_test_secret' };
const VAPRON = { VAPRON_API_KEY: 'vpk_test_secret' };

function capture(reply = { status: 200, body: JSON.stringify({ id: 'msg_1' }) }) {
  const calls = [];
  return { calls, request: async (target, bearer, payload) => { calls.push({ target, bearer, payload }); return reply; } };
}

describe('mail-transport: provider selection', () => {
  it('stays on Resend while it is configured and no flag is set', () => {
    assert.strictEqual(T.mailProvider({ ...RESEND, ...VAPRON }), 'resend');
  });
  it('MAIL_PROVIDER=vapron selects Vapron explicitly', () => {
    assert.strictEqual(T.mailProvider({ ...RESEND, ...VAPRON, MAIL_PROVIDER: 'vapron' }), 'vapron');
  });
  it('falls back to Vapron only when Resend is absent and a Vapron key exists', () => {
    assert.strictEqual(T.mailProvider(VAPRON), 'vapron');
    assert.strictEqual(T.mailProvider({ VAPRON_BASE_URL: 'https://api.vapron.ai/api/platform' }), 'none');
    assert.strictEqual(T.mailProvider({}), 'none');
  });
  it('the dispatch key name (VAPRON_API_TOKEN) is the same credential', () => {
    assert.strictEqual(T.mailProvider({ VAPRON_API_TOKEN: 'x' }), 'vapron');
    assert.strictEqual(T.mailConfigured({ MAIL_PROVIDER: 'vapron', VAPRON_API_TOKEN: 'x' }), true);
  });
  it('mailConfigured is false when the selected provider lacks its key', () => {
    assert.strictEqual(T.mailConfigured({ MAIL_PROVIDER: 'vapron', ...RESEND }), false);
    assert.strictEqual(T.mailConfigured({ MAIL_PROVIDER: 'resend', ...VAPRON }), false);
    assert.strictEqual(T.mailConfigured(RESEND), true);
    assert.strictEqual(T.mailConfigured({ ...VAPRON, MAIL_PROVIDER: 'vapron' }), true);
  });
  it('the From address is on the live domain by default', () => {
    assert.match(T.fromAddress({}), /@gatetest\.io>$/);
    assert.strictEqual(T.fromAddress({ RESEND_FROM: 'X <x@gatetest.io>' }), 'X <x@gatetest.io>');
  });
});

describe('mail-transport: request shaping', () => {
  it('Vapron: POST https://vapron.ai/api/platform/email/send with the platform key and a single-recipient string', async () => {
    const c = capture();
    const r = await T.deliver({ to: 'a@b.c', subject: 'S', html: '<p>h</p>', text: 't' }, { env: { ...VAPRON, MAIL_PROVIDER: 'vapron' }, request: c.request });
    assert.deepStrictEqual({ ok: r.ok, id: r.id, provider: r.provider }, { ok: true, id: 'msg_1', provider: 'vapron' });
    assert.strictEqual(c.calls[0].target.hostname, 'vapron.ai');
    assert.strictEqual(c.calls[0].target.path, '/api/platform/email/send');
    assert.strictEqual(T.VAPRON_MAIL_URL, 'https://vapron.ai/api/platform/email/send');
    assert.strictEqual(c.calls[0].bearer, 'vpk_test_secret');
    assert.strictEqual(c.calls[0].payload.to, 'a@b.c');
    assert.match(c.calls[0].payload.from, /@gatetest\.io/);
  });
  it('VAPRON_MAIL_URL overrides the endpoint; VAPRON_BASE_URL (dispatch, path-prefixed) never leaks in', async () => {
    const c = capture();
    await T.deliver({ to: 'a@b.c', subject: 'S' }, { env: { ...VAPRON, MAIL_PROVIDER: 'vapron', VAPRON_BASE_URL: 'https://api.vapron.ai/api/platform', VAPRON_MAIL_URL: 'https://mail.example/v1/send' }, request: c.request });
    assert.strictEqual(c.calls[0].target.hostname, 'mail.example');
    assert.strictEqual(c.calls[0].target.path, '/v1/send');
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
    const r = await T.deliver({ to: 'a@b.c', subject: 'S' }, { env: { ...VAPRON, MAIL_PROVIDER: 'vapron' }, request: c.request });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'invalid api key');
    assert.ok(!JSON.stringify(r).includes('vpk_test_secret'));
  });
  it('the mailer module routes all three e-mails through deliver()', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'website', 'app', 'lib', 'digest-mailer.js'), 'utf8');
    assert.ok(!src.includes('api.resend.com'), 'digest-mailer must not talk to a provider directly');
    assert.strictEqual((src.match(/return deliver\(/g) || []).length, 3);
    assert.ok(!/RESEND_API_KEY not set/.test(src));
  });
});
