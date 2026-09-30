/**
 * Admin Repo Scan tab — never writes unasked, never reports a failure as a pass.
 *
 * Admin audit (origin/main cb26ff38, 2026-09-29) found, in
 * website/app/admin/tabs/{RepoScanTab.tsx,useAutoFix.ts} and
 * website/app/components/LiveScanTerminal.tsx:
 *   1. every completed scan started the fixer on its own, which opens
 *      branches + PRs on the scanned repo; batches of 5 files each open their
 *      own PR, but only the LAST prUrl was kept;
 *   2. the terminal never checked res.ok — a 500 {status:"failed"} printed
 *      "GATE: PASSED" and the tab said "All Clear";
 *   3. the fixer never checked res.ok — a 500 marked every file "done";
 *   4. the terminal printed "running on the engine" on a timer, for a module
 *      list that was not the tier's;
 *   5. the tier <select> typed "Quick (41 modules)" (the quick tier is 4);
 *   6. copyIssues reported success on the error line, loadGuidance ignored
 *      res.ok, the <select> had no label, and the first run and the retry
 *      were two copies of one loop.
 *
 * The rules that decide what a response MEANS live in two zero-import files
 * (admin/tabs/auto-fix-logic.ts, lib/scan-outcome.ts) loaded here through
 * Node's type-stripping loader, so these tests run the code the tab runs.
 * The wiring (who calls what, from where) is pinned on source text — this
 * repo has no React renderer.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'website', 'app');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');

let logic, outcome, TIERS;
try {
  logic = require('../website/app/admin/tabs/auto-fix-logic.ts');
  outcome = require('../website/app/lib/scan-outcome.ts');
  ({ TIERS } = require('../website/app/lib/checkout-tiers.ts'));
} catch {
  // error-ok — this Node cannot strip types; the source-level tests below still run
}
const ts = logic && outcome && TIERS ? {} : { skip: 'runtime cannot require .ts (needs Node >= 22.18 type-stripping)' };

const issue = (file, text = `${file}:1: problem`, module = 'lint') => ({ file, issue: text, module });

// Strip // and /* */ comments so assertions read code, not prose about code.
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/[^\n]*/g, '$1');
}

