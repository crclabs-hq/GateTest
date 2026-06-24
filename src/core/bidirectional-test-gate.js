'use strict';
/**
 * Bidirectional Test Gate
 *
 * Verifies a regression test with two controls:
 *   Negative — test must FAIL against the original (buggy) source.
 *              Proves the test has genuine fault-detection power.
 *   Positive — test must PASS against the fixed source.
 *              Proves the fix cleanly resolves the issue.
 *
 * If either control fails, a bounded self-correction loop sends the
 * test + error context to Claude for assertion repair (up to
 * opts.maxCorrections, default 3). Corrections on existing customer
 * tests should use maxCorrections: 0.
 *
 * The source file is always restored to its pre-call state in a
 * finally block. If the gate wrote the test file itself (testContent
 * supplied, testPath was absent) and certification fails, the test
 * file is removed so it never ships in a broken state.
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const { execSync } = require('child_process');

const ANTHROPIC_HOST = 'api.anthropic.com';
const MODEL          = 'claude-sonnet-4-20250514';
const CLAUDE_TIMEOUT = 60_000;
const TEST_TIMEOUT   = 15_000;

// ── Claude call ───────────────────────────────────────────────────────────────

function _callClaude(apiKey, system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
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
    req.setTimeout(CLAUDE_TIMEOUT, () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────

/**
 * Run `node --test "<testPath>"` from `cwd`. Returns
 * { passed: boolean, output: string }.
 */
function _runTestFile(testPath, cwd, timeout) {
  if (!testPath || !fs.existsSync(testPath)) {
    return { passed: false, output: 'test file not found' };
  }
  // Strip NODE_TEST_CONTEXT so child `node --test` processes behave as
  // standalone runners (exit 1 on failure) even when invoked from inside
  // the GateTest test suite, where the parent runner sets this variable.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    execSync(`node --test "${testPath}"`, {
      cwd: cwd || path.dirname(testPath),
      timeout: timeout || TEST_TIMEOUT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    return { passed: true, output: '' };
  } catch (err) {
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n');
    return { passed: false, output: out.toString().slice(0, 600) };
  }
}

// ── Correction prompt ─────────────────────────────────────────────────────────

function _buildCorrectionPrompt(testContent, originalSource, fixedSource, errorContext) {
  return [
    'A regression test failed bidirectional validation. Repair the test assertions so that:',
    '1. The test FAILS when run against ORIGINAL (buggy) source.',
    '2. The test PASSES when run against the FIXED source.',
    '',
    `Failure context:\n${errorContext}`,
    '',
    'CURRENT TEST CODE:',
    '```',
    testContent,
    '```',
    '',
    'ORIGINAL (BUGGY) SOURCE:',
    '```',
    originalSource,
    '```',
    '',
    'FIXED SOURCE:',
    '```',
    fixedSource,
    '```',
    '',
    'Output ONLY the corrected test file content. No markdown fences. No commentary.',
  ].join('\n');
}

