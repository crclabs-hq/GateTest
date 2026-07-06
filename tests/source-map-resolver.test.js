'use strict';

// =============================================================================
// SOURCE-MAP RESOLVER — unit tests
// =============================================================================
// Zero-dependency Base64 VLQ decoder + Source Map V3 consumer. Round-trips
// the encoder/decoder for confidence, then exercises the full pipeline
// (mappings decode -> position lookup -> file loading -> stack parsing)
// against hand-built fixtures written to a real tmpdir.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  encodeVLQSegment,
  decodeVLQSegment,
  decodeMappings,
  findOriginalPosition,
  extractSourceMappingUrl,
  loadSourceMapForFile,
  resolveStackFrame,
  parseStackTrace,
  resolveStackTrace,
} = require('../src/core/source-map-resolver.js');

describe('VLQ encode/decode round trip', () => {
  it('round-trips positive, negative, zero, and large values', () => {
    for (const v of [0, 1, -1, 15, -15, 31, 32, -32, 1000, -1000, 123456, -123456]) {
      const encoded = encodeVLQSegment(v);
      const posRef = { i: 0 };
      const decoded = decodeVLQSegment(encoded, posRef);
      assert.strictEqual(decoded, v, `value ${v} round-tripped to ${decoded}`);
      assert.strictEqual(posRef.i, encoded.length);
    }
  });

  it('throws on an invalid VLQ character', () => {
    assert.throws(() => decodeVLQSegment('!!!', { i: 0 }));
  });
});

describe('decodeMappings', () => {
  it('decodes a single trivial segment (AAAA)', () => {
    const lines = decodeMappings('AAAA');
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(lines[0][0], { generatedColumn: 0, sourceIndex: 0, originalLine: 0, originalColumn: 0 });
  });

  it('decodes multiple segments across multiple lines with deltas', () => {
    const seg = (gc, si, ol, oc) => [gc, si, ol, oc].map(encodeVLQSegment).join('');
    const mappings = [seg(0, 0, 0, 0), seg(4, 0, 0, 4)].join(',') + ';' + seg(0, 0, 1, 0);
    const lines = decodeMappings(mappings);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0].length, 2);
    assert.strictEqual(lines[0][1].generatedColumn, 4);
    assert.strictEqual(lines[1][0].originalLine, 1);
    // generatedColumn resets each line
    assert.strictEqual(lines[1][0].generatedColumn, 0);
  });

  it('handles an empty mappings string', () => {
    const lines = decodeMappings('');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].length, 0);
  });
});

describe('findOriginalPosition', () => {
  const decoded = decodeMappings('AAAA,IAAI'); // seg0: gc0 -> (0,0,0); seg1: gc delta 4 -> gc4, then deltas 4,4,4
  const sources = ['a.js'];
  const names = [];

  it('returns the segment at or before the requested column', () => {
    const pos = findOriginalPosition(decoded, sources, names, 0, 0);
    assert.deepStrictEqual(pos, { source: 'a.js', line: 0, column: 0, name: null });
    const pos2 = findOriginalPosition(decoded, sources, names, 0, 10);
    assert.strictEqual(pos2.source, 'a.js');
  });

  it('returns null for an out-of-range generated line', () => {
    assert.strictEqual(findOriginalPosition(decoded, sources, names, 5, 0), null);
  });

  it('returns null for an empty line', () => {
    const lines = decodeMappings(';AAAA');
    assert.strictEqual(findOriginalPosition(lines, sources, names, 0, 0), null);
  });
});

describe('extractSourceMappingUrl', () => {
  it('finds a //# sourceMappingURL comment', () => {
    const url = extractSourceMappingUrl('var x=1;\n//# sourceMappingURL=x.js.map\n');
    assert.strictEqual(url, 'x.js.map');
  });

  it('returns the LAST occurrence when multiple exist', () => {
    const url = extractSourceMappingUrl('//# sourceMappingURL=old.map\ncode\n//# sourceMappingURL=new.map\n');
    assert.strictEqual(url, 'new.map');
  });

  it('returns null when absent', () => {
    assert.strictEqual(extractSourceMappingUrl('var x = 1;'), null);
  });
});

