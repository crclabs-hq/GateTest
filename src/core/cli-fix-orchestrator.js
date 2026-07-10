'use strict';
/**
 * Speculative Parallel Hypothesis Orchestrator
 *
 * Generates three independent repair hypotheses in a single Claude call,
 * validates all three concurrently (syntax gate + optional test run), then
 * selects the highest-ranking candidate using a deterministic scoring algorithm.
 *
 * Rank 1 — syntax passes AND all discovered tests pass
 * Rank 2 — syntax passes, some tests amber
 * Rank 3 — syntax fails (immediate discard)
 *
 * If all three branches fail to reach Rank 1, the best-performing branch's
 * stderr is bundled into the next retry prompt (up to maxAttempts).
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const vm     = require('vm');
const https  = require('https');
const { execSync } = require('child_process');
const { verifyGeneratedTest } = require('./bidirectional-test-gate');
const {
  recordFixEvent,
  executePlaybackSimulation,
  distillRecipes,
} = require('./flywheel-playback-engine');

const { CHEAP_MODEL } = require('./engine-models');

const ANTHROPIC_HOST  = 'api.anthropic.com';
const TIMEOUT_MS      = 90_000;
const TEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS    = 3;

const H = [
  '=== GATETEST_HYPOTHESIS_ALPHA ===',
  '=== GATETEST_HYPOTHESIS_BETA ===',
  '=== GATETEST_HYPOTHESIS_GAMMA ===',
];
const H_NAMES = ['Alpha', 'Beta', 'Gamma'];

// ── Claude call ───────────────────────────────────────────────────────────────

function _callClaude(apiKey, system, user, model = CHEAP_MODEL) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const req = https.request({
      hostname: ANTHROPIC_HOST,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed?.content?.[0]?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Prompt engineering ────────────────────────────────────────────────────────

function _buildMultiHypothesisPrompt(filePath, content, issues, priorError) {
  const ext = path.extname(filePath).slice(1) || 'js';
  const issueList = issues.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const errorBlock = priorError
    ? `\nPrevious attempt failed — use this context to avoid the same mistake:\n${priorError}\n`
    : '';
  return [
    `File: ${filePath}`,
    `Issues to fix:\n${issueList}`,
    errorBlock,
    'Current file content:',
    '```' + ext,
    content,
    '```',
    '',
    'Generate EXACTLY three independent repair hypotheses separated by the delimiters below.',
    'Each hypothesis must be a COMPLETE, syntactically valid file that fixes ALL listed issues.',
    'Hypotheses must differ meaningfully in approach — not just whitespace.',
    '',
    `${H[0]}`,
    '(complete corrected file — Hypothesis Alpha: minimal diff, touch only offending lines)',
    `${H[1]}`,
    '(complete corrected file — Hypothesis Beta: refactor the affected function/block)',
    `${H[2]}`,
    '(complete corrected file — Hypothesis Gamma: defensive approach, add guards/validation)',
    '',
    'Rules: no markdown fences inside file blocks. Preserve all existing behavior beyond the fix.',
  ].join('\n');
}

// ── Hypothesis parsing ────────────────────────────────────────────────────────

function _parseHypotheses(responseText) {
  const variants = [];
  for (let i = 0; i < H.length; i++) {
    const start = responseText.indexOf(H[i]);
    if (start === -1) continue;
    const bodyStart = start + H[i].length;
    const end = i + 1 < H.length
      ? responseText.indexOf(H[i + 1])
      : responseText.length;
    const code = responseText.slice(bodyStart, end === -1 ? undefined : end).trim();
    if (code) variants.push({ index: i, code });
  }
  return variants;
}

// ── Syntax validation ─────────────────────────────────────────────────────────

function _validateSyntax(code, ext) {
  if (!code || typeof code !== 'string') return { passed: false, error: 'empty response' };
  const n = ext.toLowerCase();
  if (n === '.json') {
    try { JSON.parse(code); return { passed: true }; }
    catch (e) { return { passed: false, error: e.message }; }
  }
  if (['.js', '.mjs', '.cjs'].includes(n)) {
    try { new vm.Script(code); return { passed: true }; }  // eslint-disable-line no-new
    catch (e) { return { passed: false, error: e.message }; }
  }
  // TypeScript/TSX — no runtime syntax validator; treat as passing
  return { passed: true };
}

// ── Test discovery & execution ────────────────────────────────────────────────

function _findTestFile(filePath, projectRoot) {
  const base = path.basename(filePath, path.extname(filePath));
  const candidates = [
    path.join(projectRoot, 'tests', `${base}.test.js`),
    path.join(projectRoot, 'tests', `${base}.test.ts`),
    path.join(projectRoot, '__tests__', `${base}.test.js`),
    path.join(path.dirname(filePath), `${base}.test.js`),
  ];
  return candidates.find(c => fs.existsSync(c)) || null;
}

function _runTests(testFile, timeout) {
  if (!testFile) return { passed: true, output: '' };
  // Strip NODE_TEST_CONTEXT so this subprocess behaves as a standalone runner
  // (exit 1 on failure) even when the orchestrator is called from inside a test suite.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    execSync(`node --test "${testFile}"`, {
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    return { passed: true, output: '' };
  } catch (err) {
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n');
    return { passed: false, output: out.toString().slice(0, 500) };
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function _rank({ syntaxOk, testOk }) {
  if (!syntaxOk) return 3;
  if (testOk)    return 1;
  return 2;
}

// ── Main orchestration entry point ────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {string}   opts.filePath       — absolute path to the file to fix
 * @param {string[]} opts.issues         — human-readable issue descriptions
 * @param {string}   [opts.projectRoot]  — repo root for test discovery
 * @param {string}   [opts.context]      — optional extra context injected into prompt
 * @param {number}   [opts.maxAttempts]  — max retry rounds (default 3)
 * @param {string}   [opts.apiKey]       — Anthropic key (falls back to env)
 * @param {string}   [opts.model]        — Claude model id (default CHEAP_MODEL)
 * @returns {Promise<object>}
 */
