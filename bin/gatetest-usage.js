#!/usr/bin/env node

/**
 * gatetest usage — the customer's usage meter on the command line.
 *
 * Reads GET /api/v1/usage (website/app/api/v1/usage/route.ts, backed by the
 * ledger in website/app/lib/usage-ledger.js) and prints what the caller ran
 * and what the AI layer cost — across every surface (web, hosted fix, push
 * scans, REST API, MCP, CLI, editor), whoever paid for the key (a
 * GateTest-metered key or the customer's own model API key — BYOK).
 *
 * Nothing here is computed locally: the ledger sums money as integer
 * micro-dollars and converts once at the edge (fromMicros), so this command
 * only formats the numbers the API already produced. It never adds two
 * floats together and never invents a number — when it is not signed in,
 * offline, or the API cannot be reached it prints ONE line on stderr and
 * exits non-zero (Doctrine #1: a meter that prints zeros for a customer it
 * could not identify is reporting success while doing nothing).
 *
 * Auth: the same environment variable the rest of the CLI and the MCP
 * server already read — GATETEST_API_KEY — holding a gt_live_ REST key
 * (the /api/v1 contract; see website/app/lib/api-key.ts). `--key` overrides
 * it for one run. Origin: apiBaseUrl() from src/core/site-url.js, the one
 * definition of where the API lives (GATETEST_API_BASE_URL overrides).
 *
 * Exit codes: 0 report printed (including "no usage recorded yet" — a real
 * answer) · 1 the API refused or could not be reached · 2 usage error
 * (no key, wrong key type, offline, bad flag).
 */

'use strict';

const { apiBaseUrl, siteUrl, siteHost } = require('../src/core/site-url');
const { isOffline } = require('../src/core/offline');

const KEY_ENV = 'GATETEST_API_KEY';
const KEY_PREFIX = 'gt_live_';
const REQUEST_TIMEOUT_MS = 15000;
const RECENT_ROWS = 20;

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE_HELP = `
  gatetest usage [options]

  Your usage meter: scans, fixes, findings, AI tokens and estimated cost
  across every GateTest surface — the same report the dashboard shows at
  ${siteUrl('/dashboard/usage')}. BYOK runs (your own model API key) and
  metered runs (a GateTest key) are listed separately and never mixed.

  AUTH
    Reads ${KEY_ENV} — your gt_live_ REST API key (the key the
    /api/v1 endpoints take). Request one at ${siteUrl('/docs/api')}.
    Without a key nothing is printed and the exit code is 2: this command
    never shows zeros for an account it could not identify.

  OPTIONS
    --from <ISO date>  Start of the window (default: 30 days ago, UTC)
    --to <ISO date>    End of the window (default: now; a bare date means
                       that whole day)
    --key <gt_live_…>  Use this API key instead of ${KEY_ENV}
    --json             Print the API response as ONE JSON document on stdout
                       (nothing else goes to stdout)
    --help             Show this help

  EXIT CODES
    0  report printed (including "no usage recorded yet")
    1  the API refused the request or could not be reached
    2  usage error — no key, wrong key type, offline, unknown flag
`;

const VALUE_FLAGS = new Set(['--from', '--to', '--key']);

/**
 * Parse the subcommand's own flags. Unknown flags are collected, not
 * ignored — an ignored `--from` would silently report the wrong window.
 */
function parseUsageArgs(argv) {
  const out = { help: false, json: false, from: null, to: null, key: null, problems: [] };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (VALUE_FLAGS.has(a)) {
      const v = list[i + 1];
      if (v == null || v.startsWith('--')) { out.problems.push(`${a} needs a value`); continue; }
      out[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) out.problems.push(`unknown option ${a}`);
    else out.problems.push(`unexpected argument ${a}`);
  }
  return out;
}

/**
 * The key this run authenticates with, or the one line that says why it
 * cannot. `--key` wins over the environment; both must be a gt_live_ REST
 * key — a gtmcp_ hosted-MCP key is a different product and the usage API
 * rejects it, so say so here instead of relaying a bare 401.
 */
function resolveApiKey(args, env = process.env) {
  const fromFlag = typeof args.key === 'string' ? args.key.trim() : '';
  const fromEnv = typeof env[KEY_ENV] === 'string' ? env[KEY_ENV].trim() : '';
  const key = fromFlag || fromEnv;
  const source = fromFlag ? '--key' : KEY_ENV;
  if (!key) {
    return {
      error: `gatetest usage: not signed in — set ${KEY_ENV} to your ${KEY_PREFIX} API key (or pass --key). Request a key at ${siteUrl('/docs/api')}. Nothing was reported.`,
    };
  }
  if (!key.startsWith(KEY_PREFIX)) {
    const kind = key.startsWith('gtmcp_') ? 'a hosted-MCP subscription key' : 'not a REST API key';
    return {
      error: `gatetest usage: ${source} is ${kind} — the usage API needs a ${KEY_PREFIX} key. Request one at ${siteUrl('/docs/api')}. Nothing was reported.`,
    };
  }
  return { key, source };
}

