"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  scanCode,
  createCodeScannerAdapter,
  findLatestReport,
  reportToFindings,
} = require("../website/app/lib/reliability/code-scanner-adapter.js");

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
  const stats = new Map();
  for (const p of files.keys()) stats.set(p, { mtimeMs: Date.now() });

  return {
    files,
    dirs,
    existsSync: (p) => files.has(p) || dirs.has(p),
    readdirSync: (p) => {
      const out = new Set();
      for (const f of files.keys()) {
        if (f.startsWith(p + "/") || f.startsWith(p + path.sep)) {
          const rest = f.slice(p.length + 1);
          out.add(rest.split(/[\\/]/)[0]);
        }
      }
      return Array.from(out);
    },
    statSync: (p) => stats.get(p) || { mtimeMs: Date.now() },
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error("ENOENT " + p);
      return files.get(p);
    },
    writeFileSync: (p, data) => { files.set(p, data); },
    setMtime(p, ms) { stats.set(p, { mtimeMs: ms }); },
  };
}

function makeExec(impl) {
  const calls = [];
  return {
    calls,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return impl ? impl({ cmd, args, opts }) : { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

// ---------------------------------------------------------------------------
// reportToFindings
// ---------------------------------------------------------------------------

test("reportToFindings: extracts failed checks across modules", () => {
  const report = {
    results: [
      {
        module: "money-float",
        checks: [
          { passed: false, severity: "error", file: "/repo/x.js", line: 1, name: "py-float", message: "float on money" },
          { passed: true, severity: "info", file: "/repo/y.js", line: 2, name: "ok", message: "ok" },
        ],
      },
      {
        module: "lint",
        checks: [
          { passed: false, severity: "warning", file: "/repo/a.js", line: 5, name: "no-console", message: "console.log" },
        ],
      },
    ],
  };
  const findings = reportToFindings(report, "/repo");
  assert.equal(findings.length, 2);
  assert.equal(findings[0].module, "money-float");
  assert.equal(findings[0].file, "x.js");
  assert.equal(findings[0].rule, "py-float");
  assert.equal(findings[1].severity, "warning");
});

test("reportToFindings: empty / missing fields handled", () => {
  assert.deepEqual(reportToFindings(null), []);
  assert.deepEqual(reportToFindings({}), []);
  assert.deepEqual(reportToFindings({ results: [] }), []);
  assert.deepEqual(reportToFindings({ results: [{ checks: null }] }), []);
});

test("reportToFindings: file path absolute → made relative when projectRoot provided", () => {
  const findings = reportToFindings({
    results: [
      { module: "x", checks: [{ passed: false, severity: "error", file: "/repo/sub/file.js", name: "r", message: "m" }] },
    ],
  }, "/repo");
  assert.equal(findings[0].file, "sub/file.js");
});

// ---------------------------------------------------------------------------
// findLatestReport
// ---------------------------------------------------------------------------

test("findLatestReport: returns null when reports dir missing", () => {
  const fs = makeFs({});
  assert.equal(findLatestReport("/repo", fs), null);
});

test("findLatestReport: picks newest .json by mtime", () => {
  const fs = makeFs({
    "/repo/.gatetest/reports/gatetest-report-old.json": JSON.stringify({ ts: 1 }),
    "/repo/.gatetest/reports/gatetest-report-new.json": JSON.stringify({ ts: 2 }),
    "/repo/.gatetest/reports/skip.html": "<html>",
  });
  fs.setMtime("/repo/.gatetest/reports/gatetest-report-old.json", 1000);
  fs.setMtime("/repo/.gatetest/reports/gatetest-report-new.json", 2000);
  const r = findLatestReport("/repo", fs);
  assert.match(r, /new\.json$/);
});

// ---------------------------------------------------------------------------
// scanCode — error paths
// ---------------------------------------------------------------------------

test("scanCode: target.type !== code → target-not-code error", async () => {
  const r = await scanCode({
    manifest: { tier: "quick" },
    target: { type: "url", url: "https://x" },
    gatetestBin: "/bin/gatetest.js",
    _fs: makeFs(),
    _exec: makeExec(),
  });
  assert.equal(r.error, "target-not-code");
});

test("scanCode: missing codeRoot → codeRoot-missing", async () => {
  const r = await scanCode({
    manifest: { tier: "quick" },
    target: { type: "code" },
    gatetestBin: "/bin/gatetest.js",
    _fs: makeFs(),
    _exec: makeExec(),
  });
  assert.equal(r.error, "codeRoot-missing");
});

test("scanCode: codeRoot does not exist → codeRoot-not-found", async () => {
  const r = await scanCode({
    manifest: { tier: "quick" },
    target: { type: "code", codeRoot: "/missing" },
    gatetestBin: "/bin/gatetest.js",
    _fs: makeFs(),
    _exec: makeExec(),
  });
  assert.equal(r.error, "codeRoot-not-found");
});

test("scanCode: missing gatetestBin → gatetestBin-missing", async () => {
  const fs = makeFs({ "/repo/src/x.js": "code" });
  const r = await scanCode({
    manifest: { tier: "quick" },
    target: { type: "code", codeRoot: "/repo" },
    _fs: fs,
    _exec: makeExec(),
  });
  assert.equal(r.error, "gatetestBin-missing");
});

test("scanCode: scanner timeout → scanner-timed-out", async () => {
  const fs = makeFs({ "/repo/src/x.js": "code" });
  const r = await scanCode({
    manifest: { tier: "quick" },
    target: { type: "code", codeRoot: "/repo" },
    gatetestBin: "/bin/gatetest.js",
    _fs: fs,
    _exec: makeExec(() => ({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", killed: true })),
  });
  assert.equal(r.error, "scanner-timed-out");
});

test("scanCode: report not found → report-not-found", async () => {
  const fs = makeFs({ "/repo/src/x.js": "code" });
  const r = await scanCode({
    manifest: { tier: "quick" },
    target: { type: "code", codeRoot: "/repo" },
    gatetestBin: "/bin/gatetest.js",
    _fs: fs,
    _exec: makeExec(() => ({ exitCode: 0, stdout: "scanned", stderr: "" })),
  });
  assert.equal(r.error, "report-not-found");
});

test("scanCode: malformed report JSON → report-parse-failed", async () => {
  const fs = makeFs({
    "/repo/src/x.js": "code",
    "/repo/.gatetest/reports/gatetest-report-r.json": "{ this is not json",
  });
  fs.setMtime("/repo/.gatetest/reports/gatetest-report-r.json", Date.now());
  const r = await scanCode({
    manifest: { tier: "quick" },
    target: { type: "code", codeRoot: "/repo" },
    gatetestBin: "/bin/gatetest.js",
    _fs: fs,
    _exec: makeExec(() => ({ exitCode: 0, stdout: "scanned", stderr: "" })),
  });
  assert.match(r.error, /report-parse-failed/);
});

// ---------------------------------------------------------------------------
// scanCode — happy path
// ---------------------------------------------------------------------------

test("scanCode: spawns gatetest with right args and parses report", async () => {
  const fs = makeFs({
    "/repo/src/x.js": "code",
    "/repo/.gatetest/reports/gatetest-report-latest.json": JSON.stringify({
      gatetest: { gateStatus: "BLOCKED" },
      results: [
        {
          module: "money-float",
          checks: [
            { passed: false, severity: "error", file: "/repo/src/x.js", line: 5, name: "js-parse-float", message: "parseFloat on money" },
          ],
        },
      ],
    }),
  });
  const exec = makeExec(() => ({ exitCode: 0, stdout: "ok", stderr: "" }));
  const r = await scanCode({
    manifest: { tier: "full", budgets: { maxDurationMs: 30_000 } },
    target: { type: "code", codeRoot: "/repo" },
    gatetestBin: "/bin/gatetest.js",
    _fs: fs,
    _exec: exec,
  });
  assert.ok(!r.error);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].module, "money-float");
  assert.equal(r.findings[0].file, "src/x.js");
  assert.equal(exec.calls[0].cmd, "node");
  assert.ok(exec.calls[0].args.includes("--suite"));
  assert.ok(exec.calls[0].args.includes("full"));
  assert.ok(exec.calls[0].args.includes("--project"));
  assert.ok(exec.calls[0].args.includes("/repo"));
  assert.ok(exec.calls[0].args.includes("--report-only"));
});

test("scanCode: defaults tier to quick when manifest.tier missing", async () => {
  const fs = makeFs({
    "/repo/src/x.js": "code",
    "/repo/.gatetest/reports/gatetest-report-r.json": JSON.stringify({ results: [] }),
  });
  const exec = makeExec(() => ({ exitCode: 0, stdout: "", stderr: "" }));
  await scanCode({
    manifest: {},
    target: { type: "code", codeRoot: "/repo" },
    gatetestBin: "/bin/gatetest.js",
    _fs: fs,
    _exec: exec,
  });
  const args = exec.calls[0].args;
  const suiteIdx = args.indexOf("--suite");
  assert.equal(args[suiteIdx + 1], "quick");
});

// ---------------------------------------------------------------------------
// createCodeScannerAdapter — wraps scanCode for the scanner-adapter slot
// ---------------------------------------------------------------------------

test("createCodeScannerAdapter: returns an object with scan()", async () => {
  const fs = makeFs({
    "/repo/src/x.js": "code",
    "/repo/.gatetest/reports/gatetest-report-r.json": JSON.stringify({ results: [] }),
  });
  const adapter = createCodeScannerAdapter({
    gatetestBin: "/bin/gatetest.js",
    _fs: fs,
    _exec: makeExec(() => ({ exitCode: 0, stdout: "", stderr: "" })),
  });
  const r = await adapter.scan({
    manifest: { tier: "quick" },
    target: { type: "code", codeRoot: "/repo" },
  });
  assert.ok(!r.error);
  assert.deepEqual(r.findings, []);
});