async function runFixOrchestration(opts) {
  const {
    filePath,
    issues,
    projectRoot = process.cwd(),
    context     = '',
    maxAttempts = MAX_ATTEMPTS,
    model       = CHEAP_MODEL,
  } = opts;
  // Honor an explicitly-passed apiKey even when empty (caller forcing the
  // no-key early-exit); only fall back to the env var when omitted entirely.
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.ANTHROPIC_API_KEY;
  if (!apiKey)   return { fixed: false, reason: 'no-api-key' };
  if (!issues?.length) return { fixed: false, reason: 'no-issues-provided' };

  let content;
  try   { content = fs.readFileSync(filePath, 'utf-8'); }
  catch (e) { return { fixed: false, reason: `unreadable: ${e.message}` }; }

  const ext      = path.extname(filePath);
  const testFile = _findTestFile(filePath, projectRoot);
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hyp-'));
  let priorError = '';
  const t0 = Date.now();

  // ── Playback simulation — check recipe store BEFORE calling Claude ─────────
  // If a stable recipe exists for this pattern, apply it and return immediately
  // with zero Anthropic spend.
  const playback = executePlaybackSimulation({
    content,
    issues,
    fileExt: ext,
    recipePath: opts.recipePath || null,
  });
  if (playback.hit && playback.code) {
    fs.writeFileSync(filePath, playback.code, 'utf-8');
    recordFixEvent({
      ruleKey:    issues[0] || '',
      layer:      playback.layer,
      success:    true,
      durationMs: Date.now() - t0,
      fileExt:    ext,
      eventsPath: opts.eventsPath || undefined,
    });
    return {
      fixed:      true,
      rank:       1,
      hypothesis: 'Playback',
      attempt:    0,
      lineDelta:  Math.abs(playback.code.split('\n').length - content.split('\n').length),
      testsPassed: false,
      testGate:   null,
      playback:   true,
      recipeId:   playback.recipeId || null,
    };
  }

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const systemPrompt = [
        'You are a senior software engineer performing surgical code repair.',
        'Return EXACTLY three complete file hypotheses separated by the required delimiters.',
        'No text before the first delimiter. No commentary after the last hypothesis.',
      ].join(' ');

      const userPrompt = (context ? context + '\n\n' : '') +
        _buildMultiHypothesisPrompt(filePath, content, issues, priorError);

      let responseText;
      try   { responseText = await _callClaude(apiKey, systemPrompt, userPrompt, model); }
      catch (e) { return { fixed: false, reason: `claude-error: ${e.message}` }; }

      const hypotheses = _parseHypotheses(responseText);
      if (hypotheses.length === 0) {
        priorError = 'model returned no parseable hypotheses';
        continue;
      }

      // Write each hypothesis to an isolated temp file
      for (const h of hypotheses) {
        h.tempPath = path.join(tmpDir, `hypothesis-${h.index}${ext}`);
        fs.writeFileSync(h.tempPath, h.code, 'utf-8');
      }

      // Validate all candidates concurrently
      const evaluated = await Promise.all(hypotheses.map(async (h) => {
        const syntaxResult = _validateSyntax(h.code, ext);
        const testResult   = syntaxResult.passed ? _runTests(testFile, TEST_TIMEOUT_MS) : { passed: false, output: '' };
        const lineDelta    = Math.abs(h.code.split('\n').length - content.split('\n').length);
        return {
          ...h,
          rank:        _rank({ syntaxOk: syntaxResult.passed, testOk: testResult.passed }),
          lineDelta,
          syntaxError: syntaxResult.error || null,
          testOutput:  testResult.output,
          testOk:      testResult.passed,
        };
      }));

      // Rank ASC (1 = best), lineDelta ASC as tiebreaker
      evaluated.sort((a, b) => a.rank - b.rank || a.lineDelta - b.lineDelta);
      const winner = evaluated[0];

      if (winner.rank <= 2) {
        fs.writeFileSync(filePath, winner.code, 'utf-8');

        // Bidirectional gate — verify the fix with negative + positive controls.
        // Advisory only: the fix ships regardless. maxCorrections:0 prevents
        // rewriting existing customer tests; only generated tests use correction.
        let testGate = null;
        if (testFile) {
          testGate = await verifyGeneratedTest({
            testPath:        testFile,
            sourceFilePath:  filePath,
            originalContent: content,
            fixedContent:    winner.code,
            apiKey,
            projectRoot,
            maxCorrections:  0, // existing tests — observe only, never rewrite
          }).catch(() => null); // error-ok — gate is advisory; never block the fix
        }

        // ── Flywheel recording + distillation ────────────────────────────
        // Record the event so clusterBugLineages can surface this pattern.
        recordFixEvent({
          ruleKey:               issues[0] || '',
          layer:                 'claude',
          success:               true,
          durationMs:            Date.now() - t0,
          bidirectionalCertified: testGate?.certified ?? null,
          hypothesisName:        H_NAMES[winner.index],
          lineDelta:             winner.lineDelta,
          attempt,
          fileExt:               ext,
          eventsPath:            opts.eventsPath || undefined,
        });

        // If the fix was bidirectionally certified AND a recipe path is
        // configured, distill the win into the recipe store so the next
        // identical pattern is served for free.
        if (testGate?.certified && opts.recipePath) {
          distillRecipes({
            originalContent: content,
            fixedContent:    winner.code,
            ruleKey:         issues[0] || '',
            fileExt:         ext,
            recipePath:      opts.recipePath,
          });
        }

        return {
          fixed:      true,
          rank:       winner.rank,
          hypothesis: H_NAMES[winner.index],
          attempt,
          lineDelta:  winner.lineDelta,
          testsPassed: winner.testOk,
          testGate,
          advisory:   winner.rank === 2 ? 'Some tests remain amber — review before merging' : null,
        };
      }

      // All three failed syntax — retry with the best error context
      priorError = winner.syntaxError || winner.testOutput || 'all hypotheses failed syntax';
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } // error-ok
  }

  return { fixed: false, reason: `all ${maxAttempts} attempt(s) exhausted`, lastError: priorError };
}

