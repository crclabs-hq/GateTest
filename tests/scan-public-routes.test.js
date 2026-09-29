'use strict';
/**
 * The three public scan routes the 2026-09-29 admin audit flagged —
 * /api/scan/nuclear, /api/scan/server, /api/scan/guidance — read in full:
 *
 *   nuclear, server  public on purpose: DNS / TCP / TLS / HTTP probes of a
 *                    public host, no AI spend, nothing stored; SSRF-guarded
 *                    and rate limited. Each says so above its handler.
 *   guidance         AI spend on OUR key for an anonymous caller. Already had
 *                    a per-IP limiter and the daily server-key ceiling; now
 *                    also bounds each request's size (cleanGuidanceIssues)
 *                    before any model call, so one request's cost is capped
 *                    before the ceiling is asked. Non-string input no longer
 *                    crashes it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'website');
const read = (rel) => fs.readFileSync(path.join(WEB, ...rel.split('/')), 'utf8');
const input = require(path.join(WEB, 'app', 'lib', 'guidance-input.js'));

describe('cleanGuidanceIssues — bounds a guidance request before any model call', () => {
  it('keeps well-formed issues as they are', () => {
    assert.deepEqual(
      input.cleanGuidanceIssues([{ module: 'lint', detail: 'missing license' }]),
      [{ module: 'lint', detail: 'missing license' }],
    );
  });

  it('non-array / junk / non-string detail is dropped, never thrown on (was a 500)', () => {
    for (const raw of [undefined, null, 'x', 42, {}, { issues: [] }]) assert.deepEqual(input.cleanGuidanceIssues(raw), []);
    assert.deepEqual(
      input.cleanGuidanceIssues([null, 7, 'str', { module: 'a' }, { module: 'a', detail: 5 }, { module: 'a', detail: '   ' }, { detail: { toString: 1 } }]),
      [],
    );
  });

  it('a missing module is "unknown"; fields are trimmed', () => {
    assert.deepEqual(input.cleanGuidanceIssues([{ detail: '  x  ' }]), [{ module: 'unknown', detail: 'x' }]);
  });

  it('caps the issue count and every field length', () => {
    const huge = 'A'.repeat(1_000_000);
    const out = input.cleanGuidanceIssues(Array.from({ length: 500 }, () => ({ module: huge, detail: huge })));
    assert.equal(out.length, input.MAX_ISSUES);
    for (const i of out) {
      assert.equal(i.module.length, input.MAX_MODULE_CHARS);
      assert.equal(i.detail.length, input.MAX_DETAIL_CHARS);
    }
  });

  it('the bounds are the documented ones', () => {
    assert.deepEqual(
      [input.MAX_ISSUES, input.MAX_AI_ISSUES, input.MAX_MODULE_CHARS, input.MAX_DETAIL_CHARS],
      [50, 20, 100, 2000],
    );
  });
});

describe('/api/scan/guidance wiring', () => {
  const src = read('app/api/scan/guidance/route.ts');
  const handler = src.slice(src.indexOf('export async function POST('));

  it('cleans the body before anything else reads it', () => {
    assert.match(handler, /const issues = cleanGuidanceIssues\(body && typeof body === "object" \? body\.issues : undefined\);/);
    assert.doesNotMatch(handler, /body\.issues \|\| \[\]/);
  });

  it('order: limiter → bounded input → daily ceiling → at most MAX_AI_ISSUES model calls → spend recorded', () => {
    const at = (re) => { const m = re.exec(handler); assert.ok(m, `missing ${re}`); return m.index; };
    const limiter = at(/_guidanceLimiter\.guard\(req\)/);
    const ceiling = at(/await checkServerSpend\(\{\}\)/);
    const calls = at(/unmatched\.slice\(0, MAX_AI_ISSUES\)\.map\(\(issue\) => askClaudeGuidance\(issue, onUsage\)\)/);
    const record = at(/await recordServerSpend\(\{/);
    assert.ok(limiter < ceiling && ceiling < calls && calls < record);
  });
});

describe('/api/scan/nuclear and /api/scan/server are public on purpose, and say why', () => {
  for (const rel of ['app/api/scan/nuclear/route.ts', 'app/api/scan/server/route.ts']) {
    const src = read(rel);
    it(`${rel}: an auth-public comment naming "no AI spend", SSRF guard and rate limit, all enforced in code`, () => {
      const comment = src.slice(src.lastIndexOf('// auth-public', src.indexOf('export async function POST(')), src.indexOf('export async function POST('));
      assert.match(comment, /no AI spend/i);
      assert.match(comment, /rate limit/i);
      assert.match(src, /const validated = await resolveAndValidateUrl\(url\);\s*if \(!validated\.ok\)/);
      assert.match(src, /const _hostScanLimiter = createLimiter\(PRESETS\.webScan\);/);
      assert.match(src, /const rl = await _hostScanLimiter\.guard\(req\);\s*if \(!rl\.allowed\)/);
    });

    it(`${rel}: no model call, no key, nothing stored (the claim above is true)`, () => {
      assert.doesNotMatch(src, /ANTHROPIC_API_KEY|anthropic-config|engine-models|x-api-key/);
      assert.doesNotMatch(src, /getDb\(|INSERT INTO|recordUsage/);
    });
  }
});
