'use strict';
/**
 * Per-run AI spend tracker — engine-side twin of
 * website/app/lib/budget-tracker.js. Kept as a separate file because src/ is
 * CommonJS and cannot import from website/ (same constraint as
 * engine-models.js and anthropic-config.js). `tests/budget-tracker-engine-twin.test.js`
 * asserts the two price tables agree.
 *
 * Why the engine needs its own copy: the CLI, the local MCP server and the
 * editor extension all run fixes on the user's OWN provider key. Until this
 * file existed none of them could tell the user what a fix cost — the hosted
 * tracker lives in website/, which `package.json` `files` does not ship, so
 * every `npm i @gatetest/cli` had no price table at all. The extension's
 * "Fix This Finding (your own key)" command loads THIS file from whichever
 * engine it resolved and shows the estimate before, and the actual spend
 * after, every run.
 *
 * Scope is deliberately the in-process half only: pricing, a chars→tokens
 * estimate, a cap that aborts before the NEXT call, and a fix-cost estimator.
 * The hosted twin's tier caps and AsyncLocalStorage plumbing are hosted
 * concerns and are not mirrored here.
 */

// Per-model rates, USD per million tokens. Same numbers and the same env
// overrides as the hosted twin — the twin test pins them equal.
const INPUT_USD_PER_MTOK = Number(process.env.GATETEST_INPUT_USD_PER_MTOK) || 3;
const OUTPUT_USD_PER_MTOK = Number(process.env.GATETEST_OUTPUT_USD_PER_MTOK) || 15;

const MODEL_PRICING = Object.freeze({
  'claude-sonnet-5':   { input: INPUT_USD_PER_MTOK, output: OUTPUT_USD_PER_MTOK },
  'claude-sonnet-4-6': { input: INPUT_USD_PER_MTOK, output: OUTPUT_USD_PER_MTOK },
  'claude-fable-5':    { input: Number(process.env.GATETEST_FABLE_INPUT_USD_PER_MTOK) || 10,
                         output: Number(process.env.GATETEST_FABLE_OUTPUT_USD_PER_MTOK) || 50 },
  'claude-mythos-5':   { input: Number(process.env.GATETEST_FABLE_INPUT_USD_PER_MTOK) || 10,
                         output: Number(process.env.GATETEST_FABLE_OUTPUT_USD_PER_MTOK) || 50 },
  'claude-opus-5':     { input: 5, output: 25 },
  'claude-opus-4-8':   { input: 5, output: 25 },
  'claude-haiku-4-5':  { input: 1, output: 5 },
});

// Most expensive known rate — the fail-safe for unrecognised model ids. An
// unknown id is almost always a newer, pricier model; over-counting stops a
// run early, under-counting lets real spend run past the cap.
const MAX_KNOWN_PRICING = Object.values(MODEL_PRICING).reduce(
  (worst, rate) => (rate.output > worst.output ? rate : worst),
  { input: INPUT_USD_PER_MTOK, output: OUTPUT_USD_PER_MTOK },
);

/** @returns {{input: number, output: number}} USD per million tokens. */
function priceFor(model) {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  if (typeof model !== 'string' || !model.trim()) {
    return { input: INPUT_USD_PER_MTOK, output: OUTPUT_USD_PER_MTOK };
  }
  return MAX_KNOWN_PRICING;
}

/** True when the id has its own row — false means priceFor() returned the worst-case rate. */
function hasKnownPrice(model) {
  return Boolean(MODEL_PRICING[model]);
}

// Rough char-to-token ratio. Tokenizers average ~3.5-4 chars/token for
// English + code; 3.0 deliberately over-counts so the cap trips BEFORE the
// real ceiling is crossed.
const CHARS_PER_TOKEN = 3.0;

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

function usdFor(model, inputTokens, outputTokens) {
  const rate = priceFor(model);
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}

class BudgetTracker {
  constructor({ maxTokens = Infinity, maxUsd = Infinity, label = 'fix' } = {}) {
    this.maxTokens = maxTokens;
    this.maxUsd = maxUsd;
    this.label = label;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.spentUsd = 0; // accumulated per call at each call's own model rate
    this.callCount = 0;
    this.aborted = false;
    this.abortReason = null;
    this.startedAt = Date.now();
  }

