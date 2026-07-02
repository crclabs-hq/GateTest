/**
 * Live Path-Traversal Probe Module.
 *
 * Sends path-traversal payloads to discovered endpoints and detects when
 * canonical /etc/passwd or Windows win.ini content appears in the response.
 * Only attempts to READ — never sends destructive paths.
 *
 * Pen Test tier — requires authorization-gate consent.
 */

'use strict';

const BaseModule = require('./base-module');
const { LiveProbeRunner } = require('../core/live-probe-runner');
const { PATH_TRAVERSAL_PAYLOADS, PATH_TRAVERSAL_MARKERS } = require('../core/payload-library');
const { authorize, AuthorizationRefusedError } = require('../core/authorization-gate');

function detectTraversalLeak(body, marker) {
  if (typeof body !== 'string') return false;
  const re = PATH_TRAVERSAL_MARKERS[marker];
  if (!re) return false;
  return re.test(body);
}

class LivePathTraversalModule extends BaseModule {
  constructor() {
    super(
      'livePathTraversal',
      'Live path-traversal probe — /etc/passwd / win.ini read detection (Pen Test tier — requires authorization)',
    );
  }

  async run(result, config) {
    const cfg = (config && config.livePathTraversal) || {};
    const targets = Array.isArray(cfg.targets) ? cfg.targets : [];
    const baseUrl = cfg.baseUrl || (targets[0] && targets[0].url) || null;

    if (!baseUrl || targets.length === 0) {
      result.addCheck('live-path-traversal:noop', true, {
        severity: 'info', message: 'No targets configured — module idle',
      });
      return;
    }

    try {
      await authorize({
        url: baseUrl, consent: cfg.consent, actorId: cfg.actorId,
        actorIp: cfg.actorIp, moduleName: 'livePathTraversal',
        dnsResolver: cfg.dnsResolver, auditDir: cfg.auditDir,
      });
    } catch (err) {
      if (err instanceof AuthorizationRefusedError) {
        result.addCheck('live-path-traversal:refused', true, {
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

      for (const probe of PATH_TRAVERSAL_PAYLOADS) {
        const r = await this._send(runner, url, method, paramName, paramLocation, probe.payload);
        if (r.aborted) break;
        if (!r.ok || !r.body) continue;
        if (detectTraversalLeak(r.body, probe.detect)) {
          findings.push({
            url, method, paramName,
            payloadClass: probe.class, payload: probe.payload,
            marker: probe.detect,
            evidence: `${probe.detect} content reflected — file read confirmed`,
          });
          break;
        }
      }
    }

    for (const f of findings) {
      result.addCheck(`live-path-traversal:${f.url}:${f.paramName}`, false, {
        severity: 'error',
        message: `Path traversal: ${f.method} ${f.url} (param: ${f.paramName}) — file read via ${f.payloadClass}`,
        file: f.url, rule: 'live-path-traversal',
        payloadClass: f.payloadClass, evidence: f.evidence,
      });
    }

    const summary = runner.summary();
    result.addCheck('live-path-traversal:summary', true, {
      severity: 'info',
      message: `${findings.length} traversal finding(s); ${summary.totalRequests} probes sent${summary.aborted ? ` (aborted: ${summary.abortReason})` : ''}`,
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

module.exports = LivePathTraversalModule;
module.exports.detectTraversalLeak = detectTraversalLeak;
