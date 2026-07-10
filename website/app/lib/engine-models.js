/**
 * Engine model selection — the single source of truth for which Claude model
 * the AI layer uses, by tier. (Craig 2026-07-07 — "Hybrid: Fable on paid fix
 * tiers." Craig 2026-07-10 — "Upgrade everything to Sonnet 5"; user-selectable
 * model + BYOK.)
 *
 * The 120-module deterministic scan uses ZERO Claude tokens — the model choice
 * here only affects the AI layer (auto-fix, per-finding diagnosis, pair-review,
 * cross-finding correlation, executive summary). We put the most capable model
 * where the price funds it, and keep the cheaper model on free/high-volume paths.
 *
 *   FIX_MODEL   (Fable 5)   → paid fix tiers: scan_fix ($199), nuclear/forensic ($399)
 *   CHEAP_MODEL (Sonnet 5)  → everything else: guidance, on-site chat, $29/$99 scan review, trainers
 *   FALLBACK_MODEL (Opus 4.8)→ refusal fallback for Fable (security-tooling false positives)
 *
 * Fable is ~3.3x Sonnet per token ($10/$50 vs $3/$15 per MTok); the paid-tier
 * budget caps in budget-tracker.js were raised to fund deeper analysis, and that
 * tracker prices each call at the model that actually ran it.
 *
 * Data-retention note: Fable 5 is unavailable under zero-data-retention. Craig
 * confirmed the org is on standard 30-day retention 2026-07-07. If that ever
 * changes, set GATETEST_FIX_MODEL=claude-sonnet-5 (or =claude-opus-4-8) to
 * flip the paid tiers off Fable with no code change.
 */

'use strict';

const FIX_MODEL = process.env.GATETEST_FIX_MODEL || 'claude-fable-5';
const CHEAP_MODEL = process.env.GATETEST_CHEAP_MODEL || 'claude-sonnet-5';
const FALLBACK_MODEL = process.env.GATETEST_FALLBACK_MODEL || 'claude-opus-4-8';

// Tiers whose deliverable is deep enough (and priced high enough) to fund Fable.
const FIX_TIERS = new Set(['scan_fix', 'nuclear', 'forensic']);

/**
 * Models a user may explicitly select for fix/explain operations (CLI --model,
 * MCP `model` arg, website `model` field). BYOK: on CLI/MCP the spend rides
 * the user's own ANTHROPIC_API_KEY, so any allowed choice is their budget.
 */
const ALLOWED_FIX_MODELS = Object.freeze({
  'claude-sonnet-5': {
    label: 'Sonnet 5 (default — fast, cheapest)',
    aliases: Object.freeze(['sonnet', 'sonnet-5']),
  },
  'claude-opus-4-8': {
    label: 'Opus 4.8 (deeper reasoning)',
    aliases: Object.freeze(['opus', 'opus-4-8', 'opus-4.8']),
  },
  'claude-fable-5': {
    label: 'Fable 5 (most capable, ~3.3x Sonnet cost)',
    aliases: Object.freeze(['fable', 'fable-5']),
  },
});

/** @returns {string[]} the exact model ids a user may select */
function allowedModelIds() {
  return Object.keys(ALLOWED_FIX_MODELS);
}

/**
 * Resolve a user-supplied model name (exact id or alias, case-insensitive)
 * against the allow-list.
 * @param {unknown} raw
 * @returns {{ok: true, model: string} | {ok: false, error: string}}
 */
function resolveModelChoice(raw) {
  const ids = allowedModelIds();
  const error =
    `Unknown model ${JSON.stringify(raw)}. Allowed: ${ids.join(', ')} ` +
    `(aliases: ${ids.map((id) => ALLOWED_FIX_MODELS[id].aliases[0]).join(', ')}).`;
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error };
  const wanted = raw.trim().toLowerCase();
  for (const id of ids) {
    if (id === wanted || ALLOWED_FIX_MODELS[id].aliases.includes(wanted)) {
      return { ok: true, model: id };
    }
  }
  return { ok: false, error };
}

/**
 * @param {string} tier 'quick' | 'full' | 'scan_fix' | 'nuclear' | 'forensic'
 * @returns {string} the Claude model id to use for the AI layer at this tier
 */
function modelForTier(tier) {
  const key = typeof tier === 'string' ? tier.toLowerCase() : '';
  return FIX_TIERS.has(key) ? FIX_MODEL : CHEAP_MODEL;
}

/** True when the given model needs Fable's refusal-fallback wrapping. */
function needsRefusalFallback(model) {
  return model === 'claude-fable-5' || model === 'claude-mythos-5';
}

module.exports = {
  FIX_MODEL,
  CHEAP_MODEL,
  FALLBACK_MODEL,
  FIX_TIERS,
  ALLOWED_FIX_MODELS,
  allowedModelIds,
  resolveModelChoice,
  modelForTier,
  needsRefusalFallback,
};