// ---------------------------------------------------------------------------
// Formatting — presentation only. Money arrives as USD already converted
// from integer micro-dollars by the ledger; it is re-expressed as integer
// micros here so the printed string is exact (no float arithmetic, no
// accumulation), and sub-cent estimates are not rounded away to "$0.00".
// ---------------------------------------------------------------------------

function toMicros(usd) {
  const n = Number(usd);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) : 0;
}

function formatUsd(usd) {
  const micros = toMicros(usd);
  if (micros === 0) return '$0.00';
  const dollars = Math.floor(micros / 1e6);
  const rest = micros % 1e6;
  const dollarStr = dollars.toLocaleString('en-US');
  if (rest % 10000 === 0) return `$${dollarStr}.${String(rest / 10000).padStart(2, '0')}`;
  // Sub-cent: four decimals, exact from the integer.
  return `$${dollarStr}.${String(Math.round(rest / 100)).padStart(4, '0')}`;
}

function formatInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—';
}

function dayOf(iso) {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '—';
}

function whenOf(iso) {
  if (typeof iso !== 'string') return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso.slice(0, 16);
  return t.toISOString().slice(0, 16).replace('T', ' ');
}

function pad(s, w, right = false) {
  const str = String(s == null ? '' : s);
  if (str.length >= w) return str;
  return right ? ' '.repeat(w - str.length) + str : str + ' '.repeat(w - str.length);
}

/** Render rows as an aligned table; `align` marks numeric columns. */
function table(header, rows, align) {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => String(r[c] == null ? '' : r[c]).length)));
  return all.map((r) => '  ' + r.map((cell, c) => pad(cell, widths[c], align[c] === 'r')).join('  ').trimEnd());
}

function keyOwnerLabel(owner) {
  return owner === 'byok' ? 'BYOK' : 'metered';
}

/**
 * The human report. `report` is the GET /api/v1/usage body. Returns lines.
 * An account with no events in the window gets a sentence, not a table of
 * zeros — zeros dressed as a bill are the fake success Doctrine #1 forbids.
 */
