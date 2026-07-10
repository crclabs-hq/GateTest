/**
 * Engine model selection — CLI/engine-side twin of
 * website/app/lib/engine-models.js. Kept as a separate file because src/ is
 * CommonJS and cannot import from website/. Keep the two in sync.
 *
 * See the website twin for the full rationale (hybrid: Fable 5 on paid fix
 * tiers, Sonnet 5 on cheap/high-volume paths, Opus 4.8 refusal fallback).
 * Craig 2026-07-07; Sonnet 5 upgrade + user-selectable model Craig 2026-07-10.
 */

'use strict';

const FIX_MODEL = process.env.GATETEST_FIX_MODEL || 'claude-fable-5';
const CHEAP_MODEL = process.env.GATETEST_CHEAP_MODEL || 'claude-sonnet-5';
const FALLBACK_MODEL = process.env.GATETEST_FALLBACK_MODEL || 'claude-opus-4-8';

const FIX_TIERS = new Set(['scan_fix', 'nuclear', 'forensic']);

// Models a user may explicitly select (CLI --model, MCP `model` arg). On
// CLI/MCP the spend rides the user's own ANTHROPIC_API_KEY (BYOK).
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

function allowedModelIds() {
  return Object.keys(ALLOWED_FIX_MODELS);
}

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

function modelForTier(tier) {
  const key = typeof tier === 'string' ? tier.toLowerCase() : '';
  return FIX_TIERS.has(key) ? FIX_MODEL : CHEAP_MODEL;
}

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
