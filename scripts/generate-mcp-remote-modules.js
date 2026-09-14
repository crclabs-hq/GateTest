#!/usr/bin/env node
'use strict';

/**
 * Regenerate website/app/lib/mcp-remote-modules.json — the module manifest
 * the HOSTED remote MCP server (mcp-remote-core.cjs) hands to every
 * claude.ai user via `list_modules`.
 *
 * Why a script: the file was hand-generated once (2026-07-07, 120 modules)
 * and never again — spineHealth (#121) shipped 2026-07-30 and every hosted
 * MCP user was told "120" for three weeks (found by the 2026-08-18 audit).
 * The Bible's sync rule says counts are imported, never typed; this makes
 * the manifest a build artifact of the registry, and
 * tests/mcp-remote-modules-sync.test.js fails the suite if it drifts.
 *
 * Usage: node scripts/generate-mcp-remote-modules.js [--check]
 *   --check  exit 1 if the committed file differs from the registry (CI)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'website', 'app', 'lib', 'mcp-remote-modules.json');
const { BUILT_IN_MODULES } = require(path.join(ROOT, 'src', 'core', 'registry.js'));

function build() {
  const modules = [];
  for (const [name, rel] of Object.entries(BUILT_IN_MODULES)) {
    const Mod = require(path.resolve(ROOT, 'src', 'core', rel));
    let description = name;
    try {
      const inst = new Mod();
      if (inst && typeof inst.description === 'string' && inst.description) description = inst.description;
    } catch {
      /* error-ok — a module whose constructor needs config still gets listed by name */
    }
    modules.push({ name, description });
  }
  return { source: 'scripts/generate-mcp-remote-modules.js — generated from src/core/registry.js, do not hand-edit', count: modules.length, modules };
}

function stable(obj) {
  // generatedAt deliberately excluded so --check compares content only
  return JSON.stringify(obj, null, 2) + '\n';
}

if (require.main === module) {
  const next = build();
  const check = process.argv.includes('--check');
  let current = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    delete parsed.generatedAt;
    current = stable(parsed);
  } catch { /* error-ok — missing or unreadable — will be (re)written */ }
  const wanted = stable(next);
  if (check) {
    if (current !== wanted) {
      console.error(`mcp-remote-modules.json is stale (registry has ${next.count} modules) — run: node scripts/generate-mcp-remote-modules.js`);
      process.exit(1);
    }
    console.log(`mcp-remote-modules.json in sync (${next.count} modules)`);
    process.exit(0);
  }
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), ...next }, null, 2) + '\n');
  console.log(`wrote ${OUT} (${next.count} modules)`);
}

module.exports = { build };
