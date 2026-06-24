/**
 * Live Reflected-XSS Probe Module.
 *
 * Sends XSS payloads (from payload-library) to discovered endpoints and
 * checks if the payload is reflected verbatim in the response. We do NOT
 * execute payloads — we look for reflection. A payload echoed unencoded
 * in an HTML / attribute / JS context is a reflected XSS vulnerability.
 *
 * THIS MODULE WILL NOT RUN IN CUSTOMER SCANS. Pen Test tier only.
 * Requires authorization-gate consent before any payload is transmitted.
 */

'use strict';

const BaseModule = require('./base-module');
const { LiveProbeRunner } = require('../core/live-probe-runner');
const { XSS_PAYLOADS } = require('../core/payload-library');
const { authorize, AuthorizationRefusedError } = require('../core/authorization-gate');

const XSS_PROBE_MARKER = '__gatetest_xss_probe__';

/**
 * Detect whether the payload was reflected unencoded in the response body.
 * Returns the kind of reflection or null.
 */
function detectReflection(body, payload) {
  if (typeof body !== 'string' || !payload) return null;
  // Verbatim reflection — the payload appears as-is. Most dangerous.
  if (body.includes(payload)) return 'verbatim';
  // Marker-only — the inert marker string `__gatetest_xss_probe__` is
  // reflected even if surrounding tags were stripped. Still indicates
  // partial reflection worth investigating.
  if (body.includes(XSS_PROBE_MARKER)) return 'marker-only';
  return null;
}

class LiveXssModule extends BaseModule {
  constructor() {
    super(
      'liveXss',
      'Live reflected-XSS probe — reflection detection on discovered endpoints (Pen Test tier — requires authorization)',
    );
  }

  async run(result, config) {
    const cfg = (config && config.liveXss) || {};
    const targets = Array.isArray(cfg.targets) ? cfg.targets : [];
    const baseUrl = cfg.baseUrl || (targets[0] && targets[0].url) || null;

    if (!baseUrl || targets.length === 0) {
      result.addCheck('live-xss:noop', true, {
        severity: 'info', message: 'No targets configured — module idle',
      });
      return;
    }

    try {
      await authorize({
        url: baseUrl, consent: cfg.consent, actorId: cfg.actorId,
        actorIp: cfg.actorIp, moduleName: 'liveXss',
        dnsResolver: cfg.dnsResolver, auditDir: cfg.auditDir,
      });
    } catch (err) {
      if (err instanceof AuthorizationRefusedError) {
        result.addCheck('live-xss:refused', true, {
          severity: 'info', message: `Authorization refused: ${err.reason}`, reason: err.reason,
        });
        return;
      }
      throw err;
    }

    const runner = cfg.runner || new LiveProbeRunner(cfg.runnerOpts || {});
    const findings = [];

    for (const target of targets.slice(0, cfg.maxTargets || 50)) {
      const { url, method = 'GET', paramName, paramLocation } = target;
      if (!paramName) continue;

      for (const probe of XSS_PAYLOADS) {
        const r = await this._send(runner, url, method, paramName, paramLocation, probe.payload);
        if (r.aborted) break;
        if (!r.ok || !r.body) continue;

        const reflection = detectReflection(r.body, probe.payload);
        if (reflection) {
          findings.push({
            url, method, paramName,
            payloadClass: probe.class,
            payload: probe.payload, marker: probe.detect,
            reflectionKind: reflection,
            evidence: `payload reflected (${reflection}) at ${url}`,
          });
          break; // confirmed — move on
        }
      }
    }

    for (const f of findings) {
      result.addCheck(`live-xss:${f.url}:${f.paramName}`, false, {
        severity: f.reflectionKind === 'verbatim' ? 'error' : 'warning',
        message: `Possible reflected XSS (${f.reflectionKind}): ${f.method} ${f.url} (param: ${f.paramName})`,
        file: f.url, rule: 'live-xss',
        payloadClass: f.payloadClass, evidence: f.evidence,
      });
    }

    const summary = runner.summary();
    result.addCheck('live-xss:summary', true, {
      severity: 'info',
      message: `${findings.length} XSS finding(s); ${summary.totalRequests} probes sent${summary.aborted ? ` (aborted: ${summary.abortReason})` : ''}`,
      probeCount: summary.totalRequests, findingsCount: findings.length,
    });
  }

  async _send(runner, url, method, paramName, paramLocation, value) {
    if (paramLocation === 'query') {
      const u = new URL(url);
      u.searchParams.set(paramName, value);
      return runner.probe({ method, url: u.toString() });
    }
    if (paramLocation === 'body') {
      return runner.probe({
        method, url, body: JSON.stringify({ [paramName]: value }),
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return runner.probe({ method, url });
  }
}

module.exports = LiveXssModule;
module.exports.detectReflection = detectReflection;
module.exports.XSS_PROBE_MARKER = XSS_PROBE_MARKER;
