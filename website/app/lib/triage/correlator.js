'use strict';

/**
 * GateTest Triage Correlator
 *
 * Pure logic — no I/O, no HTTP. Takes three scan-layer summaries
 * (source / server / browser) and produces a single localised verdict
 * naming WHICH layer the problem lives in.
 *
 * Contract is frozen — orchestrator + admin UI agents build against it.
 * Do not change `module.exports`.
 */

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

// ---------- regexes (compiled once) ----------
const RE_SERVER_DOWN = /5\d\d|timed out|timeout|connection refused|cannot reach|unreachable|econnrefused|enotfound/i;
const RE_BROWSER_PAINT_FAIL = /could not load|navigation failed|net::err|page failed|did not paint|blank page|playwright not available/i;
const RE_BROWSER_RUNTIME = /page-error|page_error|pageerror|uncaught|hydration|chunk[- ]?load|chunkloaderror|console-error/i;
const RE_SOURCE_RUNTIME_FAMILY = /errorSwallow|undefinedRef|undefined-ref|null[- ]?deref|typeError|nPlusOne|asyncIteration|raceCondition|resourceLeak/i;
const RE_SECURITY_HEADER = /csp|content-security-policy|hsts|strict-transport|x-frame|x-content-type|tls|certificate|cipher|cookie.*(secure|httponly)|cors/i;

// ---------- helpers ----------
function isLayer(x) {
  return x && typeof x === 'object';
}

function safeLayer(x) {
  if (!isLayer(x)) {
    return { ok: false, totalIssues: 0, failedModules: 0, topFindings: [], error: 'missing layer' };
  }
  return {
    ok: x.ok === true,
    totalIssues: Number.isFinite(x.totalIssues) ? x.totalIssues : 0,
    failedModules: Number.isFinite(x.failedModules) ? x.failedModules : 0,
    topFindings: Array.isArray(x.topFindings) ? x.topFindings.filter(isLayer) : [],
    error: typeof x.error === 'string' ? x.error : undefined,
  };
}

function errorCount(layer) {
  return layer.topFindings.filter((f) => f.severity === 'error').length;
}

function anyFindingMatches(layer, regex) {
  return layer.topFindings.some(
    (f) => typeof f.detail === 'string' && regex.test(f.detail)
  ) || (typeof layer.error === 'string' && regex.test(layer.error));
}

function hasModuleMatching(layer, regex) {
  return layer.topFindings.some((f) => typeof f.module === 'string' && regex.test(f.module));
}

function hasDetailOrModule(layer, regex) {
  return anyFindingMatches(layer, regex) || hasModuleMatching(layer, regex);
}

// ---------- summariseLayer ----------
function summariseLayer(raw, opts) {
  const source = (opts && opts.source) || 'source';
  if (!raw || typeof raw !== 'object') {
    return { ok: false, totalIssues: 0, failedModules: 0, topFindings: [], error: 'no response' };
  }

  const ok = raw.ok !== false && !raw.error;
  const totalIssues =
    Number.isFinite(raw.totalIssues) ? raw.totalIssues :
    Number.isFinite(raw.errorCount) ? raw.errorCount + (raw.warningCount || 0) :
    Array.isArray(raw.findings) ? raw.findings.length : 0;

  let failedModules = 0;
  if (Array.isArray(raw.modules)) {
    failedModules = raw.modules.filter((m) => m && m.status === 'failed').length;
  } else if (Number.isFinite(raw.failedModules)) {
    failedModules = raw.failedModules;
  }

  // Collect findings from common shapes
  let findings = [];
  if (Array.isArray(raw.topFindings)) findings = raw.topFindings.slice();
  else if (Array.isArray(raw.findings)) findings = raw.findings.slice();
  else if (Array.isArray(raw.modules)) {
    for (const m of raw.modules) {
      if (!m || !Array.isArray(m.checks)) continue;
      for (const c of m.checks) {
        findings.push({
          module: m.name || source,
          severity: c.severity || 'warning',
          detail: c.message || c.detail || '',
        });
      }
    }
  }

  // Normalise
  findings = findings
    .filter(isLayer)
    .map((f) => ({
      module: typeof f.module === 'string' ? f.module : source,
      severity: ['error', 'warning', 'info'].includes(f.severity) ? f.severity : 'warning',
      detail: typeof f.detail === 'string' ? f.detail.slice(0, 200) : '',
    }));

  // Drop info if non-info available; sort by severity; cap at 5
  const nonInfo = findings.filter((f) => f.severity !== 'info');
  const pool = nonInfo.length > 0 ? nonInfo : findings;
  pool.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    ok,
    totalIssues,
    failedModules,
    topFindings: pool.slice(0, 5),
    error: raw.error || (ok ? undefined : 'scan failed'),
  };
}

