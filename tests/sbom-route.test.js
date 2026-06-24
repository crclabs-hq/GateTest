// =============================================================================
// /api/sbom ROUTE — STRUCTURE + CONTRACT TEST
// =============================================================================
// Source-level checks: file exists, route exports GET, CycloneDX shape
// elements are present. End-to-end response shape is tested via the
// website's TypeScript build (npx tsc --noEmit).
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROUTE_PATH = path.join(__dirname, '..', 'website', 'app', 'api', 'sbom', 'route.ts');

function read() {
  return fs.readFileSync(ROUTE_PATH, 'utf8');
}

describe('sbom route — file structure', () => {
  it('route file exists', () => {
    assert.ok(fs.existsSync(ROUTE_PATH));
  });

  it('exports a GET handler', () => {
    assert.match(read(), /export\s+async\s+function\s+GET/);
  });

  it('declares dynamic = "force-dynamic" (always reflects current deploy)', () => {
    assert.match(read(), /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  });
});

describe('sbom route — CycloneDX 1.4 contract', () => {
  const src = read();

  it('emits bomFormat: "CycloneDX"', () => {
    assert.match(src, /bomFormat:\s*["']CycloneDX["']/);
  });

  it('emits specVersion: "1.4"', () => {
    assert.match(src, /specVersion:\s*["']1\.4["']/);
  });

  it('includes serialNumber field', () => {
    assert.match(src, /serialNumber/);
  });

  it('walks both root + website package.json', () => {
    assert.match(src, /readPkg\(path\.join\(repoRoot,\s*["']package\.json["']\)\)/);
    assert.match(src, /readPkg\(path\.join\(websiteDir,\s*["']package\.json["']\)\)/);
  });

  it('produces PURL strings (pkg:npm/...)', () => {
    assert.match(src, /pkg:npm\//);
  });

  it('deduplicates components by name+version', () => {
    assert.match(src, /seen\.has/);
  });

  it('serves CORS-open for third-party SBOM consumers', () => {
    assert.match(src, /Access-Control-Allow-Origin["']\s*:\s*["']\*["']/);
  });

  it('returns 503 if both package.json reads fail', () => {
    assert.match(src, /SBOM unavailable/);
    assert.match(src, /status:\s*503/);
  });

  it('sets Content-Type to vnd.cyclonedx+json', () => {
    assert.match(src, /application\/vnd\.cyclonedx\+json/);
  });

  it('no-store cache header (every fetch reflects current state)', () => {
    assert.match(src, /Cache-Control[^\n]*no-store/);
  });
});

describe('sbom route — collectDeps + depToComponent behaviour', () => {
  it('strips semver prefixes from version strings', () => {
    // The route's collectDeps strips ^, ~, >=, etc. — pinned in source so
    // a reviewer's accidental refactor doesn't silently let a "^1.2.3"
    // leak into the SBOM (which downstream tooling would parse as a
    // literal version).
    assert.match(read(), /\.replace\(\/\^\[\\\^~>=<\]\+\//);
  });

  it('separates required vs optional scope', () => {
    const src = read();
    assert.match(src, /scope:\s*["']required["']/);
    assert.match(src, /scope:\s*["']optional["']/);
  });
});