function _stripFences(text) {
  return (text || '').replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * @param {object}  opts
 * @param {string}  opts.testPath          — absolute path to the test file
 * @param {string}  [opts.testContent]     — test file content (written temporarily if testPath absent)
 * @param {string}  opts.sourceFilePath    — absolute path to the source being tested
 * @param {string}  opts.originalContent   — the original (buggy) source content
 * @param {string}  opts.fixedContent      — the fixed source content
 * @param {string}  [opts.apiKey]          — Anthropic key for correction loop
 * @param {number}  [opts.maxCorrections]  — max self-correction iterations (default 3; use 0 to skip)
 * @param {string}  [opts.projectRoot]     — cwd for node --test (default: dirname of testPath)
 * @returns {Promise<{
 *   certified: boolean,
 *   finalTestContent: string|null,
 *   correctionsMade: number,
 *   negativePass: boolean,
 *   positivePass: boolean,
 *   reason: string,
 * }>}
 */
async function verifyGeneratedTest(opts) {
  const {
    testPath,
    testContent,
    sourceFilePath,
    originalContent,
    fixedContent,
    apiKey,
    maxCorrections = 3,
    projectRoot,
  } = opts || {};

  if (!testPath || !sourceFilePath) {
    return { certified: false, negativePass: false, positivePass: false,
      correctionsMade: 0, finalTestContent: null, reason: 'missing testPath or sourceFilePath' };
  }
  if (typeof originalContent !== 'string' || typeof fixedContent !== 'string') {
    return { certified: false, negativePass: false, positivePass: false,
      correctionsMade: 0, finalTestContent: null, reason: 'originalContent and fixedContent must be strings' };
  }

  const cwd = projectRoot || path.dirname(testPath);

  // Write test to disk if it isn't already there.
  const testExistedBefore = fs.existsSync(testPath);
  let workingContent = testContent;

  if (!testExistedBefore) {
    if (!testContent) {
      return { certified: false, negativePass: false, positivePass: false,
        correctionsMade: 0, finalTestContent: null, reason: 'test file does not exist and no testContent supplied' };
    }
    try {
      fs.mkdirSync(path.dirname(testPath), { recursive: true });
      fs.writeFileSync(testPath, testContent, 'utf-8');
    } catch (e) {
      return { certified: false, negativePass: false, positivePass: false,
        correctionsMade: 0, finalTestContent: null, reason: `could not write test file: ${e.message}` };
    }
  } else if (!workingContent) {
    workingContent = fs.readFileSync(testPath, 'utf-8');
  }

  // Save current source state — restored unconditionally in finally.
  let sourceSnapshot;
  try { sourceSnapshot = fs.readFileSync(sourceFilePath, 'utf-8'); }
  catch (e) {
    if (!testExistedBefore) try { fs.unlinkSync(testPath); } catch { /* best-effort */ } // error-ok
    return { certified: false, negativePass: false, positivePass: false,
      correctionsMade: 0, finalTestContent: null, reason: `could not read source file: ${e.message}` };
  }

  let negPass = false, posPass = false, correctionsMade = 0;
  const canCorrect = apiKey && maxCorrections > 0;

  try {
    for (let attempt = 0; attempt <= maxCorrections; attempt++) {
      // Sync working content to disk
      fs.writeFileSync(testPath, workingContent, 'utf-8');

      // ── Negative control ──────────────────────────────────────────
      // Write original (buggy) code → test must FAIL (exit > 0)
      fs.writeFileSync(sourceFilePath, originalContent, 'utf-8');
      const negResult = _runTestFile(testPath, cwd, TEST_TIMEOUT);
      negPass = !negResult.passed; // we WANT the test to detect the bug

      // ── Positive control ──────────────────────────────────────────
      // Write fixed code → test must PASS (exit == 0)
      fs.writeFileSync(sourceFilePath, fixedContent, 'utf-8');
      const posResult = _runTestFile(testPath, cwd, TEST_TIMEOUT);
      posPass = posResult.passed;

      if (negPass && posPass) break; // certified — stop

      if (!canCorrect || attempt >= maxCorrections) break; // exhausted or disabled

      // ── Self-correction loop ──────────────────────────────────────
      const errorContext = !negPass
        ? `Negative control failed — test passes against the buggy code (no fault detected).\nTest output: ${negResult.output}`
        : `Positive control failed — test fails against the fixed code (fix not recognised).\nTest output: ${posResult.output}`;

      try {
        const raw = await _callClaude(
          apiKey,
          'You repair regression tests. Return only the corrected test file — no markdown fences, no commentary.',
          _buildCorrectionPrompt(workingContent, originalContent, fixedContent, errorContext)
        );
        const corrected = _stripFences(raw);
        if (corrected && corrected !== workingContent) {
          workingContent = corrected;
          correctionsMade++;
        } else {
          break; // no progress — stop
        }
      } catch {
        break; // Claude unreachable — stop correction loop, ship whatever we have
      }
    }
  } finally {
    // Always restore source file to the state it had when we were called.
    try { fs.writeFileSync(sourceFilePath, sourceSnapshot, 'utf-8'); } catch { /* best-effort */ } // error-ok
    // If WE wrote the test and it didn't pass certification, remove it.
    if (!testExistedBefore && !(negPass && posPass)) {
      try { fs.unlinkSync(testPath); } catch { /* best-effort */ } // error-ok
    }
  }

  const certified = negPass && posPass;
  return {
    certified,
    finalTestContent: certified ? workingContent : null,
    correctionsMade,
    negativePass: negPass,
    positivePass: posPass,
    reason: certified
      ? 'bidirectional validation passed'
      : !negPass
        ? 'test passes against buggy code — assertions too weak'
        : 'test fails against fixed code — fix incomplete or test mismatched',
  };
}

module.exports = { verifyGeneratedTest };
