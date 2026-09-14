/**
 * Spine Health — structural integrity of the codebase, not surface defects.
 *
 * Every other module in this engine asks "is this line wrong?". This one asks
 * "what does it cost to change this codebase?", which is a property of the
 * dependency graph and invisible to any per-file scan. A file can be perfectly
 * clean by every lint rule and still be the single most dangerous file in the
 * repo, because 60% of the code transitively depends on it.
 *
 * What it reports:
 *
 *   fragile-spine        — a load-bearing file (large blast radius) that also
 *                          carries a fragility signal: untested, oversized, or
 *                          depending on many things itself. Blast radius alone
 *                          is not a defect; blast radius plus fragility is.
 *   layering-violation   — an import running against the direction dependencies
 *                          demonstrably flow between two directories. The grain
 *                          is inferred from the codebase, so this needs no
 *                          configuration and cannot go stale.
 *   god-file             — high fan-in AND high fan-out. Everyone depends on it
 *                          and it depends on everyone, so it cannot be moved.
 *   unstable-dependency  — a widely-depended-on module importing a volatile one
 *                          (Martin's Stable Dependencies Principle). Its
 *                          stability is a fiction; churn propagates through it.
 *   coupling-trend       — how the above moved since the last scan of this repo.
 *
 * ── Everything here is a WARNING, deliberately ───────────────────────────────
 * These are refactor-scale observations, not runtime faults. Blocking a build on
 * "your fan-in distribution got worse" would make GateTest the bottleneck rather
 * than the painkiller (Bible Forbidden #25). They surface, rank, and trend; the
 * developer decides. Cycles — which ARE runtime bugs — stay in `importCycle`
 * where they block.
 *
 * ── Thresholds are calibrated per repo ───────────────────────────────────────
 * Every cut-off is a percentile of this repo's own distribution with an absolute
 * floor, and nothing is reported below 20 source files. Hardcoded thresholds are
 * what made 20 modules noisy in KI #77.
 *
 * TODO(host-parity): host-neutral — pure static analysis, no git host involved.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');
const { buildImportGraph } = require('../core/import-graph');
const { computeSpineMetrics, MIN_NODES_FOR_ANALYSIS } = require('../core/spine-metrics');

/**
 * A file is load-bearing at either threshold.
 *
 * The percentage alone is scope-sensitive: `src/modules/base-module.js` is 58.8%
 * of the engine but 19.3% of this monorepo, because the website dilutes the
 * denominator — so a pure-percentage rule reports it when you scan `src/` and
 * goes quiet when you scan the repo, for the same file with the same 230
 * dependents. The absolute count is what makes the finding scope-stable.
 */
const SPINE_BLAST_PCT = 20;
const SPINE_BLAST_FILES = 50;
/** Cap on reported findings per category. Anything dropped is disclosed. */
const MAX_PER_CATEGORY = 5;
/** Above this many files, blast radius is skipped rather than hanging the gate. */
const MAX_NODES_FOR_BLAST = 5000;

class SpineHealthModule extends BaseModule {
  constructor() {
    super(
      'spineHealth',
      'Structural integrity — blast radius, layering violations, god files, and coupling trend',
    );
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const graph = buildImportGraph({ projectRoot });

    if (graph.files.length < MIN_NODES_FOR_ANALYSIS) {
      result.addCheck('spine-health:too-small', true, {
        severity: 'info',
        message: `${graph.files.length} source file(s) — below the ${MIN_NODES_FOR_ANALYSIS}-file floor for structural analysis`,
        fileCount: graph.files.length,
      });
      return;
    }

    const lineCounts = this._lineCounts(graph.files);
    const testTargets = this._testTargets(graph.files, projectRoot);

    const m = computeSpineMetrics({
      fullGraph: graph.fullGraph,
      edges: graph.edges,
      rel: graph.rel,
      lineCounts,
      maxNodesForBlast: MAX_NODES_FOR_BLAST,
      isTest: (abs) => this._isTestPath(graph.rel(abs)),
    });

    this._reportFragileSpine(result, m, testTargets);
    this._reportLayering(result, m, graph.rel);
    this._reportGodFiles(result, m);
    this._reportUnstableDeps(result, m);
    this._reportSpineInfo(result, m);
    this._reportTrend(result, m, projectRoot);

    const kinds = graph.edges.reduce((a, e) => { a[e.kind] = (a[e.kind] || 0) + 1; return a; }, {});
    result.addCheck('spine-health:summary', true, {
      severity: 'info',
      message: `${m.nodes} production file(s) (${m.testNodeCount} test file(s) excluded), `
        + `${m.edgeTotal} dependency edge(s), coupling index ${m.couplingIndex}`
        + ` — ${m.layerViolations.length} layering violation(s), ${m.godFiles.length} god file(s),`
        + ` ${m.unstableDeps.length} unstable dependency(ies)`,
      fileCount: m.nodes,
      edgeCount: m.edgeTotal,
      couplingIndex: m.couplingIndex,
      staticEdges: kinds.static || 0,
      lazyEdges: kinds.lazy || 0,
      typeEdges: kinds.type || 0,
      blastComputed: m.blastComputed,
    });
  }

