/**
 * Multi-Agent Consensus gate — pure decision logic extracted from
 * /api/scan/fix/route.ts for direct testability (route.ts itself isn't
 * unit-testable in isolation; this mirrors the existing extraction pattern
 * used by budget-tracker.js's capsForTier()).
 *
 * Three conditions all have to hold for consensus to run: the customer
 * asked for it, the tier is Forensic ($399, internal key "nuclear"), and
 * the deployment actually has OPENAI_API_KEY configured. Any other
 * combination falls back to single-agent Claude — never a hard error.
 */

'use strict';

/**
 * @param {Object} opts
 * @param {boolean} opts.consensusRequested — input.consensus === true
 * @param {boolean} opts.tierIsNuclear      — tierForCap === "nuclear"
 * @param {boolean} opts.openAiConfigured   — isOpenAiConfigured()
 * @returns {{ useConsensus: boolean, reason: string|null }}
 *   reason is null when useConsensus is true, else a human-readable
 *   explanation matching the API response's `consensus.skipped.reason` shape.
 */
function resolveConsensusGate({ consensusRequested, tierIsNuclear, openAiConfigured }) {
  const useConsensus = Boolean(consensusRequested) && Boolean(tierIsNuclear) && Boolean(openAiConfigured);
  if (useConsensus) return { useConsensus: true, reason: null };

  if (!consensusRequested) {
    return { useConsensus: false, reason: 'not requested — pass consensus:true on Forensic tier to enable' };
  }
  if (!tierIsNuclear) {
    return { useConsensus: false, reason: 'tier is not nuclear — Multi-Agent Consensus is a Forensic-tier ($399) opt-in' };
  }
  return { useConsensus: false, reason: 'OPENAI_API_KEY not configured on this deployment' };
}

module.exports = { resolveConsensusGate };
