/**
 * Service Consistency — ExecStart / Procfile / PM2 vs package.json.
 *
 * Catches the class of bug where a systemd unit, Procfile, docker-compose
 * command, or PM2 ecosystem file starts the app with a command that differs
 * from what package.json declares as the start script.
 *
 * Common failure modes:
 *   - systemd ExecStart: `node dist/server.js` but package.json "start": "node src/index.js"
 *   - Procfile: `web: node build/app.js` but package.json "start": "node dist/app.js"
 *   - PM2: `script: "server.js"` but entry point is `index.js`
 *   - docker-compose CMD: `["node", "app.js"]` vs `src/app.js`
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');

// ─── helpers ───────────────────────────────────────────────────────────────

function stripComments(line) {
  return line.replace(/#.*$/, '').trim();
}

// Normalise a node start command to just the js file path
function extractNodeFile(cmd) {
  // node dist/server.js, ts-node src/index.ts, npx tsx src/main.ts, bun src/index.ts
  const m = cmd.match(/(?:node|ts-node|tsx|bun)\s+([^\s]+\.(js|ts|mjs|cjs))/);
  return m ? m[1] : null;
}

function normaliseSlashes(s) {
  return s.replace(/\\/g, '/');
}

// ─── parsers ───────────────────────────────────────────────────────────────

function parseSystemd(content) {
  const commands = [];
  for (const line of content.split(/\r?\n/)) {
    const clean = stripComments(line);
    const m = clean.match(/^ExecStart\s*=\s*(.+)/);
    if (m) commands.push(m[1].trim());
  }
  return commands;
}

function parseProcfile(content) {
  const commands = [];
  for (const line of content.split(/\r?\n/)) {
    const clean = stripComments(line);
    const m = clean.match(/^\w+\s*:\s*(.+)/);
    if (m) commands.push(m[1].trim());
  }
  return commands;
}

function parsePM2(content) {
  const commands = [];
  // script: "..." or script: '...'
  for (const m of content.matchAll(/["']?script["']?\s*:\s*["']([^"']+)["']/g)) {
    commands.push(`node ${m[1]}`);
  }
  // interpreter_args + script
  for (const m of content.matchAll(/["']?interpreter["']?\s*:\s*["'](node|bun|ts-node|tsx)["']/g)) {
    commands.push(m[1]); // flag that this PM2 app is node-type
  }
  return commands;
}

function parseDockerCompose(content) {
  const commands = [];
  // command: node src/app.js  or  command: ["node", "src/app.js"]
  for (const m of content.matchAll(/^\s*command\s*:\s*(.+)/gm)) {
    commands.push(m[1].replace(/[[\]"']/g, '').replace(/,/g, ' ').trim());
  }
  // entrypoint
  for (const m of content.matchAll(/^\s*entrypoint\s*:\s*(.+)/gm)) {
    commands.push(m[1].replace(/[[\]"']/g, '').replace(/,/g, ' ').trim());
  }
  return commands;
}

function parseDockerfile(content) {
  const commands = [];
  for (const m of content.matchAll(/^CMD\s+(.+)/gm)) {
    commands.push(m[1].replace(/[[\]"']/g, '').replace(/,/g, ' ').trim());
  }
  for (const m of content.matchAll(/^ENTRYPOINT\s+(.+)/gm)) {
    commands.push(m[1].replace(/[[\]"']/g, '').replace(/,/g, ' ').trim());
  }
  return commands;
}

// ─── module ────────────────────────────────────────────────────────────────

class ServiceConsistency extends BaseModule {
  constructor() {
    super('serviceConsistency', 'Service Consistency — ExecStart / Procfile / PM2 vs package.json start script');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Load package.json start script
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      result.addCheck('service-consistency:no-package-json', true, {
        severity: 'info',
        message: 'No package.json found — service consistency check skipped',
      });
      return;
    }

    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch {
      result.addCheck('service-consistency:parse-error', true, { severity: 'info', message: 'Could not parse package.json' });
      return;
    }

    const startScript = (pkg.scripts || {}).start || '';
    const startFile   = extractNodeFile(startScript);
    const mainField   = normaliseSlashes(pkg.main || '');

    if (!startScript && !mainField) {
      result.addCheck('service-consistency:no-start', true, {
        severity: 'info',
        message: 'No start script or main field in package.json — check skipped',
      });
      return;
    }

    const serviceFiles = this._collectServiceFiles(projectRoot);
    let mismatches = 0;

    for (const { rel, type, content, absPath } of serviceFiles) {
      let commands = [];
      switch (type) {
        case 'systemd':    commands = parseSystemd(content); break;
        case 'procfile':   commands = parseProcfile(content); break;
        case 'pm2':        commands = parsePM2(content); break;
        case 'compose':    commands = parseDockerCompose(content); break;
        case 'dockerfile': commands = parseDockerfile(content); break;
      }

      for (const cmd of commands) {
        const cmdFile = extractNodeFile(cmd);
        if (!cmdFile) continue;

        const normCmd   = normaliseSlashes(cmdFile);
        const normStart = startFile ? normaliseSlashes(startFile) : null;
        const normMain  = mainField;

        const matchesStart = normStart && (normCmd === normStart || normCmd.endsWith(normStart) || normStart.endsWith(normCmd));
        const matchesMain  = normMain  && (normCmd === normMain  || normCmd.endsWith(normMain)  || normMain.endsWith(normCmd));

        if (!matchesStart && !matchesMain) {
          mismatches++;
          const expected = normStart || normMain || 'undefined';
          result.addCheck(`service-consistency:${rel}:${normCmd}`, false, {
            severity: 'warning',
            message: `${type} file \`${rel}\` starts \`${normCmd}\` but package.json start script uses \`${expected}\``,
            file: rel,
            fix: `Update ${rel} to use \`${expected}\` or update package.json start script to match.`,
            autoFix: makeAutoFix(
              absPath,
              'service-consistency',
              `Service file starts ${normCmd} but package.json start script uses ${expected}`,
              undefined,
              `Replace ${normCmd} with ${expected} in this file`
            ),
          });
        }
      }
    }

    if (mismatches === 0) {
      result.addCheck('service-consistency:ok', true, {
        severity: 'info',
        message: 'All service / deploy files are consistent with package.json start script',
      });
    }
  }

  _collectServiceFiles(projectRoot) {
    const found = [];
    // KI #104: shared walk replaces the private one. Procfile and Dockerfile
    // carry no extension, so the sweep takes '*' and classifies on basename.
    for (const full of this._collectFiles(projectRoot, ['*'])) {
      const rel   = repoRelative(projectRoot, full);
      const lower = path.basename(full).toLowerCase();
      let type = null;

      if (lower.endsWith('.service'))                                type = 'systemd';
      else if (lower === 'procfile')                                 type = 'procfile';
      else if (lower.includes('ecosystem') && lower.endsWith('.js')) type = 'pm2';
      else if (lower.includes('ecosystem') && lower.endsWith('.json')) type = 'pm2';
      else if (lower.startsWith('docker-compose') && (lower.endsWith('.yml') || lower.endsWith('.yaml'))) type = 'compose';
      else if (lower === 'dockerfile')                               type = 'dockerfile';

      if (!type) continue;

      try {
        const content = fs.readFileSync(full, 'utf-8');
        found.push({ rel, absPath: full, type, content });
      } catch { // error-ok — a service file that cannot be read is left out of the comparison; there is nothing to compare it against
        continue;
      }
    }
    return found;
  }
}

module.exports = ServiceConsistency;
