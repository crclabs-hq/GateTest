/**
 * Cross-product platform registry.
 *
 * The bug this defends against actually shipped. The three sibling status
 * URLs were written out twice — once in the PUBLIC /api/platform-status map
 * that other products discover us through, once in the admin health
 * aggregator. In 2026-07 someone measured `vapron.ai/api/platform-status` at
 * 404, found the real endpoint on `api.vapron.ai`, and fixed only the admin
 * copy — leaving a comment in that file explaining the 404 while the public
 * map kept serving it. Re-measured 2026-09-01: still 404, five weeks later.
 *
 * Knowing a URL is dead in one file and advertising it in another is the
 * defect, and "remember to update both" is not a fix. These tests defend:
 *   1. One registry decides where a sibling lives.
 *   2. An env var can repoint a sibling without a code change.
 *   3. Our own entry stays derived from the canonical-domain env var.
 *   4. The specific dead URL cannot come back.
 *   5. A new URL literal cannot creep into either route.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  SIBLING_REGISTRY, resolveSiblingUrl, siblingUrlMap,
} = require('../website/app/lib/platform-siblings');

const REPO = path.join(__dirname, '..');

// Both routes that render sibling URLs. If a third appears, add it here —
// that is the whole point of the guard.
const GUARDED = [
  'website/app/api/platform-status/route.ts',
  'website/app/api/admin/platform-siblings/route.ts',
];

describe('platform-siblings — registry', () => {
  it('covers all three products', () => {
    const ids = SIBLING_REGISTRY.map((s) => s.id).sort();
    assert.deepStrictEqual(ids, ['gatetest', 'gluecron', 'tallrig']);
  });

  it('every entry carries the env var that repoints it', () => {
    for (const s of SIBLING_REGISTRY) {
      assert.ok(s.envVar, `${s.id} has no envVar`);
      assert.match(s.envVar, /^[A-Z0-9_]+$/, `${s.id} envVar is not an env name`);
    }
  });

  it('an env var overrides the default', () => {
    const platform = SIBLING_REGISTRY.find((s) => s.id === 'tallrig');
    assert.strictEqual(
      resolveSiblingUrl(platform, { VAPRON_STATUS_URL: 'https://staging.example/s' }), // the pre-rename name still repoints it
      'https://staging.example/s',
    );
  });

  it('resolves a full map of absolute URLs', () => {
    const map = siblingUrlMap({});
    for (const [id, url] of Object.entries(map)) {
      assert.match(url, /^https?:\/\//, `${id} resolved to a non-absolute URL: ${url}`);
    }
  });
});

describe('platform-siblings — the dead URLs cannot return', () => {
  // `/api/platform-status` has never existed anywhere in Vapron. BOTH URLs
  // this registry has historically carried were built on that path: the
  // marketing-host one (404) and the api-host one (401, which was mistaken for
  // proof of life). Neither hostname is the issue — the path is.
  it('does not point the platform at the path it never shipped', () => {
    const url = siblingUrlMap({}).tallrig;
    assert.ok(
      !/platform-status/.test(url),
      `platform URL uses /platform-status, a path that does not exist there: ${url}`,
    );
  });

  it('points the platform (Tallrig) at its real public status document', () => {
    // Measured 2026-09-01 on vapron.ai and 2026-09-15 on tallrig.com: 200, unauthenticated, body carries overall+services.
    // Not /api/health — that is a bare liveness ping.
    assert.strictEqual(
      siblingUrlMap({}).tallrig,
      'https://tallrig.com/api/health/status',
    );
  });

  it('does not mark the platform key-gated — its status contract is public', () => {
    // If this ever flips back to true, something has re-pointed the entry at
    // the /api/platform/ tree, where a 401 is returned for every path
    // including invented ones and therefore proves nothing.
    const platform = SIBLING_REGISTRY.find((s) => s.id === 'tallrig');
    assert.strictEqual(platform.requiresAuth, false);
  });
});

describe('platform-siblings — our own entry stays derived', () => {
  it('follows the canonical-domain env var rather than a literal', () => {
    const map = siblingUrlMap({ NEXT_PUBLIC_BASE_URL: 'https://example.test' });
    assert.strictEqual(map.gatetest, 'https://example.test/api/platform-status');
  });

  it('has no hardcoded default of its own', () => {
    const self = SIBLING_REGISTRY.find((s) => s.id === 'gatetest');
    assert.strictEqual(self.defaultUrl, null);
  });
});

describe('platform-siblings — no second copy', () => {
  // Matches a quoted absolute URL naming a status endpoint. Comment lines are
  // exempt: a URL in prose cannot be served, and the comments here deliberately
  // cite the dead vapron.ai path as the reason the registry exists. What must
  // not reappear is a URL *literal in code* that a route could hand out.
  const URL_LITERAL = /["'`]https?:\/\/[^"'`\s]*platform-status/;
  const IS_COMMENT = /^\s*(\/\/|\*|\/\*)/;

  for (const rel of GUARDED) {
    it(`${rel} contains no sibling URL literal`, () => {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      const offenders = src
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => URL_LITERAL.test(line) && !IS_COMMENT.test(line));

      assert.deepStrictEqual(
        offenders,
        [],
        `${rel} hardcodes a sibling status URL — import it from ` +
        `app/lib/platform-siblings.js instead:\n` +
        offenders.map((o) => `  line ${o.n}: ${o.line}`).join('\n'),
      );
    });

    it(`${rel} imports the shared registry`, () => {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      assert.match(
        src,
        /from "@\/app\/lib\/platform-siblings"/,
        `${rel} should build its sibling list from the shared registry`,
      );
    });
  }
});
