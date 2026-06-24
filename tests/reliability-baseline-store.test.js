"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  buildBaseline,
  writeBaseline,
  readBaseline,
  captureBaselines,
  compareCaseToBaseline,
  baselinePath,
  BASELINE_VERSION,
} = require("../website/app/lib/reliability/baseline-store.js");

const { runReliabilityCli } = require("../website/app/lib/reliability/cli-runner.js");

// ---------------------------------------------------------------------------
// In-memory fs adapter
// ---------------------------------------------------------------------------

function makeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  function addDirs(p) {
    let d = path.dirname(p);
    while (d && d !== "." && d !== "/") {
      dirs.add(d);
      d = path.dirname(d);
    }
  }
  for (const p of files.keys()) addDirs(p);
  return {
    files,
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) {
        const e = new Error("ENOENT " + p);
        e.code = "ENOENT";
        throw e;
      }
      return files.get(p);
    },
    writeFileSync: (p, data) => { files.set(p, data); addDirs(p); },
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    unlinkSync: (p) => { files.delete(p); },
    mkdirSync: (p) => { dirs.add(p); },
    readdirSync: (p, opts) => {
      const out = new Set();
      for (const f of files.keys()) {
        if (f.startsWith(p + "/") || f.startsWith(p + path.sep)) {
          const rest = f.slice(p.length + 1);
          const first = rest.split(/[\\/]/)[0];
          if (opts && opts.withFileTypes) {
            const fullChild = path.join(p, first);
            const isDir = !files.has(fullChild);
            if (!out.has(first)) {
              out.add(first);
              // We have to dedupe and produce just-one
            }
          } else {
            out.add(first);
          }
        }
      }
      if (opts && opts.withFileTypes) {
        return Array.from(out).map((n) => {
          const fullChild = path.join(p, n);
          return { name: n, isDirectory: () => !files.has(fullChild) };
        });
      }
      return Array.from(out);
    },
    statSync: (p) => ({ mtimeMs: Date.now() }),
  };
}

const SAMPLE_RESULT = {
  name: "case-a",
  category: "known-bad",
  tier: "full",
  target: "code",
  findingsByModule: { moneyFloat: { errors: 2, warnings: 0, info: 0 } },
  totals: { errors: 2, warnings: 0, info: 0 },
  durationMs: 100,
  passed: true,
};

// ---------------------------------------------------------------------------
// buildBaseline
// ---------------------------------------------------------------------------

test("buildBaseline: requires caseResult.name", () => {
  assert.throws(() => buildBaseline({ caseResult: {} }), TypeError);
});

test("buildBaseline: extracts the right fields, drops volatile ones", () => {
  const b = buildBaseline({ caseResult: SAMPLE_RESULT });
  assert.equal(b.version, BASELINE_VERSION);
  assert.equal(b.name, "case-a");
  assert.equal(b.category, "known-bad");
  assert.equal(b.passed, true);
  assert.deepEqual(b.totals, { errors: 2, warnings: 0, info: 0 });
  // No durationMs / peakMemoryMb stored
  assert.equal(b.durationMs, undefined);
  assert.equal(b.peakMemoryMb, undefined);
});

test("buildBaseline: honours capturedBy / capturedFrom metadata", () => {
  const b = buildBaseline({
    caseResult: SAMPLE_RESULT,
    runMetadata: { capturedBy: "alice-laptop", capturedFrom: "manual" },
  });
  assert.equal(b.capturedBy, "alice-laptop");
  assert.equal(b.capturedFrom, "manual");
});

// ---------------------------------------------------------------------------
// baselinePath
// ---------------------------------------------------------------------------

test("baselinePath: resolves under <corpusRoot>/baselines/<name>.json", () => {
  const p = baselinePath({ corpusRoot: "/c", caseName: "case-a" });
  assert.equal(p, path.join("/c", "baselines", "case-a.json"));
});

test("baselinePath: throws on missing args", () => {
  assert.throws(() => baselinePath({ corpusRoot: "/c" }), TypeError);
});

// ---------------------------------------------------------------------------
// writeBaseline + readBaseline round-trip
// ---------------------------------------------------------------------------

test("writeBaseline + readBaseline: round-trip preserves data", () => {
  const fs = makeFs({});
  const baseline = buildBaseline({ caseResult: SAMPLE_RESULT });
  const writeRes = writeBaseline({ baseline, corpusRoot: "/c", _fs: fs });
  assert.equal(writeRes.written, true);
  const read = readBaseline({ corpusRoot: "/c", caseName: "case-a", _fs: fs });
  assert.equal(read.name, "case-a");
  assert.deepEqual(read.totals, baseline.totals);
});

test("readBaseline: missing baseline → null", () => {
  const fs = makeFs({});
  assert.equal(readBaseline({ corpusRoot: "/c", caseName: "missing", _fs: fs }), null);
});

