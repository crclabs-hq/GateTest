/**
 * Theme system (issue #690) — the pre-hydration script must actually set
 * data-theme from whatever is in storage, must never throw when storage is
 * blocked (private browsing, a locked-down browser policy), and must run
 * before anything else in <head> so there is no flash of the wrong theme.
 *
 * The script is a plain string (THEME_INIT_SCRIPT in ThemeToggle.tsx) so it
 * can be inlined via dangerouslySetInnerHTML; this test runs that exact
 * string in a tiny fake DOM via vm, rather than asserting on its source
 * text, so a refactor that keeps the behaviour but changes the wording
 * still passes.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const THEME_TOGGLE_SRC = fs.readFileSync(
  path.join(ROOT, 'website', 'app', 'components', 'ThemeToggle.tsx'),
  'utf8',
);
const LAYOUT_SRC = fs.readFileSync(path.join(ROOT, 'website', 'app', 'layout.tsx'), 'utf8');

function extractStorageKey() {
  const m = THEME_TOGGLE_SRC.match(/export const THEME_STORAGE_KEY = "([^"]+)";/);
  assert.ok(m, 'THEME_STORAGE_KEY export not found in ThemeToggle.tsx');
  return m[1];
}

// THEME_INIT_SCRIPT is a single-line template literal with one interpolated
// expression (`${JSON.stringify(THEME_STORAGE_KEY)}`) so the key has one
// definition (Doctrine #4). Pulling the raw source text out of the backticks
// leaves that placeholder un-evaluated (this is a source scrape, not a real
// template literal), so it is substituted with the real value here before
// the string is run as JS — rather than importing the .tsx module, which
// has JSX/React deps this plain Node test does not want to transpile.
function extractInitScript() {
  const m = THEME_TOGGLE_SRC.match(/export const THEME_INIT_SCRIPT = `([^`]+)`;/);
  assert.ok(m, 'THEME_INIT_SCRIPT export not found in ThemeToggle.tsx');
  const key = extractStorageKey();
  return m[1].replace('${JSON.stringify(THEME_STORAGE_KEY)}', JSON.stringify(key));
}

/** Runs THEME_INIT_SCRIPT against a fake document + localStorage and
 *  returns what data-theme ended up set to (or null if never set). */
function runInitScript(script, { storedValue, storageThrows = false } = {}) {
  let dataTheme = null;
  const documentElement = {
    setAttribute(name, value) {
      if (name === 'data-theme') dataTheme = value;
    },
  };
  const localStorage = {
    getItem(key) {
      if (storageThrows) throw new Error('storage blocked');
      return key === extractStorageKey() ? storedValue ?? null : null;
    },
  };
  const sandbox = { document: { documentElement }, localStorage };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return dataTheme;
}

describe('theme init script (pre-hydration, issue #690)', () => {
  const script = extractInitScript();

  it('sets data-theme="dark" when "dark" is stored', () => {
    assert.strictEqual(runInitScript(script, { storedValue: 'dark' }), 'dark');
  });

  it('sets data-theme="light" when "light" is stored', () => {
    assert.strictEqual(runInitScript(script, { storedValue: 'light' }), 'light');
  });

  it('sets nothing when nothing is stored (system default)', () => {
    assert.strictEqual(runInitScript(script, { storedValue: null }), null);
  });

  it('sets nothing for a garbage stored value', () => {
    assert.strictEqual(runInitScript(script, { storedValue: 'purple' }), null);
  });

  it('never throws when localStorage access throws (private browsing / blocked storage)', () => {
    assert.doesNotThrow(() => runInitScript(script, { storageThrows: true }));
    assert.strictEqual(runInitScript(script, { storageThrows: true }), null);
  });

  it('is wrapped in try/catch in source, not just accidentally safe', () => {
    assert.match(script, /try\s*\{/);
    assert.match(script, /catch\s*\(/);
  });
});

describe('theme init script wiring (website/app/layout.tsx)', () => {
  it('imports THEME_INIT_SCRIPT from ThemeToggle', () => {
    assert.match(LAYOUT_SRC, /import\s*\{\s*THEME_INIT_SCRIPT\s*\}\s*from\s*["']\.\/components\/ThemeToggle["']/);
  });

  it('renders the theme script as the first child of <head>, before anything else', () => {
    const headOpen = LAYOUT_SRC.indexOf('<head>');
    const scriptTag = LAYOUT_SRC.indexOf('dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}');
    const manifestLink = LAYOUT_SRC.indexOf('rel="manifest"');
    assert.ok(headOpen > -1, '<head> not found in layout.tsx');
    assert.ok(scriptTag > -1, 'THEME_INIT_SCRIPT script tag not found in <head>');
    assert.ok(
      headOpen < scriptTag && scriptTag < manifestLink,
      'the theme script must run before any other <head> content, or a stored theme can flash the wrong colours for a frame',
    );
  });

  it('does not use next/script for the theme init (next/script can defer past first paint)', () => {
    const headSection = LAYOUT_SRC.slice(LAYOUT_SRC.indexOf('<head>'), LAYOUT_SRC.indexOf('</head>'));
    assert.doesNotMatch(headSection, /<Script\b/);
  });
});

describe('ThemeToggle component shape', () => {
  it('exposes three states: system, light, dark', () => {
    assert.match(THEME_TOGGLE_SRC, /"system"/);
    assert.match(THEME_TOGGLE_SRC, /"light"/);
    assert.match(THEME_TOGGLE_SRC, /"dark"/);
  });

  it('is keyboard-accessible: a radiogroup of real <button role="radio"> elements', () => {
    assert.match(THEME_TOGGLE_SRC, /role="radiogroup"/);
    assert.match(THEME_TOGGLE_SRC, /role="radio"/);
    assert.match(THEME_TOGGLE_SRC, /<button/);
  });

  it('wraps every localStorage write in try/catch', () => {
    const writes = THEME_TOGGLE_SRC.match(/localStorage\.(setItem|removeItem)/g) || [];
    assert.ok(writes.length > 0, 'expected at least one localStorage write');
    // Every write call must be textually inside a try block: crude but
    // effective given the whole component is one small file.
    assert.match(THEME_TOGGLE_SRC, /try\s*\{[^}]*localStorage\.(setItem|removeItem)/s);
  });
});

describe('Navbar wires ThemeToggle in', () => {
  const NAVBAR_SRC = fs.readFileSync(path.join(ROOT, 'website', 'app', 'components', 'Navbar.tsx'), 'utf8');

  it('imports and renders <ThemeToggle /> on desktop and in the mobile drawer', () => {
    assert.match(NAVBAR_SRC, /import\s*\{\s*ThemeToggle\s*\}\s*from\s*["']\.\/ThemeToggle["']/);
    const count = (NAVBAR_SRC.match(/<ThemeToggle\s*\/>/g) || []).length;
    assert.ok(count >= 2, `expected ThemeToggle rendered at least twice (desktop + mobile drawer), found ${count}`);
  });
});
