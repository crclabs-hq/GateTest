'use strict';

/**
 * The one list of modules whose FINDINGS are a model's judgment call rather
 * than a deterministic rule (the Fifty, move 14 / complaint C1+C4: "40% of
 * AI review alerts ignored" — customers distrust a tool that mixes
 * deterministic checks and model opinions at equal weight).
 *
 * Membership is evidence, not guesswork: every name here was verified by
 * grepping `src/modules/*.js` for a require of `../core/anthropic-config`
 * (the one AI-client entry point every model-calling module uses to reach
 * the Anthropic API) and confirming the module's registered name in
 * `src/core/registry.js`. Two modules whose NAMES suggest an AI origin were
 * checked and excluded: `aiHallucination` (import-graph analysis — no
 * network call, no anthropic-config require) and `explorer` (Playwright
 * browser automation — same). Their findings are deterministic.
 *
 * `fakeFixDetector` is MIXED: `_recordFindings()` in fake-fix-detector.js
 * tags each finding with its origin engine ('pattern' — regex/diff rules —
 * or 'ai' — a Claude call), so that module sets `details.verdictSource`
 * explicitly per finding instead of relying on this table (see
 * fake-fix-detector.js `_recordFindings`). It stays OFF this table so a
 * caller who forgets the explicit tag defaults to 'deterministic', not a
 * blanket 'model' that would wrongly exempt its pattern-engine findings
 * from the gate.
 *
 * Doctrine #4 (one definition, imported): `runner.js` (`TestResult.addCheck`)
 * is the ONLY place that reads this table to default a finding's
 * `verdictSource`. Reporters and the website read the field off the
 * finding, never this table.
 */
const MODEL_JUDGED_MODULES = new Set([
  'aiReview',
  'agentic',
  'architectureDrift',
  'intentVerification',
  'regressionPredictor',
]);

/**
 * @param {string} moduleName
 * @returns {'model'|'deterministic'}
 */
function defaultVerdictSource(moduleName) {
  return MODEL_JUDGED_MODULES.has(moduleName) ? 'model' : 'deterministic';
}

module.exports = { MODEL_JUDGED_MODULES, defaultVerdictSource };
