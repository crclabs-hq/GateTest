'use strict';

// ADMIN INPUT CONTRAST — 2026-10-01, Craig: "when we enter information into
// the white bars i can barely see the writing". Measured in Chromium before
// the fix: the Platforms org box and all three GitHub Accounts boxes rendered
// typed text at 1.18:1 in dark mode (near-white on white); after it, every one
// of 38 admin inputs across 18 views was >= 15:1 in both themes.
//
// Two causes, both closed in website/app/admin/admin.css:
//   1. inputs had no colours of their own and inherited the wrapper's text;
//   2. older tabs use light-only Tailwind utilities (bg-white, text-gray-*)
//      that stayed light while the admin shell turned dark.
// This file pins both: the input rule exists, and every light-only utility an
// admin file uses has a theme-aware mapping. A new `bg-gray-200` in an admin
// tab fails here until admin.css maps it (or the tab uses --gt-admin-* tokens).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN = path.join(__dirname, '..', 'website', 'app', 'admin');
const css = fs.readFileSync(path.join(ADMIN, 'admin.css'), 'utf8');

function adminSources(dir = ADMIN, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) adminSources(full, out);
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

// Light-only utilities that make text or surfaces unreadable in dark mode.
// Utilities that are dark on purpose (bg-gray-900 panels, text-white on a
// coloured button, text-gray-300 inside a dark panel) are not in scope.
const LIGHT_ONLY = /(?<![\w:/-])(?:hover:)?(?:bg-white|bg-(?:gray|slate)-(?:50|100)|text-black|text-(?:gray|slate)-(?:400|500|600|700|800|900)|border-(?:gray|slate)-(?:100|200|300)|divide-gray-100)(?![\w/-])/g;

describe('admin input contrast', () => {
  it('every admin text input, textarea and select takes theme colours from --gt-admin-* tokens', () => {
    const rule = css.match(/\.gt-admin-root :is\(input:not\([^{]*\{([^}]*)\}/);
    assert.ok(rule, 'the admin input rule is missing from admin.css');
    assert.match(rule[1], /background-color:\s*var\(--gt-admin-bg-alt\)/);
    assert.match(rule[1], /color:\s*var\(--gt-admin-fg\)/);
    assert.match(css, /\.gt-admin-root :is\(input, textarea\)::placeholder\s*\{[^}]*color:\s*var\(--gt-admin-muted\)/);
  });

  it('admin.css is not inside a Tailwind @layer, so its rules beat utility classes', () => {
    assert.doesNotMatch(css, /^\s*@layer\b/m);
  });

  it('every light-only utility used under website/app/admin has a theme-aware mapping', () => {
    const used = new Set();
    for (const file of adminSources()) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(LIGHT_ONLY)) used.add(m[0]);
    }
    assert.ok(used.has('bg-white'), 'control: the scan must see the utilities it guards');
    const unmapped = [...used].filter((u) => {
      const selector = `.${u.replace(':', '\\:')}`;
      return !css.includes(selector + ' ') && !css.includes(selector + ',') && !css.includes(selector + ')') && !css.includes(selector + ':hover');
    });
    assert.deepEqual(unmapped, [], `admin.css has no dark-mode mapping for: ${unmapped.join(', ')}`);
  });

  it('the mapped values are theme tokens defined for light, system-dark and explicit dark', () => {
    for (const token of ['--gt-admin-l-card', '--gt-admin-l-text-strong', '--gt-admin-l-text-4', '--gt-admin-l-line']) {
      const defs = css.split(`${token}:`).length - 1;
      assert.equal(defs, 3, `${token} must be defined in all three theme blocks (found ${defs})`);
    }
  });
});
