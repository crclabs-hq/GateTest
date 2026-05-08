/**
 * Orphan Test Imports Module
 *
 * Catches a specific class of structural failure: test files that import
 * functions, classes, or modules from source paths that don't exist.
 * This produces a passing CI (the test file parses fine, jest/node:test
 * collects 0 tests) but a runtime crash when the test actually runs —
 * or worse, the import resolves to `undefined` and the test silently passes.
 *
 * Real failure classes caught:
 *   - Test imports a function that was renamed or deleted from the source
 *   - Test imports from a path that was moved but the test wasn't updated
 *   - Test barrel-imports a named export that was removed from the barrel
 *   - Test uses a __mocks__ path that references a non-existent real module
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

function exists(filePath) {
  try { fs.accessSync(filePath); return true; } catch { return false; }
}

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\/__tests__\//,
  /\/tests?\//,
  /\/spec\//,
];

function isTestFile(filePath) {
  return TEST_PATTERNS.some(p => p.test(filePath));
}

function findTestFiles(dir) {
  const results = [];
  try {
    const walk = (current) => {
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' ||
            entry.name === 'dist'         || entry.name === 'build' ||
            entry.name === '.next'        || entry.name === 'coverage') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (SOURCE_EXTENSIONS.some(e => entry.name.endsWith(e)) && isTestFile(full)) {
          results.push(full);
        }
      }
    };
    walk(dir);
  } catch { /* ignore */ }
  return results;
}

// ---------------------------------------------------------------------------
// String literal mask — marks characters that are INSIDE a string literal
// so we can skip require() calls that appear within test-fixture strings.
// ---------------------------------------------------------------------------

function buildStringMask(src) {
  const inStr = new Uint8Array(src.length);
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      const start = i;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++; // skip closing quote
      for (let j = start; j < Math.min(i, src.length); j++) inStr[j] = 1;
    } else if (ch === '`') {
      // template literal — simplified, doesn't handle nested ${}
      const start = i;
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      for (let j = start; j < Math.min(i, src.length); j++) inStr[j] = 1;
    } else {
      i++;
    }
  }
  return inStr;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractRelativeImports(src) {
  const imports = [];
  // Strip block comments first (rough)
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const mask = buildStringMask(stripped);

  // ES import: import ... from './path' or import './path'
  // Anchored to start of line so almost never inside a string, but we still check.
  const esImport = /^import\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm;
  for (const m of stripped.matchAll(esImport)) {
    if (!mask[m.index]) {
      imports.push({ specifier: m[1], line: lineOf(src, m.index) });
    }
  }

  // require('./path') — must NOT be inside a string literal
  const cjsRequire = /\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const m of stripped.matchAll(cjsRequire)) {
    if (!mask[m.index]) {
      imports.push({ specifier: m[1], line: lineOf(src, m.index) });
    }
  }

  // export ... from './path'
  const esReexport = /^export\s+(?:[\s\S]*?\s+)?from\s+['"](\.[^'"]+)['"]/gm;
  for (const m of stripped.matchAll(esReexport)) {
    if (!mask[m.index]) {
      imports.push({ specifier: m[1], line: lineOf(src, m.index) });
    }
  }

  return imports;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// Resolve a specifier to an actual file path
// ---------------------------------------------------------------------------

