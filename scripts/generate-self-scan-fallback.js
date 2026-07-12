#!/usr/bin/env node
'use strict';

/**
 * Generate website/app/data/self-scan-fallback.json from the latest
 * self-scan report + current git HEAD.
 *
 * The homepage trust panel (<HomeSelfScan>) prefers LIVE data published
 * by CI to /api/internal/self-scan-status. When no live publish has
 * arrived (fresh deploy, CI secret unset), it falls back to this file —
 * a dated, measured result — instead of rendering a dead "STANDBY /
 * Awaiting first scan" panel. A trust section with no data is anti-trust.
 *
 * Run after a green quick-suite self-scan:
 *   node bin/gatetest.js --suite quick --parallel
 *   node scripts/generate-self-scan-fallback.js
 *
 * Honesty contract: this script copies MEASURED numbers from the actual
 * report. It never invents values; it refuses to write if the report is
 * missing or the gate did not run.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, '.gatetest', 'reports', 'gatetest-report-latest.json');
const OUT = path.join(ROOT, 'website', 'app', 'data', 'self-scan-fallback.json');

let report;
try {
  report = JSON.parse(fs.readFileSync(REPORT, 'utf-8'));
} catch (err) {
  console.error(`No readable report at ${REPORT} — run a self-scan first. (${err.message})`);
  process.exit(1);
}

const summary = report.summary || {};
const modules = summary.modules || {};
const checks = summary.checks || {};
if (!modules.total) {
  console.error('Report has no module summary — refusing to write a fallback from it.');
  process.exit(1);
}

let commitSha = 'unknown';
try {
  commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
} catch { /* error-ok: sha is cosmetic in the fallback; "unknown" renders fine */ }

const fallback = {
  generatedAt: new Date().toISOString(),
  source: 'scripts/generate-self-scan-fallback.js',
  note: 'Measured self-scan result. Do not hand-edit — re-run the script after a self-scan.',
  gateStatus: (checks.blockingErrors || 0) > 0 ? 'BLOCKED' : 'PASSED',
  errorCount: checks.blockingErrors || 0,
  warningCount: checks.warnings || 0,
  modulesPassedCount: modules.passed || 0,
  modulesTotalCount: modules.total || 0,
  durationMs: summary.duration || null,
  scannedAt: new Date().toISOString(),
  commitSha,
};

fs.writeFileSync(OUT, JSON.stringify(fallback, null, 2) + '\n');
console.log(`Wrote ${OUT}`);
console.log(`  ${fallback.gateStatus} — ${fallback.modulesPassedCount}/${fallback.modulesTotalCount} modules, ${fallback.errorCount} blocking errors, ${fallback.warningCount} warnings @ ${fallback.commitSha.slice(0, 7)}`);
