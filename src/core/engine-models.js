/**
 * Engine model selection — CLI/engine-side twin of
 * website/app/lib/engine-models.js. Kept as a separate file because src/ is
 * CommonJS and cannot import from website/. Keep the two in sync.
 *
 * See the website twin for the full rationale (hybrid: Fable 5 on paid fix
 * tiers, Sonnet 4.6 on cheap/high-volume paths, Opus 4.8 refusal fallback).
 * Craig 2026-07-07.
 */

'use strict';

const FIX_MODEL = process.env.GATETEST_FIX_MODEL || 'claude-fable-5';
const CHEAP_MODEL = process.env.GATETEST_CHEAP_MODEL || 'claude-sonnet-4-6';
const FALLBACK_MODEL = process.env.GATETEST_FALLBACK_MODEL || 'claude-opus-4-8';

const FIX_TIERS = new Set(['scan_fix', 'nuclear', 'forensic']);

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
  modelForTier,
  needsRefusalFallback,
};