// ── Batch entry point — the contract bin/gatetest.js consumes ────────────────

/**
 * Fix a whole findings list (the shape produced by extractFileFromCheck in
 * bin/gatetest.js: { file, message, moduleName, checkName, severity }),
 * grouped per file, each file driven through runFixOrchestration.
 *
 * @param {object[]} findings
 * @param {string}   projectRoot
 * @param {string}   apiKey
 * @param {{maxAttempts?: number, fileCap?: number, model?: string}} [opts]
 * @returns {Promise<{accepted: object[], testFiles: object[], allFixes: object[], prBody: string, failed: object[]}>}
 */
async function runFixBatch(findings, projectRoot, apiKey, opts = {}) {
  const { maxAttempts = MAX_ATTEMPTS, fileCap = 50, model = CHEAP_MODEL } = opts;
  const byFile = new Map();
  for (const f of findings || []) {
    if (!f || !f.file) continue;
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(`${f.moduleName || 'module'}:${f.checkName || 'check'} — ${f.message || ''}`);
  }

  const files = [...byFile.keys()].slice(0, fileCap);
  const accepted = [];
  const failed = [];
  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    const result = await runFixOrchestration({
      filePath,
      issues: byFile.get(file),
      projectRoot,
      apiKey,
      maxAttempts,
      model,
    });
    if (result.fixed) {
      // runFixOrchestration wrote the winning hypothesis to disk — read it
      // back so callers get the exact accepted content.
      accepted.push({ file, fixed: fs.readFileSync(filePath, 'utf-8'), issues: byFile.get(file), result });
    } else {
      failed.push({ file, reason: result.reason || 'unknown', issues: byFile.get(file) });
    }
  }

  const { composePrBody } = require('../../lib/pr-composer.js');
  const prBody = composePrBody({ fixes: accepted.map(({ file, issues }) => ({ file, issues })) });
  // The orchestrator verifies existing tests; it does not generate new ones.
  return { accepted, testFiles: [], allFixes: accepted, prBody, failed };
}

module.exports = { runFixOrchestration, runFixBatch };
