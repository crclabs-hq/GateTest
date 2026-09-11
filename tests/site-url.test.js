/**
 * Canonical site origin.
 *
 * The domain used to be a 148-occurrence string literal spread across SEO
 * canonicals, Stripe redirect URLs, the GitHub OAuth callback and badge
 * embed snippets. A domain move meant a find-and-replace where missing one
 * site silently pointed a paying customer at a domain we no longer own.
 *
 * These tests defend three things:
 *   1. One environment variable decides the domain.
 *   2. Malformed env values fall back rather than emitting a broken URL.
 *   3. New hardcoded literals cannot creep back into the routes that break
 *      customers when they are wrong.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  DEFAULT_SITE_URL, siteUrl, badgeUrl, resolveSiteUrl, normaliseOrigin,
} = require('../website/app/lib/site-url');

const REPO = path.join(__dirname, '..');

describe('site-url — origin resolution', () => {
  it('prefers NEXT_PUBLIC_BASE_URL', () => {
    assert.strictEqual(
      resolveSiteUrl({ NEXT_PUBLIC_BASE_URL: 'https://gatetest.io' }),
      'https://gatetest.io',
    );
  });

  it('falls back to the server-side name the CLI and engine use', () => {
    assert.strictEqual(
      resolveSiteUrl({ GATETEST_PUBLIC_BASE_URL: 'https://gatetest.io' }),
      'https://gatetest.io',
    );
  });

  it('NEXT_PUBLIC_BASE_URL wins when both are set', () => {
    assert.strictEqual(
      resolveSiteUrl({
        NEXT_PUBLIC_BASE_URL: 'https://gatetest.io',
        GATETEST_PUBLIC_BASE_URL: 'https://stale.example',
      }),
      'https://gatetest.io',
    );
  });

  it('falls back to the default when nothing is set', () => {
    assert.strictEqual(resolveSiteUrl({}), DEFAULT_SITE_URL);
  });
});

describe('site-url — normalisation', () => {
  it('adds a scheme when the platform omits it', () => {
    // Vercel's VERCEL_URL and most PaaS host vars arrive bare.
    assert.strictEqual(normaliseOrigin('gatetest.io'), 'https://gatetest.io');
  });

  it('strips a trailing slash', () => {
    // The failure this prevents: 'https://x.io/' + '/checkout' -> '//checkout',
    // which mostly works and then fails OAuth exact-match redirect checking.
    assert.strictEqual(normaliseOrigin('https://gatetest.io/'), 'https://gatetest.io');
  });

  it('discards a path, query or fragment', () => {
    assert.strictEqual(normaliseOrigin('https://gatetest.io/a/b?c=1#d'), 'https://gatetest.io');
  });

  it('preserves an explicit port', () => {
    assert.strictEqual(normaliseOrigin('http://localhost:3000'), 'http://localhost:3000');
  });

  it('keeps http when it is stated explicitly', () => {
    assert.strictEqual(normaliseOrigin('http://gatetest.io'), 'http://gatetest.io');
  });

  it('rejects unusable values rather than emitting a broken URL', () => {
    for (const bad of [undefined, null, '', '   ', 'https://', 42, {}]) {
      assert.strictEqual(normaliseOrigin(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });

  it('a malformed env value falls back instead of poisoning every URL', () => {
    assert.strictEqual(resolveSiteUrl({ NEXT_PUBLIC_BASE_URL: 'https://' }), DEFAULT_SITE_URL);
  });
});

describe('site-url — joining', () => {
  it('returns the bare origin with no argument', () => {
    assert.strictEqual(siteUrl(), require('../website/app/lib/site-url').SITE_URL);
  });

  it('joins with or without a leading slash, never doubling it', () => {
    assert.strictEqual(siteUrl('/checkout'), `${siteUrl()}/checkout`);
    assert.strictEqual(siteUrl('checkout'), `${siteUrl()}/checkout`);
  });
});

describe('site-url — badge origin', () => {
  it('tracks the site origin by default', () => {
    assert.strictEqual(badgeUrl('/api/badge'), siteUrl('/api/badge'));
  });

  it('is a separate export so it can lag a domain move', () => {
    // Badges live in READMEs we do not control. When the site moves, already
    // -pasted badges keep hitting the OLD origin forever, so the old domain
    // must keep 301'ing. Keeping this decision separate from SITE_URL is what
    // makes that possible.
    const mod = require('../website/app/lib/site-url');
    assert.ok('BADGE_ORIGIN' in mod, 'BADGE_ORIGIN must stay independently settable');
  });
});

describe('site-url — engine and website copies must not drift', () => {
  // There are deliberately TWO implementations: the website copy reads
  // NEXT_PUBLIC_BASE_URL as a static member expression so Next.js can inline it
  // into client bundles, and the engine copy must stand alone because the
  // published npm package ships src/ and bin/ WITHOUT website/.
  //
  // Two copies of a decision is exactly how a domain move half-happens, so
  // these tests are the thing that makes the duplication safe.
  const web = require('../website/app/lib/site-url');
  const engine = require('../src/core/site-url');

  it('agrees on the default origin', () => {
    assert.strictEqual(engine.DEFAULT_SITE_URL, web.DEFAULT_SITE_URL);
  });

  it('agrees on the legacy origin', () => {
    assert.strictEqual(engine.LEGACY_SITE_URL, web.LEGACY_SITE_URL);
  });

  it('agrees on the resolved origin and host', () => {
    assert.strictEqual(engine.SITE_URL, web.SITE_URL);
    assert.strictEqual(engine.siteHost(), web.siteHost());
  });

  it('resolves every env shape identically', () => {
    const cases = [
      {},
      { NEXT_PUBLIC_BASE_URL: 'https://a.example' },
      { GATETEST_PUBLIC_BASE_URL: 'https://b.example' },
      { NEXT_PUBLIC_BASE_URL: 'https://a.example', GATETEST_PUBLIC_BASE_URL: 'https://b.example' },
      { NEXT_PUBLIC_BASE_URL: 'bare.example' },
      { NEXT_PUBLIC_BASE_URL: 'https://trailing.example/' },
      { NEXT_PUBLIC_BASE_URL: 'https://' },
      { NEXT_PUBLIC_BASE_URL: '   ' },
    ];
    for (const env of cases) {
      assert.strictEqual(
        engine.resolveSiteUrl(env),
        web.resolveSiteUrl(env),
        `divergent resolution for ${JSON.stringify(env)}`,
      );
    }
  });

  it('normalises identically, including the rejection cases', () => {
    for (const raw of [
      'gatetest.io', 'https://gatetest.io/', 'http://localhost:3000',
      'https://x.io/a/b?c=1#d', 'https://', '', '   ', undefined, null, 42,
    ]) {
      assert.strictEqual(
        engine.normaliseOrigin(raw),
        web.normaliseOrigin(raw),
        `divergent normalisation for ${JSON.stringify(raw)}`,
      );
    }
  });

  it('agrees on the support address', () => {
    assert.strictEqual(engine.SUPPORT_EMAIL, web.SUPPORT_EMAIL);
  });
});

describe('site-url — the domain move', () => {
  const web = require('../website/app/lib/site-url');

  it('defaults to the .io origin', () => {
    // The .ai domain went into registry redemption on 2026-07-29 and returns
    // NXDOMAIN. Defaulting to it means defaulting to a name that does not
    // resolve, which is why this assertion is worth pinning.
    assert.strictEqual(web.DEFAULT_SITE_URL, 'https://gatetest.io');
  });

  it('support address lives on the live domain, and never on the dead one', () => {
    // Until 2026-09-11 this asserted the OPPOSITE — the address stayed on the
    // legacy domain on purpose, because an unverified sending domain fails
    // silently. Both preconditions were then met and confirmed by Craig:
    // gatetest.io verified in the Resend dashboard, and gatetest.io MX
    // receiving into real mailboxes (admin@, support@, billing@). Meanwhile
    // gatetest.ai has been NXDOMAIN since 2026-07-29, so any address there
    // bounces. Pin the new truth.
    assert.ok(
      web.SUPPORT_EMAIL.endsWith('@gatetest.io'),
      `support address must be on gatetest.io, got ${web.SUPPORT_EMAIL}`,
    );
    assert.ok(!web.SUPPORT_EMAIL.endsWith('@gatetest.ai'), 'gatetest.ai does not resolve — mail to it bounces');
    assert.ok(['support', 'admin', 'billing'].includes(web.SUPPORT_EMAIL.split('@')[0]),
      'only the mailboxes that exist: admin@, support@, billing@');
  });

  it('lets one env var move every URL', () => {
    assert.strictEqual(
      web.resolveSiteUrl({ NEXT_PUBLIC_BASE_URL: 'https://gatetest.ai' }),
      'https://gatetest.ai',
      'the move must stay reversible from the environment alone',
    );
  });
});

describe('site-url — no new hardcoded domains', () => {
  // Scoped to the files where a wrong domain breaks a paying customer:
  // payment redirects, OAuth callbacks, and the snippets customers paste
  // into repos we cannot edit. Marketing prose is deliberately excluded.
  const GUARDED = [
    'website/app/lib/stripe-checkout.js',
    'website/app/lib/github-callback.js',
    'website/app/lib/weekly-digest.js',
    'website/app/api/score/route.ts',
    'website/app/badge/[owner]/[repo]/route.ts',
    // The badge page's embed snippets — pasted into READMEs we can never
    // edit. Four literals lived here until 2026-09-05.
    'website/app/badge/page.tsx',
    'website/app/layout.tsx',
    // The cross-product discovery map. A wrong domain here doesn't break a
    // page a human would notice — it hands every sibling service a dead URL
    // to poll. Production was serving `https://gatetest.ai` in this field on
    // 2026-08-05, long after that domain started returning NXDOMAIN.
    'website/app/api/platform-status/route.ts',
    // 2026-09-05 sweep: every remaining runtime literal in website/app moved
    // onto the helper — Stripe/portal/fleet/watch base URLs, API JSON
    // responses, e-mail bodies, PR/issue/report footers, bot User-Agents,
    // JSON-LD, and the code snippets customers copy off the docs pages.
    'website/app/api/billing/portal/route.ts',
    'website/app/api/checkout/route.ts',
    'website/app/api/heal/sentry-webhook/route.ts',
    'website/app/api/integrations/ai-generators/route.ts',
    'website/app/api/mcp/route.ts',
    'website/app/api/scan/fleet/route.ts',
    'website/app/api/slack/events/route.ts',
    'website/app/api/v1/scan/route.ts',
    'website/app/api/watches/tick/route.ts',
    'website/app/components/url-scan-flow-export.tsx',
    'website/app/docs/api/page.tsx',
    'website/app/find/[slug]/page.tsx',
    'website/app/find/page.tsx',
    'website/app/for/[country]/page.tsx',
    'website/app/github/setup/page.tsx',
    'website/app/lib/ai-handoff.js',
    'website/app/lib/architecture-annotator.js',
    'website/app/lib/ciso-report-generator.js',
    'website/app/lib/cross-finding-correlator.js',
    'website/app/lib/dependency-upgrade-patcher.js',
    'website/app/lib/digest-mailer.js',
    'website/app/lib/executive-summary.js',
    'website/app/lib/nuclear-diagnoser.js',
    'website/app/lib/pair-review.js',
    'website/app/lib/pentest/http-client.js',
    'website/app/lib/pr-composer.js',
    'website/app/lib/trainers/hacker-news-monitor.js',
    'website/app/lib/url-stack-detector.js',
    'website/app/mcp/page.tsx',
    'website/app/playground/page.tsx',
    'website/app/regulation/page.tsx',
    'website/app/score/[owner]/[repo]/page.tsx',
  ];

  for (const rel of GUARDED) {
    it(`${rel} has no hardcoded domain outside comments`, () => {
      const full = path.join(REPO, rel);
      if (!fs.existsSync(full)) return; // route moved — other tests will catch it

      const offenders = fs.readFileSync(full, 'utf8')
        .split('\n')
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        .filter(({ line }) => /https:\/\/gatetest\.(ai|io)/.test(line))
        // Doc comments explaining the URL shape are fine; code is not.
        .filter(({ line }) => !(line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')));

      assert.deepStrictEqual(
        offenders.map((o) => `${o.no}: ${o.line}`),
        [],
        `hardcoded domain in ${rel} — import siteUrl() from app/lib/site-url instead`,
      );
    });
  }
});

// ─── composed artifacts: what a customer's repo actually receives ────────────
//
// The checks above guard the helpers and ban hardcoded literals in guarded
// files. This one guards the OUTPUT. A PR body is written into the customer's
// repository and a badge URL is pasted into their README — neither can be
// edited afterwards, so a stale domain there is permanent. Verified by running
// the composer, not by grepping it.

describe('composed customer-facing artifacts carry the live domain', () => {
  const { composePrBody } = require(path.resolve(
    __dirname, '..', 'website', 'app', 'lib', 'pr-composer.js'
  ));

  const prBody = composePrBody({
    fixes: [{ file: 'src/a.js', original: 'a', fixed: 'b', issues: ['secrets: hardcoded key'] }],
    errors: [],
    syntaxGate: { summary: 'ok' },
    scannerGate: { summary: 'ok' },
    testGen: { summary: 'none' },
  });

  it('the PR body a customer receives contains no gatetest.ai URL', () => {
    // E-mails are deliberately still @gatetest.ai, so match URLs only.
    const aiUrls = prBody.match(/https?:\/\/[^\s"'`)>\]]*gatetest\.ai[^\s"'`)>\]]*/g) || [];
    assert.deepStrictEqual(
      [...new Set(aiUrls)],
      [],
      'the PR body is committed into the customer repo and cannot be edited later',
    );
  });

  it('and does reference the live site (anti-vacuity: it emits a URL at all)', () => {
    // Without this, the assertion above would pass on an empty body.
    assert.match(prBody, /https:\/\/gatetest\.io/);
  });
});
