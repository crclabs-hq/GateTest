/**
 * Agentic Exploration Module — the feature no competitor has.
 *
 * An AI agent that reads codebase memory, picks areas to investigate based
 * on what history shows, and finds bugs no fixed ruleset describes.
 *
 * Contrast with aiReview:
 *   - aiReview sends a batch of recently-changed files and asks for issues.
 *   - agentic uses MEMORY to decide WHAT to look at. It's hypothesis-driven.
 *
 * Requires ANTHROPIC_API_KEY. Gracefully skips when not configured.
 *
 * Two-phase flow:
 *   Phase 1 (plan): Claude returns a list of up to 3 "investigations" —
 *                   each is a file path + a specific hypothesis/question.
 *   Phase 2 (execute): For each investigation, send the file + the
 *                      hypothesis and ask Claude to find ONLY issues
 *                      relevant to that hypothesis.
 *
 * This keeps total token cost bounded (1 plan call + up to 3 execute calls)
 * while producing findings that are deeper than any one-shot review.
 *
 * TODO(gluecron): once Gluecron exposes commit-authorship metadata, feed
 * "riskiest authors / hottest files" into the plan prompt.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ANTHROPIC_API_HOST = 'api.anthropic.com';
const MODEL = 'claude-sonnet-4-6';
const MAX_INVESTIGATIONS = 3;
const MAX_FILE_SIZE = 40000;
const TIMEOUT_MS = 45000;

class AgenticModule extends BaseModule {
  constructor() {
    super('agentic', 'Agentic Exploration — memory-driven AI investigation');
  }

  async run(result, config) {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      result.addCheck('agentic:not-configured', true, {
        severity: 'info',
        message: 'Agentic exploration skipped — set ANTHROPIC_API_KEY to enable',
      });
      return;
    }

    const memory = config._memory;
    if (!memory) {
      result.addCheck('agentic:no-memory', true, {
        severity: 'info',
        message: 'Agentic skipped — memory module must run first',
      });
      return;
    }

    const projectRoot = config.projectRoot;
    const sourceFiles = this._listSourceFiles(projectRoot).slice(0, 50);
    if (sourceFiles.length === 0) {
      result.addCheck('agentic:no-source', true, {
        severity: 'info',
        message: 'Agentic skipped — no source files found',
      });
      return;
    }

    result.addCheck('agentic:planning', true, {
      severity: 'info',
      message: `Agentic planning investigation across ${sourceFiles.length} file(s)...`,
    });

    let plan;
    try {
      plan = await this._planInvestigations(apiKey, memory, sourceFiles, projectRoot);
    } catch (err) {
      result.addCheck('agentic:plan-error', false, {
        severity: 'warning',
        message: `Agentic planning failed: ${err.message}`,
        suggestion: 'Verify ANTHROPIC_API_KEY and network access.',
      });
      return;
    }

    if (!plan.investigations || plan.investigations.length === 0) {
      result.addCheck('agentic:no-plan', true, {
        severity: 'info',
        message: plan.rationale || 'Agent found no hypotheses worth investigating.',
      });
      return;
    }

    const investigations = plan.investigations.slice(0, MAX_INVESTIGATIONS);
    result.addCheck('agentic:plan', true, {
      severity: 'info',
      message: `Agentic plan: ${investigations.length} investigation(s) — ${investigations.map((i) => i.file).join(', ')}`,
    });

    for (const inv of investigations) {
      await this._executeInvestigation(apiKey, inv, projectRoot, result);
    }

    result.addCheck('agentic:complete', true, {
      severity: 'info',
      message: `Agentic exploration complete — ${investigations.length} investigation(s) executed.`,
    });
  }

  _listSourceFiles(projectRoot) {
    const exts = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.rb', '.java', '.php'];
    return this._collectFiles(projectRoot, exts)
      .map((f) => path.relative(projectRoot, f))
      .filter((f) => !f.startsWith('.'));
  }

  async _planInvestigations(apiKey, memory, sourceFiles, projectRoot) {
    const fingerprint = memory.fingerprint || {};
    const recurring = memory.recurring || [];
    const scanCount = memory.previous?.scans?.totalScans || 0;

    const prompt = `You are the GateTest agentic investigator. Your job is to pick up to ${MAX_INVESTIGATIONS} targeted investigations that fixed-rule scanners would miss.

You have access to codebase memory:
- Languages detected: ${JSON.stringify(fingerprint.languages || {})}
- Frameworks hinted: ${JSON.stringify(fingerprint.frameworks || [])}
- Previous scans: ${scanCount}
- Recurring issues (${recurring.length}): ${JSON.stringify(recurring.slice(0, 10))}

Source files in this repo (${sourceFiles.length}):
${sourceFiles.slice(0, 50).map((f) => `  - ${f}`).join('\n')}

Pick up to ${MAX_INVESTIGATIONS} files where a focused, hypothesis-driven review would catch a bug. Prefer files that:
- Handle auth, payments, or external APIs
- Orchestrate state across multiple systems
- Appear related to recurring issues in memory
- Handle user input or untrusted data

Respond ONLY with JSON in this exact shape:
{
  "rationale": "One sentence explaining the overall strategy",
  "investigations": [
    { "file": "relative/path.ts", "hypothesis": "A specific testable hypothesis about a likely bug or weakness." }
  ]
}`;

    const raw = await this._callClaude(apiKey, prompt, 2048);
    return this._parseJsonResponse(raw) || { investigations: [] };
  }

  async _executeInvestigation(apiKey, investigation, projectRoot, result) {
    const absPath = path.join(projectRoot, investigation.file);
    if (!fs.existsSync(absPath)) {
      result.addCheck(`agentic:missing:${investigation.file}`, true, {
        severity: 'info',
        message: `Agentic: file disappeared before investigation — ${investigation.file}`,
      });
      return;
    }

    let content;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
      if (content.length > MAX_FILE_SIZE) {
        content = content.slice(0, MAX_FILE_SIZE) + '\n/* ...truncated... */';
      }
    } catch (err) {
      result.addCheck(`agentic:read-error:${investigation.file}`, false, {
        severity: 'warning',
        message: `Agentic could not read ${investigation.file}: ${err.message}`,
      });
      return;
    }

    const prompt = `You are investigating a specific hypothesis about a file.

HYPOTHESIS: ${investigation.hypothesis}

File: ${investigation.file}

${content}

Evaluate ONLY issues that relate to the hypothesis. Do NOT report general style or unrelated concerns.

Respond ONLY with JSON:
{
  "findings": [
    {
      "line": 42,
      "severity": "error|warning|info",
      "title": "Short description",
      "explanation": "Why this is a problem (tie it back to the hypothesis)",
      "suggestion": "How to fix it"
    }
  ],
  "verdict": "confirmed|refuted|partial"
}

If the hypothesis is refuted (no bug found), return findings: [] and verdict: "refuted".`;

    let raw;
    try {
      raw = await this._callClaude(apiKey, prompt, 2048);
    } catch (err) {
      result.addCheck(`agentic:api-error:${investigation.file}`, false, {
        severity: 'warning',
        message: `Agentic call failed for ${investigation.file}: ${err.message}`,
      });
      return;
    }

    const parsed = this._parseJsonResponse(raw) || { findings: [], verdict: 'error' };
    const findings = parsed.findings || [];

    result.addCheck(`agentic:verdict:${investigation.file}`, true, {
      severity: 'info',
      message: `Agentic [${parsed.verdict || 'unknown'}]: ${investigation.file} — ${investigation.hypothesis}`,
    });

    for (const finding of findings) {
      const severity = ['error', 'warning', 'info'].includes(finding.severity)
        ? finding.severity
        : 'warning';
      result.addCheck(`agentic:finding:${investigation.file}:${finding.line || 0}`, false, {
        file: investigation.file,
        line: finding.line,
        severity,
        message: `[Agentic] ${finding.title}`,
        explanation: finding.explanation,
        suggestion: finding.suggestion,
      });
    }
  }

  _parseJsonResponse(text) {
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }

  _callClaude(apiKey, prompt, maxTokens) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });

      const req = https.request(
        {
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
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            try {
              const response = JSON.parse(raw);
              if (res.statusCode !== 200) {
                reject(new Error(`API ${res.statusCode}: ${response.error?.message || raw}`));
                return;
              }
              resolve(response.content?.[0]?.text || '');
            } catch (err) {
              reject(new Error(`Parse error: ${err.message}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.setTimeout(TIMEOUT_MS, () => {
        req.destroy();
        reject(new Error(`Agentic call timed out after ${TIMEOUT_MS}ms`));
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = AgenticModule;
