/**
 * Watchdog Intelligence — the brain the watchdog tick never had.
 *
 * Three capabilities, all pure JS and dependency-injected so the tick
 * route (TS) and tests can drive them without network or DB access:
 *
 *   1. detectAnomalies()      — trend-aware anomaly detection against the
 *                               watch's OWN history (status transitions,
 *                               duration spikes, issue-count spikes,
 *                               status flapping). Deterministic, free.
 *   2. diagnoseWatchEvent()   — Claude root-cause diagnosis of a
 *                               degradation, fed the scan evidence and
 *                               recent history. Injected askClaude,
 *                               structured STATUS/CAUSE/IMPACT/NEXT
 *                               response, non-blocking on failure.
 *   3. composeBriefing()      — deterministic operator briefing across
 *                               all watches for the last 24h: fleet
 *                               counts, transitions, auto-fix outcomes,
 *                               anomalies, stored diagnoses. Zero cost.
 *
 * Severity ladder for anomalies: 'critical' > 'warning' > 'info'.
 * The tick route only spends Claude calls on 'critical' (worsening
 * transitions), capped per tick, so the watchdog can never run away
 * with Anthropic spend.
 */

const { ANTI_INJECTION_PREAMBLE, wrapUntrusted } = require('./prompt-injection-guard');

/** Statuses ordered from best to worst so transitions can be compared. */
const STATUS_RANK = { healthy: 0, degraded: 1, down: 2 };

function rankOf(status) {
  return STATUS_RANK[status] !== undefined ? STATUS_RANK[status] : 1;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function meanAndStddev(values) {
  if (values.length === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Detect anomalies for one watch given its recent scan history.
 *
 * @param {object} opts
 * @param {Array<{status: string, totalIssues: number, durationMs: number}>} opts.history
 *        Most-recent-first prior scan records (NOT including the current one).
 *        Shape mirrors what the tick stores in heal_history details.
 * @param {{status: string, totalIssues: number, durationMs: number}} opts.current
 * @param {string|null} opts.previousStatus  The watch row's last_status.
 * @returns {Array<{kind: string, severity: string, detail: string}>}
 */
function detectAnomalies({ history = [], current, previousStatus = null }) {
  const anomalies = [];
  if (!current) return anomalies;

  // 1. Status transition — the single most important signal.
  if (previousStatus && previousStatus !== current.status) {
    const worsened = rankOf(current.status) > rankOf(previousStatus);
    anomalies.push({
      kind: worsened ? 'status-worsened' : 'status-recovered',
      severity: worsened ? 'critical' : 'info',
      detail: `status ${previousStatus} → ${current.status} (${current.totalIssues} issue(s))`,
    });
  }

  // 2. Duration spike — needs a baseline of at least 3 prior samples.
  const durations = history.map((h) => h.durationMs).filter((d) => Number.isFinite(d) && d > 0);
  if (Number.isFinite(current.durationMs) && durations.length >= 3) {
    const base = median(durations);
    // 3x median AND at least 5s absolute so tiny-fast scans don't FP.
    if (base > 0 && current.durationMs > base * 3 && current.durationMs - base > 5000) {
      anomalies.push({
        kind: 'duration-spike',
        severity: 'warning',
        detail: `scan took ${Math.round(current.durationMs / 1000)}s vs ~${Math.round(base / 1000)}s median (${(current.durationMs / base).toFixed(1)}x slower)`,
      });
    }
  }

  // 3. Issue-count spike — 2σ above baseline mean, with a floor of +3
  //    so a 0→2 wobble on a quiet target doesn't page anyone.
  const counts = history.map((h) => h.totalIssues).filter((n) => Number.isFinite(n));
  if (Number.isFinite(current.totalIssues) && counts.length >= 3) {
    const { mean, stddev } = meanAndStddev(counts);
    const threshold = mean + Math.max(3, 2 * stddev);
    if (current.totalIssues > threshold) {
      anomalies.push({
        kind: 'issue-spike',
        severity: 'warning',
        detail: `${current.totalIssues} issues vs baseline ~${mean.toFixed(1)} (threshold ${threshold.toFixed(1)})`,
      });
    }
  }

  // 4. Flapping — 3+ status changes across the last 10 scans means the
  //    target is unstable, which is its own problem even if it is
  //    currently "healthy".
  const recent = history.slice(0, 10);
  if (recent.length >= 4) {
    let changes = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].status !== recent[i - 1].status) changes++;
    }
    if (current.status !== (recent[0] && recent[0].status)) changes++;
    if (changes >= 3) {
      anomalies.push({
        kind: 'flapping',
        severity: 'warning',
        detail: `${changes} status changes across the last ${recent.length + 1} scans — unstable target`,
      });
    }
  }

  return anomalies;
}

