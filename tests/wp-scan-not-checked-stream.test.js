'use strict';

/**
 * Issue #699 — follow-up from #698. `/api/wp/scan/stream` never got the
 * #648 fix that `/api/web/scan/stream` has: its SSE `module:end` handler
 * read `.errors`/`.warnings` straight off the live TestResult instance
 * (always `undefined`) instead of `.toJSON()`, and never looked at a
 * check's own `notChecked` flag — so a WordPress live scan could tick a
 * not-checked module as checked in the stream while the completed card
 * said otherwise.
 *
 * Fix: the module:end serialisation is now ONE shared helper,
 * `buildModuleEndEvent()` in `website/app/lib/scan-stream-events.js`,
 * used by both `/api/web/scan/stream` and `/api/wp/scan/stream`. This file
 * (a) behaviourally proves the helper turns a fixture not-checked module
 * into the right event, on the same fixture the completed-card math uses,
 * and (b) proves both routes call that ONE function in their `module:end`
 * branch rather than each carrying its own copy of the detection logic.
 *
 * The routes are Next.js server routes (ReadableStream + require() of the
 * bundled engine entry) that aren't practical to execute directly in a
 * plain `node --test` file — `web-scan-not-checked-stream.test.js` follows
 * the same source-text-contract pattern for the same reason.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildModuleEndEvent } = require('../website/app/lib/scan-stream-events.js');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('buildModuleEndEvent — the one shared module:end serialisation', () => {
  it('a fixture module that reports not-checked produces the same event regardless of caller', () => {
    // Fixture: a file-scanner module given no live page on a URL-only scan
    // (the exact shape BaseModule#_notChecked() + TestResult#toJSON()
    // produce), fed through the helper the way BOTH routes' onProgress
    // hooks do.
    const fixtureModule = {
      toJSON: () => ({
        module: 'webHeaders',
        duration: 4,
        checks: [
          { name: 'web-headers:not-checked', passed: false, severity: 'info', notChecked: true, message: 'no live page was fetched for this scan' },
        ],
      }),
    };

    const webRouteEvent = buildModuleEndEvent(fixtureModule);
    const wpRouteEvent = buildModuleEndEvent(fixtureModule);

    assert.deepEqual(webRouteEvent, wpRouteEvent, 'the same fixture must produce an identical event through both routes');
    assert.deepEqual(webRouteEvent, {
      module: 'webHeaders',
      status: 'not-checked',
      reason: 'no live page was fetched for this scan',
      duration: 4,
    });
  });

  it('reads the real TestResult#toJSON() shape instead of undefined properties off the live instance', () => {
    const liveInstanceLookalike = {
      module: 'seo',
      // These would be read directly by the pre-fix code and always be
      // undefined on the live (non-JSON) instance.
      errors: undefined,
      warnings: undefined,
      toJSON: () => ({ module: 'seo', duration: 12, checks: [], errors: 2, warnings: 1, infoFindings: 0 }),
    };
    const event = buildModuleEndEvent(liveInstanceLookalike);
    assert.equal(event.status, 'checked');
    assert.equal(event.errors, 2);
    assert.equal(event.warnings, 1);
  });

  it('a clean module (no toJSON, plain object) still reports checked with its numbers', () => {
    const event = buildModuleEndEvent({ module: 'links', duration: 5, checks: [{ name: 'links:ok', passed: true }], errors: 0, warnings: 0, infoFindings: 0 });
    assert.deepEqual(event, { module: 'links', status: 'checked', errors: 0, warnings: 0, info: 0, duration: 5 });
  });

  it('the not-checked branch wins even when other checks on the same module passed', () => {
    const event = buildModuleEndEvent({
      toJSON: () => ({
        module: 'accessibility',
        duration: 7,
        checks: [
          { name: 'accessibility:alt-text', passed: true },
          { name: 'accessibility:not-checked', passed: false, notChecked: true, message: 'no live page was fetched for this scan' },
        ],
      }),
    });
    assert.equal(event.status, 'not-checked');
    assert.equal(event.reason, 'no live page was fetched for this scan');
  });

  it('falls back to a generic reason when the not-checked check carries no message', () => {
    const event = buildModuleEndEvent({ toJSON: () => ({ module: 'cookieSecurity', checks: [{ name: 'cookie-not-checked', passed: false, notChecked: true }] }) });
    assert.equal(event.reason, 'not checked');
  });
});

describe('/api/web/scan/stream and /api/wp/scan/stream — both import the ONE shared helper', () => {
  for (const rel of ['website/app/api/web/scan/stream/route.ts', 'website/app/api/wp/scan/stream/route.ts']) {
    it(`${rel} imports buildModuleEndEvent from scan-stream-events.js`, () => {
      const src = read(rel);
      assert.match(src, /require\("@\/app\/lib\/scan-stream-events"\)/);
      assert.match(src, /buildModuleEndEvent/);
    });

    it(`${rel}'s module:end handler delegates to buildModuleEndEvent, with no local copy of the detection logic`, () => {
      const src = read(rel);
      const idx = src.indexOf('if (event === "module:end")');
      assert.ok(idx > -1, 'module:end handler not found');
      const body = src.slice(idx, idx + 700);
      assert.match(body, /send\(event,\s*buildModuleEndEvent\(payload\)\)/);
      // The old per-route copy is gone — no route re-implements the
      // notChecked scan or the toJSON() unwrap itself.
      assert.ok(!/notCheckedCheck/.test(body), `${rel} must not carry its own not-checked detection copy`);
      assert.ok(!/raw\.toJSON/.test(body), `${rel} must not carry its own toJSON() unwrap copy`);
    });
  }
});

describe('website/app/lib/scan-stream-events.js — single definition, not duplicated in either route', () => {
  it('neither route file defines its own notChecked-detection or toJSON-unwrap logic outside the shared import', () => {
    for (const rel of ['website/app/api/web/scan/stream/route.ts', 'website/app/api/wp/scan/stream/route.ts']) {
      const src = read(rel);
      assert.ok(!/const notCheckedCheck/.test(src), `${rel} still has an inline notCheckedCheck copy`);
    }
  });

  it('the helper module exports exactly buildModuleEndEvent', () => {
    const mod = require('../website/app/lib/scan-stream-events.js');
    assert.deepEqual(Object.keys(mod), ['buildModuleEndEvent']);
    assert.equal(typeof mod.buildModuleEndEvent, 'function');
  });
});
