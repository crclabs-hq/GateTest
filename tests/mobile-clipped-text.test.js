// mobileRendering: text cut off at the right edge with NO sideways scroll
// (a container's overflow hides it). Tallrig /about at 375px, 2026-10-03:
// "vendors" clipped, scrollWidth == viewport, so the scroll-only check passed.
// Run in a real browser; skipped (not passed) when no browser is available.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { findClippedText } = require('../src/core/clipped-text');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* resolved below */ }
if (!chromium) { try { ({ chromium } = require(require.resolve('playwright', { paths: [require('path').join(__dirname, '..', 'website')] }))); } catch { chromium = null; } }

let browser;
let page;
const skip = !chromium && 'playwright not available';

before(async () => {
  if (skip) return;
  try { browser = await chromium.launch(); } catch { browser = null; return; }
  page = await browser.newPage({ viewport: { width: 375, height: 800 } });
});
after(async () => { if (browser) await browser.close(); });

async function clipped(bodyHtml) {
  if (!browser) return null;
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;overflow-x:hidden}</style></head><body>${bodyHtml}</body></html>`);
  return page.evaluate(findClippedText, 375);
}

describe('clipped text at 375px', { skip }, () => {
  it('fires: a hero line that runs past the edge inside an overflow-hidden wrapper (Tallrig /about)', async (t) => {
    const r = await clipped('<div style="overflow:hidden"><p style="width:420px;font-size:20px">We believe developers should not have to assemble their stack from a dozen vendors</p></div>');
    if (r === null) return t.skip('browser did not launch');
    assert.strictEqual(r.length, 1, JSON.stringify(r));
    assert.strictEqual(r[0].tag, 'p');
  });

  it('quiet: text that fits, a code block in a scroll container, an off-canvas menu, sr-only text, deliberate ellipsis', async (t) => {
    const r = await clipped([
      '<p>Short line that wraps fine within the viewport width.</p>',
      '<div style="overflow-x:auto"><pre style="width:900px;margin:0">npm install @gatetest/cli --save-dev && npx gatetest --suite full</pre></div>',
      '<nav style="position:fixed;top:0;left:375px;width:300px">Menu item one</nav>',
      '<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Skip to content</span>',
      '<p style="width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">A long title the author chose to truncate with an ellipsis</p>',
    ].join(''));
    if (r === null) return t.skip('browser did not launch');
    assert.deepStrictEqual(r, []);
  });
});