/**
 * Build the diagnosis prompt. Exposed for tests.
 */
function buildWatchDiagnosisPrompt({ watch, scanResult, anomalies = [], recentHistory = [] }) {
  const failedModules = (scanResult.modules || [])
    .filter((m) => m.status !== 'passed')
    .slice(0, 8)
    .map((m) => `- ${wrapUntrusted('module', m.name)}: ${wrapUntrusted('details', (m.details || []).slice(0, 3).join(' | ') || '(no detail)')}`)
    .join('\n');

  const historyLines = recentHistory
    .slice(0, 6)
    .map((h) => `- status=${h.status} issues=${h.totalIssues} duration=${Math.round((h.durationMs || 0) / 1000)}s`)
    .join('\n');

  const anomalyLines = anomalies.map((a) => `- [${a.severity}] ${a.kind}: ${a.detail}`).join('\n');

  return `${ANTI_INJECTION_PREAMBLE}
You are the watchdog diagnosis agent for GateTest's admin console. A monitored target just degraded. The operator needs a fast, specific read on WHY — not a generic checklist.

TARGET: ${wrapUntrusted('target', watch.target)} (type: ${watch.target_type})
CURRENT: status=${scanResult.status}, ${scanResult.totalIssues} issue(s)

FAILED MODULES (sampled):
${failedModules || '(no module detail available)'}

RECENT SCAN HISTORY (most recent first):
${historyLines || '(no prior history)'}

DETECTED ANOMALIES:
${anomalyLines || '(none)'}

Respond in EXACTLY this format, nothing before or after:
STATUS: <one-line plain-English summary of what changed>
CAUSE: <most likely root cause given the evidence — name the module/finding driving it; say "uncertain" if the evidence is thin>
IMPACT: <what this means for the target's users right now>
NEXT: <the single most useful action the operator should take first>`;
}

function parseDiagnosisResponse(text) {
  const sections = { status: null, cause: null, impact: null, next: null };
  const patterns = [
    ['status', /^STATUS:\s*(.+)$/m],
    ['cause', /^CAUSE:\s*(.+)$/m],
    ['impact', /^IMPACT:\s*(.+)$/m],
    ['next', /^NEXT:\s*(.+)$/m],
  ];
  for (const [key, re] of patterns) {
    const m = (text || '').match(re);
    if (m) sections[key] = m[1].trim();
  }
  return sections;
}

/**
 * Run a Claude diagnosis for one degraded watch. Never throws — a
 * diagnosis failure must not break the tick (Forbidden #15: wrap, log,
 * recover).
 *
 * @param {object} opts
 * @param {object} opts.watch          { target, target_type }
 * @param {object} opts.scanResult     { status, totalIssues, modules? }
 * @param {Array}  opts.anomalies      output of detectAnomalies
 * @param {Array}  opts.recentHistory  prior scan records, most recent first
 * @param {(prompt: string) => Promise<string>} opts.askClaude
 * @returns {Promise<{ok: boolean, diagnosis: object|null, reason: string|null}>}
 */
async function diagnoseWatchEvent({ watch, scanResult, anomalies, recentHistory, askClaude }) {
  if (typeof askClaude !== 'function') {
    return { ok: false, diagnosis: null, reason: 'askClaude not provided' };
  }
  try {
    const prompt = buildWatchDiagnosisPrompt({ watch, scanResult, anomalies, recentHistory });
    const text = await askClaude(prompt);
    const parsed = parseDiagnosisResponse(text);
    if (!parsed.status && !parsed.cause) {
      return { ok: false, diagnosis: null, reason: 'unparseable diagnosis response' };
    }
    return { ok: true, diagnosis: parsed, reason: null };
  } catch (err) {
    return { ok: false, diagnosis: null, reason: err && err.message ? err.message : String(err) };
  }
}

/**
 * Compose the operator briefing — deterministic, zero-cost, renders as
 * markdown. The admin panel shows this verbatim.
 *
 * @param {object} opts
 * @param {Array} opts.watches     watch rows: { target, target_type, enabled,
 *                                 last_status, last_issue_count, last_checked_at }
 * @param {Array} opts.events      last-24h heal_history rows:
 *                                 { watch_id, target?, action, status, pr_url?, details? }
 * @param {Array} opts.diagnoses   stored diagnosis rows: { target, diagnosis: {status,cause,impact,next} }
 * @param {Date}  [opts.now]
 * @returns {{markdown: string, stats: object}}
 */