function formatUsageTable(report, opts = {}) {
  const host = opts.host || siteHost();
  const s = (report && report.summary) || {};
  const win = s.window || {};
  const lines = [];
  const windowLabel = `${dayOf(win.from)} → ${dayOf(win.to)} (UTC)`;
  lines.push(`GateTest usage · ${host} · ${windowLabel}`);

  const events = Number(s.events) || 0;
  if (events === 0) {
    lines.push('');
    lines.push('  No usage recorded yet for this window.');
    lines.push('  Scans and fixes you run on any surface — web, CLI, GitHub Action, MCP, editor —');
    lines.push('  appear here once they finish. Widen the window with --from <date>.');
    return lines;
  }

  const byok = Number(s.byokEvents) || 0;
  const metered = events - byok;
  lines.push('');
  lines.push(`  Runs       ${formatInt(s.scans)} scans · ${formatInt(s.fixes)} fixes · ${formatInt(s.modulesRun)} modules run`);
  lines.push(`  Findings   ${formatInt(s.findingsTotal)} total · ${formatInt(s.findingsBlocking)} blocking`);
  lines.push(`  AI         ${formatInt(s.aiCalls)} calls · ${formatInt(s.tokensIn)} tokens in · ${formatInt(s.tokensOut)} out · ${formatInt(s.tokensTotal)} total`);
  lines.push(`  Cost       ${formatUsd(s.usdEstimated)} estimated from recorded tokens`);
  lines.push(`             BYOK (your own model API key)   ${formatUsd(s.usdByok)}  · ${formatInt(byok)} run${byok === 1 ? '' : 's'}`);
  lines.push(`             Metered (GateTest key)           ${formatUsd(s.usdGatetestPaid)}  · ${formatInt(metered)} run${metered === 1 ? '' : 's'}`);

  const bySurface = (report && report.bySurface) || {};
  const surfaces = Object.keys(bySurface).sort((a, b) => (bySurface[b].events || 0) - (bySurface[a].events || 0));
  if (surfaces.length > 0) {
    lines.push('');
    lines.push('By surface');
    const rows = surfaces.map((name) => {
      const v = bySurface[name] || {};
      return [name, formatInt(v.events), formatInt(v.findingsTotal), formatInt(v.aiCalls),
        formatInt((Number(v.tokensIn) || 0) + (Number(v.tokensOut) || 0)), formatUsd(v.usdEstimated), formatInt(v.byokEvents)];
    });
    lines.push(...table(['surface', 'runs', 'findings', 'ai calls', 'tokens', 'cost', 'byok runs'], rows, ['l', 'r', 'r', 'r', 'r', 'r', 'r']));
  }

  const series = Array.isArray(report && report.series) ? report.series.filter((d) => (Number(d.events) || 0) > 0) : [];
  if (series.length > 0) {
    lines.push('');
    lines.push(`By day (${series.length} active day${series.length === 1 ? '' : 's'}; quiet days omitted)`);
    const rows = series.map((d) => [d.day, formatInt(d.events), formatInt(d.findingsTotal), formatInt(d.aiCalls),
      formatInt((Number(d.tokensIn) || 0) + (Number(d.tokensOut) || 0)), formatUsd(d.usdEstimated)]);
    lines.push(...table(['day (UTC)', 'runs', 'findings', 'ai calls', 'tokens', 'cost'], rows, ['l', 'r', 'r', 'r', 'r', 'r']));
  }

  const recent = Array.isArray(report && report.recent) ? report.recent.slice(0, RECENT_ROWS) : [];
  if (recent.length > 0) {
    lines.push('');
    const more = report.nextCursor != null ? ' — more on the dashboard' : '';
    lines.push(`Recent (newest first, ${recent.length} shown${more})`);
    const rows = recent.map((e) => [whenOf(e.occurredAt), e.surface || '—', e.repo || '—', e.suite || e.tier || '—',
      formatInt(e.findingsTotal), formatInt(e.aiCalls), formatInt((Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0)),
      formatUsd(e.usdEstimated), keyOwnerLabel(e.keyOwner)]);
    lines.push(...table(['when (UTC)', 'surface', 'repo', 'suite', 'findings', 'ai', 'tokens', 'cost', 'key'], rows,
      ['l', 'l', 'l', 'l', 'r', 'r', 'r', 'r', 'l']));
  }

  lines.push('');
  lines.push(`  Full history and per-day charts: ${siteUrl('/dashboard/usage')}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function usageUrl(baseUrl, args) {
  const url = new URL('/api/v1/usage', baseUrl);
  if (args.from) url.searchParams.set('from', args.from);
  if (args.to) url.searchParams.set('to', args.to);
  return url.toString();
}

/**
 * One GET. Resolves { status, body } for any HTTP answer; rejects only when
 * the network did (the caller turns that into the "could not reach" line).
 */
async function fetchUsage({ key, args, baseUrl, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('fetch is not available in this Node runtime');
  const res = await doFetch(usageUrl(baseUrl, args), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'User-Agent': `gatetest-cli usage (${siteHost()})`,
    },
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv   flags after `usage`
 * @param {{ env?: object, fetch?: Function, baseUrl?: string, timeoutMs?: number }} [deps]
 * @returns {Promise<number>} exit code
 */
async function main(argv, deps = {}) {
  const env = deps.env || process.env;
  const args = parseUsageArgs(argv);
  if (args.help) {
    console.log(USAGE_HELP);
    return EXIT_OK;
  }
  if (args.problems.length > 0) {
    console.error(`gatetest usage: ${args.problems.join('; ')}. See 'gatetest usage --help'.`);
    return EXIT_USAGE;
  }
  const baseUrl = deps.baseUrl || apiBaseUrl(env);
  let host;
  try { host = new URL(baseUrl).host; } catch { host = baseUrl; }

  if (isOffline(env)) {
    console.error(`gatetest usage: offline mode — the usage meter lives at ${host} and nothing leaves this machine. Unset GATETEST_OFFLINE to use it. Nothing was reported.`);
    return EXIT_USAGE;
  }
  const auth = resolveApiKey(args, env);
  if (auth.error) {
    console.error(auth.error);
    return EXIT_USAGE;
  }

  let res;
  try {
    res = await fetchUsage({ key: auth.key, args, baseUrl, fetchImpl: deps.fetch, timeoutMs: deps.timeoutMs });
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? `timed out after ${(deps.timeoutMs || REQUEST_TIMEOUT_MS) / 1000}s` : (err && err.message) || String(err);
    console.error(`gatetest usage: could not reach ${host} (${reason}). Nothing was reported.`);
    return EXIT_FAILED;
  }
  if (!res.ok) {
    const detail = res.body && typeof res.body.error === 'string' ? `: ${res.body.error}` : '';
    const hint = res.status === 401 || res.status === 403
      ? ` Check ${auth.source} — it must be an active ${KEY_PREFIX} key for your account.`
      : res.status === 503 ? ' The usage ledger is not available right now; nothing was checked.' : '';
    console.error(`gatetest usage: ${host} answered ${res.status}${detail}.${hint}`);
    return EXIT_FAILED;
  }
  if (!res.body || typeof res.body !== 'object' || !res.body.summary || typeof res.body.summary !== 'object') {
    console.error(`gatetest usage: ${host} answered 200 without a usage summary — not a report. Nothing was reported.`);
    return EXIT_FAILED;
  }

  if (args.json) {
    console.log(JSON.stringify(res.body, null, 2));
    return EXIT_OK;
  }
  for (const line of formatUsageTable(res.body, { host })) console.log(line);
  return EXIT_OK;
}

module.exports = {
  main,
  parseUsageArgs,
  resolveApiKey,
  formatUsageTable,
  formatUsd,
  fetchUsage,
  usageUrl,
  USAGE_HELP,
  KEY_ENV,
  KEY_PREFIX,
  EXIT_OK,
  EXIT_FAILED,
  EXIT_USAGE,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`gatetest usage: ${err && err.message ? err.message : err}`);
    process.exit(EXIT_FAILED);
  });
}
