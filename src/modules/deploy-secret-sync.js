/**
 * Deploy-Secret Sync Module
 *
 * Catches the deployment-configuration class of failures where your deploy
 * pipeline references environment variables that are not declared in your
 * project's env documentation — so the first deploy to a fresh environment
 * silently fails with "undefined is not a function" or a cryptic Stripe error.
 *
 * Real failure classes caught:
 *   - GitHub Actions step uses ${{ secrets.STRIPE_KEY }} but .env.example has no STRIPE_KEY
 *   - vercel.json references an env var that no .env.example declares
 *   - netlify.toml [build.environment] references undeclared vars
 *   - docker-compose.yml passes env vars to containers that aren't in .env.example
 *   - .env.example declares vars that no deploy config ever injects (dead config)
 *
 * Zero network calls. Pure filesystem reads.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function exists(filePath) {
  try { fs.accessSync(filePath); return true; } catch { return false; }
}

function findFiles(dir, pattern) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findFiles(full, pattern));
      } else if (pattern.test(entry.name)) {
        results.push(full);
      }
    }
  } catch { /* ignore */ }
  return results;
}

// Known runtime-injected vars that don't need to be in .env.example
const RUNTIME_ALLOWLIST = new Set([
  'CI', 'NODE_ENV', 'PORT', 'HOST', 'PATH', 'HOME', 'USER', 'SHELL',
  'PWD', 'TMPDIR', 'TMP', 'TEMP', 'LOGNAME',
  'GITHUB_TOKEN', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_ACTOR',
  'GITHUB_REPOSITORY', 'GITHUB_WORKSPACE', 'GITHUB_EVENT_NAME',
  'GITHUB_RUN_ID', 'GITHUB_RUN_NUMBER', 'GITHUB_HEAD_REF',
  'GITHUB_BASE_REF', 'GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_ARCH',
  'VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_REGION',
  'VERCEL_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_REF',
  'VERCEL_GIT_REPO_SLUG', 'VERCEL_GIT_REPO_OWNER',
  'VERCEL_DEPLOYMENT_ID', 'VERCEL_BRANCH_URL',
  'NETLIFY', 'NETLIFY_BUILD_BASE', 'DEPLOY_URL', 'DEPLOY_PRIME_URL',
  'CONTEXT', 'BRANCH', 'COMMIT_REF',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_EXECUTION_ENV',
  'AWS_LAMBDA_FUNCTION_NAME', 'AWS_LAMBDA_FUNCTION_VERSION',
  'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID',
  'FLY_APP_NAME', 'FLY_REGION', 'FLY_ALLOC_ID',
  'HEROKU_APP_NAME', 'DYNO', 'WEB_CONCURRENCY',
  'K_SERVICE', 'K_REVISION', 'GOOGLE_CLOUD_PROJECT',
  'npm_package_version', 'npm_lifecycle_event',
]);

function isAllowlisted(name) {
  if (RUNTIME_ALLOWLIST.has(name)) return true;
  // Dynamic prefixes
  if (name.startsWith('VERCEL_') || name.startsWith('GITHUB_') ||
      name.startsWith('AWS_') || name.startsWith('NETLIFY_') ||
      name.startsWith('npm_')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Collect declared vars from .env.example files
// ---------------------------------------------------------------------------

function collectEnvExample(root) {
  const declared = new Set();
  const exampleFiles = [
    '.env.example', '.env.sample', '.env.template',
    '.env.local.example', '.env.production.example',
    '.env.staging.example', '.env.test.example',
  ];
  for (const name of exampleFiles) {
    const src = readText(path.join(root, name));
    if (!src) continue;
    for (const line of src.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)(?:\s*=|$)/i);
      if (m) declared.add(m[1].toUpperCase());
    }
  }
  return declared;
}

// ---------------------------------------------------------------------------
// Collect vars referenced in GitHub Actions workflows
// ---------------------------------------------------------------------------

