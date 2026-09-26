'use strict';
// GT-06 (outside crawl, 2026-09-26): the "see our own full-scan findings" link
// on /pricing and the free-scan result page pointed at GitHub's code-scanning
// view, which answers 404 to anyone not signed in with repository access. The
// sample-report link must be a URL GitHub serves anonymously.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'lib', 'sample-report.ts'), 'utf8');
const url = /export const SAMPLE_REPORT_URL\s*=\s*"([^"]+)"/.exec(SRC)?.[1];

describe('sample-report link is reachable without signing in', () => {
  it('is defined once', () => {
    assert.ok(url, 'SAMPLE_REPORT_URL must be a string literal');
  });
  it('NEGATIVE: never the code-scanning view (404 to anonymous readers)', () => {
    assert.ok(!/\/security\/code-scanning/.test(url), url);
  });
  it('POSITIVE: a public GitHub Actions page on this repository', () => {
    assert.match(url, /^https:\/\/github\.com\/crclabs-hq\/GateTest\/actions\//);
  });
});
