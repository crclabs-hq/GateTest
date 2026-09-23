// =============================================================================
// WEBSITE NO-NETWORK FONTS — the build must never fetch a font at build time.
// =============================================================================
// Issue #684: `website/app/layout.tsx` imported Bricolage Grotesque via
// next/font/google, so `next build` fetched the font CSS and files from
// Google over the network. On 22 Sep 2026 16:06Z that fetch failed in CI
// ("Module not found: Can't resolve
// '@vercel/turbopack-next/internal/font/google/font'") and the production
// box froze mid-deploy at the same minute. The font is now self-hosted from
// website/public/fonts (next/font/local) — this test is the tripwire that
// keeps a next/font/google import from ever reappearing under website/.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEBSITE_DIR = path.join(ROOT, 'website');

const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'coverage']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe('website build never fetches a font over the network', () => {
  it('no file under website/ imports next/font/google', () => {
    const files = walk(WEBSITE_DIR);
    const offenders = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('next/font/google')) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `next/font/google reappeared in: ${offenders.join(', ')}. ` +
        'Self-host the font under website/public/fonts and load it with ' +
        'next/font/local instead (issue #684 — a Google Fonts fetch failure ' +
        'at build time froze production deploys).'
    );
  });

  it('website/app/layout.tsx loads the display font via next/font/local', () => {
    const layout = fs.readFileSync(path.join(WEBSITE_DIR, 'app', 'layout.tsx'), 'utf8');
    assert.match(
      layout,
      /from ["']next\/font\/local["']/,
      'layout.tsx should import next/font/local for the self-hosted display font'
    );
  });

  it('the self-hosted Bricolage Grotesque font file and its README exist', () => {
    const fontsDir = path.join(WEBSITE_DIR, 'public', 'fonts');
    assert.ok(fs.existsSync(fontsDir), 'website/public/fonts is missing');
    const files = fs.readdirSync(fontsDir);
    const woff2Files = files.filter((f) => f.endsWith('.woff2'));
    assert.ok(
      woff2Files.length > 0,
      'website/public/fonts has no .woff2 font file — self-hosted fonts must be woff2'
    );
    assert.ok(
      files.includes('README.md'),
      'website/public/fonts/README.md is missing — it must document the font license and source URL'
    );
    const readme = fs.readFileSync(path.join(fontsDir, 'README.md'), 'utf8');
    assert.match(readme, /Open Font License|OFL/i, 'README.md must note the font license');
  });
});
