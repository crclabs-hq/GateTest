import js from '@eslint/js';

// Node globals used across src/, bin/, lib/, integrations/ — hand-rolled
// instead of pulling in the `globals` package to avoid an extra dependency
// for a handful of well-known identifiers.
const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  structuredClone: 'readonly',
};

// Browser globals for files that embed page.evaluate()-style callbacks —
// code that runs inside a headless-browser context, not Node. These files
// live in Node but author snippets executed via Playwright/Puppeteer.
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  CSS: 'readonly',
  Node: 'readonly',
  NodeList: 'readonly',
  HTMLElement: 'readonly',
  Element: 'readonly',
  getComputedStyle: 'readonly',
  performance: 'readonly',
  PerformanceObserver: 'readonly',
  MutationObserver: 'readonly',
  IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
};

const BROWSER_EVAL_FILES = [
  'src/core/screenshot-capture.js',
  'src/core/visual-facts.js',
  'src/modules/accessibility.js',
  'src/modules/chaos.js',
  'src/modules/design-system-compliance.js',
  'src/modules/explorer.js',
  'src/modules/form-testing.js',
  'src/modules/interactive-elements.js',
  'src/modules/live-crawler-browser-engine.js',
  'src/modules/mobile-rendering.js',
  'src/modules/performance-budget.js',
  'src/modules/runtime-errors.js',
  'src/modules/visual-regression.js',
];

export default [
  {
    // This repo's root is bigger than the four directories this config
    // actually covers (fixture corpora, docs, a VS Code extension, a WP
    // plugin, the separately-linted website/ …). Without an exhaustive
    // ignore list, `eslint .` (run by src/modules/lint.js — GateTest's own
    // self-scan — once it finds *any* root config) discovers those files
    // too, applies zero rules to them (none of the `files` patterns below
    // match), but still parses them with default settings — which false-
    // positived on legitimate CommonJS `return` statements outside our
    // target dirs and on unrelated eslint-disable comments referencing
    // plugins we don't load. Every top-level dir except src/bin/lib/
    // integrations (and node_modules) must be listed here.
    ignores: [
      'node_modules/**',
      'website/**',
      'benchmarks/**',
      'reliability-corpus/**',
      'corpus/**',
      'demo/**',
      'docs/**',
      'editors/**',
      'packages/**',
      'scripts/**',
      'tests/**',
      'arena-scaffold/**',
      'vscode-extension/**',
      'wp-plugin/**',
      '.gatetest/**',
      'coverage/**',
      'dist/**',
      'setup.js',
    ],
  },
  {
    files: ['src/**/*.js', 'bin/**/*.js', 'lib/**/*.js', 'integrations/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // These modules ARE the security/obfuscation-detection engine — control
      // characters and joined-codepoint character classes are exactly what
      // they match against (ANSI escapes, null bytes, homoglyph sequences).
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
    },
  },
  {
    // bin/gatetest-mcp.mjs — the sole ESM file in these directories.
    files: ['bin/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: BROWSER_EVAL_FILES,
    languageOptions: {
      globals: { ...nodeGlobals, ...browserGlobals },
    },
  },
];
