'use strict';

/**
 * CLI fix orchestrator — the full production pipeline for `gatetest --auto-pr`.
 *
 * Mirrors what /api/scan/fix does for web scans:
 *   1. Group findings by file (multiple issues → one Claude batch per file).
 *   2. Per-file iterative fix loop (up to maxAttempts, learning from failures).
 *   3. Cross-fix syntax gate (JS / JSON validation; TS/TSX pass-through).
 *   4. Regression test generation for every successful, gate-passed fix.
 *   5. PR-body composition with before/after tables, attempt history, gate summary.
 *
 * Pure Node.js — no Next.js, no TypeScript transform needed.
 */

const fs   = require('fs');
const path = require('path');

const { attemptFixWithRetries } = require('../../website/app/lib/fix-attempt-loop');
const { validateFixesSyntax }   = require('../../website/app/lib/cross-fix-syntax-gate');
const { generateTestsForFixes } = require('../../website/app/lib/test-generator');
const { composePrBody }         = require('../../website/app/lib/pr-composer');
const { callAnthropic }         = require('./ai-fix-engine');
const {
  KNOWN_CONVENTION_FILES,
  extractConventions,
  formatGroundingHeader,
} = require('../../lib/contextual-grounding');

const MODEL         = 'claude-sonnet-4-6';
const MAX_FILE_BYTES = 120_000;

function _buildGroundingHeader(projectRoot) {
  const fileContents = [];
  const files = [];
  for (const name of KNOWN_CONVENTION_FILES) {
    try {
      const content = fs.readFileSync(path.join(projectRoot, name), 'utf-8');
      fileContents.push({ path: name, content });
      files.push(name);
    } catch { /* not present */ }
  }
  const extract = extractConventions({ files, fileContents });
  return formatGroundingHeader(extract.found);
}

function _buildFixPrompt(conventionsHeader, filePath, fileContent, issues) {
  return `${conventionsHeader}You are an expert code fixer for GateTest, an AI-powered QA platform.

Fix ALL of the following issues in this file. Every fix must pass GateTest's re-scan.

FILE: ${filePath}
ISSUES TO FIX:
${issues.map((issue, idx) => `${idx + 1}. ${issue}`).join('\n')}

CURRENT CODE:
\`\`\`
${fileContent}
\`\`\`

CRITICAL RULES:
- Return ONLY the complete fixed file content. No explanations. No markdown fences.
- Fix the ROOT CAUSE, not the symptom. Never patch over an issue.
- NEVER introduce: console.log/debug/info, debugger statements, TODO/FIXME comments, eval() calls, var declarations, empty catch blocks, unused imports.
- Preserve every non-issue line exactly — do not rewrite or reformat unrelated code.
- If a fix would require context you don't have, output the UNCHANGED original file verbatim.
- The fixed code will be automatically re-scanned. If it fails, the fix is rejected.`;
}

function _validateFix(original, fixed) {
  if (!fixed || typeof fixed !== 'string' || fixed.trim().length === 0) {
    return { ok: false, reason: 'empty response' };
  }
  if (fixed.trim() === original.trim()) {
    return { ok: false, reason: 'no changes made' };
  }
  const refusals = ["I cannot", "I can't", 'I apologize', 'I am unable', "I'm unable"];
  if (refusals.some((r) => fixed.includes(r))) {
    return { ok: false, reason: 'refusal response' };
  }
  return { ok: true };
}

