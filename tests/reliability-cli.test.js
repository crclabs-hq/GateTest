"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  loadCorpus,
  walkForManifests,
  renderCorpusSummary,
  isSkippable,
} = require("../website/app/lib/reliability/corpus-loader.js");

const { runReliabilityCli, renderSuiteMarkdown } = require("../website/app/lib/reliability/cli-runner.js");

// ---------------------------------------------------------------------------
// In-memory fs adapter
// ---------------------------------------------------------------------------

function makeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  for (const p of files.keys()) {
    let d = path.dirname(p);
    while (d && d !== "." && d !== "/") {
      dirs.add(d);
      d = path.dirname(d);
    }
  }
  return {
    files,
    existsSync: (p) => files.has(p) || dirs.has(p),
    readdirSync: (p, opts) => {
      const out = [];
      const seen = new Set();
      for (const f of files.keys()) {
        if (f.startsWith(p + "/") || f.startsWith(p + path.sep)) {
          const rest = f.slice(p.length + 1);
          const first = rest.split(/[\\/]/)[0];
          if (seen.has(first)) continue;
          seen.add(first);
          const fullChild = path.join(p, first);
          const isDir = !files.has(fullChild);
          if (opts && opts.withFileTypes) {
            out.push({ name: first, isDirectory: () => isDir });
          } else {
            out.push(first);
          }
        }
      }
      return out;
    },
    readFileSync: (p) => {
      if (!files.has(p)) {
        const e = new Error("ENOENT " + p);
        e.code = "ENOENT";
        throw e;
      }
      return files.get(p);
    },
    statSync: (p) => ({ mtimeMs: Date.now() }),
  };
}

// ---------------------------------------------------------------------------
// isSkippable
// ---------------------------------------------------------------------------

test("isSkippable: hidden + skip dirs + underscore-prefixed", () => {
  assert.equal(isSkippable(".git"), true);
  assert.equal(isSkippable("baselines"), true);
  assert.equal(isSkippable("_drafts"), true);
  assert.equal(isSkippable("known-bad"), false);
  assert.equal(isSkippable(""), true);
});

// ---------------------------------------------------------------------------
// walkForManifests
// ---------------------------------------------------------------------------

test("walkForManifests: returns manifest paths only", () => {
  const fs = makeFs({
    "/corpus/known-bad/a/manifest.json": "{}",
    "/corpus/known-bad/a/src/index.js": "code",
    "/corpus/known-good/b/manifest.json": "{}",
    "/corpus/baselines/c.json": "ignored",
  });
  const found = walkForManifests("/corpus", fs);
  assert.equal(found.length, 2);
  assert.ok(found.every((p) => p.endsWith("manifest.json")));
  // baselines/ dir is skipped
  assert.ok(!found.some((p) => p.includes("baselines")));
});

test("walkForManifests: missing root → empty list (no throw)", () => {
  const fs = makeFs({});
  assert.deepEqual(walkForManifests("/missing", fs), []);
});

// ---------------------------------------------------------------------------
// loadCorpus
// ---------------------------------------------------------------------------

const VALID = JSON.stringify({
  name: "case-a",
  category: "known-bad",
  tier: "full",
  expected: { totalErrorsAtLeast: 1 },
});

const VALID_GOOD = JSON.stringify({
  name: "case-b",
  category: "known-good",
  tier: "quick",
});

const VALID_URL = JSON.stringify({
  name: "site-c",
  category: "url-known-good",
  tier: "quick",
  url: "https://example.com",
});

test("loadCorpus: valid manifests collected; invalid ones reported with reasons", () => {
  const fs = makeFs({
    "/c/known-bad/a/manifest.json": VALID,
    "/c/known-good/b/manifest.json": VALID_GOOD,
    "/c/broken/x/manifest.json": "{ this is not json",
    "/c/url-known-good/c/manifest.json": VALID_URL,
  });
  const loaded = loadCorpus("/c", fs);
  assert.equal(loaded.cases.length, 3);
  assert.equal(loaded.invalid.length, 1);
  assert.match(loaded.invalid[0].errors[0], /json parse/);
});

test("loadCorpus: cases sorted by category then name", () => {
  const fs = makeFs({
    "/c/url-known-good/z/manifest.json": JSON.stringify({
      name: "z", category: "url-known-good", tier: "quick", url: "https://z",
    }),
    "/c/known-bad/y/manifest.json": JSON.stringify({
      name: "y", category: "known-bad", tier: "full",
    }),
    "/c/known-bad/a/manifest.json": JSON.stringify({
      name: "a", category: "known-bad", tier: "full",
    }),
  });
  const loaded = loadCorpus("/c", fs);
  const order = loaded.cases.map((c) => `${c.manifest.category}/${c.manifest.name}`);
  assert.deepEqual(order, ["known-bad/a", "known-bad/y", "url-known-good/z"]);
});

