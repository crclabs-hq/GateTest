'use strict';
/**
 * Test-impact selection — which of the customer's own test files a diff can
 * affect (Launch Board move 5: "`--diff` runs only the tests the import graph
 * touches").
 *
 * Until this module `--diff` narrowed what GateTest READS, never what the
 * unitTests / integrationTests modules RUN: both executed the customer's
 * whole suite (`npm test`, `npm run test:integration`) on every diff scan,
 * and `_scopeResultToChangedFiles` only filtered the findings afterwards.
 *
 * ONE definition of "what depends on what": src/core/import-graph.js. The
 * reverse-dependency closure of the changed files is taken over its
 * `fullGraph` (every edge kind — static, lazy, type, path-literal), the
 * over-approximate view, because the cost of a wrong answer here is a test
 * that should have run and did not. ONE definition of "is this a test path":
 * src/core/test-paths.js. Whether that file is one a runner treats as an
 * entry file (`*.test.js`) or a helper is decided here, and only here.
 *
 * Doctrine 1 and 6 — the selection never skips silently. Everything it
 * cannot map sends the run back to the FULL set and says why:
 *   - `--all-tests` (asked for)
 *   - a changed config file (package.json, a lockfile, tsconfig, a runner
 *     config, .env) — it can change any test's behaviour
 *   - a changed file that was deleted, or that is in a language / format the
 *     graph does not read (.py, .json data, .css …) — a test can read it
 *     without importing it
 *   - a changed source file nothing imports — a runner config, a CLI or a
 *     framework may load it by name
 *   - a file in a test directory that is not named like a test and is
 *     imported by nothing: it may be a test the runner discovers by
 *     directory (mocha's `test/*.js`), and it depends on a changed file
 *   - a test script this module cannot pass a file list to (a chain of
 *     commands, a runner it does not know, a mocha config with `spec`)
 * And a test that can reach a `require(x)` / `import(x)` whose argument is
 * computed is KEPT (never dropped) and named — the graph cannot say what it
 * loads.
 *
 * Not checked, and printed as such: code reached only through a child
 * process or a file read (a test that spawns a script by a path it builds at
 * run time, reads a fixture, or loads a JSON file). Docs and images are
 * ignored, by name.
 */

const fs = require('fs');
const path = require('path');
const { buildImportGraph, reverseGraph } = require('./import-graph');
const { isTestPath } = require('./test-paths');
const { toPosix } = require('./repo-path');

/**
 * Of the paths the test-path definition calls test code, the ones a runner
 * treats as an entry file: a `.test.` / `.spec.` / `_test.` / `-test.`
 * suffix, a `test-` / `test_` prefix, or anything directly inside
 * `__tests__/`. A helper (`tests/helpers/db.js`) is test code too, but it is
 * not something to hand to a runner.
 */
const RUNNABLE_TEST_NAME_RE = /(?:^|[.\-_])(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test[-_][^/]*\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$/i;

/** Configuration that can change the behaviour of any test. */
const CONFIG_FILE_RE = /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|tsconfig[^/]*\.json|jsconfig\.json|\.babelrc[^/]*|babel\.config\.[cm]?js|\.mocharc[^/]*|\.env(?:\.[^/]+)?|\.npmrc|\.nvmrc|\.node-version|(?:jest|vitest|vite|webpack|rollup|playwright|cypress|karma|ava|tap|nyc|c8)\.[^/]*config[^/]*|(?:jest|vitest)\.setup\.[^/]+|\.c8rc[^/]*|\.nycrc[^/]*)$|(?:^|\/)\.github\/workflows\//i;

/** Files that cannot be imported and carry no behaviour a test can depend on. */
const DOC_OR_ASSET_RE = /\.(?:md|mdx|markdown|txt|rst|png|jpe?g|gif|webp|svg|ico|pdf)$|(?:^|\/)(?:LICENSE|CHANGELOG|CODEOWNERS)[^/]*$/i;

const MAX_NAMED = 5;

function nameSome(items) {
  const shown = items.slice(0, MAX_NAMED).join(', ');
  return items.length > MAX_NAMED ? `${shown} and ${items.length - MAX_NAMED} more` : shown;
}

/** Reverse-dependency closure: every file that transitively imports one of `seeds` (seeds included). */
function reverseClosure(reverse, seeds) {
  const seen = new Set(seeds);
  const stack = Array.from(seeds);
  while (stack.length) {
    const cur = stack.pop();
    for (const importer of reverse.get(cur) || []) {
      if (!seen.has(importer)) { seen.add(importer); stack.push(importer); }
    }
  }
  return seen;
}