// ---------- correlate ----------
function correlate(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const source = safeLayer(inp.source);
  const server = safeLayer(inp.server);
  const browser = safeLayer(inp.browser);

  // Rule 1 — all three failed to run
  if (!source.ok && !server.ok && !browser.ok) {
    return {
      layer: 'unknown',
      confidence: 'low',
      headline: 'All three scans failed to complete',
      rationale: 'Source, server, and browser scans all errored out before producing usable signal. We have no data to localise the problem.',
      recommendedNext: 'Retry the triage run; if it fails again, check the orchestrator logs and that the target URL is correct.',
    };
  }

  const serverDown =
    !server.ok || anyFindingMatches(server, RE_SERVER_DOWN);
  const browserCouldntPaint =
    !browser.ok || anyFindingMatches(browser, RE_BROWSER_PAINT_FAIL) || hasDetailOrModule(browser, /network|fetch[- ]?fail|net-error/i);

  // Rule 2 — server unreachable + browser failed/network errors
  if (serverDown && browserCouldntPaint) {
    return {
      layer: 'server',
      confidence: 'high',
      headline: 'Server is unreachable or returning 5xx — browser cannot paint',
      rationale: 'The server probe failed or returned 5xx-class responses, and the headless browser was unable to load the page or saw network failures. This is the strongest single-layer signal in the triage matrix.',
      recommendedNext: 'Check the origin server, load balancer, and DNS. Restore server availability before re-running the source/browser triage.',
    };
  }

  const browserRuntime = hasDetailOrModule(browser, RE_BROWSER_RUNTIME);
  const sourceErrors = errorCount(source) > 0;
  const sourceRuntimeFamily = hasDetailOrModule(source, RE_SOURCE_RUNTIME_FAMILY);
  const serverHealthy = server.ok && errorCount(server) === 0;
  const browserHealthy = browser.ok && errorCount(browser) === 0;

  // Rule 3 — browser runtime errors, source clean, server healthy → build/deploy skew
  if (browserRuntime && !sourceErrors && serverHealthy) {
    return {
      layer: 'build',
      confidence: 'medium',
      headline: 'Browser shows runtime errors but source HEAD is clean',
      rationale: 'The deployed bundle is throwing uncaught errors or hydration mismatches that do not correspond to anything in the source layer, and the server itself is healthy. The most likely cause is a build/deploy mismatch — the running bundle was built from a different commit or with a different config than current source.',
      recommendedNext: 'Re-run the deploy pipeline from the current source HEAD and verify the bundle hash matches; check for stale CDN cache.',
    };
  }

  // Rule 4 — browser runtime + source has matching-family errors → source is the cause
  if (browserRuntime && sourceRuntimeFamily) {
    return {
      layer: 'source',
      confidence: 'high',
      headline: 'Browser runtime errors trace back to source-level bugs',
      rationale: 'The runtime failures observed in the browser correspond to error-handling, async-iteration, or null-dereference findings flagged by the static scan. The runtime symptom is a direct downstream effect of a statically visible source bug.',
      recommendedNext: 'Fix the source findings listed above; the browser errors should clear once the underlying bug ships.',
    };
  }

  // Rule 5 — server has security/header findings, nothing else
  const serverSecurityIssues = hasDetailOrModule(server, RE_SECURITY_HEADER) && errorCount(server) > 0;
  if (serverSecurityIssues && !browserRuntime && !sourceErrors) {
    return {
      layer: 'server',
      confidence: 'medium',
      headline: 'Server is reachable but misconfigured (security headers / TLS)',
      rationale: 'The server responds correctly but is missing or misconfiguring security-critical headers (CSP, HSTS, etc.) or TLS settings. Source and browser layers are clean.',
      recommendedNext: 'Update the server / edge config (nginx, vercel.json, next.config) to add the missing headers and re-deploy.',
    };
  }

  // Rule 6 — source errors, server + browser healthy → latent
  if (sourceErrors && serverHealthy && browserHealthy) {
    return {
      layer: 'source',
      confidence: 'medium',
      headline: 'Latent source issues — not yet manifesting in production',
      rationale: 'The static scan flagged errors in the source, but neither the server probe nor the live browser layer is showing symptoms yet. These are latent bugs waiting to surface.',
      recommendedNext: 'Ship the fixes now so the latent issues never reach a production incident.',
    };
  }

  // Rule 7 — two or three layers each have ≥3 errors → mixed
  const layersWith3Plus = [source, server, browser].filter((l) => errorCount(l) >= 3).length;
  if (layersWith3Plus >= 2) {
    return {
      layer: 'mixed',
      confidence: 'low',
      headline: 'Multiple layers each have significant errors — cannot localise',
      rationale: `Two or more layers (${layersWith3Plus} of 3) each have at least three error-severity findings. The correlator cannot point to a single root layer; operator must triage each layer in turn.`,
      recommendedNext: 'Start with the server layer, then source, then browser — fixing the deepest layer first usually clears symptoms upstream.',
    };
  }

  // Rule 8 — all clean
  if (source.totalIssues === 0 && server.totalIssues === 0 && browser.totalIssues === 0) {
    return {
      layer: 'unknown',
      confidence: 'high',
      headline: 'No issues detected across source, server, or browser layers',
      rationale: 'All three layers returned zero findings. The system is currently green across static, server, and runtime checks.',
      recommendedNext: 'Nothing to triage — system is green.',
    };
  }

  // Rule 9 — fallback
  const seen = [];
  if (source.totalIssues) seen.push(`source ${source.totalIssues}`);
  if (server.totalIssues) seen.push(`server ${server.totalIssues}`);
  if (browser.totalIssues) seen.push(`browser ${browser.totalIssues}`);
  return {
    layer: 'unknown',
    confidence: 'low',
    headline: 'Triage could not localise the problem to a single layer',
    rationale: `None of the correlator rules matched the observed pattern (${seen.join(', ') || 'no findings'}). Operator review required.`,
    recommendedNext: 'Inspect the per-layer findings below and decide manually which layer to address first.',
  };
}

