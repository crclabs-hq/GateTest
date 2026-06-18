/**
 * AI Code Review Module — The feature no competitor has.
 *
 * Uses Claude API to perform intelligent code review on changed files.
 * This isn't pattern matching. This is an AI that understands your code,
 * finds real bugs, suggests fixes, and explains WHY something is wrong.
 *
 * Requires: ANTHROPIC_API_KEY environment variable.
 * When not configured, gracefully skips with an info message.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ANTHROPIC_API_HOST = 'api.anthropic.com';
const MODEL = 'claude-sonnet-4-6';
const MAX_FILES_PER_REVIEW = 10;
const MAX_FILE_SIZE = 50000; // 50KB per file

class AiReviewModule extends BaseModule {
  constructor() {
    super('aiReview', 'AI-Powered Code Review');
  }

  async run(result, config) {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      result.addCheck('ai-review:not-configured', true, {
        severity: 'info',
        message: 'AI code review skipped — set ANTHROPIC_API_KEY to enable',
      });
      return;
    }

    const projectRoot = config.projectRoot;
    this._lastProjectRoot = projectRoot;
    const runnerOptions = config._runnerOptions || {};
    // Memory context (attached by the memory module when it runs first).
    // This is the compounding moat: Claude gets smarter context every scan.
    const memory = config._memory || null;

    // Get files to review
    let filesToReview;
    if (runnerOptions.diffOnly && runnerOptions.changedFiles) {
      filesToReview = runnerOptions.changedFiles
        .filter(f => this._isReviewableFile(f))
        .map(f => path.join(projectRoot, f));
    } else {
      // Review recent git changes or sample source files
      filesToReview = this._getRecentChanges(projectRoot);
    }

    if (filesToReview.length === 0) {
      result.addCheck('ai-review:no-files', true, {
        severity: 'info',
        message: 'No files to review',
      });
      return;
    }

    // Limit to MAX_FILES_PER_REVIEW
    const reviewBatch = filesToReview.slice(0, MAX_FILES_PER_REVIEW);

    result.addCheck('ai-review:scanning', true, {
      severity: 'info',
      message: `AI reviewing ${reviewBatch.length} file(s)...`,
    });

    // Build review payload
    const fileContents = [];
    for (const file of reviewBatch) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.length > MAX_FILE_SIZE) continue;
        const relPath = path.relative(projectRoot, file);
        fileContents.push({ path: relPath, content });
      } catch { /* skip unreadable */ }
    }

    if (fileContents.length === 0) {
      result.addCheck('ai-review:empty', true, {
        severity: 'info',
        message: 'No reviewable file content found',
      });
      return;
    }

    try {
      const review = await this._callClaude(apiKey, fileContents, memory);
      this._processReview(review, result, memory);
    } catch (err) {
      result.addCheck('ai-review:error', false, {
        severity: 'warning',
        message: `AI review failed: ${err.message}`,
        suggestion: 'Check ANTHROPIC_API_KEY is valid and has available credits',
      });
    }
  }

  /**
   * Build a compact memory-context block the prompt can condition on.
   * Keeps token usage bounded while giving Claude real codebase context.
   */
  _buildMemoryContext(memory) {
    if (!memory) return '';

    const lines = [];
    const fp = memory.fingerprint || {};
    const langs = Object.keys(fp.languages || {}).join(', ') || 'unknown';
    const frameworks = (fp.frameworks || []).join(', ') || 'none detected';
    lines.push(`Stack: languages=[${langs}], frameworks=[${frameworks}]`);

    const scanCount = memory.previous?.scans?.totalScans || 0;
    if (scanCount > 0) lines.push(`Scan history: ${scanCount} previous scan(s)`);

    const recurring = (memory.recurring || []).slice(0, 8);
    if (recurring.length > 0) {
      lines.push(`Recurring issues already tracked (do NOT re-flag these — they are known):`);
      for (const r of recurring) {
        lines.push(`  - ${r.key} (seen ${r.count}x)`);
      }
    }

    const fps = memory.previous?.falsePositives || {};
    const fpKeys = Object.keys(fps).slice(0, 8);
    if (fpKeys.length > 0) {
      lines.push(`Known false positives (never flag these):`);
      for (const k of fpKeys) lines.push(`  - ${k}`);
    }

    // Fix patterns: tell Claude what GateTest has already auto-fixed here.
    // This lets Claude suggest the same kind of fix for matching issues
    // rather than inventing a new approach each scan.
    const topFixPatterns = memory.topFixPatterns || [];
    if (topFixPatterns.length > 0) {
      lines.push(`Known fix patterns (GateTest has auto-fixed these before — prefer matching strategies):`);
      for (const p of topFixPatterns.slice(0, 5)) {
        const desc = p.lastDescription ? ` — "${p.lastDescription}"` : '';
        lines.push(`  - ${p.key} (fixed ${p.count}x)${desc}`);
      }
    }

    return lines.length > 0
      ? `\n## CODEBASE MEMORY\n${lines.join('\n')}\n\nUse this context to:\n- Skip issues already in the recurring list (they're tracked elsewhere).\n- Tailor suggestions to the detected stack.\n- Never suggest fixes that match known false positives.\n- When an issue matches a known fix pattern, propose a fix consistent with the prior fix.\n`
      : '';
  }

  async _callClaude(apiKey, files, memory) {
    const filesText = files.map(f =>
      `--- ${f.path} ---\n${f.content}\n`
    ).join('\n');

    const memoryContext = this._buildMemoryContext(memory);

    const prompt = `You are a senior code reviewer for GateTest, the most advanced QA system available. Review the following source files and find REAL bugs, security issues, performance problems, and quality concerns.${memoryContext}

For each issue found, respond in this exact JSON format:
{
  "issues": [
    {
      "file": "path/to/file.js",
      "line": 42,
      "severity": "error|warning|info",
      "category": "security|performance|bug|quality|accessibility",
      "title": "Short description",
      "explanation": "Why this is a problem",
      "suggestion": "How to fix it",
      "fixedCode": "The corrected code (if applicable, just the relevant lines)"
    }
  ],
  "summary": "One paragraph overall assessment"
}

Rules:
- Only report REAL issues. No style nitpicks. No subjective preferences.
- Security issues are always severity "error"
- Bugs that cause incorrect behavior are severity "error"
- Performance issues are severity "warning"
- Minor quality improvements are severity "info"
- If the code is clean, return an empty issues array
- Be specific about line numbers

Files to review:

${filesText}`;

    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const options = {
        hostname: ANTHROPIC_API_HOST,
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            const response = JSON.parse(raw);

            if (res.statusCode !== 200) {
              reject(new Error(`API returned ${res.statusCode}: ${response.error?.message || raw}`));
              return;
            }

            const text = response.content?.[0]?.text || '';

            // Extract JSON from response (Claude may wrap it in markdown)
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              resolve(JSON.parse(jsonMatch[0]));
            } else {
              resolve({ issues: [], summary: text });
            }
          } catch (err) {
            reject(new Error(`Failed to parse AI response: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(60000, () => {
        req.destroy();
        reject(new Error('AI review timed out after 60s'));
      });

      req.write(body);
      req.end();
    });
  }

  _processReview(review, result, memory) {
    if (!review || !review.issues) {
      result.addCheck('ai-review:complete', true, {
        severity: 'info',
        message: 'AI review complete — no issues found',
      });
      return;
    }

    const issues = review.issues;

    if (issues.length === 0) {
      result.addCheck('ai-review:clean', true, {
        severity: 'info',
        message: `AI review complete — code looks clean. ${review.summary || ''}`,
      });
      return;
    }

    // Convert AI findings to GateTest checks — but honour memory's
    // recorded false positives so we don't re-flag dismissed issues.
    const store = memory?.store;
    let filtered = 0;
    for (const issue of issues) {
      if (store) {
        const key = `ai-review:${issue.category || 'quality'}:${issue.file}:${issue.line || 0}`;
        if (store.isFalsePositive(key)) {
          filtered += 1;
          continue;
        }
      }
      const severity = ['error', 'warning', 'info'].includes(issue.severity)
        ? issue.severity : 'warning';

      const checkDetails = {
        file: issue.file,
        line: issue.line,
        severity,
        message: `[AI] ${issue.title}`,
        suggestion: issue.suggestion,
        explanation: issue.explanation,
        fixedCode: issue.fixedCode,
      };

      // Wire up auto-fix: if Claude returned fixedCode, apply it to the file
      if (issue.fixedCode && issue.file && issue.line) {
        const filePath = issue.file;
        const lineNum = issue.line;
        const fixed = issue.fixedCode;
        const projectRoot = this._lastProjectRoot;
        checkDetails.autoFix = () => this._applyFix(projectRoot, filePath, lineNum, fixed);
      }

      result.addCheck(`ai-review:${issue.category || 'quality'}:${issue.file}:${issue.line || 0}`, false, checkDetails);
    }

    // Summary
    if (review.summary) {
      result.addCheck('ai-review:summary', true, {
        severity: 'info',
        message: `AI Review: ${review.summary}`,
      });
    }

    const reportedCount = issues.length - filtered;
    const filteredMsg = filtered > 0 ? ` (${filtered} filtered by memory as known false positives)` : '';
    result.addCheck('ai-review:complete', true, {
      severity: 'info',
      message: `AI found ${reportedCount} issue(s) across reviewed files${filteredMsg}`,
    });
  }

  /**
   * Apply Claude's fixedCode to the source file.
   * Replaces lines around the issue location with the AI-generated fix.
   */
  _applyFix(projectRoot, relPath, lineNum, fixedCode) {
    try {
      const absPath = path.join(projectRoot, relPath);
      if (!fs.existsSync(absPath)) return { fixed: false };

      const content = fs.readFileSync(absPath, 'utf-8');
      const lines = content.split('\n');
      const fixLines = fixedCode.split('\n');
      const idx = lineNum - 1;

      if (idx < 0 || idx >= lines.length) return { fixed: false };

      // Replace the target line(s) with the fix.
      // If the fix is multi-line, replace the same number of lines from the
      // original, or just replace the single target line if we can't be sure.
      const replaceCount = Math.min(fixLines.length, lines.length - idx);
      lines.splice(idx, replaceCount, ...fixLines);

      fs.writeFileSync(absPath, lines.join('\n'), 'utf-8');
      return {
        fixed: true,
        description: `AI fix applied to ${relPath}:${lineNum}`,
        filesChanged: [relPath],
      };
    } catch {
      return { fixed: false };
    }
  }

  _isReviewableFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const reviewable = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.rb', '.rs', '.php'];
    return reviewable.includes(ext);
  }

  _getRecentChanges(projectRoot) {
    try {
      const { stdout } = this._exec('git diff --name-only HEAD~5 2>/dev/null || git diff --name-only HEAD 2>/dev/null', {
        cwd: projectRoot,
      });

      return stdout.trim().split('\n')
        .filter(f => f && this._isReviewableFile(f))
        .map(f => path.join(projectRoot, f))
        .filter(f => fs.existsSync(f));
    } catch {
      // Not a git repo or no commits — review all source files
      return this._collectFiles(projectRoot, ['.js', '.ts', '.jsx', '.tsx']).slice(0, MAX_FILES_PER_REVIEW);
    }
  }
}

module.exports = AiReviewModule;
