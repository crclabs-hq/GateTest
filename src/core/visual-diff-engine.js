/**
 * Visual Diff Engine — pure pixel-comparison algorithms for the
 * `visualRegression` module. Kept dependency-thin (pixelmatch + pngjs,
 * both pure JS, no native bindings) and free of any Playwright / browser
 * code so it can be unit-tested with synthetic PNG buffers.
 */

'use strict';

const { PNG } = require('pngjs');
// pixelmatch@7 ships ESM-only; CJS interop exposes the function on
// `.default` when required from a CommonJS module.
const pixelmatchModule = require('pixelmatch');
const pixelmatch = pixelmatchModule.default || pixelmatchModule;

/**
 * Decode a PNG buffer into raw RGBA pixel data.
 * @param {Buffer} buffer
 * @returns {{data: Buffer, width: number, height: number}}
 */
function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

/**
 * Encode raw RGBA pixel data into a PNG buffer.
 * @param {{data: Buffer, width: number, height: number}} raw
 * @returns {Buffer}
 */
function encodePng(raw) {
  const png = new PNG({ width: raw.width, height: raw.height });
  raw.data.copy(png.data);
  return PNG.sync.write(png);
}

/**
 * Pad an image's raw pixel buffer to a target width/height, filling new
 * area with a flat mid-grey so growth/shrinkage at the page edges shows
 * up as a real diff rather than crashing the comparator on a dimension
 * mismatch. Growth (more content) or shrinkage (less content) at the
 * bottom of a full-page screenshot is a legitimate regression signal.
 */
function padToSize(raw, width, height, fill = 128) {
  if (raw.width === width && raw.height === height) return raw;
  const data = Buffer.alloc(width * height * 4, fill);
  // alpha channel opaque so the fill doesn't get treated as transparent
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (let y = 0; y < raw.height; y++) {
    const srcStart = y * raw.width * 4;
    const dstStart = y * width * 4;
    raw.data.copy(data, dstStart, srcStart, srcStart + raw.width * 4);
  }
  return { data, width, height };
}

/**
 * Compare two PNG screenshot buffers.
 *
 * @param {Buffer} baselineBuffer
 * @param {Buffer} currentBuffer
 * @param {object} [options]
 * @param {number} [options.pixelThreshold=0.1] pixelmatch per-pixel sensitivity (0..1)
 * @returns {{
 *   diffPixels: number,
 *   totalPixels: number,
 *   diffPercent: number,
 *   width: number,
 *   height: number,
 *   dimensionMismatch: boolean,
 *   diffPngBuffer: Buffer,
 * }}
 */
function compareScreenshots(baselineBuffer, currentBuffer, options = {}) {
  const pixelThreshold = typeof options.pixelThreshold === 'number' ? options.pixelThreshold : 0.1;

  let baseline = decodePng(baselineBuffer);
  let current = decodePng(currentBuffer);

  const dimensionMismatch = baseline.width !== current.width || baseline.height !== current.height;
  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);

  if (dimensionMismatch) {
    baseline = padToSize(baseline, width, height);
    current = padToSize(current, width, height);
  }

  const diffData = Buffer.alloc(width * height * 4);
  const diffPixels = pixelmatch(baseline.data, current.data, diffData, width, height, {
    threshold: pixelThreshold,
    alpha: 0.3,
    diffColor: [255, 0, 0],
  });

  const totalPixels = width * height;
  const diffPercent = totalPixels === 0 ? 0 : (diffPixels / totalPixels) * 100;

  return {
    diffPixels,
    totalPixels,
    diffPercent,
    width,
    height,
    dimensionMismatch,
    diffPngBuffer: encodePng({ data: diffData, width, height }),
  };
}

/**
 * Stitch baseline / current / diff PNGs side-by-side into one composite
 * image for posting to Slack. All three inputs are padded to a common
 * height so mismatched dimensions don't throw.
 *
 * @param {Buffer} baselineBuffer
 * @param {Buffer} currentBuffer
 * @param {Buffer} diffBuffer
 * @returns {Buffer}
 */
function buildSideBySideComposite(baselineBuffer, currentBuffer, diffBuffer) {
  const panels = [decodePng(baselineBuffer), decodePng(currentBuffer), decodePng(diffBuffer)];
  const height = Math.max(...panels.map((p) => p.height));
  const gutter = 4;
  const normalised = panels.map((p) => padToSize(p, p.width, height));
  const totalWidth = normalised.reduce((sum, p) => sum + p.width, 0) + gutter * (panels.length - 1);

  const composite = { data: Buffer.alloc(totalWidth * height * 4, 40), width: totalWidth, height };
  for (let i = 3; i < composite.data.length; i += 4) composite.data[i] = 255;

  let xOffset = 0;
  for (const panel of normalised) {
    for (let y = 0; y < height; y++) {
      const srcStart = y * panel.width * 4;
      const dstStart = (y * totalWidth + xOffset) * 4;
      panel.data.copy(composite.data, dstStart, srcStart, srcStart + panel.width * 4);
    }
    xOffset += panel.width + gutter;
  }

  return encodePng(composite);
}

module.exports = {
  decodePng,
  encodePng,
  padToSize,
  compareScreenshots,
  buildSideBySideComposite,
};
