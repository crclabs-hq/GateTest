// =============================================================================
// SIBLING PLATFORMS ARE NOT "GATED BY" OR "AUDITED BY" GATETEST — issue #715.
// =============================================================================
// Owner concern, 23 Sep: copy that reads "Code on Gluecron, audited by
// GateTest" or "gated by GateTest at push-time" tells a reader Gluecron and
// Tallrig are not safe without GateTest. False — Gluecron has its own CI
// gate and Tallrig its own deploy gate; GateTest is an optional audit layer
// for either. Decision rule (owner): marketing copy that names a sibling
// platform is agreed with that platform before it ships, and never implies
// the sibling depends on GateTest to function.
//
// This guard fails on the phrase "audited by GateTest" or "gated by
// GateTest" appearing within 80 characters of "Gluecron" or "Tallrig"
// anywhere under website/app, in either order, so the phrase cannot come
// back attached to a sibling's name even if the two are separated by other
// text in between.
// =============================================================================
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'website', 'app');

const EXT = new Set(['.tsx', '.ts', '.js', '.jsx', '.md', '.mdx']);
const WINDOW = 80;

const BANNED_PHRASES = [/audited by GateTest/i, /gated by GateTest/i];
const SIBLINGS = [/Gluecron/, /Tallrig/];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walk(full);
    } else if (EXT.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

/** Every match position (start index) for a regex over a string, global-safe. */
function matchStarts(re, text) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const starts = [];
  let m;
  while ((m = g.exec(text)) !== null) {
    starts.push(m.index);
    if (m[0].length === 0) g.lastIndex++;
  }
  return starts;
}

describe('public copy — sibling platforms are never "audited/gated by GateTest" (issue #715)', () => {
  it('no banned phrase within 80 characters of a sibling platform name, anywhere under website/app', () => {
    const hits = [];
    for (const file of walk(APP)) {
      const text = fs.readFileSync(file, 'utf8');
      const bannedStarts = BANNED_PHRASES.flatMap((re) => matchStarts(re, text));
      if (bannedStarts.length === 0) continue;
      const siblingStarts = SIBLINGS.flatMap((re) => matchStarts(re, text));
      if (siblingStarts.length === 0) continue;

      for (const b of bannedStarts) {
        for (const s of siblingStarts) {
          if (Math.abs(b - s) <= WINDOW) {
            const lineNo = text.slice(0, b).split('\n').length;
            hits.push(`${path.relative(ROOT, file)}:${lineNo}: banned phrase within ${WINDOW} chars of a sibling name`);
          }
        }
      }
    }
    assert.deepStrictEqual(hits, [], `sibling-dependency phrasing found:\n${hits.join('\n')}`);
  });

  it('the guard itself is not vacuous', () => {
    const text = 'Code on Gluecron, audited by GateTest: push triggers a scan.';
    const bannedStarts = BANNED_PHRASES.flatMap((re) => matchStarts(re, text));
    const siblingStarts = SIBLINGS.flatMap((re) => matchStarts(re, text));
    assert.ok(bannedStarts.length > 0 && siblingStarts.length > 0);
    assert.ok(Math.abs(bannedStarts[0] - siblingStarts[0]) <= WINDOW);
  });
});