// ---------------------------------------------------------------------------
// renderCorpusSummary
// ---------------------------------------------------------------------------

test("renderCorpusSummary: includes counts by category", () => {
  const fs = makeFs({
    "/c/known-bad/a/manifest.json": VALID,
    "/c/known-good/b/manifest.json": VALID_GOOD,
  });
  const loaded = loadCorpus("/c", fs);
  const md = renderCorpusSummary(loaded);
  assert.match(md, /2 cases loaded/);
  assert.match(md, /known-bad/);
  assert.match(md, /known-good/);
});

// ---------------------------------------------------------------------------
// runReliabilityCli
// ---------------------------------------------------------------------------

test("runReliabilityCli: missing corpusRoot → exitCode 2", async () => {
  const r = await runReliabilityCli({});
  assert.equal(r.exitCode, 2);
});

test("runReliabilityCli: empty corpus → exitCode 2 with explanation", async () => {
  const r = await runReliabilityCli({ corpusRoot: "/empty", _fs: makeFs({}) });
  assert.equal(r.exitCode, 2);
  assert.match(r.output, /No valid cases/);
});

test("runReliabilityCli: URL-only filter limits cases", async () => {
  const fs = makeFs({
    "/c/known-bad/a/manifest.json": VALID,
    "/c/url-known-good/u/manifest.json": VALID_URL,
  });
  const mockFetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => "",
  });
  const r = await runReliabilityCli({
    corpusRoot: "/c",
    urlOnly: true,
    _fs: fs,
    _fetch: mockFetch,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.total, 1);
});

test("runReliabilityCli: code-only filter limits cases", async () => {
  const fs = makeFs({
    "/c/known-bad/a/manifest.json": VALID,
    "/c/url-known-good/u/manifest.json": VALID_URL,
  });
  // No gatetestBin and no _exec → code scan returns "no-code-scanner-adapter"
  // but the case is still INCLUDED in the suite (count == 1)
  const r = await runReliabilityCli({
    corpusRoot: "/c",
    codeOnly: true,
    _fs: fs,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.total, 1);
});

test("runReliabilityCli: never returns non-zero on case failures (painkiller)", async () => {
  const fs = makeFs({
    "/c/known-bad/x/manifest.json": JSON.stringify({
      name: "x",
      category: "known-bad",
      tier: "full",
      // Expects at least 1 error but mock returns none → case will FAIL
      expected: { totalErrorsAtLeast: 1 },
    }),
  });
  const r = await runReliabilityCli({
    corpusRoot: "/c",
    _fs: fs,
    // No gatetestBin → case fails (no-code-scanner-adapter)
  });
  // exit code must be 0 despite suite.failed >= 1
  assert.equal(r.exitCode, 0);
});

test("runReliabilityCli: JSON mode emits valid JSON output", async () => {
  const fs = makeFs({ "/c/known-good/a/manifest.json": VALID_GOOD });
  const r = await runReliabilityCli({ corpusRoot: "/c", json: true, _fs: fs });
  const parsed = JSON.parse(r.output);
  // Output now wraps the suite under .suite (alongside .captureResult /
  // .driftPerCase from the baseline pipeline).
  assert.ok(parsed.suite);
  assert.ok(parsed.suite.total >= 1);
  assert.ok(Array.isArray(parsed.suite.results));
});

test("runReliabilityCli: category filter applied", async () => {
  const fs = makeFs({
    "/c/known-bad/a/manifest.json": VALID,
    "/c/known-good/b/manifest.json": VALID_GOOD,
  });
  const r = await runReliabilityCli({
    corpusRoot: "/c",
    includeCategories: ["known-good"],
    _fs: fs,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.total, 1);
});

// ---------------------------------------------------------------------------
// renderSuiteMarkdown
// ---------------------------------------------------------------------------

test("renderSuiteMarkdown: highlights failing cases", () => {
  const md = renderSuiteMarkdown({
    total: 2, passed: 1, failed: 1, passRate: 0.5, durationMs: 1234,
    results: [
      { name: "ok-case", category: "known-good", target: "code", passed: true, issues: [], durationMs: 100 },
      { name: "broken", category: "known-bad", target: "code", passed: false, issues: ["expected error not found"], totals: { errors: 0, warnings: 0 }, durationMs: 200 },
    ],
  }, { invalid: [] });
  assert.match(md, /Failing cases \(1\)/);
  assert.match(md, /broken/);
  assert.match(md, /expected error not found/);
});

test("renderSuiteMarkdown: all-pass shows celebration line", () => {
  const md = renderSuiteMarkdown({
    total: 1, passed: 1, failed: 0, passRate: 1, durationMs: 100,
    results: [{ name: "x", category: "known-good", target: "code", passed: true, issues: [], durationMs: 100 }],
  }, { invalid: [] });
  assert.match(md, /All cases passed/);
});