function fnBody(src, name) {
  const at = src.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(at !== -1, `function ${name} not found`);
  const rest = src.slice(at + 1);
  const next = rest.search(/\n  (async )?function \w+\(/);
  return next === -1 ? src.slice(at) : src.slice(at, at + 1 + next);
}

describe('fix responses — a failed request is never a fixed file', ts, () => {
  it('HTTP 500 {status:"failed"} is a failed request with the status and reason', () => {
    const o = logic.readFixResponse(false, 500, { status: 'failed', error: 'Failed to create PR' });
    assert.equal(o.requestOk, false);
    assert.match(o.reason, /HTTP 500/);
    assert.match(o.reason, /Failed to create PR/);
  });

  it('an unreadable body and a 200 {status:"error"} are failed requests too', () => {
    assert.equal(logic.readFixResponse(false, 504, null).requestOk, false);
    assert.match(logic.readFixResponse(false, 504, null).reason, /HTTP 504/);
    assert.equal(logic.readFixResponse(true, 200, { status: 'error', error: 'x' }).requestOk, false);
  });

  it('control: a 200 pr_created response is a successful request', () => {
    assert.equal(logic.readFixResponse(true, 200, { status: 'pr_created', prUrl: 'u' }).requestOk, true);
  });

  it('a failed request marks every file in its batch failed — none "done" — and leaves other batches alone', () => {
    const progress = logic.buildFileProgress(logic.groupIssuesByFile([issue('a.js'), issue('b.js'), issue('c.js')]));
    const out = logic.applyBatchToProgress(progress, logic.readFixResponse(false, 500, { status: 'failed' }), new Set(['a.js', 'b.js']));
    assert.deepEqual(out.map((f) => f.status), ['failed', 'failed', 'pending']);
    assert.match(out[0].error, /HTTP 500/);
  });

  it('a file is "done" only when the response lists it as fixed', () => {
    const progress = logic.buildFileProgress(logic.groupIssuesByFile([issue('a.js'), issue('b.js'), issue('c.js'), issue('d.js')]));
    const res = logic.readFixResponse(true, 200, {
      status: 'pr_created', prUrl: 'https://github.com/o/r/pull/7', filesFixed: 1,
      fixes: [{ file: 'a.js', issues: ['x'] }],
      failedFiles: [{ file: 'b.js', issues: ['y'], reason: 'syntax gate rejected the fix' }],
      errors: ['c.js: request timed out after 60s'],
    });
    const out = logic.applyBatchToProgress(progress, res, new Set(['a.js', 'b.js', 'c.js', 'd.js']));
    assert.deepEqual(out.map((f) => f.status), ['done', 'failed', 'timeout', 'not_fixed']);
    assert.equal(out[1].error, 'syntax gate rejected the fix');
  });

  it('no_fixes marks the batch "not fixed", never "done"', () => {
    const progress = logic.buildFileProgress(logic.groupIssuesByFile([issue('a.js')]));
    const out = logic.applyBatchToProgress(progress, logic.readFixResponse(true, 200, { status: 'no_fixes', message: 'No fixes could be generated' }), new Set(['a.js']));
    assert.equal(out[0].status, 'not_fixed');
    assert.equal(out[0].error, 'No fixes could be generated');
  });

  it('without a per-file list, only a count that covers every file proves each was fixed', () => {
    const progress = logic.buildFileProgress(logic.groupIssuesByFile([issue('a.js'), issue('b.js')]));
    const all = logic.applyBatchToProgress(progress, logic.readFixResponse(true, 200, { status: 'fixes_committed', branch: 'b1', filesFixed: 2 }), new Set(['a.js', 'b.js']));
    assert.deepEqual(all.map((f) => f.status), ['done', 'done']);
    const some = logic.applyBatchToProgress(progress, logic.readFixResponse(true, 200, { status: 'fixes_committed', branch: 'b1', filesFixed: 1 }), new Set(['a.js', 'b.js']));
    assert.deepEqual(some.map((f) => f.status), ['not_fixed', 'not_fixed']);
    assert.match(some[0].error, /did not say which/);
  });
});

describe('fix run — every PR is kept, failures are counted', ts, () => {
  const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.js`);
  const groups = logic ? logic.groupIssuesByFile(files.map((f) => issue(f))) : [];

  it('12 files → 3 batches of at most 5 → at most 3 PRs', () => {
    const batches = logic.planBatches(groups);
    assert.deepEqual(batches.map((b) => b.length), [5, 5, 2]);
    assert.equal(logic.maxPullRequests(12), 3);
    assert.equal(logic.FIX_BATCH_SIZE, 5);
  });

  it('three batches that each open a PR yield three PR urls, not the last one', () => {
    let acc = logic.emptyFixResult();
    logic.planBatches(groups).forEach((batch, i) => {
      acc = logic.mergeBatch(acc, logic.readFixResponse(true, 200, {
        status: 'pr_created', prUrl: `https://github.com/o/r/pull/${i + 1}`, prNumber: i + 1,
        filesFixed: batch.length, issuesFixed: batch.length, fixes: batch.map((g) => ({ file: g.file })),
      }), batch);
    });
    const done = logic.finalizeFixResult(acc);
    assert.deepEqual(done.pullRequests.map((p) => p.number), [1, 2, 3]);
    assert.equal(done.filesFixed, 12);
    assert.equal(done.status, 'complete');
    assert.match(logic.fixRunHeadline(done), /^3 pull requests opened/);
  });

  it('a 500 batch lands every one of its files in failedFiles (so Retry covers them) and the run is partial', () => {
    const [b1, b2] = logic.planBatches(groups);
    let acc = logic.mergeBatch(logic.emptyFixResult(), logic.readFixResponse(true, 200, { status: 'pr_created', prUrl: 'https://github.com/o/r/pull/1', filesFixed: 5, fixes: b1.map((g) => ({ file: g.file })) }), b1);
    acc = logic.mergeBatch(acc, logic.readFixResponse(false, 500, { status: 'failed', error: 'boom' }), b2);
    const done = logic.finalizeFixResult(acc);
    assert.equal(done.status, 'partial');
    assert.deepEqual(done.failedFiles.map((f) => f.file), b2.map((g) => g.file));
    assert.match(done.failedFiles[0].reason, /HTTP 500 — boom/);
    assert.equal(done.failedBatches, 1);
  });

  it('every batch failing is "failed" — never "partially completed" — and says nothing was written', () => {
    let acc = logic.emptyFixResult();
    for (const batch of logic.planBatches(groups)) acc = logic.mergeBatch(acc, logic.readFixResponse(false, 500, { status: 'failed' }), batch);
    const done = logic.finalizeFixResult(acc);
    assert.equal(done.status, 'failed');
    assert.equal(done.failedFiles.length, 12);
    const headline = logic.fixRunHeadline(done);
    assert.doesNotMatch(headline, /partial/i);
    assert.match(headline, /nothing was written/);
  });

  it('requests that succeed but write nothing are "no_fixes", not "complete"', () => {
    const acc = logic.mergeBatch(logic.emptyFixResult(), logic.readFixResponse(true, 200, { status: 'no_fixes', message: 'No fixes could be generated' }), groups.slice(0, 5));
    assert.equal(logic.finalizeFixResult(acc).status, 'no_fixes');
    const mixed = logic.finalizeFixResult(logic.mergeBatch(acc, logic.readFixResponse(false, 500, {}), groups.slice(5, 10)));
    assert.equal(mixed.status, 'no_fixes');
    assert.match(logic.fixRunHeadline(mixed), /5 files failed/);
  });

  it('retry keeps the landed PRs and re-sends the original issues with their module names', () => {
    const originals = new Map([['a.js', [issue('a.js', 'a.js:3: no-unused-vars', 'lint')]]]);
    const retry = logic.retryGroups([
      { file: 'a.js', issues: ['a.js:3: no-unused-vars'], reason: 'HTTP 500' },
      { file: 'z.js', issues: ['z.js:1: other'], reason: 'HTTP 500' },
    ], originals);
    assert.equal(retry[0].issues[0].module, 'lint');
    assert.equal(retry[1].issues[0].module, 'retry');
    const base = logic.retryBase({ ...logic.emptyFixResult(), pullRequests: [{ url: 'u', filesFixed: 1, files: [] }], failedFiles: [{ file: 'a.js', issues: [], reason: 'r' }] });
    assert.equal(base.pullRequests.length, 1);
    assert.equal(base.failedFiles.length, 0);
  });
});