// ---------- renderVerdictMarkdown ----------
function renderVerdictMarkdown(verdict, layers) {
  const v = verdict || {};
  const l = layers || {};
  const out = [];

  out.push(`## ${v.headline || 'Triage verdict'}`);
  out.push('');
  out.push(`**Layer:** \`${v.layer || 'unknown'}\` · **Confidence:** \`${v.confidence || 'low'}\``);
  out.push('');
  if (v.rationale) {
    out.push(v.rationale);
    out.push('');
  }

  const renderLayer = (name, data) => {
    out.push(`### ${name}`);
    if (!data) {
      out.push('_no data_');
      out.push('');
      return;
    }
    const status = data.ok ? 'ok' : `failed${data.error ? ` (${data.error})` : ''}`;
    out.push(`- Status: ${status}`);
    out.push(`- Issues: ${data.totalIssues || 0} · Failed modules: ${data.failedModules || 0}`);
    if (Array.isArray(data.topFindings) && data.topFindings.length > 0) {
      out.push('- Top findings:');
      for (const f of data.topFindings) {
        out.push(`  - \`${f.severity}\` **${f.module}** — ${f.detail}`);
      }
    }
    out.push('');
  };

  renderLayer('Source layer', l.source);
  renderLayer('Server layer', l.server);
  renderLayer('Browser layer', l.browser);

  if (v.recommendedNext) {
    out.push(`**Recommended next:** ${v.recommendedNext}`);
  }

  return out.join('\n');
}

module.exports = { correlate, summariseLayer, renderVerdictMarkdown };