/** Like reverseClosure, but remembers which seed each reached file was first reached from. */
function reverseReach(reverse, seeds) {
  const origin = new Map();
  for (const seed of seeds) origin.set(seed, seed);
  const queue = Array.from(seeds);
  for (let i = 0; i < queue.length; i += 1) {
    const cur = queue[i];
    for (const importer of reverse.get(cur) || []) {
      if (!origin.has(importer)) { origin.set(importer, origin.get(cur)); queue.push(importer); }
    }
  }
  return origin;
}

/**
 * Split the changed files into what the graph can map and what it cannot.
 * @returns {{mapped: string[], ignored: string[], unmapped: Array<{file:string, reason:string}>}}
 */
function classifyChanges({ projectRoot, changedFiles, graph, reverse }) {
  const mapped = [];
  const ignored = [];
  const unmapped = [];
  for (const raw of changedFiles) {
    const rel = toPosix(raw).replace(/^\.\//, '');
    const abs = path.resolve(projectRoot, rel);
    if (CONFIG_FILE_RE.test(rel)) { unmapped.push({ file: rel, reason: 'config file — it can change any test' }); continue; }
    if (!fs.existsSync(abs)) { unmapped.push({ file: rel, reason: 'deleted or moved — tests that loaded it by name cannot be found' }); continue; }
    if (DOC_OR_ASSET_RE.test(rel)) { ignored.push(rel); continue; }
    if (!graph.fileSet.has(abs)) { unmapped.push({ file: rel, reason: 'not in the import graph (a language or format it does not read)' }); continue; }
    if (!isTestPath(rel) && !(reverse.get(abs) || new Set()).size) {
      unmapped.push({ file: rel, reason: 'nothing imports it — a runner config, CLI or framework may load it by name' });
      continue;
    }
    mapped.push(abs);
  }
  return { mapped, ignored, unmapped };
}

function fullSet(base, testFiles, reason, extra = {}) {
  return {
    ...base,
    mode: 'full',
    reason,
    selected: testFiles.slice(),
    line: `running all ${testFiles.length} test files — ${reason}`,
    ...extra,
  };
}

/**
 * Which test files does this diff touch?
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string[]} opts.changedFiles   repo-relative paths (the runner's `changedFiles`)
 * @param {boolean} [opts.allTests]      `--all-tests`
 * @param {(files:string[])=>string[]} [opts.testFilter]  restrict to the test files the caller owns (integration tests)
 * @returns {{
 *   basis: 'import-graph', mode: 'selected'|'full', reason: string|null,
 *   totalTestFiles: number, selected: string[], graphSelected: number,
 *   conservative: Array<{file:string, reason:string}>,
 *   changed: string[], ignored: string[], unmapped: Array<{file:string, reason:string}>,
 *   line: string,
 * }}
 */
function selectImpactedTests({ projectRoot, changedFiles, allTests = false, testFilter }) {
  const graph = buildImportGraph({ projectRoot });
  const rel = (abs) => graph.rel(abs);
  let testFiles = graph.files.map(rel).filter((f) => isTestPath(f) && RUNNABLE_TEST_NAME_RE.test(f)).sort();
  if (typeof testFilter === 'function') {
    const owned = new Set(testFilter(testFiles));
    testFiles = testFiles.filter((f) => owned.has(f));
  }
  const changed = (changedFiles || []).map((f) => toPosix(f).replace(/^\.\//, '')).sort();
  const base = {
    basis: 'import-graph',
    totalTestFiles: testFiles.length,
    graphSelected: 0,
    conservative: [],
    changed,
    ignored: [],
    unmapped: [],
  };

  if (allTests) return fullSet(base, testFiles, 'forced by --all-tests');

  const reverse = reverseGraph(graph.fullGraph);
  const { mapped, ignored, unmapped } = classifyChanges({ projectRoot, changedFiles: changed, graph, reverse });
  base.ignored = ignored;
  if (unmapped.length) {
    const why = unmapped.slice(0, MAX_NAMED).map((u) => `${u.file} (${u.reason})`).join('; ');
    const more = unmapped.length > MAX_NAMED ? `; and ${unmapped.length - MAX_NAMED} more` : '';
    return fullSet(base, testFiles, `cannot map ${unmapped.length} changed file(s): ${why}${more}`, { unmapped });
  }

  const closure = reverseClosure(reverse, mapped);

  // A closure member in a test directory that is not named like a test and
  // that nothing imports: helper or mocha-style test — the graph cannot tell.
  const undecided = [];
  for (const abs of closure) {
    const r = rel(abs);
    if (isTestPath(r) && !RUNNABLE_TEST_NAME_RE.test(r) && !(reverse.get(abs) || new Set()).size) undecided.push(r);
  }
  if (undecided.length) {
    const un = undecided.sort().map((file) => ({ file, reason: 'in a test directory, not named like a test, imported by nothing — helper or runner-discovered test?' }));
    return fullSet(base, testFiles, `cannot tell helper from test: ${nameSome(undecided)}`, { unmapped: un });
  }

  const byGraph = testFiles.filter((f) => closure.has(path.resolve(projectRoot, f)));
  const selected = new Set(byGraph);

  // Tests that can reach a load the graph cannot name are kept and named.
  const conservative = [];
  const loaders = Array.from(graph.dynamic.keys());
  if (loaders.length) {
    const reachesDynamic = reverseReach(reverse, loaders);
    for (const f of testFiles) {
      const via = reachesDynamic.get(path.resolve(projectRoot, f));
      if (selected.has(f) || !via) continue;
      const at = `${rel(via)}:${graph.dynamic.get(via)[0].line}`;
      conservative.push({ file: f, reason: `reaches a require/import with a computed argument at ${at}` });
      selected.add(f);
    }
  }

  const list = testFiles.filter((f) => selected.has(f));
  const kept = conservative.length ? ` (${conservative.length} kept because ${conservative.length === 1 ? 'it reaches' : 'they reach'} a require/import the graph cannot follow)` : '';
  return {
    ...base,
    mode: 'selected',
    reason: null,
    selected: list,
    graphSelected: byGraph.length,
    conservative,
    line: `running ${list.length} of ${testFiles.length} test files touched by this diff (import graph)${kept}`,
  };
}

function quote(files) {
  return files.map((f) => `"${f.replace(/"/g, '')}"`).join(' ');
}

/** `spec` in a mocha config makes positional files ADD to the run, never narrow it. */
function mochaSpecConfigured(projectRoot) {
  const names = ['.mocharc.json', '.mocharc.jsonc', '.mocharc.yml', '.mocharc.yaml', '.mocharc.js', '.mocharc.cjs', '.mocharc.mjs', 'package.json'];
  for (const n of names) {
    let text;
    try { text = fs.readFileSync(path.join(projectRoot, n), 'utf8'); } catch { continue; } // error-ok — an absent config is the answer "none"
    if (n === 'package.json') {
      try { if (JSON.parse(text).mocha && 'spec' in JSON.parse(text).mocha) return true; } catch { /* error-ok — the syntax module reports a broken package.json */ }
    } else if (/\bspec\b/.test(text)) return true;
  }
  return false;
}

const SCRIPT_RUNNER_RE = /^(?:npx\s+(?:--no-install\s+|-y\s+|--yes\s+)?)?(jest|vitest(?:\s+run)?|mocha|node\s+--test)(?:\s+(.*))?$/;

/**
 * The command that runs exactly `files` with the customer's runner, or the
 * reason it cannot be built (never a guess — the caller then runs the full
 * set and says why).
 *
 * @param {{name:string, command:string}} testCommand  what the module detected
 * @param {string} projectRoot
 * @param {string[]} files  repo-relative, '/'-joined
 * @returns {{command:string}|{reason:string}}
 */
function commandForFiles(testCommand, projectRoot, files) {
  let kind = null;
  let flags = [];
  if (testCommand.name === 'npm test' || testCommand.name === 'npm run') {
    let script = testCommand.script;
    if (typeof script !== 'string') {
      try { script = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).scripts.test; } catch { script = null; } // error-ok — no readable script: the reason below says so
    }
    if (!script) return { reason: 'the test script could not be read' };
    const trimmed = script.trim();
    if (/[;&|<>`$()]/.test(trimmed)) return { reason: `the test script "${trimmed.slice(0, 80)}" chains commands — a file list cannot be passed through it` };
    const m = SCRIPT_RUNNER_RE.exec(trimmed);
    if (!m) return { reason: `the test script "${trimmed.slice(0, 80)}" is not a single jest, vitest, mocha or node --test invocation` };
    kind = m[1].startsWith('vitest') ? 'vitest' : m[1].startsWith('node') ? 'node' : m[1];
    const rest = (m[2] || '').split(/\s+/).filter(Boolean);
    if (rest.some((t) => !t.startsWith('-'))) return { reason: `the test script "${trimmed.slice(0, 80)}" names paths of its own — a file list would add to them, not replace them` };
    flags = rest;
  } else if (testCommand.name === 'Jest') kind = 'jest';
  else if (testCommand.name === 'Vitest') kind = 'vitest';
  else if (testCommand.name === 'Mocha') kind = 'mocha';
  else if (testCommand.name === 'Node.js test runner') kind = 'node';
  else return { reason: `${testCommand.name} does not take a file list from the import graph` };

  const list = quote(files);
  const extra = flags.length ? `${flags.join(' ')} ` : '';
  switch (kind) {
    case 'jest': return { command: `npx --no-install jest --runTestsByPath ${extra}${list} 2>&1` };
    case 'vitest': return { command: `npx --no-install vitest run ${extra}${list} 2>&1` };
    case 'mocha':
      if (mochaSpecConfigured(projectRoot)) return { reason: 'the mocha config sets `spec`, so files passed on the command line add to it instead of narrowing it' };
      return { command: `npx --no-install mocha ${extra}${list} 2>&1` };
    default: {
      const reporter = flags.some((f) => f.startsWith('--test-reporter')) ? '' : '--test-reporter=tap ';
      return { command: `node --test ${reporter}${extra}${list} 2>&1` };
    }
  }
}

/**
 * What a test-running module does for this scan.
 *
 * Returns null when the scan is not narrowed (no `--diff`): the module runs
 * exactly as before and prints exactly what it printed before.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {object} [opts.runnerOptions]  the runner's options (`diffOnly`, `changedFiles`, `allTests`)
 * @param {{name:string, command:string}} opts.testCommand
 * @param {(files:string[])=>string[]} [opts.scope]  restrict to the test files this module owns (integration tests)
 * @returns {null|{impact:object, command:string|null}}  `command` null = run nothing
 */
function planTestRun({ projectRoot, runnerOptions, testCommand, scope }) {
  const opts = runnerOptions || {};
  if (!opts.diffOnly) return null;
  const changed = Array.isArray(opts.changedFiles) ? opts.changedFiles : [];
  if (!changed.length && opts.allTests !== true) {
    const reason = 'no changed files were resolved for this diff';
    const impact = { basis: 'import-graph', mode: 'full', reason, totalTestFiles: null, selected: [], graphSelected: 0, conservative: [], changed, ignored: [], unmapped: [], line: `running the full test set — ${reason}` };
    return { impact, command: testCommand.command };
  }
  if (opts.allTests !== true) {
    // A runner that cannot take a file list makes the graph pointless: say so now.
    const probe = commandForFiles(testCommand, projectRoot, ['probe.test.js']);
    if (probe.reason) {
      const reason = `${probe.reason}; running the full set`;
      return { impact: { basis: 'import-graph', mode: 'full', reason, totalTestFiles: null, selected: [], graphSelected: 0, conservative: [], changed, ignored: [], unmapped: [], line: `running the full test set — ${reason}` }, command: testCommand.command };
    }
  }
  let impact;
  try {
    impact = selectImpactedTests({ projectRoot, changedFiles: changed, allTests: opts.allTests === true, testFilter: scope });
  } catch (err) { // error-ok — a selection that cannot run is "not narrowed", stated, never a crash
    return { impact: { basis: 'import-graph', mode: 'full', reason: `selection failed (${err && err.message ? err.message : err})`, totalTestFiles: null, selected: [], graphSelected: 0, conservative: [], changed, ignored: [], unmapped: [], line: 'running the full test set — the import-graph selection failed' }, command: testCommand.command };
  }
  if (impact.mode === 'full') return { impact, command: testCommand.command };
  if (impact.selected.length === 0) {
    impact.line = `running 0 of ${impact.totalTestFiles} test files touched by this diff (import graph) — no test file imports a changed file`;
    return { impact, command: null };
  }
  const built = commandForFiles(testCommand, projectRoot, impact.selected);
  if (built.reason) {
    const reason = `${built.reason}; running the full set`;
    return { impact: { ...impact, mode: 'full', reason, line: `running all ${impact.totalTestFiles} test files — ${reason}` }, command: testCommand.command };
  }
  return { impact, command: built.command };
}

module.exports = {
  selectImpactedTests,
  planTestRun,
  commandForFiles,
  RUNNABLE_TEST_NAME_RE,
  CONFIG_FILE_RE,
};