describe('scan responses — a failure never prints GATE: PASSED', ts, () => {
  const mods = [{ name: 'syntax', status: 'passed' }, { name: 'lint', status: 'passed' }];

  it('HTTP 500 {status:"failed"} is failed with the reason', () => {
    const o = outcome.classifyScanResponse(false, 500, { status: 'failed', error: 'Scan failed — please try again or contact support.' });
    assert.equal(o.kind, 'failed');
    assert.match(o.reason, /HTTP 500 — Scan failed/);
    const line = outcome.gateLine(o, undefined);
    assert.match(line, /^GATE: FAILED — /);
    assert.doesNotMatch(line, /PASSED/);
  });

  it('control: 200 complete with modules and zero issues passes', () => {
    const o = outcome.classifyScanResponse(true, 200, { status: 'complete', modules: mods, totalIssues: 0 });
    assert.equal(o.kind, 'passed');
    assert.match(outcome.gateLine(o, 1234), /^GATE: PASSED — 2 modules, 1234ms$/);
  });

  it('200 with status "failed" (in-band engine error) is failed', () => {
    const o = outcome.classifyScanResponse(true, 200, { status: 'failed', modules: [], totalIssues: 0, error: 'Cannot access o/r (tree read failed)' });
    assert.equal(o.kind, 'failed');
    assert.match(o.reason, /Cannot access/);
  });

  it('a complete body with no modules checked nothing — failed, unless it is a cached replay', () => {
    assert.equal(outcome.classifyScanResponse(true, 200, { status: 'complete', modules: [], totalIssues: 0 }).kind, 'failed');
    assert.equal(outcome.classifyScanResponse(true, 200, { status: 'complete', modules: [], totalIssues: 0, cached: true }).kind, 'passed');
  });

  it('unreadable bodies, 402s and non-final statuses are failed', () => {
    assert.equal(outcome.classifyScanResponse(false, 504, null).kind, 'failed');
    assert.match(outcome.classifyScanResponse(false, 402, { error: 'Payment not completed' }).reason, /HTTP 402 — Payment not completed/);
    assert.match(outcome.classifyScanResponse(true, 200, { status: 'pending', modules: mods }).reason, /status: pending/);
  });

  it('issues and not-checked modules are reported as such', () => {
    const o = outcome.classifyScanResponse(true, 200, { status: 'complete', totalIssues: 3, modules: [...mods, { name: 'python', status: 'skipped' }] });
    assert.equal(o.kind, 'issues');
    assert.equal(o.notChecked, 1);
    assert.match(outcome.gateLine(o, 10), /^GATE: 3 ISSUES — 3 modules \(1 not checked\)/);
  });

  it('the caller gets status "failed" + the reason on every failure (expired is kept for the scan page)', () => {
    const o = outcome.classifyScanResponse(false, 500, { status: 'complete', modules: mods });
    const forCaller = outcome.scanResultForCaller({ status: 'complete', modules: mods }, o);
    assert.equal(forCaller.status, 'failed');
    assert.match(forCaller.error, /HTTP 500/);
    const exp = outcome.classifyScanResponse(true, 200, { status: 'expired' });
    assert.equal(outcome.scanResultForCaller({ status: 'expired' }, exp).status, 'expired');
    const ok = outcome.classifyScanResponse(true, 200, { status: 'complete', modules: mods, totalIssues: 0 });
    assert.equal(outcome.scanResultForCaller({ status: 'complete', modules: mods }, ok).status, 'complete');
  });
});

