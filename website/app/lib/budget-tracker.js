/**
 * Per-scan Anthropic spend tracker.
 *
 * Pure in-process — created at the start of each request, mutated as
 * the request proceeds, dropped when the request ends. No durable
 * storage. Safe on Vercel serverless because each function invocation
 * is its own process; concurrent invocations get their own tracker.
 *
 * Why we need this: an unbounded fix-loop bug, a malicious repo
 * crafted to maximise prompt token usage, or a stuck retry pool can
 * each burn through the Anthropic balance in a single request. The
 * tracker stops that by aborting before the NEXT call once a cap is
 * crossed, so the worst-case overshoot is one in-flight call.
 *
 * Two-axis cap: tokens (input + output) AND estimated USD. Either
 * triggers abort. Per-scan ceilings configurable via env.
 *
 * Per-customer / per-day caps need a durable store — out of scope
 * here; this module is the in-request half. Pair with persisted
 * counters when that store lands.
 */

const ALS = (() => {
  try {
    return require('node:async_hooks').AsyncLocalStorage;
  } catch {
    return null;
  }
})();

// Hybrid-engine pricing (Craig 2026-07-07). The AI layer runs Fable 5 on the
// paid fix tiers (scan_fix / nuclear) and Sonnet 4.6 on free/cheap/high-volume
// paths — see website/app/lib/engine-models.js. The tracker prices each call at
// the model that actually ran it, so the per-scan USD cap reflects real spend.
//
// Sonnet 4.6: $3 in / $15 out per MTok. Fable 5: $10 in / $50 out per MTok.
// The default rate (used when a caller doesn't tag a model) stays Sonnet, so
// every existing cheap-path caller is priced exactly as before.
const INPUT_USD_PER_MTOK = Number(process.env.GATETEST_INPUT_USD_PER_MTOK) || 3;
const OUTPUT_USD_PER_MTOK = Number(process.env.GATETEST_OUTPUT_USD_PER_MTOK) || 15;

// Per-model rates. Keyed by the model id string passed to record(). Unknown /
// untagged calls fall back to the Sonnet default pair above.
const MODEL_PRICING = {
  'claude-sonnet-4-6': { input: INPUT_USD_PER_MTOK, output: OUTPUT_USD_PER_MTOK },
  'claude-fable-5':    { input: Number(process.env.GATETEST_FABLE_INPUT_USD_PER_MTOK) || 10,
                         output: Number(process.env.GATETEST_FABLE_OUTPUT_USD_PER_MTOK) || 50 },
  'claude-opus-4-8':   { input: 5, output: 25 },
};

function priceFor(model) {
  return MODEL_PRICING[model] || { input: INPUT_USD_PER_MTOK, output: OUTPUT_USD_PER_MTOK };
}

// Default per-scan ceilings. Sized for Opus pricing — the same token
// counts that were $12 on Sonnet cost ~$60 on Opus, so the per-scan
// caps below are CALIBRATED to dollars not tokens (a $12 default cap on
// Opus translates to roughly 240k tokens, enough for ~30-50 Claude
// fix calls). Per-tier caps in capsForTier() override this.
const DEFAULT_MAX_TOKENS = Number(process.env.GATETEST_MAX_TOKENS_PER_SCAN) || 300_000;
const DEFAULT_MAX_USD = Number(process.env.GATETEST_MAX_USD_PER_SCAN) || 12;

// Rough char-to-token ratio. Claude tokenizer averages ~3.5-4 chars/tok
// for English+code. Use 3.0 to deliberately over-count so we cut off
// BEFORE the real ceiling is crossed.
const CHARS_PER_TOKEN = 3.0;

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

class BudgetTracker {
  constructor({ maxTokens = DEFAULT_MAX_TOKENS, maxUsd = DEFAULT_MAX_USD, label = 'scan' } = {}) {
    this.maxTokens = maxTokens;
    this.maxUsd = maxUsd;
    this.label = label;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.spentUsd = 0; // accumulated per-call at each call's own model rate
    this.callCount = 0;
    this.aborted = false;
    this.abortReason = null;
    this.startedAt = Date.now();
  }

  /**
   * Account for one Claude call. `body` is the request body string,
   * `response` the result from anthropicCall (either { status, data }
   * or null if the call threw). If Anthropic returned a `usage` object
   * we use its exact token counts; otherwise we estimate from char
   * lengths.
   */
  record(body, response, model) {
    this.callCount += 1;
    const usage = response?.data?.usage;
    let callIn;
    let callOut;
    if (usage && typeof usage.output_tokens === 'number') {
      callIn = usage.input_tokens || estimateTokens(body);
      callOut = usage.output_tokens;
    } else {
      callIn = estimateTokens(body);
      const text =
        (response?.data?.content && response.data.content[0]?.text) || '';
      callOut = estimateTokens(text);
    }
    this.inputTokens += callIn;
    this.outputTokens += callOut;
    // Price this call at the model that actually ran it (defaults to Sonnet).
    const rate = priceFor(model || (response?.data?.model));
    this.spentUsd += (callIn / 1_000_000) * rate.input + (callOut / 1_000_000) * rate.output;
    this._checkCaps();
  }