  /** Line count per file, used for the "oversized" fragility signal. */
  _lineCounts(files) {
    const out = new Map();
    for (const abs of files) {
      try {
        out.set(abs, fs.readFileSync(abs, 'utf-8').split(/\r?\n/).length);
      } catch { /* unreadable — treated as unknown size */ } // error-ok
    }
    return out;
  }

  /**
   * Set of module basenames that have a test somewhere in the repo.
   *
   * Deliberately name-based rather than coverage-based: this module does not run
   * the suite, and "foo.js has no foo.test.js anywhere" is a claim we can make
   * honestly from the file list alone. It under-reports (a test may cover a file
   * without matching its name), which is the correct direction to be wrong in.
   */
  _testTargets(files, projectRoot) {
    const targets = new Set();
    for (const abs of files) {
      const rel = repoRelative(projectRoot, abs);
      if (!this._isTestPath(rel)) continue;
      const base = path.basename(abs).replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, '');
      if (base) targets.add(base);
    }
    return targets;
  }

  _reportFragileSpine(result, m, testTargets) {
    if (!m.blastComputed) return;
    const candidates = m.spine.filter((s) => {
      if (s.blastPct < SPINE_BLAST_PCT && s.blast < SPINE_BLAST_FILES) return false;
      return this._fragilityOf(s, m, testTargets).length > 0;
    });

    for (const s of candidates.slice(0, MAX_PER_CATEGORY)) {
      const reasons = this._fragilityOf(s, m, testTargets);
      result.addCheck(`spine-health:fragile-spine:${s.rel}`, false, {
        severity: 'warning',
        message: `${s.rel} is load-bearing (${s.blastPct}% of the codebase transitively depends on it: `
          + `${s.blast} file(s)) and ${reasons.join('; ')} — a change here has the widest reach in the repo`,
        file: s.rel,
        blastPct: s.blastPct,
        blastFiles: s.blast,
        fanIn: s.fanIn,
        fanOut: s.fanOut,
        reasons,
      });
    }
    this._discloseCap(result, 'fragile-spine', candidates.length);
  }

  /**
   * Which fragility signals a load-bearing file carries. Empty = not fragile.
   *
   * The untested signal is only claimed when the scan can actually SEE tests.
   * Scanning a subdirectory (`gatetest src/`) puts `tests/` outside the walked
   * tree, so the first version of this reported "has no matching test file" for
   * every load-bearing file in the repo — including `base-module.js`, which has
   * had `tests/base-module.test.js` all along. Absence of evidence is not
   * evidence: with no tests in scope the question is unanswerable, so it goes
   * unasked rather than answered wrongly.
   */
  _fragilityOf(s, m, testTargets) {
    const reasons = [];
    const base = path.basename(s.rel).replace(/\.[cm]?[jt]sx?$/i, '');
    if (testTargets.size > 0 && !testTargets.has(base)) reasons.push('has no matching test file');
    if (s.lines && s.lines >= Math.max(300, m.thresholds.linesP90)) {
      reasons.push(`is ${s.lines} lines (top decile)`);
    }
    if (s.fanOut >= m.thresholds.fanOutHigh) {
      reasons.push(`itself depends on ${s.fanOut} file(s), so it has that many reasons to change`);
    }
    return reasons;
  }

  _reportLayering(result, m, rel) {
    const shown = m.layerViolations.slice(0, MAX_PER_CATEGORY);
    for (const v of shown) {
      result.addCheck(`spine-health:layering-violation:${rel(v.from)}`, false, {
        severity: 'warning',
        message: `${rel(v.from)}:${v.line} imports ${rel(v.to)} — that is \`${v.fromDir}\` -> \`${v.toDir}\`, `
          + `against the grain: ${v.forward} import(s) run \`${v.toDir}\` -> \`${v.fromDir}\` `
          + `and only ${v.backward} the other way`,
        file: rel(v.from),
        line: v.line,
        fromDir: v.fromDir,
        toDir: v.toDir,
        forwardEdges: v.forward,
        backwardEdges: v.backward,
      });
    }
    this._discloseCap(result, 'layering-violation', m.layerViolations.length);
  }

  _reportGodFiles(result, m) {
    for (const g of m.godFiles.slice(0, MAX_PER_CATEGORY)) {
      result.addCheck(`spine-health:god-file:${g.rel}`, false, {
        severity: 'warning',
        message: `${g.rel} is both a hub and a dependent — ${g.fanIn} file(s) import it and it imports `
          + `${g.fanOut} — so it cannot be changed in isolation or moved without moving everything`,
        file: g.rel,
        fanIn: g.fanIn,
        fanOut: g.fanOut,
      });
    }
    this._discloseCap(result, 'god-file', m.godFiles.length);
  }

  _reportUnstableDeps(result, m) {
    for (const u of m.unstableDeps.slice(0, MAX_PER_CATEGORY)) {
      result.addCheck(`spine-health:unstable-dependency:${u.relFrom}`, false, {
        severity: 'warning',
        message: `${u.relFrom} is depended on by ${u.fanInFrom} file(s) (instability ${u.iFrom}) but imports `
          + `${u.relTo}, which is volatile (instability ${u.iTo}) — churn there propagates through a module `
          + `the codebase treats as stable`,
        file: u.relFrom,
        dependsOn: u.relTo,
        instabilityFrom: u.iFrom,
        instabilityTo: u.iTo,
      });
    }
    this._discloseCap(result, 'unstable-dependency', m.unstableDeps.length);
  }

  /** Bible rule: a capped list must say what it dropped, or it reads as complete. */
  _discloseCap(result, label, total) {
    if (total <= MAX_PER_CATEGORY) return;
    result.addCheck(`spine-health:more-${label}`, true, {
      severity: 'info',
      message: `${total - MAX_PER_CATEGORY} further ${label} finding(s) not shown (showing the ${MAX_PER_CATEGORY} highest-impact of ${total})`,
      total,
      shown: MAX_PER_CATEGORY,
    });
  }

  _reportSpineInfo(result, m) {
    if (!m.blastComputed) {
      result.addCheck('spine-health:blast-skipped', true, {
        severity: 'info',
        message: `${m.nodes} files exceeds the ${MAX_NODES_FOR_BLAST}-file budget for transitive blast-radius analysis — degree metrics still reported`,
        fileCount: m.nodes,
      });
      return;
    }
    const top = m.spine.filter((s) => s.blastPct > 0).slice(0, 5);
    if (!top.length) return;
    result.addCheck('spine-health:spine', true, {
      severity: 'info',
      message: 'Load-bearing files: '
        + top.map((s) => `${s.rel} (${s.blastPct}%)`).join(', '),
      spine: top.map((s) => ({ file: s.rel, blastPct: s.blastPct, fanIn: s.fanIn })),
    });
  }

  /**
   * The flywheel, locally: compare this scan's structure to the last one for
   * this repo and report the direction of travel.
   *
   * A single coupling number is nearly meaningless in isolation — nobody knows
   * whether 2.4 is good. The DELTA is what a team can act on, and it is only
   * available because every scan leaves a record behind.
   *
   * Rides the same consent gate as all telemetry, and stores only integers in
   * the project's own .gatetest/memory.json. Never throws: a trend is a nicety,
   * and losing it must not cost the caller their scan.
   */
  _reportTrend(result, m, projectRoot) {
    let mem = null;
    let memory = null;
    try {
      const { telemetryEnabled } = require('../core/scan-telemetry');
      if (!telemetryEnabled(projectRoot)) return;
      mem = require('../core/persistent-memory');
      memory = mem.load(projectRoot);
    } catch { return; } // error-ok — no memory subsystem, no trend

    const maxBlastPct = m.spine.length ? m.spine[0].blastPct : 0;
    const now = {
      files: m.nodes,
      edges: m.edgeTotal,
      couplingIndex: m.couplingIndex,
      maxBlastPct,
      layerViolations: m.layerViolations.length,
      godFiles: m.godFiles.length,
    };

    const prev = memory.spine && Array.isArray(memory.spine.history)
      ? memory.spine.history[memory.spine.history.length - 1]
      : null;

    if (prev) this._addTrendCheck(result, prev, now);
    this._appendHistory(mem, memory, projectRoot, now);
  }

  /** Emit the delta. Worse coupling or a new violation makes it a warning. */
  _addTrendCheck(result, prev, now) {
    const dCoupling = Math.round((now.couplingIndex - prev.couplingIndex) * 100) / 100;
    const dViolations = now.layerViolations - prev.layerViolations;
    const worse = dCoupling > 0.1 || dViolations > 0;
    result.addCheck('spine-health:coupling-trend', !worse, {
      severity: worse ? 'warning' : 'info',
      message: `Since the last scan: coupling index ${prev.couplingIndex} -> ${now.couplingIndex}`
        + ` (${dCoupling >= 0 ? '+' : ''}${dCoupling}), layering violations ${prev.layerViolations} -> ${now.layerViolations}`
        + `, widest blast radius ${prev.maxBlastPct}% -> ${now.maxBlastPct}%`,
      couplingDelta: dCoupling,
      violationDelta: dViolations,
    });
  }

  /** Append this scan to the rolling structural history. Never throws. */
  _appendHistory(mem, memory, projectRoot, now) {
    try {
      if (!memory.spine || !Array.isArray(memory.spine.history)) memory.spine = { history: [] };
      memory.spine.history.push({ at: new Date().toISOString(), ...now });
      // Rolling window — a trend needs recent history, not the whole archive.
      if (memory.spine.history.length > 50) {
        memory.spine.history = memory.spine.history.slice(-50);
      }
      mem.save(projectRoot, memory); // error-ok — persistent-memory.save is synchronous (writeFileSync) and never throws; the name only looks async
    } catch { /* error-ok — history is best-effort; a scan never fails on its own bookkeeping */ }
  }
}

module.exports = SpineHealthModule;