test("readBaseline: malformed JSON → null (does not throw)", () => {
  const fs = makeFs({ "/c/baselines/x.json": "{ broken" });
  assert.equal(readBaseline({ corpusRoot: "/c", caseName: "x", _fs: fs }), null);
});

// ---------------------------------------------------------------------------
// captureBaselines
// ---------------------------------------------------------------------------

test("captureBaselines: writes one baseline per result", () => {
  const fs = makeFs({});
  const out = captureBaselines({
    suiteRun: { results: [SAMPLE_RESULT, { ...SAMPLE_RESULT, name: "case-b" }] },
    corpusRoot: "/c",
    _fs: fs,
  });
  assert.equal(out.length, 2);
  assert.equal(out.every((o) => o.status === "written"), true);
});

test("captureBaselines: invalid suiteRun → TypeError", () => {
  assert.throws(() => captureBaselines({}), TypeError);
});

// ---------------------------------------------------------------------------
// compareCaseToBaseline
// ---------------------------------------------------------------------------

test("compareCaseToBaseline: no baseline → no-baseline status", () => {
  const fs = makeFs({});
  const r = compareCaseToBaseline({ caseResult: SAMPLE_RESULT, corpusRoot: "/c", _fs: fs });
  assert.equal(r.status, "no-baseline");
});

test("compareCaseToBaseline: identical → matches", () => {
  const fs = makeFs({});
  writeBaseline({
    baseline: buildBaseline({ caseResult: SAMPLE_RESULT }),
    corpusRoot: "/c",
    _fs: fs,
  });
  const r = compareCaseToBaseline({ caseResult: SAMPLE_RESULT, corpusRoot: "/c", _fs: fs });
  assert.equal(r.status, "matches");
  assert.deepEqual(r.drift, []);
});

test("compareCaseToBaseline: errors increased → drift surfaces delta", () => {
  const fs = makeFs({});
  writeBaseline({
    baseline: buildBaseline({ caseResult: SAMPLE_RESULT }),
    corpusRoot: "/c",
    _fs: fs,
  });
  const r = compareCaseToBaseline({
    caseResult: { ...SAMPLE_RESULT, totals: { errors: 4, warnings: 1, info: 0 } },
    corpusRoot: "/c",
    _fs: fs,
  });
  assert.equal(r.status, "drift");
  assert.ok(r.drift.some((d) => d.includes("totals.errors: +2")));
  assert.ok(r.drift.some((d) => d.includes("totals.warnings: +1")));
});

test("compareCaseToBaseline: passed flip → drift", () => {
  const fs = makeFs({});
  writeBaseline({
    baseline: buildBaseline({ caseResult: { ...SAMPLE_RESULT, passed: true } }),
    corpusRoot: "/c",
    _fs: fs,
  });
  const r = compareCaseToBaseline({
    caseResult: { ...SAMPLE_RESULT, passed: false },
    corpusRoot: "/c",
    _fs: fs,
  });
  assert.equal(r.status, "drift");
  assert.ok(r.drift.some((d) => d.includes("passed flipped")));
});

test("compareCaseToBaseline: per-module delta detected", () => {
  const fs = makeFs({});
  writeBaseline({
    baseline: buildBaseline({ caseResult: SAMPLE_RESULT }),
    corpusRoot: "/c",
    _fs: fs,
  });
  const r = compareCaseToBaseline({
    caseResult: {
      ...SAMPLE_RESULT,
      findingsByModule: { moneyFloat: { errors: 1, warnings: 0, info: 0 } },
      totals: { errors: 1, warnings: 0, info: 0 },
    },
    corpusRoot: "/c",
    _fs: fs,
  });
  assert.equal(r.status, "drift");
  assert.ok(r.drift.some((d) => d.includes("moneyFloat.errors: was 2, now 1")));
});

// ---------------------------------------------------------------------------
// CLI integration with --capture-baselines / --compare-baselines
// ---------------------------------------------------------------------------

const VALID_MANIFEST = JSON.stringify({
  name: "x",
  category: "known-good",
  tier: "quick",
});

test("CLI: --capture-baselines writes baseline files", async () => {
  const fs = makeFs({ "/c/known-good/x/manifest.json": VALID_MANIFEST });
  const r = await runReliabilityCli({
    corpusRoot: "/c",
    captureBaselines: true,
    _fs: fs,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.baselinesWritten, 1);
  // Baseline file should now exist
  assert.ok(fs.existsSync("/c/baselines/x.json"));
});

test("CLI: --compare-baselines with no prior baselines reports no-baseline", async () => {
  const fs = makeFs({ "/c/known-good/x/manifest.json": VALID_MANIFEST });
  const r = await runReliabilityCli({
    corpusRoot: "/c",
    compareBaselines: true,
    _fs: fs,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.casesWithoutBaseline, 1);
});
