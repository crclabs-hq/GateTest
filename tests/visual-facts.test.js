// ============================================================================
// VISUAL FACTS TEST — src/core/visual-facts.js (screenshot → code digest)
// ============================================================================
// extractDiffRegions: pure pixel clustering, tested with synthetic diff PNGs
// (red rectangles = changed pixels, gray = unchanged — matching the
// visual-diff-engine's pixelmatch output convention).
// harvestFactsInPage: designed to run inside page.evaluate, so it's fully
// self-contained — here we execute it directly against stubbed
// document/window/getComputedStyle globals.
// ============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { PNG } = require('pngjs');

const {
  extractDiffRegions,
  harvestFactsInPage,
  renderFactsDigest,
} = require('../src/core/visual-facts.js');

function diffPng(width, height, redRects) {
  const png = new PNG({ width, height });
  // unchanged = faded gray
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 180; png.data[i + 1] = 180; png.data[i + 2] = 180; png.data[i + 3] = 255;
  }
  for (const { x, y, w, h } of redRects) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const i = (yy * width + xx) * 4;
        png.data[i] = 255; png.data[i + 1] = 0; png.data[i + 2] = 0;
      }
    }
  }
  return PNG.sync.write(png);
}

describe('extractDiffRegions', () => {
  it('finds a single red rectangle as one region covering it', () => {
    const buf = diffPng(200, 200, [{ x: 48, y: 64, w: 40, h: 20 }]);
    const regions = extractDiffRegions(buf);
    assert.strictEqual(regions.length, 1);
    const r = regions[0];
    // Region is cell-aligned (16px grid) so it must CONTAIN the rect
    assert.ok(r.x <= 48 && r.x + r.width >= 88, `x range wrong: ${JSON.stringify(r)}`);
    assert.ok(r.y <= 64 && r.y + r.height >= 84, `y range wrong: ${JSON.stringify(r)}`);
    assert.strictEqual(r.diffPixels, 40 * 20);
  });

  it('separates two distant rectangles into two regions, sorted by size', () => {
    const buf = diffPng(300, 300, [
      { x: 16, y: 16, w: 20, h: 20 },     // small
      { x: 200, y: 200, w: 60, h: 40 },   // big
    ]);
    const regions = extractDiffRegions(buf);
    assert.strictEqual(regions.length, 2);
    assert.ok(regions[0].diffPixels > regions[1].diffPixels, 'sorted by diffPixels desc');
    assert.ok(regions[0].x >= 192, 'big region is the 200,200 one');
  });

  it('merges adjacent cells into one connected region', () => {
    // One 100px-wide bar spanning multiple 16px cells
    const buf = diffPng(200, 100, [{ x: 10, y: 40, w: 100, h: 10 }]);
    const regions = extractDiffRegions(buf);
    assert.strictEqual(regions.length, 1);
    assert.ok(regions[0].width >= 100);
  });

  it('drops speckle noise below minPixels', () => {
    const buf = diffPng(100, 100, [{ x: 50, y: 50, w: 2, h: 2 }]); // 4 px < default 8
    const regions = extractDiffRegions(buf);
    assert.strictEqual(regions.length, 0);
  });

  it('caps at maxRegions', () => {
    const rects = [];
    for (let i = 0; i < 12; i++) rects.push({ x: (i % 4) * 70 + 4, y: ((i / 4) | 0) * 70 + 4, w: 20, h: 20 });
    const buf = diffPng(300, 300, rects);
    const regions = extractDiffRegions(buf, { maxRegions: 5 });
    assert.strictEqual(regions.length, 5);
  });

  it('clean diff (no red) yields no regions', () => {
    const buf = diffPng(100, 100, []);
    assert.deepStrictEqual(extractDiffRegions(buf), []);
  });
});

// ── harvestFactsInPage against stubbed DOM globals ──────────────────────────

function makeElement({ tag = 'div', id, className = '', testId, text = '', parent = null, rect }) {
  return {
    tagName: tag.toUpperCase(),
    id,
    className,
    textContent: text,
    parentElement: parent,
    getAttribute: (name) => (name === 'data-testid' ? testId || null : null),
    getBoundingClientRect: () => rect || { x: 0, y: 0, width: 100, height: 20 },
  };
}