function _verifyFixQuality(fixed) {
  const newIssues = [];
  if (/console\.(log|debug|info)\s*\(/.test(fixed)) newIssues.push('introduced console.log/debug/info');
  if (/\beval\s*\(/.test(fixed))                     newIssues.push('introduced eval() call');
  if (/\bdebugger\b/.test(fixed))                    newIssues.push('introduced debugger statement');
  if (/\/\/\s*(TODO|FIXME)\b/i.test(fixed))           newIssues.push('introduced TODO/FIXME comment');
  return { clean: newIssues.length === 0, newIssues };
}

/**
 * Run the full production fix pipeline on a batch of scan findings.
 *
 * @param {Array<{file?, moduleName?, checkName?, message?, severity?}>} findings
 * @param {string} projectRoot   Absolute path to the repo root.
 * @param {string} apiKey        Anthropic API key.
 * @param {Object} [opts]
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.fileCap=50]   Max files to attempt (bounds Anthropic spend).
 * @returns {Promise<{
 *   accepted:              Array<{file,original,fixed,issues}>,
 *   testFiles:             Array<{path,content,sourceFile}>,
 *   allFixes:              Array<{file,original,fixed,issues}>,
 *   errorStrings:          string[],
 *   attemptHistoryByFile:  Record<string,{success,attempts}>,
 *   syntaxGate:            {accepted,rejected},
 *   testGenResult:         {tests,skipped,summary},
 *   prBody:                string,
 * }>}
 */
async function runFixOrchestration(findings, projectRoot, apiKey, opts = {}) {
  const { maxAttempts = 3, fileCap = 50, _callAnthropic: _callAnthropicFn } = opts;
  // Allow tests to inject a mock without touching the https module.
  const _call = _callAnthropicFn || callAnthropic;

  const conventionsHeader = _buildGroundingHeader(projectRoot);

  // Group findings by file — multiple issues on the same file become one batch
  const byFile = new Map();
  for (const f of findings) {
    if (!f.file) continue;
    const relFile = path.isAbsolute(f.file) ? path.relative(projectRoot, f.file) : f.file;
    if (!byFile.has(relFile)) byFile.set(relFile, []);
    byFile.get(relFile).push(f.message || f.checkName || 'issue');
  }

  const filePaths     = Array.from(byFile.keys()).slice(0, fileCap);
  const fixedEntries  = [];   // { file, original, fixed, issues }
  const errorStrings  = [];   // string[] — surfaces in PR advisory section
  const attemptHistoryByFile = {};

  for (const relFilePath of filePaths) {
    const absolutePath = path.join(projectRoot, relFilePath);
    const issues = byFile.get(relFilePath);

    let originalContent;
    try {
      const stat = fs.statSync(absolutePath);
      if (stat.size > MAX_FILE_BYTES) {
        errorStrings.push(`\`${relFilePath}\` — skipped (file too large: ${stat.size} bytes)`);
        continue;
      }
      originalContent = fs.readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      errorStrings.push(`\`${relFilePath}\` — could not read: ${err.message}`);
      continue;
    }

    const askClaude = async (currentIssues) => {
      const prompt = _buildFixPrompt(conventionsHeader, relFilePath, originalContent, currentIssues);
      let response = await _call(
        apiKey, MODEL,
        'Return only the complete fixed file content. No explanations. No markdown fences.',
        prompt,
      );
      return response.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    };

    let loopResult;
    try {
      loopResult = await attemptFixWithRetries({
        askClaude,
        validateFix: _validateFix,
        verifyFixQuality: _verifyFixQuality,
        originalContent,
        filePath: relFilePath,
        issues,
        maxAttempts,
      });
    } catch (err) {
      errorStrings.push(`\`${relFilePath}\` — fix loop error: ${err.message || String(err)}`);
      continue;
    }

    attemptHistoryByFile[relFilePath] = { success: loopResult.success, attempts: loopResult.attempts };

    if (loopResult.success && loopResult.fixed) {
      fixedEntries.push({ file: relFilePath, original: originalContent, fixed: loopResult.fixed, issues });
    } else {
      errorStrings.push(`\`${relFilePath}\` — ${loopResult.finalReason || 'fix failed'}`);
    }
  }

  // Syntax gate — rejects JS/JSON fixes that don't parse; TS/TSX pass-through
  const syntaxGate = validateFixesSyntax({ fixes: fixedEntries });
  const accepted = syntaxGate.accepted || [];
  for (const rej of syntaxGate.rejected || []) {
    errorStrings.push(`\`${rej.file}\` — syntax gate rejected: ${rej.reason}`);
  }

  // Test generation — regression tests for every gate-passed fix
  const askClaudeForTest = async (prompt) =>
    _call(apiKey, MODEL, 'Return only the test file content. No explanations.', prompt);

  let testGenResult = { tests: [], skipped: [], summary: 'test generation: not run' };
  try {
    testGenResult = await generateTestsForFixes({ fixes: accepted, askClaudeForTest });
  } catch { /* non-blocking — test gen failure never blocks the fix from shipping */ }

  // Combined fixes list for pr-composer
  const allFixes = [
    ...accepted,
    ...testGenResult.tests.map((t) => ({
      file: t.path,
      original: '',
      fixed: t.content,
      issues: [`Regression test for ${t.sourceFile}`],
    })),
  ];

  const prBody = composePrBody({
    fixes: allFixes,
    errors: errorStrings,
    attemptHistoryByFile,
    syntaxGate,
    testGen: testGenResult,
  });

  return {
    accepted,
    testFiles: testGenResult.tests,
    allFixes,
    errorStrings,
    attemptHistoryByFile,
    syntaxGate,
    testGenResult,
    prBody,
  };
}

module.exports = { runFixOrchestration };
