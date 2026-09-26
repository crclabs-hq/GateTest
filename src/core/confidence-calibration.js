'use strict';
/**
 * Confidence calibration against the real-world corpus (the Fifty, move 09).
 *
 * The gate blocks on `severity === 'error' && confidence >= BLOCK_THRESHOLD`.
 * The threshold was 0.7 because 0.7 sounded right; nothing had measured it.
 * This module measures it. Given every error-severity finding the corpus run
 * produced — on the precision repos, which should go quiet, and on the recall
 * repos (NodeGoat), which must stay loud — it reports:
 *
 *   bands   the distinct confidence values that actually occur, and which
 *           rules produce them on which side. Confidence is a product of a
 *           few discrete multipliers, so it is not a continuum; the bands are
 *           the whole story.
 *   sweep   for each candidate threshold, how many findings would block on
 *           the precision side and how many would still fire on the recall
 *           side. The shipped threshold is always one of the candidates.
 *   gap     the open interval of thresholds that give exactly the shipped
 *           result — the highest band below the threshold and the lowest at
 *           or above it. A threshold inside a wide gap is not load-bearing;
 *           one sitting on a band edge is a decision that needs a reason.
 *   softened  what the signals bought: findings the threshold kept off the
 *           precision side, and what it cost on the recall side.
 *
 * Pure: no I/O, so it is tested on hand-built inputs with known answers and
 * the corpus runner feeds it the real ones.
 *
 * @typedef {{ rule: string, confidence: number }} Finding
 * @typedef {{ name: string, kind: 'precision'|'recall', floor?: number, findings: Finding[] }} RepoFindings
 */

const CANDIDATES = [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0];

const round = (x) => Math.round(x * 100) / 100;

function count(map, key) { map[key] = (map[key] || 0) + 1; }

/**
 * @param {{ repos: RepoFindings[], threshold: number }} input
 */
function calibrate({ repos, threshold }) {
  const byBand = new Map();
  let precisionTotal = 0;
  let recallTotal = 0;
  for (const repo of repos) {
    const side = repo.kind === 'recall' ? 'recall' : 'precision';
    for (const f of repo.findings) {
      const c = round(typeof f.confidence === 'number' ? f.confidence : 1);
      if (!byBand.has(c)) byBand.set(c, { confidence: c, precision: 0, recall: 0, rules: { precision: {}, recall: {} } });
      const band = byBand.get(c);
      band[side] += 1;
      count(band.rules[side], f.rule);
      if (side === 'recall') recallTotal += 1; else precisionTotal += 1;
    }
  }
  const bands = [...byBand.values()].sort((a, b) => b.confidence - a.confidence);
  const blockingAt = (t, side) => bands.filter((b) => b.confidence >= t).reduce((n, b) => n + b[side], 0);

  const thresholds = [...new Set([...CANDIDATES, round(threshold)])].sort((a, b) => a - b);
  const sweep = thresholds.map((t) => ({
    threshold: t,
    precisionBlocking: blockingAt(t, 'precision'),
    recallBlocking: blockingAt(t, 'recall'),
    shipped: t === round(threshold),
  }));

  const below = bands.filter((b) => b.confidence < threshold).map((b) => b.confidence);
  const above = bands.filter((b) => b.confidence >= threshold).map((b) => b.confidence);
  const gap = {
    below: below.length ? Math.max(...below) : null,
    above: above.length ? Math.min(...above) : null,
  };

  const recallRepos = repos.filter((r) => r.kind === 'recall').map((r) => {
    const blocking = r.findings.filter((f) => round(f.confidence) >= threshold).length;
    return { name: r.name, blocking, floor: typeof r.floor === 'number' ? r.floor : null, held: typeof r.floor === 'number' ? blocking >= r.floor : null };
  });

  const precisionBlocking = blockingAt(threshold, 'precision');
  const recallBlocking = blockingAt(threshold, 'recall');
  return {
    threshold,
    bands,
    sweep,
    gap,
    softened: {
      precisionTotal,
      precisionBlocking,
      precisionSoftened: precisionTotal - precisionBlocking,
      recallTotal,
      recallBlocking,
      recallLost: recallTotal - recallBlocking,
    },
    recallRepos,
  };
}

/**
 * The error-severity findings of one gatetest JSON report, reduced to what
 * calibration needs. `ruleIdentity` is injected so this module stays pure
 * and the identity has one home (src/core/rule-identity.js). `module` is the
 * registry key the result was reported under (`mod.module`, e.g. "secrets")
 * — carried through for the per-rule corpus aggregate (the Fifty, move 02),
 * which needs to prove a rule's module is a real, loaded module.
 */
function findingsFromReport(report, ruleIdentity) {
  const out = [];
  for (const mod of (report && report.results) || []) {
    for (const check of mod.checks || []) {
      if (check.severity !== 'error') continue;
      out.push({
        rule: ruleIdentity(check),
        confidence: typeof check.confidence === 'number' ? check.confidence : 1,
        module: mod.module || null,
      });
    }
  }
  return out;
}

module.exports = { calibrate, findingsFromReport, CANDIDATES };