describe('harvestFactsInPage (stubbed DOM)', () => {
  let savedGlobals;

  beforeEach(() => {
    savedGlobals = {
      document: global.document,
      window: global.window,
      getComputedStyle: global.getComputedStyle,
    };
  });

  afterEach(() => {
    global.document = savedGlobals.document;
    global.window = savedGlobals.window;
    global.getComputedStyle = savedGlobals.getComputedStyle;
  });

  function stubDom({ elementAt, innerHeight = 800, innerWidth = 1280 }) {
    global.window = {
      innerHeight,
      innerWidth,
      scrollY: 0,
      scrollTo(_x, y) { this.scrollY = y; },
    };
    global.document = { elementFromPoint: elementAt };
    global.getComputedStyle = () => ({
      color: 'rgb(148, 163, 184)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      fontSize: '9.92px',
      fontFamily: 'Inter',
      fontWeight: '400',
      lineHeight: '12px',
      margin: '0px',
      padding: '4px',
      display: 'block',
      position: 'static',
      overflow: 'visible',
      width: '100px',
      height: '20px',
    });
  }

  it('maps a region to the element under it with selector + computed styles', () => {
    const card = makeElement({ tag: 'div', className: 'stat-card dark' });
    const label = makeElement({ tag: 'span', className: 'label muted', text: 'Active Users', parent: card });
    stubDom({ elementAt: () => label });

    const fact = harvestFactsInPage({ x: 100, y: 200, width: 80, height: 30, diffPixels: 900 });
    assert.strictEqual(fact.tag, 'span');
    assert.strictEqual(fact.selector, 'div.stat-card.dark > span.label.muted');
    assert.strictEqual(fact.computedStyles.fontSize, '9.92px');
    assert.strictEqual(fact.text, 'Active Users');
    // region reported back in DOCUMENT coordinates
    assert.deepStrictEqual(fact.region, { x: 100, y: 200, width: 80, height: 30, diffPixels: 900 });
  });

  it('prefers #id selectors and data-testid over class chains', () => {
    const withId = makeElement({ tag: 'button', id: 'buy-now' });
    stubDom({ elementAt: () => withId });
    assert.strictEqual(harvestFactsInPage({ x: 0, y: 0, width: 10, height: 10 }).selector, '#buy-now');

    const withTestId = makeElement({ tag: 'button', testId: 'checkout-cta' });
    stubDom({ elementAt: () => withTestId });
    assert.strictEqual(
      harvestFactsInPage({ x: 0, y: 0, width: 10, height: 10 }).selector,
      '[data-testid="checkout-cta"]',
    );
  });

  it('scrolls document-coordinate regions into view and translates y', () => {
    const seen = [];
    const el = makeElement({ tag: 'p', className: 'deep' });
    stubDom({
      elementAt: (x, y) => { seen.push([x, y]); return el; },
      innerHeight: 800,
    });

    harvestFactsInPage({ x: 10, y: 5000, width: 20, height: 20 });
    // scrolled to y - innerHeight/2 = 4600; region center y = 5010 - 4600 = 410
    assert.ok(global.window.scrollY === 4600, `scrollY ${global.window.scrollY}`);
    assert.ok(seen.some(([, y]) => Math.abs(y - 410) < 1), `hit-test y should be ~410, saw ${JSON.stringify(seen)}`);
  });

  it('majority vote across hit-points picks the dominant element', () => {
    const dominant = makeElement({ tag: 'div', className: 'winner' });
    const stray = makeElement({ tag: 'div', className: 'neighbour' });
    let call = 0;
    stubDom({ elementAt: () => (call++ === 1 ? stray : dominant) });
    const fact = harvestFactsInPage({ x: 50, y: 50, width: 40, height: 40 });
    assert.match(fact.selector, /winner/);
  });

  it('returns an honest note when nothing is at the coordinates', () => {
    stubDom({ elementAt: () => null });
    const fact = harvestFactsInPage({ x: 0, y: 0, width: 10, height: 10 });
    assert.strictEqual(fact.selector, null);
    assert.match(fact.note, /no element/);
  });

  it('sourceHint fires on PascalCase class blocks only', () => {
    const componenty = makeElement({ tag: 'div', className: 'StatCard-root' });
    stubDom({ elementAt: () => componenty });
    assert.match(harvestFactsInPage({ x: 0, y: 0, width: 10, height: 10 }).sourceHint, /StatCard component/);

    const plain = makeElement({ tag: 'div', className: 'flex items-center' });
    stubDom({ elementAt: () => plain });
    assert.strictEqual(harvestFactsInPage({ x: 0, y: 0, width: 10, height: 10 }).sourceHint, undefined);
  });
});

describe('renderFactsDigest', () => {
  it('renders selector, dimensions, style bits and source hint', () => {
    const md = renderFactsDigest([
      {
        region: { x: 0, y: 912, width: 412, height: 38 },
        selector: '.stat-card > span.label',
        text: 'Active Users',
        computedStyles: { fontSize: '9.92px', color: 'rgb(148, 163, 184)', backgroundColor: 'rgba(0, 0, 0, 0)' },
        sourceHint: 'StatCard component (class-name heuristic)',
      },
      { region: { x: 5, y: 5, width: 10, height: 10 }, selector: null, note: 'no element at these coordinates' },
    ]);
    assert.match(md, /412×38 at \(0,912\)/);
    assert.match(md, /`\.stat-card > span\.label`/);
    assert.match(md, /font-size 9\.92px/);
    assert.match(md, /StatCard component/);
    assert.match(md, /no element at these coordinates/);
    // transparent background must be omitted
    assert.ok(!md.includes('rgba(0, 0, 0, 0)'));
  });

  it('returns empty string for no facts', () => {
    assert.strictEqual(renderFactsDigest([]), '');
    assert.strictEqual(renderFactsDigest(null), '');
  });
});
