/**
 * Live Auth-Bypass Probe Module.
 *
 * Tests whether protected endpoints can be accessed by:
 *   1. Sending NO auth (baseline) and seeing if response indicates auth
 *   2. Sending AUTH_BYPASS_HEADERS (X-Forwarded-For: 127.0.0.1, X-Admin: true,
 *      X-HTTP-Method-Override: PUT, Host: localhost) and seeing if the
 *      response now grants access.
 *
 * Heuristic: if a request that returned 401/403 without bypass headers
 * returns 200 with them, that's a likely bypass.
 *
 * Pen Test tier — requires authorization-gate consent.
 */

'use strict';

const BaseModule = require('./base-module');
const { LiveProbeRunner } = require('../core/live-probe-runner');
const { AUTH_BYPASS_HEADERS } = require('../core/payload-library');
const { authorize, AuthorizationRefusedError } = require('../core/authorization-gate');

function isAuthBlocked(status) {
  return status === 401 || status === 403;
}

function isAuthGranted(status) {
  return status >= 200 && status < 300;
}

class LiveAuthBypassModule extends BaseModule {
  constructor() {
    super(
      'liveAuthBypass',
      'Live auth-bypass probe — tests if injected headers grant unauthenticated access (Pen Test tier — requires authorization)',
    );
  }

  async run(result, config) {
    const cfg = (config && config.liveAuthBypass) || {};
    const targets = Array.isArray(cfg.targets) ? cfg.targets : [];
    const baseUrl = cfg.baseUrl || (targets[0] && targets[0].url) || null;

    if (!baseUrl || targets.length === 0) {
      result.addCheck('live-auth-bypass:noop', true, {
        severity: 'info', message: 'No targets configured — module idle',
      });
      return;
    }

    try {
      await authorize({
        url: baseUrl, consent: cfg.consent, actorId: cfg.actorId,
        actorIp: cfg.actorIp, moduleName: 'liveAuthBypass',
        dnsResolver: cfg.dnsResolver, auditDir: cfg.auditDir,
      });
    } catch (err) {
      if (err instanceof AuthorizationRefusedError) {
        result.addCheck('live-auth-bypass:refused', true, {
          severity: 'info', message: `Authorization refused: ${err.reason}`, reason: err.reason,
        });
        return;
      }
      throw err;
    }

    const runner = cfg.runner || new LiveProbeRunner(cfg.runnerOpts || {});
    const findings = [];

    for (const target of targets.slice(0, cfg.maxTargets || 50)) {
      const { url, method = 'GET' } = target;

      // Baseline — no headers. Confirms the endpoint normally blocks unauth.
      const baseline = await runner.probe({ url, method });
      if (baseline.aborted) break;
      if (!baseline.ok || !isAuthBlocked(baseline.status)) continue;

      // Now try each bypass header set
      for (const probe of AUTH_BYPASS_HEADERS) {
        const r = await runner.probe({ url, method, headers: probe.headers });
        if (r.aborted) break;
        if (r.ok && isAuthGranted(r.status)) {
          findings.push({
            url, method,
            payloadClass: probe.class, headers: probe.headers,
            marker: probe.detect,
            evidence: `baseline=${baseline.status}, with bypass=${r.status}`,
          });
          break; // Confirmed — don't keep firing
        }
      }
    }

    for (const f of findings) {
      result.addCheck(`live-auth-bypass:${f.url}`, false, {
        severity: 'error',
        message: `Auth bypass: ${f.method} ${f.url} via ${f.payloadClass} headers`,
        file: f.url, rule: 'live-auth-bypass',
        payloadClass: f.payloadClass, evidence: f.evidence,
      });
    }

    const summary = runner.summary();
    result.addCheck('live-auth-bypass:summary', true, {
      severity: 'info',
      message: `${findings.length} bypass finding(s); ${summary.totalRequests} probes sent${summary.aborted ? ` (aborted: ${summary.abortReason})` : ''}`,
      probeCount: summary.totalRequests, findingsCount: findings.length,
    });
  }
}

module.exports = LiveAuthBypassModule;
module.exports.isAuthBlocked = isAuthBlocked;
module.exports.isAuthGranted = isAuthGranted;
