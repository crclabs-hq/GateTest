/**
 * Live IDOR Probe Module.
 *
 * For each numeric ID parameter discovered, fetch the resource at ID=N and
 * compare with ID=N-1, N+1, 0, 999999. If the response body for unauthorized
 * IDs returns 200 with content shaped like a record, that's a likely IDOR
 * (Insecure Direct Object Reference) — the customer's app isn't checking
 * ownership before returning the record.
 *
 * Conservative heuristic: only flag when the unauthorized response is
 * BOTH (a) status 200 AND (b) response body looks like a record (JSON
 * object / array, OR HTML containing typical record-page markers).
 *
 * Pen Test tier — requires authorization-gate consent.
 */

'use strict';

const BaseModule = require('./base-module');
const { LiveProbeRunner } = require('../core/live-probe-runner');
const { authorize, AuthorizationRefusedError } = require('../core/authorization-gate');

function looksLikeRecord(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  const trimmed = body.trim();
  // JSON object or array (most APIs)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return true;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return true;
  // HTML page with record-ish markers
  if (/<h1\b|<h2\b/i.test(trimmed) && trimmed.length > 200) return true;
  return false;
}

function isNumericId(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

class LiveIdorModule extends BaseModule {
  constructor() {
    super(
      'liveIdor',
      'Live IDOR probe — tests if other users\' object IDs are reachable without authorization (Pen Test tier — requires authorization)',
    );
  }

  async run(result, config) {
    const cfg = (config && config.liveIdor) || {};
    const targets = Array.isArray(cfg.targets) ? cfg.targets : [];
    const baseUrl = cfg.baseUrl || (targets[0] && targets[0].url) || null;

    if (!baseUrl || targets.length === 0) {
      result.addCheck('live-idor:noop', true, {
        severity: 'info', message: 'No targets configured — module idle',
      });
      return;
    }

    try {
      await authorize({
        url: baseUrl, consent: cfg.consent, actorId: cfg.actorId,
        actorIp: cfg.actorIp, moduleName: 'liveIdor',
        dnsResolver: cfg.dnsResolver, auditDir: cfg.auditDir,
      });
    } catch (err) {
      if (err instanceof AuthorizationRefusedError) {
        result.addCheck('live-idor:refused', true, {
          severity: 'info', message: `Authorization refused: ${err.reason}`, reason: err.reason,
        });
        return;
      }
      throw err;
    }

    const runner = cfg.runner || new LiveProbeRunner(cfg.runnerOpts || {});
    const findings = [];

    for (const target of targets.slice(0, cfg.maxTargets || 50)) {
      const { url, method = 'GET', paramName, paramLocation, paramValue } = target;
      if (!paramName) continue;

      // Determine baseline ID — either explicitly supplied or from URL
      let baseId = paramValue;
      if (!baseId && paramLocation === 'query') {
        try { baseId = new URL(url).searchParams.get(paramName); } catch { /* skip */ }
      }
      // Also accept path-form: /api/users/N
      if (!baseId && paramLocation === 'path') {
        const m = url.match(/\/(\d+)(?:\/|$)/);
        if (m) baseId = m[1];
      }
      if (!isNumericId(baseId)) continue;

      const baseNum = parseInt(baseId, 10);
      const probeIds = [baseNum - 1, baseNum + 1, 0, 999999].filter((n) => n >= 0 && n !== baseNum);

      for (const probeId of probeIds) {
        const probeUrl = this._mutate(url, paramName, paramLocation, String(probeId));
        const r = await runner.probe({ url: probeUrl, method });
        if (r.aborted) break;
        if (!r.ok) continue;

        if (r.status === 200 && looksLikeRecord(r.body)) {
          findings.push({
            url, method, paramName,
            originalId: baseId, probedId: probeId,
            evidence: `id=${probeId} returned 200 with record-shaped body`,
          });
          break;
        }
      }
    }

    for (const f of findings) {
      result.addCheck(`live-idor:${f.url}:${f.paramName}`, false, {
        severity: 'error',
        message: `Possible IDOR: ${f.method} ${f.url} (param: ${f.paramName}) — id=${f.probedId} reachable`,
        file: f.url, rule: 'live-idor',
        evidence: f.evidence,
      });
    }

    const summary = runner.summary();
    result.addCheck('live-idor:summary', true, {
      severity: 'info',
      message: `${findings.length} IDOR finding(s); ${summary.totalRequests} probes sent${summary.aborted ? ` (aborted: ${summary.abortReason})` : ''}`,
      probeCount: summary.totalRequests, findingsCount: findings.length,
    });
  }

  _mutate(url, paramName, paramLocation, newValue) {
    if (paramLocation === 'query') {
      const u = new URL(url);
      u.searchParams.set(paramName, newValue);
      return u.toString();
    }
    if (paramLocation === 'path') {
      return url.replace(/\/\d+(?=\/|$)/, `/${newValue}`);
    }
    return url;
  }
}

module.exports = LiveIdorModule;
module.exports.looksLikeRecord = looksLikeRecord;
module.exports.isNumericId = isNumericId;
