// ============================================================================
// MCP EYES TOOLS TEST — capture_screenshot + get_visual_diff handlers.
// ============================================================================
// Calls the REAL handlers via dynamic import (the .mjs guards its stdio
// connect behind an entrypoint check). get_visual_diff is pure fs — fully
// tested against a synthetic baseline tree. capture_screenshot's browser
// path skips gracefully when chromium can't launch in this environment
// (same posture as the visual modules themselves).
// ============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

let mcp;

before(async () => {
  mcp = await import('../bin/gatetest-mcp.mjs');
});

function solidPng(width, height, [r, g, b]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function textOf(res) {
  return (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function imageOf(res) {
  return (res.content || []).find((c) => c.type === 'image') || null;
}

describe('get_visual_diff — synthetic baseline tree', () => {
  let projectRoot;
  let baselineDir;

  before(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-eyes-'));
    baselineDir = path.join(projectRoot, '.gatetest', 'visual-baselines');
    // vapron.ai/desktop: baseline + current + diff for route "/" (slug index)
    const vpDesktop = path.join(baselineDir, 'vapron.ai', 'desktop');
    fs.mkdirSync(path.join(vpDesktop, 'current'), { recursive: true });
    fs.mkdirSync(path.join(vpDesktop, 'diff'), { recursive: true });
    fs.writeFileSync(path.join(vpDesktop, 'index.png'), solidPng(40, 30, [0, 128, 0]));
    fs.writeFileSync(path.join(vpDesktop, 'current', 'index.png'), solidPng(40, 30, [128, 0, 0]));
    fs.writeFileSync(path.join(vpDesktop, 'diff', 'index.png'), solidPng(40, 30, [255, 0, 0]));
    // vapron.ai/mobile: baseline ONLY for route /pricing
    const vpMobile = path.join(baselineDir, 'vapron.ai', 'mobile');
    fs.mkdirSync(vpMobile, { recursive: true });
    fs.writeFileSync(path.join(vpMobile, 'pricing.png'), solidPng(20, 40, [0, 0, 128]));
  });

  after(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('requires path and route', async () => {
    const res = await mcp.handleGetVisualDiff({ path: projectRoot });
    assert.strictEqual(res.isError, true);
  });

  it('returns a composite image when baseline+current+diff all exist', async () => {
    const res = await mcp.handleGetVisualDiff({ path: projectRoot, route: '/' });
    const img = imageOf(res);
    assert.ok(img, `expected an image block, got: ${textOf(res)}`);
    assert.strictEqual(img.mimeType, 'image/png');
    const decoded = PNG.sync.read(Buffer.from(img.data, 'base64'));
    // composite = 3 × 40px panels + 2 × 4px gutters = 128
    assert.strictEqual(decoded.width, 128);
    assert.match(textOf(res), /baseline \| current \| diff/);
  });

  it('single-panel request returns just that panel', async () => {
    const res = await mcp.handleGetVisualDiff({ path: projectRoot, route: '/', panel: 'diff' });
    const img = imageOf(res);
    assert.ok(img);
    const decoded = PNG.sync.read(Buffer.from(img.data, 'base64'));
    assert.strictEqual(decoded.width, 40);
    assert.match(textOf(res), /diff for \//);
  });

  it('falls back to baseline panel when no diff exists yet (first run)', async () => {
    const res = await mcp.handleGetVisualDiff({
      path: projectRoot, route: '/pricing', viewport: 'mobile',
    });
    const img = imageOf(res);
    assert.ok(img, `expected baseline image, got: ${textOf(res)}`);
    assert.match(textOf(res), /baseline for \/pricing/);
  });

  it('unknown route returns a discovery listing, not a dead-end', async () => {
    const res = await mcp.handleGetVisualDiff({ path: projectRoot, route: '/nonexistent' });
    assert.ok(!imageOf(res), 'should not return an image');
    const text = textOf(res);
    assert.match(text, /Available baselines/);
    assert.match(text, /vapron\.ai/);
    assert.match(text, /route-slug: `index`/);
  });

  it('empty baseline dir explains how to create baselines', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-eyes-empty-'));
    try {
      const res = await mcp.handleGetVisualDiff({ path: emptyRoot, route: '/' });
      assert.match(textOf(res), /No visual baselines found/);
      assert.match(textOf(res), /visualRegression/);
    } finally {
      try { fs.rmSync(emptyRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('respects explicit baselineDir override', async () => {
    const res = await mcp.handleGetVisualDiff({
      path: 'C:/definitely/not/a/real/project',
      baselineDir,
      route: '/',
      panel: 'baseline',
    });
    assert.ok(imageOf(res), `expected image via explicit baselineDir, got: ${textOf(res)}`);
  });

  it('maxWidth downscales the returned image', async () => {
    const res = await mcp.handleGetVisualDiff({ path: projectRoot, route: '/', panel: 'baseline', maxWidth: 20 });
    const img = imageOf(res);
    const decoded = PNG.sync.read(Buffer.from(img.data, 'base64'));
    assert.strictEqual(decoded.width, 20);
  });
});

describe('capture_screenshot — validation + real-browser (skips without chromium)', () => {
  it('rejects a missing url', async () => {
    const res = await mcp.handleCaptureScreenshot({});
    assert.strictEqual(res.isError, true);
    assert.match(textOf(res), /url is required/);
  });

  it('captures a data: URL page when chromium is available', async (t) => {
    const res = await mcp.handleCaptureScreenshot({
      url: 'data:text/html,<body style="background:#0a0">GateTest eyes</body>',
      width: 320,
      height: 240,
      waitMs: 50,
    });
    const text = textOf(res);
    if (/Screenshot unavailable/.test(text)) {
      t.skip(`no browser in this environment: ${text.split('\n')[0]}`);
      return;
    }
    const img = imageOf(res);
    assert.ok(img, `expected an image, got: ${text}`);
    assert.strictEqual(img.mimeType, 'image/jpeg');
    assert.ok(Buffer.from(img.data, 'base64').length > 500, 'jpeg should have real content');
    assert.match(text, /Captured data:/);
  });
});