function collectGitHubActionsVars(root) {
  const vars = new Set();
  const workflowDir = path.join(root, '.github', 'workflows');
  if (!exists(workflowDir)) return vars;

  const files = findFiles(workflowDir, /\.ya?ml$/);
  for (const file of files) {
    const src = readText(file);
    if (!src) continue;
    // ${{ secrets.NAME }} and ${{ vars.NAME }} and ${{ env.NAME }}
    for (const m of src.matchAll(/\$\{\{\s*(?:secrets|vars|env)\.([A-Z_][A-Z0-9_]*)\s*\}\}/gi)) {
      const name = m[1].toUpperCase();
      if (!isAllowlisted(name)) vars.add(name);
    }
    // env: blocks — NAME: ${{ secrets.X }} or NAME: value
    for (const m of src.matchAll(/^\s{2,}([A-Z_][A-Z0-9_]*):\s*\$\{\{/gim)) {
      const name = m[1].toUpperCase();
      if (!isAllowlisted(name)) vars.add(name);
    }
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Collect vars referenced in vercel.json
// ---------------------------------------------------------------------------

function collectVercelVars(root) {
  const vars = new Set();
  const vercel = readJson(path.join(root, 'vercel.json'));
  if (!vercel) return vars;

  // env + build.env sections
  const envSections = [vercel.env, vercel.build && vercel.build.env].filter(Boolean);
  for (const section of envSections) {
    if (typeof section !== 'object') continue;
    for (const key of Object.keys(section)) {
      const name = key.toUpperCase();
      if (!isAllowlisted(name)) vars.add(name);
    }
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Collect vars referenced in netlify.toml
// ---------------------------------------------------------------------------

function collectNetlifyVars(root) {
  const vars = new Set();
  const src = readText(path.join(root, 'netlify.toml'));
  if (!src) return vars;

  // Under [build.environment] or [context.*.environment] sections
  let inEnv = false;
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.match(/^\[.*environment\]/i)) { inEnv = true; continue; }
    if (trimmed.startsWith('[')) { inEnv = false; continue; }
    if (inEnv) {
      const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=/i);
      if (m) {
        const name = m[1].toUpperCase();
        if (!isAllowlisted(name)) vars.add(name);
      }
    }
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Collect vars from docker-compose files
// ---------------------------------------------------------------------------

function collectDockerComposeVars(root) {
  const vars = new Set();
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml',
    'docker-compose.prod.yml', 'docker-compose.production.yml'];
  for (const name of composeFiles) {
    const src = readText(path.join(root, name));
    if (!src) continue;
    // environment: - NAME=value or NAME: value or - NAME (bare reference)
    for (const m of src.matchAll(/^\s*-\s+([A-Z_][A-Z0-9_]*)(?:=|\s*$)/gim)) {
      const varName = m[1].toUpperCase();
      if (!isAllowlisted(varName)) vars.add(varName);
    }
    for (const m of src.matchAll(/^\s{4,}([A-Z_][A-Z0-9_]*):\s*\$/gim)) {
      const varName = m[1].toUpperCase();
      if (!isAllowlisted(varName)) vars.add(varName);
    }
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

class DeploySecretSyncModule extends BaseModule {
  constructor() {
    super('deploySecretSync', 'Deploy-Secret Sync — env vars referenced in deploy configs vs .env.example');
  }

  async run(result, config) {
    const root = (config.get && config.get('projectRoot')) || config.projectRoot || process.cwd();

    const declared = collectEnvExample(root);

    if (declared.size === 0) {
      // No .env.example at all — can't do cross-reference, skip silently
      return;
    }

    // Collect all deploy-referenced vars
    const deployVars = new Map(); // name → Set of sources
    const addDeployVar = (name, source) => {
      if (!deployVars.has(name)) deployVars.set(name, new Set());
      deployVars.get(name).add(source);
    };

    for (const v of collectGitHubActionsVars(root)) addDeployVar(v, 'GitHub Actions');
    for (const v of collectVercelVars(root))         addDeployVar(v, 'vercel.json');
    for (const v of collectNetlifyVars(root))         addDeployVar(v, 'netlify.toml');
    for (const v of collectDockerComposeVars(root))   addDeployVar(v, 'docker-compose');

    if (deployVars.size === 0) {
      // No deploy configs found — nothing to cross-reference
      return;
    }

    // --- Check 1: deploy references var not in .env.example ---
    let missingCount = 0;
    for (const [name, sources] of deployVars) {
      const nameUpper = name.toUpperCase();
      // Allow NEXT_PUBLIC_* and VITE_* — these are intentionally client-side
      if (declared.has(nameUpper)) continue;
      // Fuzzy: declared might be without NEXT_PUBLIC_ prefix
      const stripped = nameUpper.replace(/^NEXT_PUBLIC_/, '').replace(/^VITE_/, '').replace(/^REACT_APP_/, '');
      if (declared.has(stripped)) continue;

      const sourceList = [...sources].join(', ');
      result.addCheck(`deploySecret:missing-from-example:${name}`, false, {
        message: `"${name}" used in deploy config (${sourceList}) but not declared in .env.example`,
        detail: `Any fresh environment setup will fail silently or crash on "${name}". Add it to .env.example with a placeholder value so operators know it's required.`,
        severity: 'error',
      });
      missingCount++;
    }

    // --- Check 2: .env.example declares var not referenced anywhere in deploy ---
    let deadCount = 0;
    for (const declared_name of declared) {
      if (deployVars.has(declared_name)) continue;
      // Check if it's injected via NEXT_PUBLIC_ / VITE_ prefix variants
      const withPublic = `NEXT_PUBLIC_${declared_name}`;
      const withVite   = `VITE_${declared_name}`;
      if (deployVars.has(withPublic) || deployVars.has(withVite)) continue;
      // Not an error — teams often declare vars in .env.example that are
      // injected via platform UI rather than config files. Warn only.
      result.addCheck(`deploySecret:undeclared-in-deploy:${declared_name}`, false, {
        message: `"${declared_name}" in .env.example is not referenced in any deploy config`,
        detail: `If "${declared_name}" is injected via the platform UI (Vercel dashboard, AWS Secrets Manager, etc.) this warning is safe to ignore. If it should be in a workflow/vercel.json, it may have been forgotten.`,
        severity: 'warning',
      });
      deadCount++;
    }

    if (missingCount === 0 && deadCount === 0) {
      result.addCheck('deploySecret:in-sync', true, {
        message: `Deploy configs and .env.example are in sync (${deployVars.size} deploy vars, ${declared.size} declared)`,
      });
    }
  }
}

module.exports = DeploySecretSyncModule;