describe('tier labels — derived from checkout-tiers, never typed', ts, () => {
  it('the quick label counts the modules the quick tier names', () => {
    const n = TIERS.quick.modules.split(',').length;
    assert.equal(n, 4, 'checkout-tiers quick tier is the 4-module tier this test was written against');
    assert.equal(outcome.scanTierLabel('quick', TIERS), `${TIERS.quick.name} — ${n} modules`);
    assert.deepEqual(outcome.tierModuleNames(TIERS.quick), ['syntax', 'lint', 'secrets', 'codeQuality']);
    assert.match(outcome.tierScopeLine('quick', TIERS), /4 modules — syntax, lint, secrets, codeQuality/);
  });

  it('the repo-scan options are the non-URL, non-subscription tiers', () => {
    assert.deepEqual(outcome.repoScanTierKeys(TIERS), ['quick', 'full', 'scan_fix', 'nuclear']);
  });

  it('whole-engine tiers carry no number and no vendor name', () => {
    for (const key of ['full', 'scan_fix', 'nuclear']) {
      const label = outcome.scanTierLabel(key, TIERS);
      assert.match(label, /every applicable module/);
      assert.doesNotMatch(label, /\d/);
      assert.doesNotMatch(label, /claude|anthropic/i);
    }
  });
});

