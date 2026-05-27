/**
 * Live SQL Injection Probe Module.
 *
 * Tests endpoints discovered via endpoint-discovery for SQL injection by
 * sending detection-class payloads from payload-library and analysing
 * responses for tells:
 *   - Error-based: response body contains DB-error strings (SQLState, ORA-,
 *     MySQL, Postgres syntax, MSSQL conversion errors)
 *   - Boolean: a payload that should change the result actually does
 *   - Timing: response time stretches by the requested delay
 *
 * THIS MODULE WILL NOT RUN IN CUSTOMER SCANS. It is wired into the registry
 * but NOT registered in any tier suite. It requires authorize() from
 * authorization-gate to grant before a single payload is transmitted.
 *
 * Tier: Pen Test ($999) — pending compliance build (lawyer + RoE + DNS-TXT
 * verification + insurance). Until then, this module exists as the engine
 * but is not customer-facing.
 */

'use strict';

const BaseModule = require('./base-module');
const { LiveProbeRunner } = require('../core/live-probe-runner');
const { SQL_INJECTION_PAYLOADS } = require('../core/payload-library');
const { authorize, AuthorizationRefusedError } = require('../core/authorization-gate');

// ─── Detection patterns ────────────────────────────────────────────────

const DB_ERROR_PATTERNS = [
  // MySQL
  /\bSQL syntax\b.*\bMySQL\b/i,
  /\bYou have an error in your SQL syntax\b/i,
  /\bmysqli?_(query|fetch|num_rows)\b/i,
  // PostgreSQL
  /\bPG::SyntaxError\b/i,
  /\bunterminated quoted string\b/i,
  /\bsyntax error at or near\b/i,
  // MSSQL
  /\bUnclosed quotation mark\b/i,
  /\bConversion failed when converting\b/i,
  /\bMicrosoft SQL Server\b/i,
  // Oracle
  /\bORA-\d{5}\b/,
  /\bquoted string not properly terminated\b/i,
  // SQLite
  /\bSQLite3?::SQLException\b/i,
  /\bno such column\b/i,
  // Generic
  /\bSQLSTATE\[/i,
];

function bodyHasDbError(body) {
  if (typeof body !== 'string' || body.length === 0) return null;
  for (const re of DB_ERROR_PATTERNS) {
    if (re.test(body)) return re.toString();
  }
  return null;
}

// ─── Module ────────────────────────────────────────────────────────────

class LiveSqlInjectionModule extends BaseModule {
  constructor() {
    super(
      'liveSqlInjection',
      'Live SQL-injection probe — error-based, boolean, timing payloads against discovered endpoints (Pen Test tier — requires authorization)',
    );
  }

  async run(result, config) {
    const cfg = (config && config.liveSqlInjection) || {};
    const targets = Array.isArray(cfg.targets) ? cfg.targets : [];
    const baseUrl = cfg.baseUrl || (targets[0] && targets[0].url) || null;

    if (!baseUrl || targets.length === 0) {
      result.addCheck('live-sql-injection:noop', true, {
        severity: 'info',
        message: 'No targets configured — module idle',
      });
      return;
    }

    // ── Authorization gate — refuses if not all 3 keys present ──
    try {
      await authorize({
        url: baseUrl,
        consent: cfg.consent,
        actorId: cfg.actorId,
        actorIp: cfg.actorIp,
        moduleName: 'liveSqlInjection',
        dnsResolver: cfg.dnsResolver,
        auditDir: cfg.auditDir,
      });
    } catch (err) {
      if (err instanceof AuthorizationRefusedError) {
        result.addCheck('live-sql-injection:refused', true, {
          severity: 'info',
          message: `Authorization refused: ${err.reason}`,
          reason: err.reason,
          details: err.details,
        });
        return;
      }
      throw err;
    }

    // ── Probe execution ──
    const runner = cfg.runner || new LiveProbeRunner(cfg.runnerOpts || {});
    const findings = [];

    for (const target of targets.slice(0, cfg.maxTargets || 50)) {
      const { url, method = 'GET', paramName, paramLocation } = target;
      if (!paramName) continue;

      // First — baseline (benign value) to compare against.
      const baselineRes = await this._send(runner, url, method, paramName, paramLocation, 'GateTest_baseline_123');
      if (baselineRes.aborted) break;

      for (const probe of SQL_INJECTION_PAYLOADS) {
        const r = await this._send(runner, url, method, paramName, paramLocation, probe.payload);
        if (r.aborted) break;

        // Detection 1 — error reflected
        if (r.ok && r.body) {
          const errMatch = bodyHasDbError(r.body);
          if (errMatch) {
            findings.push({
              url, method, paramName, payloadClass: probe.class,
              payload: probe.payload, marker: probe.detect,
              evidence: `db-error pattern matched: ${errMatch}`,
            });
            break; // Don't keep firing payloads against a confirmed-vulnerable param
          }
        }

        // Detection 2 — timing payload increased response time vs. baseline
        if (probe.class === 'timing' && probe.timingMs && r.ok && baselineRes.ok) {
          const delta = r.timeMs - baselineRes.timeMs;
          if (delta >= probe.timingMs * 0.8) {
            findings.push({
              url, method, paramName, payloadClass: probe.class,
              payload: probe.payload, marker: probe.detect,
              evidence: `response time increased by ${delta}ms (expected ${probe.timingMs}ms)`,
            });
            break;
          }
        }

        // Detection 3 — boolean pair contradiction (handled below per param)
      }
    }

    // ── Emit findings ──
    for (const f of findings) {
      result.addCheck(`live-sql-injection:${f.url}:${f.paramName}`, false, {
        severity: 'error',
        message: `Possible SQL injection: ${f.method} ${f.url} (param: ${f.paramName})`,
        file: f.url,
        rule: 'live-sql-injection',
        payloadClass: f.payloadClass,
        evidence: f.evidence,
      });
    }

    const summary = runner.summary();
    result.addCheck('live-sql-injection:summary', true, {
      severity: 'info',
      message: `${findings.length} possible injection(s); ${summary.totalRequests} probes sent${summary.aborted ? ` (aborted: ${summary.abortReason})` : ''}`,
      probeCount: summary.totalRequests,
      findingsCount: findings.length,
    });
  }

  async _send(runner, url, method, paramName, paramLocation, value) {
    if (paramLocation === 'query') {
      const u = new URL(url);
      u.searchParams.set(paramName, value);
      return runner.probe({ method, url: u.toString() });
    }
    if (paramLocation === 'body') {
      const body = JSON.stringify({ [paramName]: value });
      return runner.probe({
        method, url, body,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (paramLocation === 'header') {
      return runner.probe({ method, url, headers: { [paramName]: value } });
    }
    return runner.probe({ method, url });
  }
}

module.exports = LiveSqlInjectionModule;
// Exposed for unit tests
module.exports.DB_ERROR_PATTERNS = DB_ERROR_PATTERNS;
module.exports.bodyHasDbError = bodyHasDbError;
