/**
 * AI Guardrails Module.
 *
 * Dynamic / behavioural testing of customer LLM endpoints. Sends adversarial
 * prompts (jailbreaks, injection, PII probes, etc.), scores each response,
 * surfaces guardrail failures.
 *
 * NOT a static scanner — `promptSafety` covers the static config-and-code slice.
 * This module is no-op when no endpoint is configured (Quick / Full tier
 * customers don't see noise from a module that requires their LLM URL).
 *
 * Configuration (one of):
 *   - env GATETEST_AI_GUARDRAILS_ENDPOINT
 *   - .gatetest/config.json → modules.aiGuardrails.endpoint
 *
 * Full config shape lives in probe.js docstring.
 */

'use strict';

const BaseModule = require('./base-module');
const { getAllScenarios, CATEGORIES } = require('./ai-guardrails/scenarios');
const { scoreResponse, aggregateResults } = require('./ai-guardrails/scoring');
const { probe } = require('./ai-guardrails/probe');

const MAX_PARALLEL_PROBES = 4; // bounded fan-out so we don't DDOS the customer endpoint

class AiGuardrailsModule extends BaseModule {
  constructor() {
    super('aiGuardrails', 'AI Guardrails — adversarial LLM testing');
  }

  async run(result, config) {
    const moduleCfg = (config && typeof config.getModuleConfig === 'function')
      ? config.getModuleConfig('aiGuardrails') || {}
      : {};

    // Endpoint resolution: env → config → no-op.
    const endpoint = process.env.GATETEST_AI_GUARDRAILS_ENDPOINT || moduleCfg.endpoint;
    if (!endpoint) {
      result.addCheck('ai-guardrails:config', true, {
        message:
          'No LLM endpoint configured — set GATETEST_AI_GUARDRAILS_ENDPOINT or ' +
          'modules.aiGuardrails.endpoint in .gatetest/config.json',
      });
      return;
    }

    const customerConfig = {
      endpoint,
      method: moduleCfg.method,
      headers: moduleCfg.headers,
      requestTemplate: moduleCfg.requestTemplate,
      responsePath: moduleCfg.responsePath,
      timeoutMs: moduleCfg.timeoutMs,
    };

    // Scenario selection — customer can restrict categories or pass their own
    // augmented scenarios. Default: all 30 bundled scenarios.
    const filterCategories = Array.isArray(moduleCfg.categories) && moduleCfg.categories.length > 0
      ? new Set(moduleCfg.categories.filter((c) => CATEGORIES.includes(c)))
      : null;

    const customerScenarios = Array.isArray(moduleCfg.scenarios) ? moduleCfg.scenarios : [];
    const baseScenarios = getAllScenarios();
    const scenarios = baseScenarios
      .concat(customerScenarios)
      .filter((s) => !filterCategories || filterCategories.has(s.category));

    if (scenarios.length === 0) {
      result.addCheck('ai-guardrails:no-scenarios', true, {
        message: 'No scenarios matched the configured category filter',
      });
      return;
    }

    // Run scenarios in a bounded-concurrency loop.
    const results = await this._runAll(scenarios, customerConfig);
    const aggregates = aggregateResults(results);

    // Per-scenario findings — only surface bypassed + error cases. Held cases
    // are summarised in the aggregate, not as N successful checks.
    for (const r of results) {
      if (r.verdict === 'held') continue;
      if (r.verdict === 'error') {
        result.addCheck(`ai-guardrails:probe-error:${r.id}`, true, {
          message: `${r.title}: ${r.errorCode || 'unknown error'}`,
          severity: 'warning',
        });
        continue;
      }
      const isBypassed = r.verdict === 'bypassed';
      const severity = isBypassed
        ? (r.severity === 'error' ? 'error' : 'warning')
        : 'warning';
      result.addCheck(`ai-guardrails:${r.verdict}:${r.id}`, false, {
        severity,
        message: `${r.title} — verdict: ${r.verdict}`,
        detail:
          `Category: ${r.category}\n` +
          `Scenario severity: ${r.severity}\n` +
          `Response (first 500 chars):\n${(r.responseText || '').slice(0, 500)}`,
        suggestion: this._suggestionFor(r.category),
      });
    }

    // Aggregate summary — always emitted, even if all held.
    const summaryParts = [];
    for (const cat of CATEGORIES) {
      const agg = aggregates[cat];
      if (!agg || agg.total === 0) continue;
      summaryParts.push(`${cat}: ${agg.passRate}% held (${agg.held}/${agg.total - agg.error}, ${agg.bypassed} bypass, ${agg.ambiguous} ambig, ${agg.error} err)`);
    }
    result.addCheck('ai-guardrails:summary', true, {
      message: `Ran ${results.length} scenarios across ${Object.keys(aggregates).length} categories`,
      detail: summaryParts.join('\n'),
    });
  }

  async _runAll(scenarios, customerConfig) {
    const results = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_PROBES, scenarios.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= scenarios.length) break;
        const s = scenarios[idx];
        try {
          const r = await probe(s, customerConfig);
          if (!r.ok) {
            results.push({
              id: s.id,
              title: s.title,
              category: s.category,
              severity: s.severity,
              verdict: 'error',
              errorCode: r.errorCode,
              responseText: null,
              durationMs: r.durationMs,
            });
          } else {
            const verdict = scoreResponse(r.responseText, s);
            results.push({
              id: s.id,
              title: s.title,
              category: s.category,
              severity: s.severity,
              verdict,
              errorCode: null,
              responseText: r.responseText,
              durationMs: r.durationMs,
            });
          }
        } catch (err) {
          // _runAll itself must never throw — the probe wraps errors, but
          // belt-and-braces: catch anything residual.
          results.push({
            id: s.id,
            title: s.title,
            category: s.category,
            severity: s.severity,
            verdict: 'error',
            errorCode: 'unexpected-throw',
            errorMessage: err && err.message ? String(err.message).slice(0, 500) : null,
            responseText: null,
            durationMs: 0,
          });
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  _suggestionFor(category) {
    const map = {
      jailbreak: 'Strengthen the system prompt with explicit refusal anchors; consider Lakera Guard / LLM Guard / Rebuff at the API layer.',
      prompt_injection: 'Sanitise tool outputs / user-fetched content; wrap user content in a strict delimiter the model is told not to obey.',
      pii_leak: 'Move secrets out of the system prompt entirely; serve via authenticated tool calls instead.',
      hallucination: 'Constrain the model to a known-answer set; reply "I don\'t know" when context is missing.',
      topic_constraint: 'Add explicit topic blacklist to the system prompt; consider a moderation pre-filter.',
      schema_integrity: 'Use JSON mode / structured-output API; validate every response against the schema, retry on failure.',
      tool_exfil: 'Allowlist tool-target URLs; never let the model fetch attacker-controlled hosts.',
      cost_control: 'Set a hard max_tokens cap server-side; reject prompts that ask for unbounded output.',
    };
    return map[category] || 'Review and tighten the system prompt + add server-side validation.';
  }
}

module.exports = AiGuardrailsModule;
