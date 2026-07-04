/**
 * Visual Facts — "screenshot → code" digest engine.
 *
 * A raw diff image tells an AI (or a human) THAT something changed, but not
 * WHAT to edit. Vision is approximate: Claude can see "the button looks
 * off" but not "it's #3B82F4 where the token says #3B82F6, offset 63px".
 * This engine converts pixel evidence into machine-readable ground truth:
 *
 *   1. extractDiffRegions — cluster the red diff pixels the visual-diff
 *      engine emits into bounding boxes (pure JS, no browser).
 *   2. collectVisualFacts — hit-test those boxes in the LIVE page at
 *      capture time (document.elementFromPoint) and harvest the element
 *      under each: a stable selector, computed styles, bounding rect.
 *   3. renderFactsDigest — one markdown/JSON block: "region 412×38 at
 *      (0,912) → `.stat-card label` — font-size 9.92px, color #94A3B8".
 *
 * Pixels for perception, facts for surgery. sourceHint is a best-effort
 * className → component-name heuristic; framework source-map resolution
 * is explicitly out of scope in v1 (don't pretend otherwise).
 */

'use strict';

const { decodePng } = require('./visual-diff-engine');

/**
 * Cluster diff-marked pixels into bounding-box regions.
 *
 * The diff PNGs from compareScreenshots mark changed pixels in red
 * ([255,0,0]); unchanged pixels are drawn as faded grayscale. Detection:
 * strongly-red pixels (r>200, g<80, b<80). Clustering: mark coarse grid
 * cells containing diff pixels, then BFS-merge adjacent cells into
 * connected components and return each component's bounding box.
 *
 * @param {Buffer} diffPngBuffer
 * @param {{cellSize?: number, maxRegions?: number, minPixels?: number}} [opts]
 * @returns {Array<{x:number, y:number, width:number, height:number, diffPixels:number}>}
 *          sorted by diffPixels desc
 */
function extractDiffRegions(diffPngBuffer, opts = {}) {
  const cellSize = opts.cellSize || 16;
  const maxRegions = opts.maxRegions || 10;
  const minPixels = opts.minPixels || 8;

  const img = decodePng(diffPngBuffer);
  const cols = Math.ceil(img.width / cellSize);
  const rows = Math.ceil(img.height / cellSize);

  // Per-cell diff-pixel counts.
  const cellCounts = new Int32Array(cols * rows);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      if (r > 200 && g < 80 && b < 80) {
        cellCounts[((y / cellSize) | 0) * cols + ((x / cellSize) | 0)]++;
      }
    }
  }

  // BFS connected components over marked cells (4-connectivity).
  const visited = new Uint8Array(cols * rows);
  const regions = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const start = cy * cols + cx;
      if (visited[start] || cellCounts[start] === 0) continue;

      let minCx = cx, maxCx = cx, minCy = cy, maxCy = cy, pixels = 0;
      const queue = [start];
      visited[start] = 1;
      while (queue.length) {
        const cell = queue.pop();
        const x = cell % cols;
        const y = (cell / cols) | 0;
        pixels += cellCounts[cell];
        if (x < minCx) minCx = x;
        if (x > maxCx) maxCx = x;
        if (y < minCy) minCy = y;
        if (y > maxCy) maxCy = y;
        const neighbors = [
          x > 0 ? cell - 1 : -1,
          x < cols - 1 ? cell + 1 : -1,
          y > 0 ? cell - cols : -1,
          y < rows - 1 ? cell + cols : -1,
        ];
        for (const n of neighbors) {
          if (n >= 0 && !visited[n] && cellCounts[n] > 0) {
            visited[n] = 1;
            queue.push(n);
          }
        }
      }

      if (pixels >= minPixels) {
        regions.push({
          x: minCx * cellSize,
          y: minCy * cellSize,
          width: Math.min((maxCx + 1) * cellSize, img.width) - minCx * cellSize,
          height: Math.min((maxCy + 1) * cellSize, img.height) - minCy * cellSize,
          diffPixels: pixels,
        });
      }
    }
  }

  regions.sort((a, b) => b.diffPixels - a.diffPixels);
  return regions.slice(0, maxRegions);
}

/**
 * The in-page harvester. Runs inside the browser via page.evaluate(fn, arg)
 * — Playwright serializes the function natively (no string eval), so it
 * must be fully self-contained: no closures over Node scope, no requires.
 * Exported so tests can execute it directly against stubbed
 * `document`/`window`/`getComputedStyle` globals.
 *
 * Takes ONE region in DOCUMENT coordinates (full-page screenshot space),
 * scrolls it into view, translates to viewport coordinates, hit-tests,
 * and returns a single fact object (region reported back in document
 * coordinates).
 *
 * @param {{x:number,y:number,width:number,height:number,diffPixels?:number}} documentRegion
 * @returns {object}
 */