function composeBriefing({ watches = [], events = [], diagnoses = [], now = new Date() }) {
  const enabled = watches.filter((w) => w.enabled !== false);
  const byStatus = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
  for (const w of enabled) {
    const s = w.last_status && byStatus[w.last_status] !== undefined ? w.last_status : 'unknown';
    byStatus[s]++;
  }

  const scans = events.filter((e) => e.action === 'scan');
  const fixes = events.filter((e) => e.action === 'auto_fix_pr');
  const anomalyEvents = events.filter((e) => e.action === 'anomaly');
  const prsOpened = fixes.filter((f) => f.status === 'success');
  const fixesFailed = fixes.filter((f) => f.status === 'failed');
  const fixesSkipped = fixes.filter((f) => f.status === 'skipped');

  const stats = {
    watchesEnabled: enabled.length,
    healthy: byStatus.healthy,
    degraded: byStatus.degraded,
    down: byStatus.down,
    unknown: byStatus.unknown,
    scans24h: scans.length,
    anomalies24h: anomalyEvents.length,
    prsOpened24h: prsOpened.length,
    fixesFailed24h: fixesFailed.length,
    fixesSkipped24h: fixesSkipped.length,
    diagnoses24h: diagnoses.length,
  };

  const lines = [];
  lines.push(`# Watchdog briefing — ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  lines.push('');

  const fleetBits = [`${byStatus.healthy} healthy`];
  if (byStatus.degraded) fleetBits.push(`${byStatus.degraded} degraded`);
  if (byStatus.down) fleetBits.push(`**${byStatus.down} down**`);
  if (byStatus.unknown) fleetBits.push(`${byStatus.unknown} never checked`);
  lines.push(`**Fleet:** ${enabled.length} watch(es) — ${fleetBits.join(', ')}.`);
  lines.push(`**Last 24h:** ${scans.length} scan(s), ${anomalyEvents.length} anomaly event(s), ${prsOpened.length} auto-fix PR(s) opened, ${fixesFailed.length} fix attempt(s) failed.`);
  lines.push('');

  const attention = enabled.filter((w) => w.last_status === 'down' || w.last_status === 'degraded');
  if (attention.length > 0) {
    lines.push('## Needs attention');
    for (const w of attention.sort((a, b) => rankOf(b.last_status) - rankOf(a.last_status))) {
      lines.push(`- **${w.target}** — ${w.last_status}, ${w.last_issue_count ?? '?'} issue(s), last checked ${w.last_checked_at || 'never'}`);
    }
    lines.push('');
  }

  if (diagnoses.length > 0) {
    lines.push('## AI diagnoses (24h)');
    for (const d of diagnoses.slice(0, 5)) {
      const diag = d.diagnosis || {};
      lines.push(`- **${d.target}**: ${diag.status || '(no summary)'}`);
      if (diag.cause) lines.push(`  - Cause: ${diag.cause}`);
      if (diag.next) lines.push(`  - Next: ${diag.next}`);
    }
    lines.push('');
  }

  if (anomalyEvents.length > 0) {
    lines.push('## Anomalies (24h)');
    for (const a of anomalyEvents.slice(0, 10)) {
      const det = a.details || {};
      lines.push(`- ${a.target || `watch #${a.watch_id}`}: [${det.severity || 'warning'}] ${det.kind || 'anomaly'} — ${det.detail || ''}`);
    }
    lines.push('');
  }

  if (prsOpened.length > 0) {
    lines.push('## Auto-fix PRs opened (24h)');
    for (const f of prsOpened.slice(0, 10)) {
      lines.push(`- ${f.target || `watch #${f.watch_id}`}: ${f.pr_url}`);
    }
    lines.push('');
  }

  if (attention.length === 0 && anomalyEvents.length === 0 && fixesFailed.length === 0) {
    lines.push('All quiet. Every watched target is green and no anomalies fired in the last 24 hours.');
  }

  return { markdown: lines.join('\n'), stats };
}

module.exports = {
  detectAnomalies,
  buildWatchDiagnosisPrompt,
  parseDiagnosisResponse,
  diagnoseWatchEvent,
  composeBriefing,
  STATUS_RANK,
};
