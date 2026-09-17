#!/usr/bin/env node
'use strict';
/**
 * generate-rule-demotions.js — the Fifty, move 08.
 *
 * Turns a rule-noise snapshot (an array of the same per-scan
 * `{ id, fired, silenced }` rows the ledger stores and /api/noise reads)
 * into the checked-in demotion list the engine applies at scan time
 * (src/core/rule-demotion.js reads data/rule-demotions.json).
 *
 * A rule is demoted error -> warning only when BOTH:
 *   - it has enough findings to trust the rate: sampleSize (fired +
 *     silenced) >= MIN_FINDINGS_FLOOR, AND enough scans to be a
 *     population, not thin (MIN_SCANS) — website/app/lib/rule-noise.js,
 *     the one definition, imported here rather than re-typed.
 *   - the field silenced it more than the retirement line (default 20%,
 *     DEFAULT_MIN_SILENCED_RATE, same file).
 *
 * A rule that clears the RATE but not one of the data floors is never
 * silently dropped (Doctrine #1: a demotion that did not happen because
 * data is thin is reported as "not enough data") — it lands in
 * `notEnoughData` instead, with the specific reason.
 *
 * No production ledger exists yet (THE-FIFTY, move 08: "waits on flywheel
 * data that cannot exist until production ships"). Run with no --snapshot,
 * this writes an empty demotion list with status "not-enough-data" so the
 * mechanism ships now and activates the moment real data exists — nothing
 * is invented in between.
 *
 * Usage:
 *   node scripts/generate-rule-demotions.js
 *   node scripts/generate-rule-demotions.js --snapshot path/to/rows.json
 *   node scripts/generate-rule-demotions.js --rate 0.2 --floor 50 --dry-run
 *   node scripts/generate-rule-demotions.js --out data/rule-demotions.json
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  aggregateRuleNoise,
  MIN_FINDINGS_FLOOR,
  DEFAULT_MIN_SILENCED_RATE,
} = require('../website/app/lib/rule-noise');

const ROOT = path.join(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'rule-demotions.json');

function parseArgs(argv) {
  const out = {
    rate: DEFAULT_MIN_SILENCED_RATE,
    floor: MIN_FINDINGS_FLOOR,
    out: OUT_PATH,
    dryRun: false,
    snapshot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--snapshot') out.snapshot = argv[++i];
    else if (a === '--rate') out.rate = Number(argv[++i]);
    else if (a === '--floor') out.floor = Number(argv[++i]);
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

/**
 * Reads the snapshot file if given and readable; null otherwise (missing
 * flag, missing file, or malformed JSON all mean "no data" — never a
 * thrown error). Accepts either a bare array of rows or `{ rows: [...] }`.
 */
function readSnapshotRows(snapshotPath) {
  if (!snapshotPath) return null;
  try {
    const raw = fs.readFileSync(snapshotPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
    return null;
  } catch {
    return null;
  }
}

/**
 * The pure move-08 decision, given rows + thresholds. Exported so tests
 * exercise the logic without touching the filesystem.
 *
 * @returns {{demotions: object, notEnoughData: Array, status: 'ok'|'not-enough-data', scans: number}}
 */
function buildDemotions(rows, { rate = DEFAULT_MIN_SILENCED_RATE, floor = MIN_FINDINGS_FLOOR } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { demotions: {}, notEnoughData: [], status: 'not-enough-data', scans: 0 };
  }

  const agg = aggregateRuleNoise(rows);
  const demotions = {};
  const notEnoughData = [];
  let sufficientDataSeen = false;

  for (const r of agg.rules) {
    const sampleSize = r.fired + r.silenced;
    const hasFloor = !r.thin && sampleSize >= floor;
    if (hasFloor) sufficientDataSeen = true;
    if (r.silencedRate <= rate) continue; // a clean bill — nothing to report

    if (hasFloor) {
      demotions[r.id] = {
        from: 'error',
        to: 'warning',
        reason: `field silence data: ${Math.round(r.silencedRate * 100)}% of ${sampleSize} findings silenced across ${r.scans} scans`,
        silencedRate: r.silencedRate,
        sampleSize,
      };
    } else {
      notEnoughData.push({
        id: r.id,
        silencedRate: r.silencedRate,
        sampleSize,
        scans: r.scans,
        reason: r.thin
          ? `seen in only ${r.scans} scan(s), below MIN_SCANS`
          : `sampleSize ${sampleSize} below the floor of ${floor} findings`,
      });
    }
  }

  // "ok" means we found at least one rule with enough data to trust a
  // verdict about it — demoted or not. "not-enough-data" means nothing in
  // this snapshot ever cleared the floor, so no verdict here is trustworthy
  // (matches the empty-snapshot case above, just reached a different way).
  const status = sufficientDataSeen ? 'ok' : 'not-enough-data';
  return { demotions, notEnoughData, status, scans: agg.scans };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = readSnapshotRows(opts.snapshot);
  const built = buildDemotions(rows, { rate: opts.rate, floor: opts.floor });

  const payload = {
    generatedAt: new Date().toISOString(),
    status: built.status,
    rate: opts.rate,
    floor: opts.floor,
    scans: built.scans,
    demotions: built.demotions,
    notEnoughData: built.notEnoughData,
  };
  // CRLF to match the rest of the repo's generated JSON (Doctrine #12) —
  // a diff that is entirely a line-ending flip is a bug, not a change.
  const json = (JSON.stringify(payload, null, 2) + '\n').replace(/\n/g, '\r\n');

  if (opts.dryRun) {
    process.stdout.write(json);
    return;
  }

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, json, 'utf-8');
  const n = Object.keys(built.demotions).length;
  console.log(`[GateTest] wrote ${path.relative(ROOT, opts.out)} — ${n} rule(s) demoted, status ${built.status}`);
}

if (require.main === module) main();

module.exports = { buildDemotions, readSnapshotRows, parseArgs, OUT_PATH };