function harvestFactsInPage(documentRegion) {
  function buildSelector(el) {
    if (!el || !el.tagName) return null;
    if (el.id) return `#${el.id}`;
    const testId = el.getAttribute && el.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId}"]`;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.tagName && node.tagName.toLowerCase() !== 'html' && depth < 3) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`#${node.id}`); break; }
      const cls = (typeof node.className === 'string' ? node.className : '')
        .trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ') || null;
  }

  function sourceHintFromClasses(el) {
    // Best-effort: PascalCase/BEM-block class names often mirror the
    // component that rendered them (StatCard → StatCard.tsx). Heuristic
    // only — no source maps in v1.
    const cls = (el && typeof el.className === 'string' ? el.className : '').split(/\s+/);
    for (const c of cls) {
      const block = c.split(/[_-]/)[0];
      if (/^[A-Z][a-zA-Z0-9]{2,}$/.test(block)) return `${block} component (class-name heuristic)`;
    }
    return null;
  }

  const STYLE_KEYS = [
    'color', 'backgroundColor', 'fontSize', 'fontFamily', 'fontWeight',
    'lineHeight', 'margin', 'padding', 'display', 'position', 'overflow',
    'width', 'height',
  ];

  // Regions come from FULL-PAGE screenshots (document coordinates), but
  // elementFromPoint works in viewport coordinates — scroll the region
  // into view, then translate.
  window.scrollTo(0, Math.max(0, documentRegion.y - (window.innerHeight || 0) / 2));
  const scrollY = window.scrollY || window.pageYOffset || 0;
  const region = {
    x: documentRegion.x,
    y: documentRegion.y - scrollY,
    width: documentRegion.width,
    height: documentRegion.height,
  };

  const cx = Math.min(Math.max(region.x + region.width / 2, 0), (window.innerWidth || 1e9) - 1);
  const cy = region.y + region.height / 2;

  // Hit-test center + inset corners; the element seen most often wins
  // (a corner can land on a neighbour when the region straddles edges).
  const points = [
    [cx, cy],
    [region.x + 2, region.y + 2],
    [region.x + region.width - 2, region.y + 2],
    [region.x + 2, region.y + region.height - 2],
    [region.x + region.width - 2, region.y + region.height - 2],
  ];
  const counts = new Map();
  for (const [px, py] of points) {
    const el = document.elementFromPoint(px, py);
    if (el && el.tagName && el.tagName.toLowerCase() !== 'html' && el.tagName.toLowerCase() !== 'body') {
      counts.set(el, (counts.get(el) || 0) + 1);
    }
  }
  let best = null;
  let bestCount = 0;
  for (const [el, count] of counts) {
    if (count > bestCount) { best = el; bestCount = count; }
  }
  if (!best) {
    return {
      region: documentRegion,
      selector: null,
      note: 'no element at these coordinates (off-viewport or removed content)',
    };
  }

  const style = getComputedStyle(best);
  const computedStyles = {};
  for (const key of STYLE_KEYS) computedStyles[key] = style[key];
  const rect = best.getBoundingClientRect();

  return {
    region: documentRegion,
    selector: buildSelector(best),
    tag: best.tagName.toLowerCase(),
    text: (best.textContent || '').trim().slice(0, 80) || undefined,
    computedStyles,
    boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    sourceHint: sourceHintFromClasses(best) || undefined,
  };
}

/**
 * Run the harvester in a live Playwright page — one evaluate per region,
 * function passed directly (Playwright serializes it; no string eval).
 *
 * @param {import('playwright').Page} page
 * @param {Array<{x:number,y:number,width:number,height:number}>} regions
 * @returns {Promise<Array<object>>}
 */
async function collectVisualFacts(page, regions) {
  const facts = [];
  for (const region of regions) {
    try {
      const fact = await page.evaluate(harvestFactsInPage, region);
      if (fact) facts.push(fact);
    } catch { /* per-region best-effort — a failed hit-test never blocks */ }
  }
  return facts;
}

/**
 * Render facts as a compact markdown digest for check details / MCP text.
 *
 * @param {Array<object>} facts
 * @returns {string}
 */
function renderFactsDigest(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return '';
  const lines = ['**Changed regions → elements (visual facts):**'];
  for (const f of facts.slice(0, 10)) {
    const r = f.region || {};
    const where = `${r.width}×${r.height} at (${r.x},${r.y})`;
    if (!f.selector) {
      lines.push(`- ${where} → ${f.note || 'unmapped'}`);
      continue;
    }
    const s = f.computedStyles || {};
    const styleBits = [
      s.fontSize ? `font-size ${s.fontSize}` : null,
      s.color ? `color ${s.color}` : null,
      s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' ? `bg ${s.backgroundColor}` : null,
    ].filter(Boolean).join(', ');
    lines.push(
      `- ${where} → \`${f.selector}\`${f.text ? ` ("${f.text}")` : ''}${styleBits ? ` — ${styleBits}` : ''}${f.sourceHint ? ` [${f.sourceHint}]` : ''}`,
    );
  }
  return lines.join('\n');
}

module.exports = {
  extractDiffRegions,
  harvestFactsInPage,
  collectVisualFacts,
  renderFactsDigest,
};