describe('wiring (source text)', () => {
  const tab = read('admin/tabs/RepoScanTab.tsx');
  const hook = read('admin/tabs/useAutoFix.ts');
  const terminal = read('components/LiveScanTerminal.tsx');
  const card = read('admin/tabs/FixResultCard.tsx');
  const modulesCard = read('admin/tabs/ModuleResults.tsx');

  it('the fixer starts only from the operator\'s click — never from scan completion', () => {
    const calls = code(tab).match(/\bfixIssues\(/g) || [];
    assert.equal(calls.length, 1, 'RepoScanTab must call fixIssues in exactly one place');
    assert.match(fnBody(code(tab), 'startFix'), /\bfixIssues\(/);
    assert.match(tab, /onClick=\{startFix\}/);
    const onComplete = code(tab).slice(code(tab).indexOf('onComplete='), code(tab).indexOf('onError='));
    assert.doesNotMatch(onComplete, /fixIssues|startFix/, 'scan completion must not start the fixer');
  });

  it('the fix button says it opens PRs on the repo, and the fixer targets the scanned repo', () => {
    assert.match(tab, /opens up to \{prCap\} PR/);
    assert.match(tab, /useAutoFix\(\{ repoUrl: scanned\?\.repoUrl/);
  });

  it('a failed scan is shown as failed, not "All Clear"', () => {
    assert.match(tab, /scanFailed = !!result && result\.status !== "complete"/);
    assert.match(tab, /scanFailed \? "Scan failed"/);
  });

  it('the terminal classifies the HTTP response and prints no timed engine progress', () => {
    const c = code(terminal);
    assert.match(c, /classifyScanResponse\(res\.ok, res\.status,/);
    assert.match(c, /onComplete\(scanResultForCaller\(/);
    assert.doesNotMatch(c, /running on the engine|MODULE_ORDER|Math\.random/);
    assert.doesNotMatch(c, /setTimeout\(/, 'no timer may print progress lines');
    assert.doesNotMatch(c, /--fix/, 'the scan does not fix; the header command must not say it does');
    assert.match(c, /from "@\/app\/lib\/checkout-tiers"/);
  });

  it('the fixer reads res.ok through one fetch and keeps no single prUrl', () => {
    const c = code(hook);
    assert.equal((c.match(/fetch\(/g) || []).length, 1);
    assert.match(c, /readFixResponse\(res\.ok, res\.status, body\)/);
    assert.doesNotMatch(c, /\.prUrl\s*=/);
    for (const entry of ['fixIssues', 'retryFailedFiles']) assert.match(fnBody(c, entry), /runFixBatches\(/);
  });

  it('the tier select is labelled and its options come from checkout-tiers', () => {
    assert.match(tab, /<select[\s\S]*?aria-label="Scan tier"/);
    assert.match(tab, /import \{ TIERS \} from "@\/app\/lib\/checkout-tiers"/);
    assert.doesNotMatch(tab, /\(\d+ modules\)/);
    assert.doesNotMatch(tab, /<option value="quick">/);
  });

  it('copy success goes to a notice, not the error line; guidance checks res.ok', () => {
    const copy = fnBody(code(tab), 'copyIssues');
    assert.doesNotMatch(copy, /setError\("Issues copied/);
    assert.match(copy, /flashNotice\(/);
    assert.match(copy, /catch/);
    assert.match(fnBody(code(tab), 'loadGuidance'), /!res\.ok/);
    assert.match(tab, /role="alert"/);
  });

  it('the result card lists every pull request', () => {
    assert.match(card, /prs\.map\(\(pr\) =>/);
    assert.doesNotMatch(card, /fixResult\.prUrl/);
  });

  it('touched files use no red/orange/amber/yellow Tailwind hue classes and name no vendor in copy', () => {
    const hue = /\b(?:[a-z]+:)*(?:text|bg|border(?:-[lrtbxy])?|ring|from|via|to|fill|stroke|outline|decoration|divide|shadow)-(?:red|orange|amber|yellow)-\d{2,3}\b/;
    for (const [name, src] of Object.entries({ tab, terminal, card, modulesCard, hook })) {
      assert.doesNotMatch(src, hue, `${name} uses a forbidden hue class`);
    }
    for (const [name, src] of Object.entries({ tab, terminal, card, modulesCard })) {
      assert.doesNotMatch(code(src), /claude|anthropic/i, `${name} names a vendor in user-visible code`);
    }
  });
});
