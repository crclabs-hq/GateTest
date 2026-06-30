'use strict';

/**
 * Regression tests for the issue-extractor helper that powers BOTH the
 * customer scan-status page and the admin Command Center.
 *
 * Background — the bug being prevented:
 *   The original `extractFixableIssues` regex required:
 *     1) the filename to have a `.ext` (so `Dockerfile` failed),
 *     2) the leading character to BE the filename (so a severity prefix
 *        like `error: src/api.ts:10: ...` failed to match the `^` anchor).
 *   The downstream `.filter((i) => i.file)` then SILENTLY DROPPED every
 *   unparseable finding — measured at 39% of real-world scan output.
 *
 * These tests assert the new helper:
 *   - tolerates a leading severity prefix (`error:` / `warning:` / `info:`),
 *   - recognises an allowlist of conventional extensionless filenames
 *     (Dockerfile, Makefile, etc.),
 *   - lets `package.json scripts.postinstall: ...` style findings through
 *     with the sub-key kept as part of the issue text,
 *   - still parses the classic `src/foo.ts:42: bad thing` shape (regression),
 *   - sends truly unparseable findings to the `unparseable` list rather
 *     than silently dropping them.
 *
 * The helper is loaded via Node 22's transparent TypeScript loader so the
 * test exercises the same source the React pages import.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The helper is a .ts file loaded via Node's transparent TypeScript loader,
// which requires Node >= 22.18 (type-stripping). On older runtimes the
// require throws a SyntaxError on TS-only syntax — skip the suite there
// rather than hard-fail, matching the codebase's graceful-degradation rule.
let parseDetail, extractIssuesFromModules;
try {
  ({ parseDetail, extractIssuesFromModules } = require('../website/app/lib/issue-extractor.ts'));
} catch {
  test('extraction-regex suite skipped — runtime cannot require .ts (needs Node >= 22.18 type-stripping)', { skip: true }, () => {});
  return;
}

test('parseDetail — Dockerfile:line:rest extracts cleanly', () => {
  const result = parseDetail('Dockerfile:15: FROM uses :latest', 'iac');
  assert.equal(result?.file, 'Dockerfile');
  assert.equal(result?.issue, 'FROM uses :latest');
  assert.equal(result?.line, 15);
  assert.equal(result?.module, 'iac');
});

test('parseDetail — Dockerfile with no line number still extracts', () => {
  const result = parseDetail('Dockerfile: no non-root USER', 'iac');
  assert.equal(result?.file, 'Dockerfile');
  assert.equal(result?.issue, 'no non-root USER');
});

test('parseDetail — leading "error:" severity prefix is stripped before matching', () => {
  const result = parseDetail('error: src/api.ts:10: hardcoded password', 'security');
  assert.equal(result?.file, 'src/api.ts');
  assert.equal(result?.issue, 'hardcoded password');
  assert.equal(result?.line, 10);
});

test('parseDetail — leading "warning:" severity prefix is stripped before matching', () => {
  const result = parseDetail('warning: tsconfig.json: strict: false', 'infra');
  assert.equal(result?.file, 'tsconfig.json');
  assert.equal(result?.issue, 'strict: false');
});

test('parseDetail — leading "info:" severity prefix is stripped before matching', () => {
  const result = parseDetail('info: src/util.ts:7: minor thing', 'infra');
  assert.equal(result?.file, 'src/util.ts');
  assert.equal(result?.issue, 'minor thing');
  assert.equal(result?.line, 7);
});

test('parseDetail — severity prefix is case-insensitive', () => {
  assert.equal(parseDetail('ERROR: src/x.ts:1: bad', 'm')?.file, 'src/x.ts');
  assert.equal(parseDetail('Warning: src/x.ts:1: bad', 'm')?.file, 'src/x.ts');
  assert.equal(parseDetail('INFO: src/x.ts:1: bad', 'm')?.file, 'src/x.ts');
});

test('parseDetail — package.json with sub-key keeps the sub-key in the issue text', () => {
  const result = parseDetail(
    'package.json scripts.postinstall: matches "curl && sh"',
    'supply-chain'
  );
  assert.equal(result?.file, 'package.json');
  assert.match(result?.issue || '', /scripts\.postinstall: matches/);
});

test('parseDetail — classic src/foo.ts:42: bad thing still parses (regression)', () => {
  const result = parseDetail('src/foo.ts:42: bad thing', 'lint');
  assert.equal(result?.file, 'src/foo.ts');
  assert.equal(result?.issue, 'bad thing');
  assert.equal(result?.line, 42);
});

test('parseDetail — deeply-nested path with extension parses', () => {
  const result = parseDetail(
    'src/components/auth/Login.tsx:128: unused variable',
    'lint'
  );
  assert.equal(result?.file, 'src/components/auth/Login.tsx');
  assert.equal(result?.issue, 'unused variable');
  assert.equal(result?.line, 128);
});

test('parseDetail — Makefile (extensionless allowlist) parses', () => {
  const result = parseDetail('Makefile:42: tab/space mismatch', 'iac');
  assert.equal(result?.file, 'Makefile');
  assert.equal(result?.line, 42);
});

test('parseDetail — .gitignore (dotfile allowlist) parses', () => {
  const result = parseDetail('.gitignore: missing node_modules', 'infra');
  assert.equal(result?.file, '.gitignore');
  assert.equal(result?.issue, 'missing node_modules');
});

test('parseDetail — Dockerfile.dev variant via "<known>." rule parses', () => {
  const result = parseDetail('Dockerfile.dev:3: USER root', 'iac');
  assert.equal(result?.file, 'Dockerfile.dev');
  assert.equal(result?.line, 3);
});

test('parseDetail — unparseable "Test suite failed" returns null', () => {
  const result = parseDetail('Test suite failed', 'unitTests');
  assert.equal(result, null);
});

test('parseDetail — unparseable "Module timed out after 30s" returns null', () => {
  const result = parseDetail('Module timed out after 30s', 'e2e');
  assert.equal(result, null);
});

test('parseDetail — fallback CREATE_FILE pathway still works for "missing X.json"', () => {
  const result = parseDetail('missing tsconfig.json at repo root', 'infra');
  assert.equal(result?.file, 'tsconfig.json');
  assert.match(result?.issue || '', /^CREATE_FILE: /);
});

test('extractIssuesFromModules — fixable and unparseable are partitioned, none silently dropped', () => {
  const modules = [
    {
      name: 'iac',
      status: 'failed',
      details: [
        'Dockerfile:15: FROM uses :latest',
        'Dockerfile: no non-root USER',
      ],
    },
    {
      name: 'infra',
      status: 'failed',
      details: [
        'error: src/api.ts:10: hardcoded password',
        'warning: tsconfig.json: strict: false',
      ],
    },
    {
      name: 'supply-chain',
      status: 'failed',
      details: [
        'package.json scripts.postinstall: matches "curl && sh"',
      ],
    },
    {
      name: 'unitTests',
      status: 'failed',
      details: [
        'Test suite failed',
        'Module timed out after 30s',
      ],
    },
    {
      // Passing modules are skipped.
      name: 'syntax',
      status: 'passed',
      details: [],
    },
  ];

  const { fixable, unparseable } = extractIssuesFromModules(modules);
  // 5 fixable across iac/infra/supply-chain.
  assert.equal(fixable.length, 5);
  // 2 unparseable from unitTests.
  assert.equal(unparseable.length, 2);
  // No silent drops — total inputs = 7, total outputs = 7.
  assert.equal(fixable.length + unparseable.length, 7);

  // Verify the unparseable entries carry their module so the UI can show them.
  assert.equal(unparseable[0].module, 'unitTests');
  assert.equal(unparseable[0].detail, 'Test suite failed');
  assert.equal(unparseable[1].detail, 'Module timed out after 30s');
});

test('extractIssuesFromModules — non-failed modules ignored by default', () => {
  const modules = [
    { name: 'lint', status: 'passed', details: ['some.ts:1: ok message'] },
    { name: 'iac', status: 'failed', details: ['Dockerfile:1: FROM uses :latest'] },
  ];
  const { fixable } = extractIssuesFromModules(modules);
  assert.equal(fixable.length, 1);
  assert.equal(fixable[0].module, 'iac');
});

test('extractIssuesFromModules — failedOnly:false includes every module', () => {
  const modules = [
    { name: 'lint', status: 'passed', details: ['src/a.ts:1: shape'] },
    { name: 'iac', status: 'failed', details: ['Dockerfile:1: FROM uses :latest'] },
  ];
  const { fixable } = extractIssuesFromModules(modules, { failedOnly: false });
  assert.equal(fixable.length, 2);
});
