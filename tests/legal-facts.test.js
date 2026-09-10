/**
 * The legal pages must never claim something the code does not do.
 *
 * `website/app/legal/_facts.js` is the single source every legal document
 * reads from. Each fact that is OWNED by runtime code is checked here against
 * that code, so a retention window or a safety list cannot drift silently
 * into a false statement on /legal/privacy or /trust. A second group of
 * checks guards the rendered text itself: no unfinished-legal markers, every
 * cross-document link has a page behind it.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'website', 'app');
const facts = require(path.join(WEB, 'legal', '_facts.js'));

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Evaluate a tiny arithmetic literal like `30 * 24 * 60 * 60` safely. */
function arith(expr) {
  const clean = expr.replace(/[\s_]/g, '');
  assert.match(clean, /^[\d*+()]+$/, `not a plain arithmetic literal: ${expr}`);
  return clean.split('+').map((t) => t.replace(/[()]/g, '').split('*').reduce((a, b) => a * Number(b), 1)).reduce((a, b) => a + b, 0);
}

function extract(file, re) {
  const m = re.exec(read(file));
  assert.ok(m, `${file} no longer matches ${re}`);
  return m[1];
}

describe('legal facts match the code that enforces them', () => {
  it('session lifetime', () => {
    const secs = arith(extract('website/app/lib/customer-session.ts', /CUSTOMER_MAX_AGE_SECONDS\s*=\s*([^;]+);/));
    assert.strictEqual(facts.SESSION_DAYS * 86400, secs);
  });

  it('oauth state cookie lifetime', () => {
    const secs = Number(extract('website/app/api/auth/github/route.ts', /maxAge:\s*(\d+)/));
    assert.strictEqual(facts.OAUTH_STATE_MINUTES * 60, secs);
  });

  it('admin cookie lifetime', () => {
    const secs = arith(extract('website/app/lib/admin-auth.ts', /COOKIE_MAX_AGE\s*=\s*([^;]+);/));
    assert.strictEqual(facts.ADMIN_COOKIE_HOURS * 3600, secs);
  });

  it('audit log retention', () => {
    const years = Number(extract('website/app/lib/audit-log-store.js', /DEFAULT_RETENTION_YEARS\s*=\s*(\d+)/));
    assert.strictEqual(facts.AUDIT_LOG_YEARS, years);
  });

  it('in-memory repo snapshot ttl', () => {
    const ms = arith(extract('website/app/lib/gluecron-client.ts', /SNAPSHOT_TTL_MS\s*=\s*([^;]+);/));
    assert.strictEqual(facts.REPO_SNAPSHOT_SECONDS * 1000, ms);
  });

  it('modules the hosted engine refuses to run', () => {
    const literal = extract('website/app/lib/cli-engine-runner.js', /HOSTED_UNSAFE_MODULES\s*=\s*(\[[^\]]+\])/);
    const fromCode = JSON.parse(literal.replace(/'/g, '"'));
    assert.deepStrictEqual([...facts.HOSTED_UNSAFE_MODULES], fromCode);
  });

  it('telemetry opt-out env var is the one the engine reads', () => {
    assert.ok(read('src/core/scan-telemetry.js').includes(facts.TELEMETRY_OPT_OUT_ENV));
  });

  it('AI provider retention is stated as standard retention, never zero-data-retention', () => {
    const src = read('website/app/lib/engine-models.js');
    assert.match(src, /standard 30-day retention/);
    assert.strictEqual(facts.AI_PROVIDER_RETENTION_DAYS, 30);
  });

  it('sub-processor list covers every SDK actually installed', () => {
    const deps = JSON.parse(read('website/package.json')).dependencies || {};
    const names = facts.SUB_PROCESSORS.map((s) => s.name);
    if (deps['@sentry/nextjs']) assert.ok(names.includes('Sentry'), 'Sentry SDK installed but not listed');
    if (deps['@neondatabase/serverless']) assert.ok(names.includes('Neon'));
    if (deps.stripe) assert.ok(names.includes('Stripe'));
    assert.ok(names.includes('Anthropic'));
    assert.ok(names.includes('GitHub'));
  });

  it('support e-mail comes from site-url, never typed', () => {
    assert.strictEqual(facts.SUPPORT_EMAIL, require(path.join(WEB, 'lib', 'site-url.js')).SUPPORT_EMAIL);
  });
});

describe('legal documents carry no unfinished-legal markers and no dead links', () => {
  const FORBIDDEN = [/\bDRAFT\b/i, /requires attorney review/i, /\bTBD\b/, /to be confirmed/i, /\[(ADDRESS|ENTITY|NAME|DATE)\]/];

  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  const legalFiles = [
    ...walk(path.join(WEB, 'legal')),
    ...walk(path.join(WEB, 'trust')),
    path.join(WEB, 'components', 'legal', 'LegalDocument.tsx'),
  ].filter(fs.existsSync);

  it('no forbidden markers in any legal source file (rendered text OR comments)', () => {
    const hits = [];
    for (const f of legalFiles) {
      const src = fs.readFileSync(f, 'utf8');
      for (const re of FORBIDDEN) if (re.test(src)) hits.push(`${path.relative(ROOT, f)}: ${re}`);
    }
    assert.deepStrictEqual(hits, []);
  });

  it('every document in LEGAL_NAV has a page', () => {
    const nav = read('website/app/components/legal/LegalDocument.tsx');
    const hrefs = [...nav.matchAll(/href:\s*"(\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 6, 'LEGAL_NAV should list the full document set');
    for (const href of hrefs) {
      const page = path.join(WEB, href.replace(/^\//, ''), 'page.tsx');
      assert.ok(fs.existsSync(page), `${href} has no page.tsx`);
    }
  });

  it('every /legal route is registered for SEO and the marketplace preflight', () => {
    const nav = read('website/app/components/legal/LegalDocument.tsx');
    const slugs = [...nav.matchAll(/href:\s*"\/legal\/([^"]+)"/g)].map((m) => m[1]);
    const allUrls = read('website/app/lib/seo/all-urls.js');
    const sitemap = read('website/app/sitemap.ts');
    const preflight = read('scripts/marketplace-preflight.js');
    for (const s of slugs) {
      assert.ok(allUrls.includes(`"${s}"`) || allUrls.includes(`'${s}'`), `all-urls.js LEGAL_SLUGS missing ${s}`);
      assert.ok(sitemap.includes(`/legal/${s}`), `sitemap.ts missing /legal/${s}`);
      assert.ok(preflight.includes(`/legal/${s}`), `marketplace-preflight LEGAL_URLS missing /legal/${s}`);
    }
  });

  it('security.txt exists, points at the support mailbox, and is not about to expire', () => {
    const p = path.join(ROOT, 'website', 'public', '.well-known', 'security.txt');
    assert.ok(fs.existsSync(p), 'public/.well-known/security.txt missing');
    const txt = fs.readFileSync(p, 'utf8');
    assert.ok(txt.includes(`Contact: mailto:${facts.SUPPORT_EMAIL}`), 'Contact must be the support mailbox from site-url');
    const exp = /Expires:\s*(\S+)/.exec(txt);
    assert.ok(exp, 'Expires line required by RFC 9116');
    const daysLeft = (new Date(exp[1]) - Date.now()) / 86400000;
    assert.ok(daysLeft > 60, `security.txt expires in ${Math.round(daysLeft)} days — renew it`);
  });
});
