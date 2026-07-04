/**
 * Pattern-miner trainer.
 *
 * The first of N flywheel trainers. Reads the unified corpus (fix-attempts
 * + session-fixes) and surfaces actionable patterns:
 *
 *   - Modules with the highest fix-frequency (signal: heavy traffic OR
 *     persistent design issue; either way they need attention).
 *   - Recurring bug-pattern strings across multiple commits (signal:
 *     candidate for a deterministic recipe → skip Claude next time).
 *   - Modules with high fix-frequency but low tests-added ratio (signal:
 *     we keep patching without locking the fix down — a regression-test
 *     gap).
 *   - Rule keys that produce the most fix attempts (signal: top of the
 *     rule-improvement queue).
 *
 * Output: structured JSON report PLUS a markdown summary suitable for a
 * PR comment or admin-dashboard render. The trainer NEVER modifies
 * source code — it only reports. A separate downstream agent (the
 * "recipe-promoter") decides whether to act on recommendations.
 *
 * RESILIENCE CONTRACT: never throws. Missing inputs → empty report.
 *
 * SCHEDULING: invoked nightly via .github/workflows/trainer-nightly.yml
 * (see same-day commit), or on-demand via:
 *   node website/app/lib/trainers/pattern-miner.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_FIX_PATH = path.join(os.homedir(), '.gatetest', 'session-fixes.jsonl');
const DEFAULT_FIX_ATTEMPT_PATH = path.join(os.homedir(), '.gatetest', 'telemetry', 'fix-attempts.jsonl');
const DEFAULT_MCP_TELEMETRY_PATH = path.join(os.homedir(), '.gatetest', 'mcp-telemetry.jsonl');

const TOP_MODULES_LIMIT = 10;
const TOP_RULES_LIMIT = 10;
const RECURRING_PATTERN_MIN_HITS = 3;
const UNDER_TESTED_MIN_FIXES = 3;
const UNDER_TESTED_RATIO_THRESHOLD = 1.0; // < 1 test per fix on average

let _warnedOnce = false;
function warnOnce(msg) {
  if (_warnedOnce) return;
  _warnedOnce = true;
  // eslint-disable-next-line no-console
  console.warn(`[pattern-miner] ${msg}`);
}

// ---------------------------------------------------------------------------
// JSONL reader
// ---------------------------------------------------------------------------

async function readJsonl(filePath) {
  const records = [];
  let exists = false;
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    exists = true;
  } catch { /* missing → empty */ }
  if (!exists) return records;

  return await new Promise((resolve) => {
    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    } catch (err) {
      warnOnce(`could not read ${filePath}: ${err.message}`);
      resolve(records);
      return;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line || !line.trim()) return;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec === 'object') records.push(rec);
      } catch { /* skip malformed */ }
    });
    rl.on('error', (err) => {
      warnOnce(`stream error on ${filePath}: ${err.message}`);
      resolve(records);
    });
    rl.on('close', () => resolve(records));
  });
}

// ---------------------------------------------------------------------------
// Analysers
// ---------------------------------------------------------------------------

function topModulesByFixCount(sessionFixes) {
  const counts = new Map();
  for (const rec of sessionFixes) {
    const m = rec.module || '(unattributed)';
    counts.set(m, (counts.get(m) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_MODULES_LIMIT)
    .map(([module, count]) => ({ module, count }));
}

function topRuleKeysByAttempts(fixAttempts) {
  const counts = new Map();
  for (const rec of fixAttempts) {
    const k = rec.issueRuleKey || '(unspecified)';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_RULES_LIMIT)
    .map(([ruleKey, attempts]) => ({ ruleKey, attempts }));
}

function recurringSubjects(sessionFixes) {
  // Group by normalised subject (strip ":...." tail to keep the "fix(x):" head)
  const groups = new Map();
  for (const rec of sessionFixes) {
    if (typeof rec.subject !== 'string') continue;
    // Normalise: keep the conventional-commit prefix + first 30 chars of body.
    const m = /^([a-z]+(?:\([^)]+\))?:\s*)(.+)$/i.exec(rec.subject);
    if (!m) continue;
    const head = m[1].toLowerCase();
    const body = m[2].slice(0, 30).toLowerCase();
    const key = head + body;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec.commitSha);
  }
  return Array.from(groups.entries())
    .filter(([, shas]) => shas.length >= RECURRING_PATTERN_MIN_HITS)
    .map(([pattern, shas]) => ({ pattern, hits: shas.length, sampleShas: shas.slice(0, 5) }))
    .sort((a, b) => b.hits - a.hits);
}

