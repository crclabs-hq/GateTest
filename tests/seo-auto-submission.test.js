"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateIndexNowKey,
  isValidKey,
  partitionByOriginValid,
  submitUrls,
  INDEXNOW_ENDPOINT,
  HOST,
  MAX_URLS_PER_BATCH,
  SOFT_RATE_LIMIT,
} = require("../website/app/lib/seo/indexnow.js");

const {
  pingEngine,
  pingAllEngines,
  ENGINES,
  SITEMAP_URL,
} = require("../website/app/lib/seo/sitemap-ping.js");

const {
  buildAllUrls,
  readModuleNamesFromSource,
  moduleNameToSlug,
  COMPARISON_SLUGS,
  FOR_SLUGS,
  LEGAL_SLUGS,
} = require("../website/app/lib/seo/all-urls.js");

// ---------------------------------------------------------------------------
// indexnow.js
// ---------------------------------------------------------------------------

test("generateIndexNowKey: 32-char hex", () => {
  const k = generateIndexNowKey();
  assert.equal(k.length, 32);
  assert.match(k, /^[a-f0-9]+$/);
});

test("generateIndexNowKey: unique each call", () => {
  const set = new Set();
  for (let i = 0; i < 50; i++) set.add(generateIndexNowKey());
  assert.equal(set.size, 50);
});

test("isValidKey: enforces protocol shape (8-128 alphanumeric+hyphen)", () => {
  assert.equal(isValidKey("a".repeat(8)), true);
  assert.equal(isValidKey("a".repeat(128)), true);
  assert.equal(isValidKey("a".repeat(129)), false);
  assert.equal(isValidKey("short"), false);
  assert.equal(isValidKey("contains_underscore_invalid"), false);
  assert.equal(isValidKey("has space"), false);
  assert.equal(isValidKey(""), false);
  assert.equal(isValidKey(null), false);
});

test("partitionByOriginValid: only allows our host on HTTPS", () => {
  const r = partitionByOriginValid([
    "https://gatetest.ai/",
    "https://gatetest.ai/modules",
    "https://evil.example.com/inject",
    "http://gatetest.ai/insecure",
    "not a url",
    null,
  ]);
  assert.equal(r.valid.length, 2);
  assert.ok(r.rejected.some((x) => x.reason.includes("host-mismatch")));
  assert.ok(r.rejected.some((x) => x.reason === "must-be-https"));
  assert.ok(r.rejected.some((x) => x.reason === "malformed-url"));
});

test("submitUrls: rejects invalid key before fetching", async () => {
  await assert.rejects(
    submitUrls({ urls: [`https://${HOST}/`], key: "short", _fetch: async () => ({}) }),
    TypeError
  );
});

test("submitUrls: posts to IndexNow endpoint with right body shape", async () => {
  let captured;
  const _fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { status: 200, ok: true };
  };
  const key = "a".repeat(16);
  const r = await submitUrls({
    urls: [`https://${HOST}/`, `https://${HOST}/modules`],
    key,
    _fetch,
  });
  assert.equal(captured.url, INDEXNOW_ENDPOINT);
  assert.equal(captured.body.host, HOST);
  assert.equal(captured.body.key, key);
  assert.equal(captured.body.keyLocation, `https://${HOST}/${key}.txt`);
  assert.deepEqual(captured.body.urlList, [`https://${HOST}/`, `https://${HOST}/modules`]);
  assert.equal(r.submitted, 2);
});

test("submitUrls: batches at SOFT_RATE_LIMIT", async () => {
  let batchesSeen = 0;
  const _fetch = async () => { batchesSeen += 1; return { status: 200, ok: true }; };
  const urls = Array.from({ length: SOFT_RATE_LIMIT * 2 + 5 }, (_, i) => `https://${HOST}/url-${i}`);
  const r = await submitUrls({ urls, key: "k".repeat(16), _fetch });
  assert.equal(batchesSeen, 3); // 1000 + 1000 + 5
  assert.equal(r.submitted, urls.length);
});

test("submitUrls: rejected URLs surface in result", async () => {
  const _fetch = async () => ({ status: 200, ok: true });
  const r = await submitUrls({
    urls: [`https://${HOST}/ok`, "https://evil.example/bad"],
    key: "k".repeat(16),
    _fetch,
  });
  assert.equal(r.submitted, 1);
  assert.equal(r.rejected.length, 1);
});

test("submitUrls: empty after filter → no fetch, returns submitted:0", async () => {
  let called = false;
  const _fetch = async () => { called = true; return { status: 200, ok: true }; };
  const r = await submitUrls({
    urls: ["https://evil.example/bad"],
    key: "k".repeat(16),
    _fetch,
  });
  assert.equal(called, false);
  assert.equal(r.submitted, 0);
});

