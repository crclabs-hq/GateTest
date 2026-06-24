/**
 * Tests for website/app/lib/cross-repo-prior-art.js — the CONSUME side of
 * the cross-repo flywheel. Verifies the diff-shape classifier agrees with
 * the promoter's fingerprint scheme, corpus hits surface as annotations,
 * and every failure mode degrades to "no prior art" instead of throwing.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PriorArt = require('../website/app/lib/cross-repo-prior-art');
const CrossRepoPromoter = require('../website/app/lib/trainers/cross-repo-promoter');

function tmpCorpus() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-prior-art-'));
}

// A 1-line token-swap fix: added=1, removed=1 → operatorClass 'token-swap'.
const SWAP_ORIGINAL = 'const a = 1;\nconst b = parseFloat(amount);\nmodule.exports = a;\n';
const SWAP_FIXED = 'const a = 1;\nconst b = new Decimal(amount);\nmodule.exports = a;\n';

function writeMatchingVector(corpusDir, { file, original, fixed, sampleSize = 3 }) {
  const shape = PriorArt._diffShapeForFix(original, fixed);
  const oc = CrossRepoPromoter._operatorClass({
    sampleDiffs: [{ added: shape.added, removed: shape.removed, files: [file] }],
  });
  const extMatch = /\.([a-zA-Z0-9]+)$/.exec(file);
  const fileExt = extMatch ? '.' + extMatch[1].toLowerCase() : null;
  const fp = CrossRepoPromoter._fingerprint({ operatorClass: oc, fileExt, diffShape: shape });
  const vector = {
    fingerprint: fp,
    operatorClass: oc,
    fileExt,
    diffShape: shape,
    plausibilityScore: 0.8,
    sampleSize,
    sourceRepoHash: 'deadbeef',
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(corpusDir, `${fp}.json`), JSON.stringify(vector), 'utf8');
  return vector;
}

test('diffShapeForFix counts added/removed lines', () => {
  const shape = PriorArt._diffShapeForFix(SWAP_ORIGINAL, SWAP_FIXED);
  assert.deepStrictEqual(shape, { added: 1, removed: 1, fileCount: 1, hunkCount: 0 });
});

test('diffShapeForFix returns null for oversized files', () => {
  const big = Array.from({ length: 2001 }, (_, i) => `line ${i}`).join('\n');
  assert.strictEqual(PriorArt._diffShapeForFix(big, big + '\nextra'), null);
});

test('lookupPriorArt returns null when corpus dir does not exist', () => {
  const hit = PriorArt.lookupPriorArt(
    { file: 'src/money.js', original: SWAP_ORIGINAL, fixed: SWAP_FIXED },
    { corpusDir: path.join(os.tmpdir(), 'gatetest-no-such-dir-' + Date.now()) }
  );
  assert.strictEqual(hit, null);
});

test('lookupPriorArt returns null for a no-op fix', () => {
  const dir = tmpCorpus();
  const hit = PriorArt.lookupPriorArt(
    { file: 'src/money.js', original: SWAP_ORIGINAL, fixed: SWAP_ORIGINAL },
    { corpusDir: dir }
  );
  assert.strictEqual(hit, null);
});

test('lookupPriorArt finds a matching corpus vector', () => {
  const dir = tmpCorpus();
  writeMatchingVector(dir, { file: 'src/money.js', original: SWAP_ORIGINAL, fixed: SWAP_FIXED, sampleSize: 5 });
  const hit = PriorArt.lookupPriorArt(
    { file: 'src/money.js', original: SWAP_ORIGINAL, fixed: SWAP_FIXED },
    { corpusDir: dir }
  );
  assert.ok(hit, 'expected a corpus hit');
  assert.strictEqual(hit.operatorClass, 'token-swap');
  assert.strictEqual(hit.fileExt, '.js');
  assert.strictEqual(hit.sampleSize, 5);
});

test('lookupPriorArt misses when fileExt differs', () => {
  const dir = tmpCorpus();
  writeMatchingVector(dir, { file: 'src/money.js', original: SWAP_ORIGINAL, fixed: SWAP_FIXED });
  const hit = PriorArt.lookupPriorArt(
    { file: 'src/money.py', original: SWAP_ORIGINAL, fixed: SWAP_FIXED },
    { corpusDir: dir }
  );
  assert.strictEqual(hit, null);
});

test('lookupPriorArt survives a malformed vector file', () => {
  const dir = tmpCorpus();
  const v = writeMatchingVector(dir, { file: 'src/money.js', original: SWAP_ORIGINAL, fixed: SWAP_FIXED });
  fs.writeFileSync(path.join(dir, `${v.fingerprint}.json`), '{not json', 'utf8');
  const hit = PriorArt.lookupPriorArt(
    { file: 'src/money.js', original: SWAP_ORIGINAL, fixed: SWAP_FIXED },
    { corpusDir: dir }
  );
  assert.strictEqual(hit, null);
});

test('lookupPriorArt tolerates garbage input without throwing', () => {
  assert.strictEqual(PriorArt.lookupPriorArt(null), null);
  assert.strictEqual(PriorArt.lookupPriorArt({}), null);
  assert.strictEqual(PriorArt.lookupPriorArt({ file: 42 }), null);
});

test('annotateFixesWithPriorArt returns only fixes with hits', () => {
  const dir = tmpCorpus();
  writeMatchingVector(dir, { file: 'src/money.js', original: SWAP_ORIGINAL, fixed: SWAP_FIXED, sampleSize: 2 });
  const annotations = PriorArt.annotateFixesWithPriorArt(
    [
      { file: 'src/money.js', original: SWAP_ORIGINAL, fixed: SWAP_FIXED },
      { file: 'src/other.py', original: 'x = 1\n', fixed: 'x = 2\n' },
    ],
    { corpusDir: dir }
  );
  assert.strictEqual(annotations.length, 1);
  assert.strictEqual(annotations[0].file, 'src/money.js');
  assert.strictEqual(annotations[0].priorArt.sampleSize, 2);
});

test('annotateFixesWithPriorArt handles non-array input', () => {
  assert.deepStrictEqual(PriorArt.annotateFixesWithPriorArt(null), []);
  assert.deepStrictEqual(PriorArt.annotateFixesWithPriorArt(undefined), []);
});

test('renderPriorArtSection renders one bullet per annotation', () => {
  const md = PriorArt.renderPriorArtSection([
    { file: 'src/money.js', priorArt: { operatorClass: 'token-swap', sampleSize: 4 } },
  ]);
  assert.match(md, /### Cross-repo prior art/);
  assert.match(md, /`src\/money\.js` — token-swap fix shape seen 4× in the corpus/);
});

test('renderPriorArtSection returns empty string for no annotations', () => {
  assert.strictEqual(PriorArt.renderPriorArtSection([]), '');
  assert.strictEqual(PriorArt.renderPriorArtSection(null), '');
});