  /**
   * Account for one provider call. `body` is the request body string,
   * `response` is `{ data }` where data is the parsed response (or null if
   * the call threw). Exact `usage` counts are used when present; otherwise
   * the tokens are estimated from the char lengths and `exact` is false.
   */
  record(body, response, model) {
    this.callCount += 1;
    const usage = response && response.data && response.data.usage;
    let callIn;
    let callOut;
    let exact = false;
    if (usage && typeof usage.output_tokens === 'number') {
      callIn = usage.input_tokens || estimateTokens(body);
      callOut = usage.output_tokens;
      exact = typeof usage.input_tokens === 'number';
    } else {
      callIn = estimateTokens(body);
      const content = response && response.data && response.data.content;
      const text = (Array.isArray(content) && content[0] && content[0].text) || '';
      callOut = estimateTokens(text);
    }
    this.inputTokens += callIn;
    this.outputTokens += callOut;
    this.spentUsd += usdFor(model || (response && response.data && response.data.model), callIn, callOut);
    this._checkCaps();
    return { inputTokens: callIn, outputTokens: callOut, exact };
  }

  _checkCaps() {
    if (this.aborted) return;
    const total = this.inputTokens + this.outputTokens;
    if (total > this.maxTokens) {
      this.aborted = true;
      this.abortReason = `token cap exceeded (${total}/${this.maxTokens})`;
      return;
    }
    if (this.spentUsd > this.maxUsd) {
      this.aborted = true;
      this.abortReason = `usd cap exceeded ($${this.spentUsd.toFixed(2)}/$${this.maxUsd})`;
    }
  }

  estimatedUsd() {
    return this.spentUsd;
  }

  /**
   * Call BEFORE each new provider call. Throws `BUDGET_EXCEEDED` once a cap
   * was crossed by a prior call, so the worst-case overshoot is one in-flight
   * call. The error carries a snapshot for the caller to surface.
   */
  preflight() {
    if (!this.aborted) return;
    const err = new Error(`AI provider budget exhausted: ${this.abortReason}`);
    err.code = 'BUDGET_EXCEEDED';
    err.tracker = this.snapshot();
    throw err;
  }

  snapshot() {
    return {
      label: this.label,
      callCount: this.callCount,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      estimatedUsd: Number(this.estimatedUsd().toFixed(4)),
      maxTokens: this.maxTokens,
      maxUsd: this.maxUsd,
      aborted: this.aborted,
      abortReason: this.abortReason,
      durationMs: Date.now() - this.startedAt,
    };
  }
}

/**
 * What one `runFixOrchestration` run is likely to cost BEFORE it runs.
 *
 * The orchestrator sends the whole file once per attempt and asks for
 * `hypotheses` complete copies back, capped by the request's max_tokens; it
 * retries up to `maxAttempts` times. The estimate counts the file body only —
 * the prompt scaffolding and the issue text are small and are NOT added, so
 * this is a floor per attempt, not a ceiling. `worstCaseUsd` assumes every
 * attempt runs and every hypothesis returns the full file.
 *
 * Pass the shape from cli-fix-orchestrator's FIX_CALL_SHAPE so the numbers
 * cannot drift from what the orchestrator actually sends.
 *
 * @param {{model: string, fileText: string, hypotheses: number, maxOutputTokens: number, maxAttempts: number}} opts
 */
function estimateFixCost({ model, fileText, hypotheses, maxOutputTokens, maxAttempts }) {
  for (const [k, v] of Object.entries({ hypotheses, maxOutputTokens, maxAttempts })) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`estimateFixCost: ${k} must be a positive number (pass FIX_CALL_SHAPE)`);
  }
  const fileTokens = estimateTokens(fileText);
  const inputTokensPerCall = fileTokens;
  const outputTokensPerCall = Math.min(fileTokens * hypotheses, maxOutputTokens);
  const perAttemptUsd = usdFor(model, inputTokensPerCall, outputTokensPerCall);
  return {
    model,
    knownPrice: hasKnownPrice(model),
    rate: priceFor(model),
    fileTokens,
    inputTokensPerCall,
    outputTokensPerCall,
    perAttemptUsd,
    maxAttempts,
    worstCaseUsd: perAttemptUsd * maxAttempts,
    basis: `${CHARS_PER_TOKEN} chars/token over the file body; prompt scaffolding and issue text not counted; output assumes ${hypotheses} full copies capped at ${maxOutputTokens} tokens`,
  };
}

module.exports = {
  BudgetTracker,
  estimateTokens,
  estimateFixCost,
  priceFor,
  hasKnownPrice,
  usdFor,
  INPUT_USD_PER_MTOK,
  OUTPUT_USD_PER_MTOK,
  MODEL_PRICING,
  CHARS_PER_TOKEN,
};
