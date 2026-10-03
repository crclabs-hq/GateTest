'use strict';

// The precision corpus judges GateTest's rules on pinned code. `npm audit`
// findings come from today's advisory database, so they moved got from 0 to
// 3 blocking on 2026-10-03 with no engine change. They are split out and
// printed, never judged and never hidden.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { splitLiveFindings, LIVE_DATA_RULE_RE } = require('../scripts/real-world-precision');

describe('real-world precision: live-advisory findings', () => {
  it('npm-audit findings are counted apart from rule findings (the got case)', () => {
    const findings = [
      { rule: 'security:npm-audit' },
      { rule: 'security:npm-audit:cacheable-request' },
      { rule: 'security:npm-audit:http-cache-semantics' },
    ];
    assert.deepEqual(splitLiveFindings(3, findings), { ruleBlocking: 0, live: 3 });
  });
  it('control: a rule finding still counts against the ceiling', () => {
    const findings = [{ rule: 'security:npm-audit' }, { rule: 'security:sql-injection' }];
    assert.deepEqual(splitLiveFindings(2, findings), { ruleBlocking: 1, live: 1 });
  });
  it('control: a rule merely named like audit is not live data', () => {
    assert.equal(LIVE_DATA_RULE_RE.test('security:npm-audit-config'), false);
    assert.equal(LIVE_DATA_RULE_RE.test('auditLog:missing'), false);
  });
  it('unreadable report: everything is counted (never a silent pass)', () => {
    assert.deepEqual(splitLiveFindings(5, null), { ruleBlocking: 5, live: null });
  });
});
