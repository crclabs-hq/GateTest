/**
 * Intent Verification — AI verifies code does what the PR description claims.
 *
 * The most common source of production bugs is not technical complexity —
 * it's the gap between intent and implementation. A developer (or AI agent)
 * writes "Fix null check in payment flow" but the diff actually changes an
 * unrelated timeout. This module uses Claude to audit that gap.
 *
 * Process:
 *   1. Get the git diff (staged or HEAD~1..HEAD).
 *   2. Get the commit message / PR description.
 *   3. Ask Claude: "Does this diff implement what the message claims?
 *      List any code changes not mentioned in the message, and any claims
 *      in the message not reflected in the diff."
 *   4. Flag discrepancies as warnings (not errors — intent drift is not
 *      always wrong, but it should be visible).
 *
 * Requires: ANTHROPIC_API_KEY.
 * No-op when no diff is available or no commit message.
 */

'use strict';

const { execSync } = require('child_process');
const https = require('https');
const BaseModule = require('./base-module');

const ANTHROPIC_HOST = 'api.anthropic.com';
const MODEL          = 'claude-sonnet-4-6';
const MAX_DIFF_SIZE  = 80_000; // 80 KB cap
const TIMEOUT_MS     = 45_000;

function callAnthropic(apiKey, messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
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
    return execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { return ''; }
}

// ─── module ────────────────────────────────────────────────────────────────

class IntentVerification extends BaseModule {
  constructor() {
    super('intentVerification', 'Intent Verification — AI checks that the diff matches the commit message / PR description');
  }

  async run(result, config) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      result.addCheck('intent-verification:no-key', true, {
        severity: 'info',
        message: 'Intent verification skipped — set ANTHROPIC_API_KEY to enable',
      });
      return;
    }

    const projectRoot = config.projectRoot;

    // Get diff
    let diff = safeExec('git diff HEAD~1..HEAD', projectRoot);
    if (!diff) diff = safeExec('git diff --staged', projectRoot);
    if (!diff) diff = safeExec('git diff HEAD', projectRoot);

    if (!diff || diff.trim().length < 50) {
      result.addCheck('intent-verification:no-diff', true, {
        severity: 'info',
        message: 'No git diff found — intent verification skipped',
      });
      return;
    }

    // Get commit message
    let commitMsg = safeExec('git log -1 --format=%B', projectRoot).trim();
    if (!commitMsg || commitMsg.length < 5) {
      result.addCheck('intent-verification:no-message', true, {
        severity: 'info',
        message: 'No commit message found — intent verification skipped',
      });
      return;
    }

    // Cap diff size
    if (diff.length > MAX_DIFF_SIZE) {
      diff = diff.slice(0, MAX_DIFF_SIZE) + '\n... (diff truncated)';
    }

    result.addCheck('intent-verification:running', true, {
      severity: 'info',
      message: `Verifying intent: "${commitMsg.split('\n')[0].slice(0, 80)}"`,
    });

    try {
      const systemPrompt = `You are a senior code reviewer specialising in intent-vs-implementation audits. You are precise, brief, and honest. You output JSON only.`;

      const userMessage = `Commit message:
"${commitMsg}"

Git diff (${diff.length} chars):
\`\`\`diff
${diff}
\`\`\`

Analyse whether the diff implements what the commit message claims.

Return ONLY valid JSON:
{
  "aligned": true | false,
  "confidence": 0-100,
  "summary": "one sentence assessment",
  "unmentioned_changes": ["change in diff not mentioned in message", ...],
  "unimplemented_claims": ["claim in message with no corresponding diff change", ...],
  "risk_level": "low | medium | high"
}

Rules:
- Minor style/whitespace changes that the message doesn't mention are OK (don't flag).
- If the message is vague ("various fixes", "cleanup"), be lenient.
- Only flag substantive behavioural changes or missing implementations.`;

      const responseText = await callAnthropic(apiKey, [{ role: 'user', content: userMessage }], systemPrompt);

      // Extract JSON
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      const analysis = JSON.parse(jsonMatch[0]);

      if (!analysis.aligned) {
        const issues = [
          ...(analysis.unmentioned_changes || []).map(c => `Unmentioned: ${c}`),
          ...(analysis.unimplemented_claims || []).map(c => `Unimplemented: ${c}`),
        ];

        const severity = analysis.risk_level === 'high' ? 'error' : 'warning';

        result.addCheck('intent-verification:drift', false, {
          severity,
          message: `Intent drift detected (confidence: ${analysis.confidence}%): ${analysis.summary}`,
          details: issues,
          fix: `Update the commit message to accurately describe all changes, or revert changes unrelated to the stated intent.`,
        });

        for (const issue of issues.slice(0, 5)) {
          result.addCheck(`intent-verification:detail:${issue.slice(0, 40)}`, false, {
            severity: 'warning',
            message: issue,
          });
        }
      } else {
        result.addCheck('intent-verification:aligned', true, {
          severity: 'info',
          message: `Diff matches commit message (confidence: ${analysis.confidence}%): ${analysis.summary}`,
        });
      }
    } catch (err) {
      result.addCheck('intent-verification:error', true, {
        severity: 'info',
        message: `Intent verification failed: ${err.message}`,
      });
    }
  }
}

module.exports = IntentVerification;
