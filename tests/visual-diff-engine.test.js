'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const {
  compareScreenshots,
  buildSideBySideComposite,
  padToSize,
  decodePng,
  encodePng,
} = require('../src/core/visual-diff-engine.js');

function solidPng(width, height, [r, g, b]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('compareScreenshots reports 0% diff for identical images', () => {
  const buf = solidPng(8, 8, [10, 20, 30]);
  const result = compareScreenshots(buf, buf);
  assert.equal(result.diffPercent, 0);
  assert.equal(result.diffPixels, 0);
  assert.equal(result.dimensionMismatch, false);
  assert.ok(Buffer.isBuffer(result.diffPngBuffer));
});

test('compareScreenshots reports ~100% diff for fully different images', () => {
  const black = solidPng(8, 8, [0, 0, 0]);
  const white = solidPng(8, 8, [255, 255, 255]);
  const result = compareScreenshots(black, white);
  assert.equal(result.diffPixels, 64);
  assert.equal(result.diffPercent, 100);
});

test('compareScreenshots handles a partial diff proportionally', () => {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(0);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  const baseline = PNG.sync.write(png);

  // Flip exactly one quadrant pixel to white.
  const modified = new PNG({ width: 4, height: 4 });
  png.data.copy(modified.data);
  const idx = (0 * 4 + 0) * 4;
  modified.data[idx] = 255;
  modified.data[idx + 1] = 255;
  modified.data[idx + 2] = 255;
  const current = PNG.sync.write(modified);

  const result = compareScreenshots(baseline, current);
  assert.equal(result.totalPixels, 16);
  assert.equal(result.diffPixels, 1);
  assert.equal(result.diffPercent, (1 / 16) * 100);
});

test('compareScreenshots pads mismatched dimensions instead of throwing', () => {
  const small = solidPng(4, 4, [0, 0, 0]);
  const large = solidPng(4, 8, [0, 0, 0]);
  const result = compareScreenshots(small, large);
  assert.equal(result.dimensionMismatch, true);
  assert.equal(result.width, 4);
  assert.equal(result.height, 8);
  // The extra 4x4 region counts as diff (page got taller).
  assert.ok(result.diffPixels > 0);
});

test('padToSize is a no-op when dimensions already match', () => {
  const raw = decodePng(solidPng(3, 3, [1, 2, 3]));
  const padded = padToSize(raw, 3, 3);
  assert.equal(padded, raw);
});

test('padToSize grows the canvas and preserves original pixels', () => {
  const raw = decodePng(solidPng(2, 2, [9, 9, 9]));
  const padded = padToSize(raw, 4, 4);
  assert.equal(padded.width, 4);
  assert.equal(padded.height, 4);
  // Original top-left pixel preserved.
  assert.equal(padded.data[0], 9);
});

test('encodePng/decodePng round-trip', () => {
  const buf = solidPng(5, 5, [11, 22, 33]);
  const raw = decodePng(buf);
  const reencoded = encodePng(raw);
  const roundTripped = decodePng(reencoded);
  assert.equal(roundTripped.width, 5);
  assert.equal(roundTripped.height, 5);
  assert.equal(roundTripped.data[0], 11);
});

test('buildSideBySideComposite stitches three panels into one wider image', () => {
  const baseline = solidPng(4, 4, [255, 0, 0]);
  const current = solidPng(4, 4, [0, 255, 0]);
  const diff = solidPng(4, 4, [0, 0, 255]);
  const composite = buildSideBySideComposite(baseline, current, diff);
  const decoded = decodePng(composite);
  // 3 panels of width 4 + 2 gutters of width 4 = 20
  assert.equal(decoded.width, 4 * 3 + 4 * 2);
  assert.equal(decoded.height, 4);
});

test('buildSideBySideComposite handles panels of different heights', () => {
  const baseline = solidPng(4, 4, [255, 0, 0]);
  const current = solidPng(4, 8, [0, 255, 0]);
  const diff = solidPng(4, 4, [0, 0, 255]);
  const composite = buildSideBySideComposite(baseline, current, diff);
  const decoded = decodePng(composite);
  assert.equal(decoded.height, 8);
});

// ── downscale + byte-cap helpers (MCP eyes payload safety) ──────────────────

const {
  readPngDimensions,
  downscaleToWidth,
  encodeUnderByteCap,
} = require('../src/core/visual-diff-engine.js');

function gradientPng(width, height) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = (x * 255 / width) | 0;
      png.data[i + 1] = (y * 255 / height) | 0;
      png.data[i + 2] = ((x + y) * 127 / (width + height)) | 0;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

test('readPngDimensions reads IHDR without decoding pixels', () => {
  const buf = gradientPng(64, 48);
  assert.deepEqual(readPngDimensions(buf), { width: 64, height: 48 });
});

test('readPngDimensions returns null for non-PNG buffers', () => {
  assert.equal(readPngDimensions(Buffer.from('not a png at all, definitely')), null);
  assert.equal(readPngDimensions(Buffer.alloc(4)), null);
});

test('downscaleToWidth halves dimensions and preserves aspect ratio', () => {
  const buf = gradientPng(64, 32);
  const out = downscaleToWidth(buf, 32);
  const dims = readPngDimensions(out);
  assert.equal(dims.width, 32);
  assert.equal(dims.height, 16);
});

test('downscaleToWidth is a no-op when already narrow enough', () => {
  const buf = gradientPng(32, 32);
  assert.equal(downscaleToWidth(buf, 64), buf);
});

test('downscaleToWidth box-filter averages colors (solid stays solid)', () => {
  const buf = solidPng(40, 40, [100, 150, 200]);
  const out = downscaleToWidth(buf, 20);
  const decoded = decodePng(out);
  // Sample the center pixel — box filter of a solid color is the same color.
  const i = (10 * 20 + 10) * 4;
  assert.equal(decoded.data[i], 100);
  assert.equal(decoded.data[i + 1], 150);
  assert.equal(decoded.data[i + 2], 200);
});

test('encodeUnderByteCap terminates at minWidth and reports downscaled', () => {
  const buf = gradientPng(512, 512); // gradient compresses poorly-ish
  const capped = encodeUnderByteCap(buf, 1, { minWidth: 320 }); // impossible cap
  assert.equal(capped.downscaled, true);
  assert.ok(capped.width >= 320 * 0.75 && capped.width <= 320, `width ${capped.width} should stop at/near floor`);
});

test('encodeUnderByteCap leaves small images untouched', () => {
  const buf = gradientPng(64, 64);
  const capped = encodeUnderByteCap(buf, 10_000_000);
  assert.equal(capped.downscaled, false);
  assert.equal(capped.buffer, buf);
  assert.equal(capped.width, 64);
});

test('encodeUnderByteCap actually gets under an achievable cap', () => {
  const big = gradientPng(800, 800);
  const target = Math.floor(big.length / 2);
  const capped = encodeUnderByteCap(big, target, { minWidth: 32 });
  assert.ok(capped.buffer.length <= target, `expected <= ${target}, got ${capped.buffer.length}`);
  assert.equal(capped.downscaled, true);
});
