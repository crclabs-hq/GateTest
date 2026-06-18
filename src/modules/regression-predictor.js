/**
 * Regression Predictor — AI predicts which files this PR is most likely to break.
 *
 * Uses git history + change coupling analysis + Claude reasoning to predict
 * the blast radius of the current diff. Outputs a risk map: which files are
 * most likely to regress and why.
 *
 * Algorithm:
 *   1. Get changed files in the diff.
 *   2. Analyse git log to find files that have historically changed together
 *      with the changed files (co-change coupling).
 *   3. Identify test files that cover the changed modules.
 *   4. Send the coupling data + diff summary to Claude for risk ranking.
 *   5. Report high-risk files as warnings with targeted test suggestions.
 *
 * This is the "regression prediction" feature no competitor has: not just
 * "here are the changed files" but "here are the files you didn't change
 * that are most likely to break."
 */

'use strict';

const { execSync } = require('child_process');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const BaseModule = require('./base-module');

const ANTHROPIC_HOST = 'api.anthropic.com';
const MODEL          = 'claude-sonnet-4-6';
const TIMEOUT_MS     = 45_000;

function callAnthropic(apiKey, systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
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

    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function safeExec(cmd, cwd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return ''; }
}

// ─── co-change coupling ────────────────────────────────────────────────────

function getCoChangedFiles(changedFiles, projectRoot, lookback = 50) {
  const coupling = new Map(); // file → count

  for (const file of changedFiles.slice(0, 10)) { // cap to 10 files
    const log = safeExec(
      `git log --format="%H" --follow -n ${lookback} -- "${file}"`,
      projectRoot
    );
    const commits = log.split('\n').filter(Boolean);

    for (const commit of commits.slice(0, lookback)) {
      const filesInCommit = safeExec(
        `git diff-tree --no-commit-id -r --name-only "${commit}"`,
        projectRoot
      ).split('\n').filter(Boolean);

      for (const f of filesInCommit) {
        if (changedFiles.includes(f)) continue;
        coupling.set(f, (coupling.get(f) || 0) + 1);
      }
    }
  }

  return [...coupling.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([file, count]) => ({ file, count }));
}

// ─── test file finder ─────────────────────────────────────────────────────

function findTestsForFiles(files, projectRoot) {
  const testFiles = [];
  for (const file of files) {
    const base     = path.basename(file, path.extname(file));
    const dir      = path.dirname(file);
    const candidates = [
      path.join(dir, `${base}.test.ts`),
      path.join(dir, `${base}.test.js`),
      path.join(dir, `${base}.spec.ts`),
      path.join(dir, `${base}.spec.js`),
      path.join(dir, '__tests__', `${base}.test.ts`),
      path.join(dir, '__tests__', `${base}.test.js`),
      path.join(projectRoot, 'tests', `${base}.test.js`),
    ];

    for (const c of candidates) {
      if (fs.existsSync(path.join(projectRoot, c))) {
        testFiles.push(c);
        break;
      }
      if (fs.existsSync(c)) {
        testFiles.push(path.relative(projectRoot, c));
        break;
      }
    }
  }
  return testFiles;
}

// ─── module ────────────────────────────────────────────────────────────────

class RegressionPredictor extends BaseModule {
  constructor() {
    super('regressionPredictor', 'Regression Predictor — AI predicts which files this PR is most likely to break');
  }

  async run(result, config) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      result.addCheck('regression-predictor:no-key', true, {
        severity: 'info',
        message: 'Regression prediction skipped — set ANTHROPIC_API_KEY to enable',
      });
      return;
    }

    const projectRoot = config.projectRoot;

    // Get changed files
    let changedFiles = safeExec('git diff --name-only HEAD~1..HEAD', projectRoot).split('\n').filter(Boolean);
    if (!changedFiles.length) {
      changedFiles = safeExec('git diff --name-only --staged', projectRoot).split('\n').filter(Boolean);
    }

    if (!changedFiles.length) {
      result.addCheck('regression-predictor:no-changes', true, {
        severity: 'info',
        message: 'No changed files found — regression prediction skipped',
      });
      return;
    }

    result.addCheck('regression-predictor:running', true, {
      severity: 'info',
      message: `Predicting regression risk for ${changedFiles.length} changed file(s)...`,
    });

    // Get co-change coupling
    const coupled = getCoChangedFiles(changedFiles, projectRoot);

    // Find missing test coverage
    const missingTests = changedFiles.filter(f => {
      const tests = findTestsForFiles([f], projectRoot);
      return tests.length === 0 && (f.endsWith('.ts') || f.endsWith('.js')) && !f.includes('.test.') && !f.includes('.spec.');
    });

    // Build diff summary (light — just filenames + stat)
    const diffStat = safeExec('git diff --stat HEAD~1..HEAD', projectRoot) ||
                     safeExec('git diff --stat --staged', projectRoot);

    try {
      const systemPrompt = `You are a senior software engineer doing regression risk analysis. You output JSON only. Be concise and precise.`;

      const userMessage = `Changed files in this PR:
${changedFiles.join('\n')}

Files that historically change together with the above (co-change coupling):
${coupled.slice(0, 15).map(c => `${c.file} (co-changed ${c.count}x)`).join('\n') || 'none found'}

Changed files with no test coverage:
${missingTests.join('\n') || 'none'}

Diff stat summary:
${diffStat.slice(0, 1000)}

Return ONLY valid JSON:
{
  "risk_level": "low | medium | high",
  "top_risk_files": [
    {
      "file": "path/to/file",
      "risk": "low | medium | high",
      "reason": "brief explanation (max 20 words)"
    }
  ],
  "test_gaps": ["files that need tests but don't have them"],
  "summary": "one sentence: overall risk assessment"
}

Limit top_risk_files to 8 entries. Focus on files not in the diff that are likely affected.`;

      const responseText = await callAnthropic(apiKey, systemPrompt, userMessage);

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      const analysis = JSON.parse(jsonMatch[0]);

      const riskSeverity = { low: 'info', medium: 'warning', high: 'error' };

      result.addCheck('regression-predictor:summary', analysis.risk_level === 'low', {
        severity: riskSeverity[analysis.risk_level] || 'info',
        message: `Regression risk: ${analysis.risk_level?.toUpperCase()} — ${analysis.summary}`,
      });

      for (const riskFile of (analysis.top_risk_files || []).slice(0, 8)) {
        const isHigh = riskFile.risk === 'high';
        result.addCheck(`regression-predictor:risk:${riskFile.file}`, !isHigh, {
          severity: riskSeverity[riskFile.risk] || 'info',
          message: `Risk file \`${riskFile.file}\`: ${riskFile.reason}`,
          fix: `Add/update tests for \`${riskFile.file}\` before merging this PR.`,
        });
      }

      for (const gapFile of (analysis.test_gaps || missingTests).slice(0, 5)) {
        result.addCheck(`regression-predictor:test-gap:${gapFile}`, false, {
          severity: 'warning',
          message: `Changed file \`${gapFile}\` has no test coverage`,
          fix: `Add tests for \`${gapFile}\` to prevent regressions.`,
        });
      }

    } catch (err) {
      result.addCheck('regression-predictor:error', true, {
        severity: 'info',
        message: `Regression prediction failed: ${err.message}`,
      });
    }
  }
}

module.exports = RegressionPredictor;