  _checkCaps() {
    if (this.aborted) return;
    const total = this.inputTokens + this.outputTokens;
    if (total > this.maxTokens) {
      this.aborted = true;
      this.abortReason = `token cap exceeded (${total}/${this.maxTokens})`;
      return;
    }
    const usd = this.estimatedUsd();
    if (usd > this.maxUsd) {
      this.aborted = true;
      this.abortReason = `usd cap exceeded ($${usd.toFixed(2)}/$${this.maxUsd})`;
    }
  }

  estimatedUsd() {
    // spentUsd accumulates per call at each call's real model rate. It equals
    // the legacy aggregate formula when every call used the Sonnet default, so
    // existing Sonnet-only callers and their tests are unaffected.
    return this.spentUsd;
  }

  /**
   * Call BEFORE each new Anthropic call. Throws `BudgetExceeded` if
   * the cap was already breached on a prior call. The error carries
   * a snapshot so the caller can surface it cleanly to the user.
   */
  preflight() {
    if (!this.aborted) return;
    const err = new Error(`Anthropic budget exhausted: ${this.abortReason}`);
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

// ---------------------------------------------------------------------------
// AsyncLocalStorage context — lets deep call stacks (libs that don't accept
// a tracker arg) reach the per-request tracker without explicit threading.
// ---------------------------------------------------------------------------

const _als = ALS ? new ALS() : null;

function getCurrentTracker() {
  if (!_als) return null;
  return _als.getStore() || null;
}

function runWithTracker(tracker, fn) {
  if (!_als) return fn();
  return _als.run(tracker, fn);
}

function createBudgetTracker(opts) {
  return new BudgetTracker(opts);
}

// ---------------------------------------------------------------------------
// Per-tier cap policy
// ---------------------------------------------------------------------------
//
// Caps the Anthropic spend per scan based on the customer's tier. Raised on the
// paid fix tiers 2026-07-07 (Craig-approved) when those tiers moved to Fable 5
// (~3.3x Sonnet per token) — the higher cap buys genuinely DEEPER analysis, not
// just more-expensive same-depth. Margins stay healthy: Quick $29→$1.50 cap
// (95%+), Full $99→$5 (95%, still Sonnet), Scan+Fix $199→$30 (~85%, Fable),
// Forensic $399→$60 (~85%, Fable).
//
// Override via environment variables (per-tier) for emergency widening:
//   GATETEST_MAX_USD_QUICK     (default 1.5)
//   GATETEST_MAX_USD_FULL      (default 5)
//   GATETEST_MAX_USD_SCAN_FIX  (default 30)
//   GATETEST_MAX_USD_NUCLEAR   (default 60)
//
// Unknown tier → DEFAULT_MAX_USD (12). Stay conservative on unrecognised
// inputs.

const TIER_CAPS_USD = {
  quick:    Number(process.env.GATETEST_MAX_USD_QUICK)    || 1.5,
  full:     Number(process.env.GATETEST_MAX_USD_FULL)     || 5,
  scan_fix: Number(process.env.GATETEST_MAX_USD_SCAN_FIX) || 30,
  nuclear:  Number(process.env.GATETEST_MAX_USD_NUCLEAR)  || 60,
};

const TIER_TOKEN_CAPS = {
  quick:    Number(process.env.GATETEST_MAX_TOKENS_QUICK)    || 250_000,
  full:     Number(process.env.GATETEST_MAX_TOKENS_FULL)     || 750_000,
  scan_fix: Number(process.env.GATETEST_MAX_TOKENS_SCAN_FIX) || 1_500_000,
  nuclear:  Number(process.env.GATETEST_MAX_TOKENS_NUCLEAR)  || 3_500_000,
};

/**
 * Resolve the dollar + token cap for a given tier string. Falls back to
 * DEFAULT_MAX_USD / DEFAULT_MAX_TOKENS for unknown tiers.
 *
 * @param {string} tier 'quick' | 'full' | 'scan_fix' | 'nuclear'
 * @returns {{ maxUsd: number, maxTokens: number, tier: string }}
 */
function capsForTier(tier) {
  const key = typeof tier === 'string' ? tier.toLowerCase() : '';
  if (key in TIER_CAPS_USD) {
    return {
      tier: key,
      maxUsd: TIER_CAPS_USD[key],
      maxTokens: TIER_TOKEN_CAPS[key],
    };
  }
  return {
    tier: 'unknown',
    maxUsd: DEFAULT_MAX_USD,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

/**
 * Convenience constructor — builds a tracker pre-configured for a tier.
 *
 * @param {string} tier
 * @param {object} [opts]                Additional BudgetTracker opts
 * @returns {BudgetTracker}
 */
function createTrackerForTier(tier, opts = {}) {
  const caps = capsForTier(tier);
  return new BudgetTracker({
    ...opts,
    maxUsd: opts.maxUsd || caps.maxUsd,
    maxTokens: opts.maxTokens || caps.maxTokens,
    label: opts.label || `${caps.tier}-scan`,
  });
}

module.exports = {
  BudgetTracker,
  createBudgetTracker,
  createTrackerForTier,
  capsForTier,
  getCurrentTracker,
  runWithTracker,
  estimateTokens,
  // Exposed for tests.
  INPUT_USD_PER_MTOK,
  OUTPUT_USD_PER_MTOK,
  MODEL_PRICING,
  priceFor,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_USD,
  CHARS_PER_TOKEN,
  TIER_CAPS_USD,
  TIER_TOKEN_CAPS,
};