function underTestedModules(sessionFixes) {
  const stats = new Map();
  for (const rec of sessionFixes) {
    const m = rec.module || '(unattributed)';
    const entry = stats.get(m) || { fixes: 0, tests: 0 };
    entry.fixes += 1;
    entry.tests += Number.isFinite(rec.testsAdded) ? rec.testsAdded : 0;
    stats.set(m, entry);
  }
  return Array.from(stats.entries())
    .filter(([, e]) => e.fixes >= UNDER_TESTED_MIN_FIXES && (e.tests / e.fixes) < UNDER_TESTED_RATIO_THRESHOLD)
    .map(([module, e]) => ({
      module,
      fixes: e.fixes,
      tests: e.tests,
      testPerFix: Number((e.tests / e.fixes).toFixed(2)),
    }))
    .sort((a, b) => b.fixes - a.fixes);
}

function claudeRatioByLayer(fixAttempts) {
  const layers = ['ast', 'rule', 'recipe', 'claude', 'null'];
  const stats = {};
  for (const l of layers) stats[l] = { attempts: 0, successes: 0 };
  for (const rec of fixAttempts) {
    const key = rec.layer === null || rec.layer === undefined ? 'null' : String(rec.layer);
    if (!stats[key]) continue;
    stats[key].attempts += 1;
    if (rec.success) stats[key].successes += 1;
  }
  const total = Object.values(stats).reduce((s, l) => s + l.attempts, 0);
  const claudeShare = total === 0 ? 0 : Number((stats.claude.attempts / total).toFixed(3));
  const deterministicShare = total === 0 ? 0 : Number(
    ((stats.ast.attempts + stats.rule.attempts + stats.recipe.attempts) / total).toFixed(3),
  );
  return { layers: stats, total, claudeShare, deterministicShare };
}

const KNOWN_FREE_TOOLS = ['scan_local', 'scan_url', 'check_health', 'list_modules', 'get_badge'];

