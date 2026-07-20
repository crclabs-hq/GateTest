/**
 * Deploy Script Validator — catches health-check URL mismatches.
 *
 * The outage scenario: a CI deploy script polls /api/health but the app
 * only registers /health — the deploy waits forever, or worse, succeeds
 * because the timeout fires and the script treats silence as OK.
 *
 * This module:
 *   1. Harvests health-check URLs from CI scripts, Dockerfiles, docker-compose,
 *      shell deploy scripts, and systemd units.
 *   2. Harvests registered routes from the codebase (Next.js, Express, Fastify).
 *   3. Flags health-check URLs that don't match any registered route.
 *
 * Also catches:
 *   - Readiness/liveness probe paths in k8s manifests vs registered routes.
 *   - `curl` / `wget` health-check calls in shell scripts vs routes.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');

// ─── patterns ─────────────────────────────────────────────────────────────

// Health-check URL in CI/shell/docker — two forms:
//   quoted: curl "$BASE_URL/api/health"  →  captures the /path after "
//   unquoted from full URL: curl http://host:3000/api/health → captures /path
const HEALTH_URL_RE_QUOTED = /(?:curl|wget|fetch|healthcheck|health.?check|ready.?check|liveness|readiness|probe)[^\n'"]{0,80}(['"`])(\/[a-z/_\-0-9]{1,60})\1/gi;
const HEALTH_URL_RE_BARE   = /(?:curl|wget)\s+https?:\/\/[^\s/'"]{1,80}(\/[a-z/_\-0-9]{1,60})(?:\s|$|['"?])/gi;

// k8s probe path
const K8S_PROBE_RE  = /(?:path|httpGet\.path)\s*:\s*['"]?(\/[a-z/_\-0-9]{1,60})['"]?/gi;

// Next.js App Router route file: app/api/health/route.ts → /api/health
function nextjsRouteFromPath(rel) {
  return rel
    .replace(/\\/g, '/')
    .replace(/^.*?app\//, '/')
    .replace(/\/route\.(ts|js|tsx|jsx)$/, '')
    .replace(/\/\(.*?\)/g, '');
}

// Express / Fastify route definitions
const EXPRESS_HEALTH_RE = /(?:app|router|fastify)\s*\.\s*(?:get|all)\s*\(\s*['"`](\/[^'"`]+)['"`]/g;

// ─── file categorisation ──────────────────────────────────────────────────

function isDeployFile(rel) {
  const lower = rel.toLowerCase();
  return (
    lower.endsWith('.sh') ||
    lower.includes('deploy') ||
    lower.includes('dockerfile') ||
    lower.endsWith('docker-compose.yml') ||
    lower.endsWith('docker-compose.yaml') ||
    lower.endsWith('.service') ||
    (lower.includes('.github/workflows') && (lower.endsWith('.yml') || lower.endsWith('.yaml')))
  );
}

function isK8sFile(rel) {
  const lower = rel.toLowerCase();
  return (
    (lower.endsWith('.yml') || lower.endsWith('.yaml')) &&
    (lower.includes('k8s') || lower.includes('kubernetes') || lower.includes('deploy') || lower.includes('manifest'))
  );
}

// ─── module ────────────────────────────────────────────────────────────────

class DeployScriptValidator extends BaseModule {
  constructor() {
    super('deployScriptValidator', 'Deploy Script Validator — health-check URL consistency');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    const deployHealthUrls = new Map(); // url → { file, line }
    const registeredRoutes = new Set();

    const allFiles = this._collectFiles(projectRoot, ['*']);

    for (const file of allFiles) {
      const rel = path.relative(projectRoot, file);
      if (rel.includes('node_modules') || rel.includes('.git')) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      // Harvest health-check URLs from deploy/CI files
      if (isDeployFile(rel) || isK8sFile(rel)) {
        let m;
        HEALTH_URL_RE_QUOTED.lastIndex = 0;
        while ((m = HEALTH_URL_RE_QUOTED.exec(content)) !== null) {
          const url    = m[2].split('?')[0];
          const lineNo = content.slice(0, m.index).split('\n').length;
          if (!deployHealthUrls.has(url)) {
            deployHealthUrls.set(url, { file: rel, line: lineNo });
          }
        }
        HEALTH_URL_RE_BARE.lastIndex = 0;
        while ((m = HEALTH_URL_RE_BARE.exec(content)) !== null) {
          const url    = m[1].split('?')[0];
          const lineNo = content.slice(0, m.index).split('\n').length;
          if (!deployHealthUrls.has(url)) {
            deployHealthUrls.set(url, { file: rel, line: lineNo });
          }
        }

        K8S_PROBE_RE.lastIndex = 0;
        while ((m = K8S_PROBE_RE.exec(content)) !== null) {
          const url    = m[1].split('?')[0];
          const lineNo = content.slice(0, m.index).split('\n').length;
          if (!deployHealthUrls.has(url)) {
            deployHealthUrls.set(url, { file: rel, line: lineNo });
          }
        }
      }

      // Harvest registered routes from app code
      const ext = path.extname(file).toLowerCase();
      if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
        // Next.js App Router
        if (rel.match(/app\/.*route\.(ts|js|tsx|jsx)$/)) {
          registeredRoutes.add(nextjsRouteFromPath(rel));
        }

        // Express / Fastify
        EXPRESS_HEALTH_RE.lastIndex = 0;
        let m2;
        while ((m2 = EXPRESS_HEALTH_RE.exec(content)) !== null) {
          registeredRoutes.add(m2[1]);
        }
      }
    }

    if (deployHealthUrls.size === 0) {
      result.addCheck('deploy-script-validator:no-health-checks', true, {
        severity: 'info',
        message: 'No health-check URLs found in deploy/CI scripts',
      });
      return;
    }

    let mismatches = 0;
    for (const [url, { file, line }] of deployHealthUrls) {
      // Check exact match or prefix match (e.g. /health matches /health or /healthz)
      const matched = registeredRoutes.has(url) ||
        Array.from(registeredRoutes).some(r => r === url || url.startsWith(r) || r.startsWith(url));

      if (!matched) {
        mismatches++;
        const candidates = Array.from(registeredRoutes)
          .filter(r => r.includes('health') || r.includes('ping') || r.includes('status'))
          .slice(0, 3);

        const candidateHint = candidates.length > 0
          ? ` Registered health-like routes: ${candidates.join(', ')}`
          : ' No health-like routes found in codebase.';

        result.addCheck(`deploy-script-validator:mismatch:${url}`, false, {
          severity: 'error',
          message: `Health-check URL \`${url}\` (from ${file}:${line}) has no matching registered route.${candidateHint}`,
          file,
          line,
          fix: `Either register a \`${url}\` route in your app, or update ${file} to use an existing route.`,
          autoFix: makeAutoFix(
            path.join(projectRoot, file),
            'deploy-script-validator',
            `Health check URL ${url} doesn't match any registered app route`,
            line,
            candidates.length > 0
              ? `Update the health check URL to one of: ${candidates.join(', ')}`
              : `Add a ${url} route handler to your app`
          ),
        });
      }
    }

    if (mismatches === 0) {
      result.addCheck('deploy-script-validator:consistent', true, {
        severity: 'info',
        message: `All ${deployHealthUrls.size} health-check URL(s) match registered routes`,
      });
    }
  }
}

module.exports = DeployScriptValidator;
