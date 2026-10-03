// a11y:reduced-motion-js matches animation libraries as tokens: Gluecron's
// compare.tsx read `commitsBetween.length` as a `tween.` call (2026-10-03).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const AccessibilityModule = require('../src/modules/accessibility');

function fired(content) {
  const checks = [];
  new AccessibilityModule()._checkReducedMotion('src/x.tsx', content, { addCheck(n, p) { checks.push({ n, p }); } });
  return checks.some((c) => !c.p && c.n.startsWith('a11y:reduced-motion-js:'));
}

describe('a11y:reduced-motion-js — tokens, not substrings', () => {
  it('an identifier ending in "tween" is not a tween library', () => {
    assert.strictEqual(fired('const n = commitsBetween.length; const m = inBetween.size;'), false);
  });
  it('control: tween./TWEEN./gsap./.animate( still fire', () => {
    assert.strictEqual(fired('tween.to(el, { x: 10 });'), true);
    assert.strictEqual(fired('new TWEEN.Tween(pos);'), true);
    assert.strictEqual(fired('gsap.to(".box", { x: 100 });'), true);
    assert.strictEqual(fired('el.animate([{ opacity: 0 }], 300);'), true);
  });
  it('control: a prefers-reduced-motion check still exempts', () => {
    assert.strictEqual(fired('if (!matchMedia("(prefers-reduced-motion: reduce)").matches) gsap.to(el, {});'), false);
  });
});
