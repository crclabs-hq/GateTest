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

/**
 * Read a PNG's dimensions from the IHDR header without decoding pixel
 * data — a 1280×20000 full-page PNG decodes to ~100MB of RGBA, so callers
 * guard on area BEFORE decoding.
 *
 * @param {Buffer} buffer
 * @returns {{width: number, height: number} | null} null when not a PNG
 */
function readPngDimensions(buffer) {
  // PNG signature (8 bytes) + IHDR length/type (8 bytes) + width/height at 16/20
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null; // \x89PNG
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Downscale a PNG to a maximum width using a box filter (average of the
 * covered source rectangle per output pixel). Aspect ratio preserved.
 * Returns the input unchanged when it's already narrow enough.
 *
 * @param {Buffer} pngBuffer
 * @param {number} maxWidth
 * @returns {Buffer}
 */
function downscaleToWidth(pngBuffer, maxWidth) {
  const src = decodePng(pngBuffer);
  if (src.width <= maxWidth) return pngBuffer;

  const scale = maxWidth / src.width;
  const outW = maxWidth;
  const outH = Math.max(1, Math.round(src.height * scale));
  const out = Buffer.alloc(outW * outH * 4);

  for (let oy = 0; oy < outH; oy++) {
    const syStart = Math.floor(oy / scale);
    const syEnd = Math.min(src.height, Math.max(syStart + 1, Math.floor((oy + 1) / scale)));
    for (let ox = 0; ox < outW; ox++) {
      const sxStart = Math.floor(ox / scale);
      const sxEnd = Math.min(src.width, Math.max(sxStart + 1, Math.floor((ox + 1) / scale)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = syStart; sy < syEnd; sy++) {
        for (let sx = sxStart; sx < sxEnd; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n++;
        }
      }
      const o = (oy * outW + ox) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }

  return encodePng({ data: out, width: outW, height: outH });
}

/**
 * Re-encode a PNG under a byte budget by repeatedly downscaling ×0.75
 * until it fits or the width floor is hit. MCP transports practically cap
 * tool results around ~1MB and base64 inflates 33%, so image payloads
 * must be hard-bounded, not best-effort.
 *
 * @param {Buffer} pngBuffer
 * @param {number} maxBytes
 * @param {{minWidth?: number}} [opts]
 * @returns {{buffer: Buffer, width: number, height: number, downscaled: boolean}}
 */
function encodeUnderByteCap(pngBuffer, maxBytes, opts = {}) {
  const minWidth = opts.minWidth || 320;
  let buffer = pngBuffer;
  let dims = readPngDimensions(buffer) || { width: 0, height: 0 };
  let downscaled = false;

  while (buffer.length > maxBytes && dims.width > minWidth) {
    const nextWidth = Math.max(minWidth, Math.floor(dims.width * 0.75));
    buffer = downscaleToWidth(buffer, nextWidth);
    dims = readPngDimensions(buffer) || dims;
    downscaled = true;
  }

  return { buffer, width: dims.width, height: dims.height, downscaled };
}

module.exports = {
  decodePng,
  encodePng,
  padToSize,
  compareScreenshots,
  buildSideBySideComposite,
  readPngDimensions,
  downscaleToWidth,
  encodeUnderByteCap,
};