function resolveSpecifier(specifier, fromFile) {
  const dir = path.dirname(fromFile);
  const candidate = path.resolve(dir, specifier);

  // Exact match
  if (exists(candidate)) return candidate;

  // Try adding each source extension
  for (const ext of SOURCE_EXTENSIONS) {
    if (exists(candidate + ext)) return candidate + ext;
  }

  // Try index file
  for (const ext of SOURCE_EXTENSIONS) {
    const indexPath = path.join(candidate, `index${ext}`);
    if (exists(indexPath)) return indexPath;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Named export extraction — lightweight, no AST
// ---------------------------------------------------------------------------

function extractNamedExports(filePath) {
  const src = readText(filePath);
  if (!src) return new Set();

  const exports = new Set();
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

  // export function name / export class name / export const name =
  for (const m of stripped.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
    exports.add(m[1]);
  }

  // export { name, name as alias }
  for (const m of stripped.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().match(/(?:.*\s+as\s+)?([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (alias) exports.add(alias[1].trim());
    }
  }

  // module.exports = { name, name }
  for (const m of stripped.matchAll(/module\.exports\s*=\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const key = part.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (key) exports.add(key[1]);
    }
  }

  // module.exports.name = or exports.name =
  for (const m of stripped.matchAll(/(?:module\.exports|exports)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/gm)) {
    exports.add(m[1]);
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Extract what a test file imports by name from a specifier
// ---------------------------------------------------------------------------

function extractImportedNames(src, specifier) {
  const names = [];
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');

  // import { name, name as alias } from 'specifier'
  const namedImport = new RegExp(
    `import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${escapeReg(specifier)}['"]`, 'g'
  );
  for (const m of stripped.matchAll(namedImport)) {
    for (const part of m[1].split(',')) {
      const orig = part.trim().split(/\s+as\s+/)[0].trim();
      if (orig && orig !== '*') names.push(orig);
    }
  }

  // const { name } = require('specifier')
  const cjsDestructure = new RegExp(
    `const\\s*\\{([^}]+)\\}\\s*=\\s*require\\(\\s*['"]${escapeReg(specifier)}['"]\\s*\\)`, 'g'
  );
  for (const m of stripped.matchAll(cjsDestructure)) {
    for (const part of m[1].split(',')) {
      const key = part.trim().split(/\s*:\s*/)[0].trim();
      if (key) names.push(key);
    }
  }

  return names;
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

class OrphanTestImportsModule extends BaseModule {
  constructor() {
    super('orphanTestImports', 'Orphan Test Imports — test files importing non-existent source paths or removed named exports');
  }

  async run(result, config) {
    const root = (config.get && config.get('projectRoot')) || config.projectRoot || process.cwd();

    const testFiles = findTestFiles(root);
    if (testFiles.length === 0) return;

    let orphanCount = 0;
    let checkedCount = 0;

    for (const testFile of testFiles) {
      const src = readText(testFile);
      if (!src) continue;

      const relTest = path.relative(root, testFile);
      const imports = extractRelativeImports(src);

      for (const { specifier, line } of imports) {
        checkedCount++;
        const resolved = resolveSpecifier(specifier, testFile);

        if (!resolved) {
          result.addCheck(`orphanTest:missing-path:${relTest}:${line}`, false, {
            message: `"${relTest}" imports from "${specifier}" which does not exist`,
            detail: `Line ${line}: the imported path "${specifier}" resolves to a file that cannot be found. The source was likely renamed, moved, or deleted without updating the test.`,
            severity: 'error',
          });
          orphanCount++;
          continue;
        }

        // Check named imports against the source file's actual exports
        const namedImports = extractImportedNames(src, specifier);
        if (namedImports.length === 0) continue;

        const exported = extractNamedExports(resolved);
        if (exported.size === 0) continue; // Can't determine exports — skip

        for (const name of namedImports) {
          if (name === 'default' || name === '*') continue;
          if (!exported.has(name)) {
            result.addCheck(`orphanTest:missing-export:${relTest}:${name}`, false, {
              message: `"${relTest}" imports "${name}" from "${specifier}" but that export doesn't exist`,
              detail: `"${name}" is not exported from ${path.relative(root, resolved)}. It may have been renamed, removed, or is dynamically exported. The test will silently receive undefined.`,
              severity: 'warning',
            });
            orphanCount++;
          }
        }
      }
    }

    if (orphanCount === 0 && checkedCount > 0) {
      result.addCheck('orphanTest:all-imports-valid', true, {
        message: `All test imports resolve to existing source paths (${testFiles.length} test files, ${checkedCount} import paths checked)`,
      });
    }
  }
}

module.exports = OrphanTestImportsModule;