function mcpToolUsageStats(mcpEvents) {
  if (!mcpEvents.length) return { totalCalls: 0, tools: [], neverCalled: KNOWN_FREE_TOOLS.slice(), highFailTools: [] };

  const stats = new Map();
  for (const ev of mcpEvents) {
    const tool = ev.tool || '(unknown)';
    const entry = stats.get(tool) || { calls: 0, successes: 0, totalLatencyMs: 0, gatedDenials: 0 };
    entry.calls += 1;
    if (ev.success) entry.successes += 1;
    if (ev.reason === 'gate_denied') entry.gatedDenials += 1;
    entry.totalLatencyMs += ev.latencyMs || 0;
    stats.set(tool, entry);
  }

  const tools = Array.from(stats.entries())
    .map(([tool, e]) => ({
      tool,
      calls: e.calls,
      successRate: e.calls > 0 ? Number((e.successes / e.calls).toFixed(2)) : 0,
      avgLatencyMs: e.calls > 0 ? Math.round(e.totalLatencyMs / e.calls) : 0,
      gatedDenials: e.gatedDenials,
    }))
    .sort((a, b) => b.calls - a.calls);

  // Tools that have never been called (compared against the known free tools list)
  const calledTools = new Set(tools.map(t => t.tool));
  const neverCalled = KNOWN_FREE_TOOLS.filter(t => !calledTools.has(t));

  const highFailTools = tools.filter(t => t.calls >= 3 && t.successRate < 0.5 && t.gatedDenials < t.calls);

  return { totalCalls: mcpEvents.length, tools, neverCalled, highFailTools };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the trainer and produce a structured report.
 *
 * @param {object} [opts]
 * @param {string} [opts.sessionFixPath]
 * @param {string} [opts.fixAttemptPath]
 * @returns {Promise<object>}
 */
async function mine(opts = {}) {
  const sessionFixPath = opts.sessionFixPath || DEFAULT_SESSION_FIX_PATH;
  const fixAttemptPath = opts.fixAttemptPath || DEFAULT_FIX_ATTEMPT_PATH;
  const mcpTelemetryPath = opts.mcpTelemetryPath || DEFAULT_MCP_TELEMETRY_PATH;

  const [sessionFixes, fixAttempts, mcpEvents] = await Promise.all([
    readJsonl(sessionFixPath),
    readJsonl(fixAttemptPath),
    readJsonl(mcpTelemetryPath),
  ]);

  const topModules = topModulesByFixCount(sessionFixes);
  const topRules = topRuleKeysByAttempts(fixAttempts);
  const recurring = recurringSubjects(sessionFixes);
  const underTested = underTestedModules(sessionFixes);
  const layerStats = claudeRatioByLayer(fixAttempts);
  const mcpUsage = mcpToolUsageStats(mcpEvents);

  const recommendations = [];
  for (const m of topModules.slice(0, 3)) {
    if (m.count >= 5) {
      recommendations.push({
        kind: 'investigate-module',
        module: m.module,
        reason: `${m.count} session-fixes recorded — high-touch module, candidate for refactor or rule split`,
      });
    }
  }
  for (const r of recurring.slice(0, 5)) {
    recommendations.push({
      kind: 'candidate-recipe',
      pattern: r.pattern,
      hits: r.hits,
      reason: `${r.hits} commits with this signature — convert to deterministic recipe`,
    });
  }
  for (const u of underTested.slice(0, 5)) {
    recommendations.push({
      kind: 'regression-test-gap',
      module: u.module,
      reason: `${u.fixes} fixes / ${u.tests} tests added (${u.testPerFix}/fix) — lock down the pattern with a regression test`,
    });
  }
  if (layerStats.total >= 50 && layerStats.claudeShare > 0.6) {
    recommendations.push({
      kind: 'flywheel-not-maturing',
      reason: `Claude handles ${(layerStats.claudeShare * 100).toFixed(1)}% of fixes vs deterministic ${(layerStats.deterministicShare * 100).toFixed(1)}% — distill more recipes`,
    });
  }

  // MCP discoverability recommendations — only when MCP has been used at all
  // (0 events means telemetry not installed yet, not that tools are being ignored)
  if (mcpUsage.totalCalls > 0 && mcpUsage.neverCalled.length > 0) {
    recommendations.push({
      kind: 'mcp-never-called',
      tools: mcpUsage.neverCalled,
      reason: `Free MCP tools never invoked: ${mcpUsage.neverCalled.join(', ')} — improve discoverability (prompts endpoint, description, /mcp page)`,
    });
  }
  for (const t of mcpUsage.highFailTools) {
    recommendations.push({
      kind: 'mcp-high-fail',
      tool: t.tool,
      reason: `MCP tool ${t.tool} has ${Math.round((1 - t.successRate) * 100)}% failure rate over ${t.calls} calls — investigate error path`,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    inputs: {
      sessionFixCount: sessionFixes.length,
      fixAttemptCount: fixAttempts.length,
      mcpEventCount: mcpEvents.length,
    },
    topModulesByFixCount: topModules,
    topRuleKeysByAttempts: topRules,
    recurringSubjects: recurring,
    underTestedModules: underTested,
    layerStats,
    mcpUsage,
    recommendations,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Flywheel Pattern Miner — Nightly Report');
  lines.push('');
  lines.push(`_Generated ${report.generatedAt}_`);
  lines.push('');
  const mcpNote = report.inputs.mcpEventCount != null ? `, ${report.inputs.mcpEventCount} MCP event(s)` : '';
  lines.push(`Inputs: ${report.inputs.sessionFixCount} session-fix(es), ${report.inputs.fixAttemptCount} fix-attempt(s)${mcpNote}.`);
  lines.push('');

  if (report.recommendations.length > 0) {
    lines.push('## Recommendations');
    lines.push('');
    for (const r of report.recommendations) {
      const head = r.module ? `**${r.kind}** — \`${r.module}\`` : `**${r.kind}**`;
      lines.push(`- ${head}: ${r.reason}`);
    }
    lines.push('');
  } else {
    lines.push('## Recommendations');
    lines.push('');
    lines.push('_No actionable patterns yet. Continue capturing._');
    lines.push('');
  }

  lines.push('## Top modules by fix-count');
  lines.push('');
  if (report.topModulesByFixCount.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Module | Fixes |');
    lines.push('| --- | --- |');
    for (const m of report.topModulesByFixCount) lines.push(`| \`${m.module}\` | ${m.count} |`);
  }
  lines.push('');

  lines.push('## Top rule keys by attempt count');
  lines.push('');
  if (report.topRuleKeysByAttempts.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Rule key | Attempts |');
    lines.push('| --- | --- |');
    for (const r of report.topRuleKeysByAttempts) lines.push(`| \`${r.ruleKey}\` | ${r.attempts} |`);
  }
  lines.push('');

  lines.push('## Recurring subjects (recipe candidates)');
  lines.push('');
  if (report.recurringSubjects.length === 0) {
    lines.push('_No recurring patterns yet._');
  } else {
    lines.push('| Pattern (head) | Hits |');
    lines.push('| --- | --- |');
    for (const r of report.recurringSubjects) lines.push(`| \`${r.pattern}\` | ${r.hits} |`);
  }
  lines.push('');

  lines.push('## Under-tested modules (regression-test gaps)');
  lines.push('');
  if (report.underTestedModules.length === 0) {
    lines.push('_All modules are at ≥1 test added per fix on average._');
  } else {
    lines.push('| Module | Fixes | Tests added | Tests/fix |');
    lines.push('| --- | --- | --- | --- |');
    for (const u of report.underTestedModules) lines.push(`| \`${u.module}\` | ${u.fixes} | ${u.tests} | ${u.testPerFix} |`);
  }
  lines.push('');

  lines.push('## Flywheel maturity (Claude vs deterministic share)');
  lines.push('');
  if (report.layerStats.total === 0) {
    lines.push('_No fix attempts yet. The flywheel hasn\'t had a chance to mature._');
  } else {
    lines.push(`- Total attempts: **${report.layerStats.total}**`);
    lines.push(`- Claude share: **${(report.layerStats.claudeShare * 100).toFixed(1)}%**`);
    lines.push(`- Deterministic share (ast + rule + recipe): **${(report.layerStats.deterministicShare * 100).toFixed(1)}%**`);
    lines.push('');
    lines.push('| Layer | Attempts | Successes |');
    lines.push('| --- | --- | --- |');
    for (const [layer, s] of Object.entries(report.layerStats.layers)) {
      lines.push(`| ${layer} | ${s.attempts} | ${s.successes} |`);
    }
  }
  lines.push('');

  // MCP usage section
  if (report.mcpUsage) {
    lines.push('## MCP tool usage (discoverability signal)');
    lines.push('');
    if (report.mcpUsage.totalCalls === 0) {
      lines.push('_No MCP tool calls recorded yet._');
    } else {
      lines.push(`Total calls: **${report.mcpUsage.totalCalls}**`);
      lines.push('');
      lines.push('| Tool | Calls | Success rate | Avg latency | Gate denials |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const t of report.mcpUsage.tools) {
        lines.push(`| \`${t.tool}\` | ${t.calls} | ${(t.successRate * 100).toFixed(0)}% | ${t.avgLatencyMs}ms | ${t.gatedDenials} |`);
      }
      if (report.mcpUsage.neverCalled.length > 0) {
        lines.push('');
        lines.push(`**Never called (free tools):** ${report.mcpUsage.neverCalled.map(t => `\`${t}\``).join(', ')}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entrypoint — `node website/app/lib/trainers/pattern-miner.js`
// ---------------------------------------------------------------------------

async function main() {
  const report = await mine();
  // eslint-disable-next-line no-console
  console.log(renderMarkdown(report)); // code-quality-ok — CLI trainer prints markdown report to stdout
  // Also emit the JSON to a sibling file so a downstream agent can consume it
  const outDir = path.join(os.homedir(), '.gatetest', 'trainers');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'pattern-miner-latest.json'), JSON.stringify(report, null, 2));
  } catch { /* best-effort */ }
}

if (require.main === module) {
  main().catch((err) => {
    warnOnce(`fatal: ${err && err.message}`);
    process.exit(0); // trainers NEVER block CI
  });
}

module.exports = {
  mine,
  renderMarkdown,
  // exposed for tests
  _topModulesByFixCount: topModulesByFixCount,
  _topRuleKeysByAttempts: topRuleKeysByAttempts,
  _recurringSubjects: recurringSubjects,
  _underTestedModules: underTestedModules,
  _claudeRatioByLayer: claudeRatioByLayer,
  _mcpToolUsageStats: mcpToolUsageStats,
};
