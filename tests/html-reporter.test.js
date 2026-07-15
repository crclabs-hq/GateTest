const { describe, it } = require('node:test');
const assert = require('node:assert');

const { HtmlReporter } = require('../src/reporters/html-reporter');

function makeSummary(overrides = {}) {
  return {
    gateStatus: 'PASSED',
    modules: { total: 5, passed: 5 },
    checks: {
      total: 100, passed: 60, failed: 40,
      errors: 0, blockingErrors: 0, softErrors: 0,
      warnings: 5, infoFindings: 35,
    },
    fixes: { total: 0 },
    duration: 1000,
    results: [],
    ...overrides,
  };
}

describe('HtmlReporter — pass-rate excludes info-only findings (self-scan 2026-07-15 fix)', () => {
  it('excludes info findings from the pass-rate denominator', () => {
    const reporter = Object.create(HtmlReporter.prototype);
    const html = reporter._generateHtml(makeSummary(), []);
    // 60 passed / (100 - 35 info) = 60/65 = 92%, not 60/100 = 60%.
    assert.match(html, /card-value[^>]*>92%</);
  });

  it('falls back to the raw total when infoFindings is absent (older summary shape)', () => {
    const reporter = Object.create(HtmlReporter.prototype);
    const summary = makeSummary();
    delete summary.checks.infoFindings;
    const html = reporter._generateHtml(summary, []);
    assert.match(html, /card-value[^>]*>60%</);
  });
});
