'use strict';

// scripts/ops/required-checks.js
//
// ONE DEFINITION (Doctrine #4) of the job `name:` values that GitHub branch
// protection on main requires from .github/workflows/ci.yml: "Test + Build",
// "Pre-Merge Sweep", "GateTest Quality Gate", "GateTest Full Scan". Any
// session that renames one of those jobs must update this list in the same
// commit — tests/bot-pr-required-ci.test.js asserts every name below still
// appears as a job `name:` in ci.yml, so a silent rename fails the suite
// instead of leaving every bot-authored PR BLOCKED with no visible cause.

const REQUIRED_CHECKS = [
  'Test + Build',
  'Pre-Merge Sweep',
  'GateTest Quality Gate',
  'GateTest Full Scan',
];

module.exports = { REQUIRED_CHECKS };
