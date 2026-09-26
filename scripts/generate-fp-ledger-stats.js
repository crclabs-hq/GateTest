#!/usr/bin/env node
/**
 * generate-fp-ledger-stats.js — computes the false-positive SLA numbers
 * from docs/precision/retractions.json and writes them back into the same
 * file (Doctrine #7, Generated over typed; the Fifty, move 20).
 *
 * The ledger's `entries` array is the one definition of a retracted false
 * positive: rule, when it was reported, when it was retracted, and the
 * control-pair test that pins it as a regression. This script never edits
 * `entries` — it only derives `reportedCount`, `retractedCount` and
 * `medianHoursToFix` from them, so the public counter
 * (website/app/trust/trust-content-2.ts) and `tests/false-positive-ledger
 * .test.js` read one already-computed answer instead of recomputing it
 * (and risking a second, drifting definition of "median").
 *
 * The website cannot import a file from outside `website/` (every other
 * generated number it shows — precision.json, site-stats.json,
 * head-to-head.json — lives under `website/app/data/`, never reached through
 * a `../../../docs/...` import), so this script also writes a small derived
 * copy to `website/app/data/fp-ledger-stats.json`. That copy is the counts
 * only, never a second set of entries — `tests/false-positive-ledger.test.js`
 * fails if it drifts from the ledger it was generated from.
 *
 * Usage:
 *   node scripts/generate-fp-ledger-stats.js            # measure + write
 *   node scripts/generate-fp-ledger-stats.js --dry-run   # print, don't write
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', 'docs', 'precision', 'retractions.json');
const WEBSITE_COPY_PATH = path.join(__dirname, '..', 'website', 'app', 'data', 'fp-ledger-stats.json');

function hoursBetween(fromIso, toIso) {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return ms / (1000 * 60 * 60);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeStats(ledger) {
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const retracted = entries.filter((e) => e && e.retracted && e.retracted.date);
  const hours = retracted
    .filter((e) => e.reported && e.reported.date)
    .map((e) => hoursBetween(e.reported.date, e.retracted.date))
    .filter((h) => Number.isFinite(h) && h >= 0);
  return {
    reportedCount: entries.length,
    retractedCount: retracted.length,
    medianHoursToFix: hours.length > 0 ? Math.round(median(hours) * 10) / 10 : null,
  };
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const raw = fs.readFileSync(LEDGER_PATH, 'utf8');
  const ledger = JSON.parse(raw);
  const stats = computeStats(ledger);
  const next = {
    ...ledger,
    generatedAt: new Date().toISOString(),
    ...stats,
  };
  const text = JSON.stringify(next, null, 2) + '\n';
  const websiteCopy = { generatedAt: next.generatedAt, ...stats };
  const websiteCopyText = JSON.stringify(websiteCopy, null, 2) + '\n';
  if (dryRun) {
    console.log(text);
    console.log(websiteCopyText);
    return;
  }
  fs.writeFileSync(LEDGER_PATH, text);
  fs.writeFileSync(WEBSITE_COPY_PATH, websiteCopyText);
  console.log(
    `[fp-ledger] ${stats.retractedCount}/${stats.reportedCount} retracted · median ${stats.medianHoursToFix ?? 'n/a'}h to a fix`
  );
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { computeStats, hoursBetween, median, LEDGER_PATH, WEBSITE_COPY_PATH };