test("submitUrls: network error captured per batch", async () => {
  const _fetch = async () => { throw new Error("network down"); };
  const r = await submitUrls({
    urls: [`https://${HOST}/x`],
    key: "k".repeat(16),
    _fetch,
  });
  assert.equal(r.submitted, 0);
  assert.equal(r.batches[0].ok, false);
  assert.match(r.batches[0].error, /network down/);
});

test("MAX_URLS_PER_BATCH respects the IndexNow protocol cap", () => {
  assert.equal(MAX_URLS_PER_BATCH, 10000);
});

// ---------------------------------------------------------------------------
// sitemap-ping.js
// ---------------------------------------------------------------------------

test("ENGINES: covers Bing + Yandex", () => {
  assert.ok(typeof ENGINES.bing === "function");
  assert.ok(typeof ENGINES.yandex === "function");
});

test("pingEngine: unknown engine returns error result (does not throw)", async () => {
  const r = await pingEngine({ engine: "nonsense", _fetch: async () => ({ status: 200, ok: true }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown-engine/);
});

test("pingEngine: success → ok:true with correct URL shape", async () => {
  let capturedUrl;
  const _fetch = async (url) => {
    capturedUrl = url;
    return { status: 200, ok: true };
  };
  const r = await pingEngine({ engine: "bing", _fetch });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.match(capturedUrl, /bing\.com\/ping\?sitemap=/);
  assert.match(decodeURIComponent(capturedUrl), /sitemap\.xml/);
});

test("pingEngine: network error captured", async () => {
  const _fetch = async () => { throw new Error("EAI_AGAIN"); };
  const r = await pingEngine({ engine: "bing", _fetch });
  assert.equal(r.ok, false);
  assert.match(r.error, /EAI_AGAIN/);
});

test("pingAllEngines: results for every engine, parallel", async () => {
  let calls = 0;
  const _fetch = async () => { calls += 1; return { status: 200, ok: true }; };
  const r = await pingAllEngines({ _fetch });
  assert.equal(r.length, Object.keys(ENGINES).length);
  assert.ok(r.every((x) => x.ok));
  assert.equal(calls, Object.keys(ENGINES).length);
});

test("SITEMAP_URL is the canonical https://gatetest.ai/sitemap.xml", () => {
  assert.equal(SITEMAP_URL, "https://gatetest.ai/sitemap.xml");
});

// ---------------------------------------------------------------------------
// all-urls.js
// ---------------------------------------------------------------------------

test("moduleNameToSlug: matches the TS implementation", () => {
  assert.equal(moduleNameToSlug("moneyFloat"), "money-float");
  assert.equal(moduleNameToSlug("tlsSecurity"), "tls-security");
  assert.equal(moduleNameToSlug("ssrf"), "ssrf");
  assert.equal(moduleNameToSlug("crossFileTaint"), "cross-file-taint");
});

test("readModuleNamesFromSource: parses module names out of the live TS file", () => {
  const names = readModuleNamesFromSource();
  // Sanity bound — should hit the actual 104+ modules in modules-data.ts
  assert.ok(names.length >= 100, `expected >= 100 modules, got ${names.length}`);
});

test("buildAllUrls: includes home, modules index, all comparisons, all for, all legal", () => {
  const urls = buildAllUrls();
  assert.ok(urls.includes("https://gatetest.ai"));
  assert.ok(urls.includes("https://gatetest.ai/modules"));
  for (const slug of COMPARISON_SLUGS) {
    assert.ok(urls.includes(`https://gatetest.ai/compare/${slug}`));
  }
  for (const slug of FOR_SLUGS) {
    assert.ok(urls.includes(`https://gatetest.ai/for/${slug}`));
  }
  for (const slug of LEGAL_SLUGS) {
    assert.ok(urls.includes(`https://gatetest.ai/legal/${slug}`));
  }
});

test("buildAllUrls: every URL is HTTPS on gatetest.ai (no leaks)", () => {
  const urls = buildAllUrls();
  for (const url of urls) {
    assert.ok(url.startsWith("https://gatetest.ai"), `non-canonical URL leaked: ${url}`);
  }
});

test("buildAllUrls: emits a URL for every module slug (deduped)", () => {
  const urls = buildAllUrls();
  const moduleUrls = urls.filter((u) => u.startsWith("https://gatetest.ai/modules/"));
  // Sanity — should hit the full module set + the index
  assert.ok(moduleUrls.length >= 100, `expected >= 100 module URLs, got ${moduleUrls.length}`);
  // No duplicates
  assert.equal(new Set(moduleUrls).size, moduleUrls.length);
});