describe('end-to-end: external .map file + inline data URI', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-sourcemap-'));
  });

  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Generated line 0, column 9 (0-based) maps to original.js line 1, column 2 (0-based).
  const originalContent = 'function add(a, b) {\n  return a + b;\n}\n';
  const mappings = [9, 0, 1, 2].map(encodeVLQSegment).join('');
  const mapJson = JSON.stringify({
    version: 3,
    sources: ['original.js'],
    sourcesContent: [originalContent],
    names: [],
    mappings,
  });

  it('resolves a frame via an external sibling .map file', () => {
    const bundlePath = path.join(dir, 'bundle.js');
    fs.writeFileSync(bundlePath, 'function add(a,b){return a+b}\n//# sourceMappingURL=bundle.js.map\n');
    fs.writeFileSync(path.join(dir, 'bundle.js.map'), mapJson);

    const loaded = loadSourceMapForFile(bundlePath);
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(loaded.map.sources[0], 'original.js');

    // V8 stack traces are 1-based: line 1, column 10 -> generated (0, 9).
    const res = resolveStackFrame({ file: bundlePath, line: 1, column: 10 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.original.source, 'original.js');
    assert.strictEqual(res.original.line, 2);
    assert.strictEqual(res.original.column, 3);
    assert.strictEqual(res.original.snippet.trim(), 'return a + b;');
  });

  it('resolves a frame via an inline base64 data: URI', () => {
    const bundlePath = path.join(dir, 'bundle-inline.js');
    const b64 = Buffer.from(mapJson, 'utf8').toString('base64');
    fs.writeFileSync(
      bundlePath,
      `function add(a,b){return a+b}\n//# sourceMappingURL=data:application/json;base64,${b64}\n`,
    );

    const res = resolveStackFrame({ file: bundlePath, line: 1, column: 10 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.original.line, 2);
    assert.strictEqual(res.original.column, 3);
  });

  it('fails gracefully when the file has no sourceMappingURL comment', () => {
    const bundlePath = path.join(dir, 'no-map.js');
    fs.writeFileSync(bundlePath, 'function noop(){}\n');
    const res = resolveStackFrame({ file: bundlePath, line: 1, column: 1 });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /no sourceMappingURL/);
  });

  it('fails gracefully when the file does not exist', () => {
    const res = resolveStackFrame({ file: path.join(dir, 'missing.js'), line: 1, column: 1 });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /cannot read/);
  });

  it('fails gracefully when required args are missing', () => {
    const res = resolveStackFrame({ file: null, line: 1 });
    assert.strictEqual(res.ok, false);
  });
});

describe('parseStackTrace', () => {
  it('parses V8-style frames with a function name', () => {
    const frames = parseStackTrace('Error: boom\n    at add (/tmp/x/bundle.js:1:10)\n');
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].functionName, 'add');
    assert.strictEqual(frames[0].file, '/tmp/x/bundle.js');
    assert.strictEqual(frames[0].line, 1);
    assert.strictEqual(frames[0].column, 10);
  });

  it('parses V8-style frames with no function name', () => {
    const frames = parseStackTrace('    at /tmp/x/bundle.js:2:5\n');
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].functionName, null);
  });

  it('parses Firefox/Safari-style frames', () => {
    const frames = parseStackTrace('add@/tmp/x/bundle.js:1:10\n');
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].functionName, 'add');
    assert.strictEqual(frames[0].line, 1);
  });

  it('skips unrecognised lines instead of throwing', () => {
    const frames = parseStackTrace('Error: boom\nsome nonsense line\n');
    assert.strictEqual(frames.length, 0);
  });

  it('returns an empty array for non-string input', () => {
    assert.deepStrictEqual(parseStackTrace(undefined), []);
  });
});

describe('resolveStackTrace end-to-end', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-sourcemap-trace-'));
  });

  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('resolves the frames it can and reports the rest as unresolved', () => {
    const bundlePath = path.join(dir, 'bundle.js');
    const mapJson = JSON.stringify({
      version: 3,
      sources: ['original.js'],
      sourcesContent: ['function add(a, b) {\n  return a + b;\n}\n'],
      names: [],
      mappings: [9, 0, 1, 2].map(encodeVLQSegment).join(''),
    });
    fs.writeFileSync(bundlePath, 'function add(a,b){return a+b}\n//# sourceMappingURL=bundle.js.map\n');
    fs.writeFileSync(path.join(dir, 'bundle.js.map'), mapJson);

    const stack = [
      'Error: boom',
      `    at add (${bundlePath}:1:10)`,
      '    at Module._compile (node:internal/modules/cjs/loader:1105:14)',
    ].join('\n');

    const resolved = resolveStackTrace(stack);
    assert.strictEqual(resolved.length, 2);
    assert.strictEqual(resolved[0].resolution.ok, true);
    assert.strictEqual(resolved[0].resolution.original.line, 2);
    assert.strictEqual(resolved[1].resolution.ok, false);
  });
});
