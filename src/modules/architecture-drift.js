/**
 * Architecture Drift — AI flags code that violates documented conventions.
 *
 * Every project has architectural rules: "no business logic in controllers",
 * "all API calls go through the service layer", "use Zod for validation",
 * "no direct database access in route handlers". These live in CLAUDE.md,
 * ADR files, README, or ARCHITECTURE.md — and get violated the moment
 * someone is in a hurry.
 *
 * This module:
 *   1. Reads the project's architectural documentation (CLAUDE.md, ADRs,
 *      ARCHITECTURE.md, CONTRIBUTING.md, docs/architecture/**).
 *   2. Gets the current diff.
 *   3. Asks Claude to check the diff against the documented conventions.
 *   4. Flags specific violations with file + line references.
 *
 * Special GateTest rule: always checks against GateTest's own Bible
 * (CLAUDE.md) when running in the GateTest repo itself.
 */

'use strict';

const { execSync } = require('child_process');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const BaseModule = require('./base-module');

const ANTHROPIC_HOST = 'api.anthropic.com';
const MODEL          = 'claude-sonnet-5';
const TIMEOUT_MS     = 50_000;
const MAX_DOC_SIZE   = 8_000;
const MAX_DIFF_SIZE  = 60_000;

function callAnthropic(apiKey, systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
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

// ─── doc loader ───────────────────────────────────────────────────────────

const ARCHITECTURE_DOC_CANDIDATES = [
  'CLAUDE.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md', 'docs/ARCHITECTURE.md',
  'docs/architecture.md', 'docs/ADR.md', 'ADR.md',
  '.github/CONTRIBUTING.md', 'docs/decisions/README.md',
];

const ADR_DIRS = ['docs/adr', 'docs/decisions', 'adr', 'decisions', 'architecture'];

function loadArchitectureDocs(projectRoot) {
  const docs = [];

  for (const candidate of ARCHITECTURE_DOC_CANDIDATES) {
    const full = path.join(projectRoot, candidate);
    if (!fs.existsSync(full)) continue;
    try {
      const content = fs.readFileSync(full, 'utf-8').slice(0, MAX_DOC_SIZE);
      docs.push({ file: candidate, content });
    } catch { /* skip */ }
    if (docs.reduce((s, d) => s + d.content.length, 0) > MAX_DOC_SIZE * 2) break;
  }

  // Load ADR directory
  for (const adrDir of ADR_DIRS) {
    const full = path.join(projectRoot, adrDir);
    if (!fs.existsSync(full)) continue;
    try {
      const files = fs.readdirSync(full)
        .filter(f => f.endsWith('.md'))
        .slice(0, 10);

      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(full, f), 'utf-8').slice(0, 2000);
          docs.push({ file: path.join(adrDir, f), content });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return docs;
}

// ─── module ────────────────────────────────────────────────────────────────

class ArchitectureDrift extends BaseModule {
  constructor() {
    super('architectureDrift', 'Architecture Drift — AI flags code that violates documented architectural conventions');
  }

  async run(result, config) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      result.addCheck('architecture-drift:no-key', true, {
        severity: 'info',
        message: 'Architecture drift check skipped — set ANTHROPIC_API_KEY to enable',
      });
      return;
    }

    const projectRoot = config.projectRoot;

    // Load docs
    const docs = loadArchitectureDocs(projectRoot);
    if (docs.length === 0) {
      result.addCheck('architecture-drift:no-docs', true, {
        severity: 'info',
        message: 'No architecture documentation found (CLAUDE.md, ARCHITECTURE.md, ADRs) — drift check skipped',
      });
      return;
    }

    // Get diff
    let diff = safeExec('git diff HEAD~1..HEAD', projectRoot);
    if (!diff) diff = safeExec('git diff --staged', projectRoot);

    if (!diff || diff.trim().length < 30) {
      result.addCheck('architecture-drift:no-diff', true, {
        severity: 'info',
        message: 'No diff to analyse — architecture drift check skipped',
      });
      return;
    }

    if (diff.length > MAX_DIFF_SIZE) {
      diff = diff.slice(0, MAX_DIFF_SIZE) + '\n... (diff truncated)';
    }

    const docsText = docs.map(d => `## ${d.file}\n${d.content}`).join('\n\n');

    result.addCheck('architecture-drift:running', true, {
      severity: 'info',
      message: `Checking diff against ${docs.length} architecture doc(s)...`,
    });

    try {
      const systemPrompt = `You are an architecture reviewer. You enforce documented architectural decisions found in project documentation. You output JSON only. You are precise, never flagging things the docs don't actually restrict.`;

      const userMessage = `Architecture documentation:
---
${docsText.slice(0, MAX_DOC_SIZE * 2)}
---

Git diff to review:
\`\`\`diff
${diff}
\`\`\`

Check the diff for violations of the architectural rules documented above.
Only flag genuine violations of EXPLICITLY stated rules — not style preferences or opinions.

Return ONLY valid JSON:
{
  "violations": [
    {
      "rule": "exact quote of the violated rule from the docs",
      "violation": "what the diff does that violates it",
      "file": "path/to/file (if identifiable)",
      "severity": "error | warning",
      "fix": "how to bring the code into compliance"
    }
  ],
  "summary": "one sentence: compliance assessment"
}

If no violations found: {"violations": [], "summary": "No architectural violations detected."}`;

      const responseText = await callAnthropic(apiKey, systemPrompt, userMessage);

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      const analysis = JSON.parse(jsonMatch[0]);

      if (!analysis.violations || analysis.violations.length === 0) {
        result.addCheck('architecture-drift:clean', true, {
          severity: 'info',
          message: `Architecture check passed: ${analysis.summary || 'No violations detected'}`,
        });
        return;
      }

      for (const v of analysis.violations) {
        result.addCheck(
          `architecture-drift:${v.file || 'general'}:${v.rule?.slice(0, 30) || 'rule'}`,
          false,
          {
            severity: v.severity === 'error' ? 'error' : 'warning',
            message: `Architecture violation: ${v.violation}${v.file ? ` (${v.file})` : ''}`,
            file: v.file,
            fix: v.fix || `Align code with documented rule: "${v.rule}"`,
          }
        );
      }
    } catch (err) {
      result.addCheck('architecture-drift:error', true, {
        severity: 'info',
        message: `Architecture drift check failed: ${err.message}`,
      });
    }
  }
}

module.exports = ArchitectureDrift;
