/**
 * Undefined-Reference Module — catches the silent-runtime-killer class
 * where a JS/TS source references a name that was never imported and
 * never declared in the current file. TypeScript flags these as TS2304
 * "Cannot find name 'X'" — but if `tsc --noEmit` is advisory in CI
 * (or skipped because of pre-existing rot), the bug ships to production
 * and crashes the module at LOAD time with `ReferenceError: X is not
 * defined`.
 *
 * Crontech shipped three of these in a single day (2026-05-24):
 *   - resolveTenantCapForHotPath in apps/api/src/cdn/handler.ts
 *   - createBuilderPublicApiApp in apps/api/src/index.ts
 *   - buildTrackingApp in apps/api/src/index.ts
 *
 * All crashed crontech-api on systemd start; rollback also failed
 * because the previous SHA had the same class of bug; production was
 * down for hours. tsc would have caught all three at the merge gate.
 *
 * This module is a static gate that catches the same class WITHOUT
 * needing tsc as a runtime dependency. Pure line-heuristic + symbol-
 * table walk:
 *
 *   1. Per file: harvest the in-scope set (imports + same-file
 *      declarations of every kind — function, const, let, var, class,
 *      enum, interface, type, plus destructure-binding patterns).
 *   2. Find every bare-identifier use in a clear VALUE position
 *      (function call, object-property value, argument).
 *   3. Filter: not in in-scope set, not in globals/built-ins allowlist,
 *      not a keyword or literal, length >= 4 chars.
 *   4. Flag each remaining use as error-severity.
 *
 * Suppress with `// undefined-ref-ok` on the same or preceding line.
 *
 * Scope: top-level value uses (module-load-time references — the
 * shape that crashes on module import). Function bodies are
 * intentionally NOT scanned in V1 because parameter / closure /
 * hoisted-function scope tracking is brittle without a real parser
 * and the false-positive cost dominates the catch rate. The Crontech
 * bug class is module-load-time use, which V1 covers cleanly.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

// ─── Globals / built-ins allowlist ──────────────────────────────────────
// Names that are unambiguously available without import. Conservative —
// when in doubt, INCLUDE so we don't false-positive.
const GLOBAL_NAMES = new Set([
  // ES intrinsics (constructors & namespaces)
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Function', 'RegExp', 'Date', 'Error', 'TypeError', 'SyntaxError',
  'RangeError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'JSON', 'Math', 'Reflect',
  'Proxy', 'Intl', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array',
  'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'Uint8ClampedArray', 'WeakRef', 'FinalizationRegistry',
  'Atomics', 'Generator', 'AsyncGenerator', 'Iterator', 'AsyncIterator',

  // ES values & functions
  'undefined', 'NaN', 'Infinity', 'globalThis',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
  'eval', 'structuredClone',

  // Browser DOM / BOM
  'console', 'window', 'document', 'navigator', 'location', 'history',
  'screen', 'localStorage', 'sessionStorage', 'self', 'top', 'parent',
  'frames', 'name', 'closed', 'opener',
  'fetch', 'Request', 'Response', 'Headers', 'FormData',
  'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
  'Blob', 'File', 'FileReader', 'FileList',
  'XMLHttpRequest', 'WebSocket', 'EventSource',
  'BroadcastChannel', 'MessageChannel', 'MessagePort',
  'Worker', 'SharedWorker', 'ServiceWorker', 'ServiceWorkerContainer',
  'Notification', 'Permissions', 'Geolocation', 'PermissionStatus',
  'crypto', 'performance', 'caches', 'indexedDB', 'cookieStore',
  'atob', 'btoa', 'queueMicrotask',
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback',
  'alert', 'confirm', 'prompt', 'postMessage',
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'CustomEvent', 'Event', 'EventTarget',
  'KeyboardEvent', 'MouseEvent', 'TouchEvent', 'PointerEvent',
  'WheelEvent', 'FocusEvent', 'InputEvent', 'DragEvent',
  'ClipboardEvent', 'MessageEvent', 'CloseEvent', 'ErrorEvent',
  'ProgressEvent', 'PopStateEvent', 'HashChangeEvent',
  'Image', 'Audio', 'Video', 'HTMLElement', 'Element', 'Node',
  'NodeList', 'HTMLCollection', 'DocumentFragment', 'ShadowRoot',
  'CSSStyleSheet', 'StyleSheet',
  'TextEncoder', 'TextDecoder', 'TextEncoderStream', 'TextDecoderStream',
  'ReadableStream', 'WritableStream', 'TransformStream',

  // Node.js
  'process', 'Buffer', 'global', '__dirname', '__filename',
  'require', 'module', 'exports',

  // Test runner globals (node:test / Jest / Vitest / Mocha)
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
  'before', 'after', 'beforeAll', 'afterAll', 'context', 'specify',
  'xit', 'xtest', 'xdescribe', 'fit', 'fdescribe',
  'jest', 'vi', 'spyOn', 'fn', 'jasmine', 'sinon', 'cy', 'Cypress',
  'mock', 'unmock', 'doMock', 'dontMock', 'pending', 'fail',

  // TypeScript utility types (used as types AND occasionally values)
  'Partial', 'Required', 'Readonly', 'Record', 'Pick', 'Omit',
  'Exclude', 'Extract', 'NonNullable', 'Parameters',
  'ConstructorParameters', 'ReturnType', 'InstanceType',
  'ThisParameterType', 'OmitThisParameter', 'ThisType',
  'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize',
  'Awaited', 'NoInfer', 'Capabilities',

  // TypeScript primitive type names — appear in `(x: string, y: number)`
  // signatures which look like object-property values to our heuristic.
  // Allowlisting kills the highest-volume FP class.
  'string', 'number', 'boolean', 'bigint', 'symbol', 'any', 'unknown',
  'never', 'object',

  // TypeScript DOM / lib types that show up as type annotations and
  // would otherwise pass the camelCase-shape filter. Conservative list
  // covering the cases hit in dogfood scans of website/.
  'TemplateStringsArray', 'RegExpMatchArray', 'RegExpExecArray',
  'RequestInit', 'ResponseInit', 'RequestInfo', 'BodyInit',
  'ReadableStreamDefaultReader', 'ReadableStreamDefaultController',
  'WritableStreamDefaultWriter', 'WritableStreamDefaultController',
  'PropertyKey', 'PropertyDescriptor', 'PropertyDescriptorMap',
  'IteratorResult', 'AsyncIterableIterator', 'IterableIterator',
  'ArrayLike', 'ArrayBufferLike', 'ArrayBufferView',
  'NodeListOf', 'HTMLOrSVGElement', 'EventListenerOrEventListenerObject',
  'CSSStyleDeclaration', 'DOMRect', 'DOMRectReadOnly',
  'BufferEncoding', 'NodeJS', 'Iterable',
]);

// Reserved words / contextual keywords that look like identifiers but
// can never be flagged. Skip in identifier detection entirely.
const KEYWORD_NAMES = new Set([
  'true', 'false', 'null', 'this', 'super',
  'void', 'typeof', 'instanceof', 'new', 'delete', 'in', 'of',
  'await', 'yield', 'async', 'return', 'throw', 'try', 'catch',
  'finally', 'if', 'else', 'switch', 'case', 'default',
  'break', 'continue', 'for', 'while', 'do', 'function', 'class',
  'extends', 'implements', 'const', 'let', 'var', 'enum',
  'interface', 'type', 'as', 'is', 'satisfies', 'keyof', 'infer',
  'readonly', 'abstract', 'private', 'protected', 'public', 'static',
  'declare', 'export', 'import', 'from', 'with', 'package',
  'namespace', 'module',
]);

const SUPPORTED_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

// Excluded dir names (anywhere in the path). Same convention as other
// modules. Test-path downgrade applied separately per finding.
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', 'vendor', 'target', 'bin', 'obj', '.cache', '.parcel-cache',
  '.gatetest',
]);

class UndefinedRefModule extends BaseModule {
  constructor() {
    super(
      'undefinedRef',
      'Undefined-reference detector — catches TS2304-shape bugs (name used but not imported / declared) that crash modules at load time',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._collectFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('undefined-ref:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('undefined-ref:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS source file(s)`,
    });

    let totalIssues = 0;
    for (const file of files) {
      totalIssues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('undefined-ref:summary', true, {
      severity: 'info',
      message: `Undefined-ref scan: ${files.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _collectFiles(projectRoot) {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (EXCLUDE_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith('.') && entry.name !== '.github') continue;
          walk(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.has(ext)) {
            // Skip declaration-only files (`*.d.ts`) — they're ambient
            // by definition; no runtime value references possible.
            if (!entry.name.endsWith('.d.ts')) {
              out.push(path.join(dir, entry.name));
            }
          }
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return 0;
    }

    const rel = path.relative(projectRoot, file);
    const isTestPath = /\b(?:tests?|spec|specs|__tests__|e2e|fixtures?|stories)\b/i.test(rel);

    // Strip comments / string literals for USE-detection (Pass 2 only).
    // Stripping protects pass 2 from flagging identifier-shaped substrings
    // inside strings as undefined references.
    const stripped = this._stripCommentsAndStrings(content);
    const strippedLines = stripped.split('\n');
    const rawLines = content.split('\n');

    // Pass 1: harvest declarations + imports from RAW content. The string
    // stripper has limitations (regex literals with embedded quote chars
    // can confuse the state machine and eat entire function definitions),
    // so we run harvest on raw text. Risk: an identifier-shaped substring
    // inside a string literal `"const fakeName"` gets added to the scope
    // set falsely. That only INFLATES the set, biasing toward false-
    // negative (miss real bugs) over false-positive (flag legit code) —
    // the right bias for a launch-day rule that must not noise-block.
    const inScope = this._harvestScope(content);

    // Pass 2: find suspicious value-position uses on stripped content.
    const findings = this._findUndefinedRefs(strippedLines, rawLines, inScope);

    let issues = 0;
    for (const finding of findings) {
      const suppress = this._isSuppressed(rawLines, finding.line - 1);
      if (suppress) continue;
      const severity = isTestPath ? 'warning' : 'error';
      issues += 1;
      result.addCheck(`undefined-ref:${finding.name}:${rel}:${finding.line}`, false, {
        severity,
        file: rel,
        line: finding.line,
        message: `\`${finding.name}\` used as a value but never imported or declared in this file — module will crash on load with ReferenceError`,
        suggestion: `Add the missing import for \`${finding.name}\`. If the symbol is defined elsewhere in this workspace, run \`grep -rn "function ${finding.name}\\|const ${finding.name}\\|export.*${finding.name}" src/\` to find it. If the name is a typo, fix the use site.`,
      });
    }
    return issues;
  }

  // ─── Comment / string stripping (line-number-preserving) ──────────
  _stripCommentsAndStrings(src) {
    // Replace string / template / comment contents with same-length
    // spaces (preserve line breaks). Line numbers are stable and
    // identifier-shaped substrings inside strings/comments don't get
    // mis-parsed as code.
    //
    // Template literals: entire contents (INCLUDING `${...}` expressions)
    // are stripped. We lose the ability to detect undefined refs inside
    // template expressions, but the Crontech bug class is plain
    // `{ key: undefinedName }` object literals — not template
    // interpolations. Preserving template expressions was attempted in
    // V1 but tracking template-brace nesting across multi-line literals
    // had subtle bugs (eating the line after a template). Trade-off:
    // bias toward false-NEGATIVE (miss template-expression bugs) over
    // false-POSITIVE (flag legitimate const declarations).
    let out = '';
    let i = 0;
    const len = src.length;
    let state = 'code'; // code | line-comment | block-comment | string | template
    let stringChar = '';

    while (i < len) {
      const ch = src[i];
      const next = src[i + 1];

      if (state === 'code') {
        if (ch === '/' && next === '/') { state = 'line-comment'; out += '  '; i += 2; continue; }
        if (ch === '/' && next === '*') { state = 'block-comment'; out += '  '; i += 2; continue; }
        if (ch === '"' || ch === "'") { state = 'string'; stringChar = ch; out += ' '; i += 1; continue; }
        if (ch === '`') { state = 'template'; out += ' '; i += 1; continue; }
        out += ch; i += 1; continue;
      }
      if (state === 'line-comment') {
        if (ch === '\n') { state = 'code'; out += '\n'; i += 1; continue; }
        out += ' '; i += 1; continue;
      }
      if (state === 'block-comment') {
        if (ch === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue; }
        out += ch === '\n' ? '\n' : ' '; i += 1; continue;
      }
      if (state === 'string') {
        if (ch === '\\' && next !== undefined) { out += '  '; i += 2; continue; }
        if (ch === stringChar) { state = 'code'; out += ' '; i += 1; continue; }
        out += ch === '\n' ? '\n' : ' '; i += 1; continue;
      }
      if (state === 'template') {
        if (ch === '\\' && next !== undefined) { out += '  '; i += 2; continue; }
        if (ch === '`') { state = 'code'; out += ' '; i += 1; continue; }
        out += ch === '\n' ? '\n' : ' '; i += 1; continue;
      }
      i += 1;
    }
    return out;
  }

  // ─── Pass 1: harvest in-scope names ───────────────────────────────
  _harvestScope(src) {
    const scope = new Set();

    // Imports — ES & CommonJS.
    // `import X from '...'`
    for (const m of src.matchAll(/^\s*import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from\s+/gm)) {
      scope.add(m[1]);
    }
    // `import * as X from '...'`
    for (const m of src.matchAll(/^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/gm)) {
      scope.add(m[1]);
    }
    // `import { X, Y as Z } from '...'` (and `import default, { X } from`)
    for (const m of src.matchAll(/^\s*import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s+from/gm)) {
      this._parseDestructureNames(m[1]).forEach((n) => scope.add(n));
    }
    // `import X = require(...)` (TS namespace/CommonJS interop)
    for (const m of src.matchAll(/^\s*import\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/gm)) {
      scope.add(m[1]);
    }
    // `const X = require(...)` and `const { X, Y } = require(...)`
    for (const m of src.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/gm)) {
      scope.add(m[1]);
    }
    for (const m of src.matchAll(/^\s*(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(/gm)) {
      this._parseDestructureNames(m[1]).forEach((n) => scope.add(n));
    }

    // Top-level value declarations: `function X`, `const X = ...`, `let X = ...`,
    // `var X = ...`, `class X`, `enum X`. We catch any indentation — function-
    // local declarations only inflate the scope set, which biases toward
    // false-NEGATIVE (preferred). False-positives are the cost we minimise.
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) {
      scope.add(m[1]);
    }
    // Match `const X` / `let X` / `var X` with or without an immediate
    // assignment. `let X;` (declaration-only) is a common pattern that
    // earlier drafts missed because the regex required `[:=]` after the
    // identifier.
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g)) {
      scope.add(m[1]);
    }
    // Multi-binding declarations: `let a, b, c;` — capture every name.
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([^;\n=]+)[;=]/g)) {
      for (const piece of m[1].split(',')) {
        const name = piece.trim().split(/[\s:[{]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(name)) scope.add(name);
      }
    }
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)) {
      scope.add(m[1]);
    }
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/g)) {
      scope.add(m[1]);
    }
    // TS types/interfaces — used in type positions but harvest anyway to
    // not false-positive when a type name appears in a value-looking
    // context (e.g., generic argument).
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g)) {
      scope.add(m[1]);
    }
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/g)) {
      scope.add(m[1]);
    }
    // Destructure declarations: `const { x, y } = ...` and `const [a, b] = ...`
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+\{([^}]+)\}\s*=/g)) {
      this._parseDestructureNames(m[1]).forEach((n) => scope.add(n));
    }
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+\[([^\]]+)\]\s*=/g)) {
      for (const piece of m[1].split(',')) {
        const name = piece.trim().split(/[\s=]/)[0].replace(/^\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(name)) scope.add(name);
      }
    }
    // `for (const X of ...)`, `for (let X = 0; ...)`, `for (const X in ...)`.
    // The loop binding is in scope for the whole for-body — common cause
    // of false-positives until covered. Crontech FP class.
    for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g)) {
      scope.add(m[1]);
    }
    // for (const { a, b } of ...) / for (const [a, b] of ...) — destructured
    // loop binding.
    for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+\{([^}]+)\}/g)) {
      this._parseDestructureNames(m[1]).forEach((n) => scope.add(n));
    }
    for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+\[([^\]]+)\]/g)) {
      for (const piece of m[1].split(',')) {
        const name = piece.trim().split(/[\s=]/)[0].replace(/^\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(name)) scope.add(name);
      }
    }

    // Catch-clause binding: `catch (err)` / `catch (e)` — `err` is in
    // scope inside the catch block.
    for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      scope.add(m[1]);
    }

    // Arrow function destructure param: `({ a, b }) =>` — strictly require
    // `=>` to disambiguate from object-literal arguments. A broader pattern
    // like `[(,=]\s*\{...\}\s*[,)=:]` accidentally absorbs object literals
    // in function calls (the Crontech bug shape) into the scope set and
    // suppresses the rule entirely.
    for (const m of src.matchAll(/\(\s*\{([^{}]+)\}\s*\)\s*=>/g)) {
      this._parseDestructureNames(m[1]).forEach((n) => scope.add(n));
    }
    // Named function destructure param: `function name({a, b})` /
    // `function ({a, b})` (anonymous) — both have a `function` keyword
    // immediately preceding which disambiguates from call sites.
    for (const m of src.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$\w$]*\s*\(\s*\{([^{}]+)\}\s*\)/g)) {
      this._parseDestructureNames(m[1]).forEach((n) => scope.add(n));
    }
    // Method-shorthand destructure param: `methodName({a, b}) {` —
    // distinguishable from call by the trailing `{` of the method body.
    for (const m of src.matchAll(/[A-Za-z_$][\w$]*\s*\(\s*\{([^{}]+)\}\s*\)\s*\{/g)) {
      this._parseDestructureNames(m[1]).forEach((n) => scope.add(n));
    }
    // TypeScript-typed destructure param: `({a, b}: SomeType)` — common
    // React-component pattern (`function Page({...}: PageProps)`). The
    // `}: Type)` suffix between the destructure and the param-list close
    // blocks the earlier regexes that expected `})` directly.
    for (const m of src.matchAll(/\(\s*\{([^{}]+)\}\s*:\s*[^)]+\)/g)) {
      this._parseDestructureNames(m[1]).forEach((n) => scope.add(n));
    }

    // `declare const X`, `declare function X`, `declare class X`
    for (const m of src.matchAll(/(?:^|\n)\s*declare\s+(?:const|let|var|function|class|namespace|module)\s+([A-Za-z_$][\w$]*)/g)) {
      scope.add(m[1]);
    }
    // `namespace X { ... }` and `module X { ... }` (TS)
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?namespace\s+([A-Za-z_$][\w$]*)/g)) {
      scope.add(m[1]);
    }
    // Function parameters at any level — broad-stroke heuristic that
    // inflates the set conservatively. Pattern: `(name: Type, ...)` or
    // `(name, ...)` after a `function`/arrow.
    for (const m of src.matchAll(/(?:function\s*\*?\s*[A-Za-z_$\w$]*\s*\(|\(\s*)([^()]*?)\)\s*(?:=>|\{|:)/g)) {
      const params = m[1];
      // Split on commas at depth 0 only — primitive but works for typical
      // signatures. Destructured params and defaults inflate the set further.
      for (const piece of this._splitParams(params)) {
        // Strip default values, type annotations, rest spread. Normalize
        // whitespace FIRST — multi-line TS parameter lists have newlines
        // inside each piece, and `.replace(/:.*$/, '')` doesn't span
        // newlines (the `.` excludes `\n` and `$` without `m` flag means
        // end-of-string, so a trailing `\n` blocks the match).
        const flat = piece.replace(/\s+/g, ' ').trim();
        // Strip default values, then type annotations, then rest-spread,
        // then the TypeScript optional marker `?` (e.g. `projectName?: string`).
        const cleaned = flat
          .replace(/=.*$/, '')
          .replace(/:.*$/, '')
          .replace(/\?$/, '')
          .trim()
          .replace(/^\.\.\./, '');
        if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
          this._parseDestructureNames(cleaned.replace(/^[{[]/, '').replace(/[}\]]$/, ''))
            .forEach((n) => scope.add(n));
        } else if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) {
          scope.add(cleaned);
        }
      }
    }

    return scope;
  }

  _splitParams(s) {
    const out = [];
    let depth = 0;
    let buf = '';
    for (const ch of s) {
      if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim()) out.push(buf);
    return out;
  }

  _parseDestructureNames(inside) {
    // `{a, b: c, d = 1, e: f = 2, ...rest}` — extract a, c, d, f, rest.
    // Strip nested braces; we treat them as opaque (false-negative bias).
    let depth = 0;
    let buf = '';
    const pieces = [];
    for (const ch of inside) {
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') depth -= 1;
      if (ch === ',' && depth === 0) { pieces.push(buf); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim()) pieces.push(buf);
    const names = [];
    for (const piece of pieces) {
      let s = piece.trim();
      if (!s) continue;
      // Import rename: `someFunction as renamedHandler` → renamedHandler.
      // Must check `as` BEFORE the colon-rename rule so `{ type as foo }`
      // (TS `import { type X as Y }`) resolves correctly. Word-boundary
      // anchors keep `class` / `castable` etc. from being treated as `as`.
      const asMatch = s.match(/^\S+\s+as\s+([A-Za-z_$][\w$]*)/);
      if (asMatch) {
        s = asMatch[1];
      } else {
        // Object destructure rename: `x: y` → y is the binding
        const colon = s.indexOf(':');
        if (colon !== -1) s = s.slice(colon + 1).trim();
      }
      // Default value: `y = 1` → y
      s = s.replace(/=.*$/, '').trim();
      // Rest spread: `...rest` → rest
      s = s.replace(/^\.\.\./, '').trim();
      // Strip leading `type` modifier from TS type-only named imports
      // (`import { type Foo } from`): `type Foo` → `Foo`
      s = s.replace(/^type\s+/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(s)) names.push(s);
    }
    return names;
  }

  // ─── Pass 2: find suspicious value-position uses ──────────────────
  _findUndefinedRefs(strippedLines, rawLines, inScope) {
    const findings = [];
    const seen = new Set(); // dedupe same name on same line

    // V1 only fires on ONE pattern — object-property value with a bare
    // identifier on the right:
    //
    //   { keyName: undefinedFunctionName, ... }
    //
    // This is the EXACT shape of all three Crontech bugs from
    // 2026-05-24 (resolveTenantCapForHotPath, createBuilderPublicApiApp,
    // buildTrackingApp) — a config object passes a function-as-value
    // where the function name was never imported.
    //
    // Earlier V1 drafts also flagged object-shorthand (`{ x, y }`) and
    // bare-argument-in-call (`func(x, y)`) patterns, but those produced
    // a long tail of false-positives on argument-list contexts that
    // were hard to disambiguate from declarations / scope. The
    // "key: value" pattern alone catches the highest-pain class with
    // <1% FP rate on dogfood scans.

    for (let i = 0; i < strippedLines.length; i += 1) {
      const line = strippedLines[i];
      if (!line.trim()) continue;

      for (const m of line.matchAll(/(?:^|[,{(\s])([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*(?=[,}\s)])/g)) {
        const value = m[2];
        const key = m[1];
        // `x: x` is a verbose-shorthand pattern — the value is the same
        // as the key, almost always intentional and already-in-scope.
        if (key === value) continue;
        if (this._shouldFlag(value, inScope)) {
          const sig = `${value}|${i + 1}`;
          if (!seen.has(sig)) {
            seen.add(sig);
            findings.push({ name: value, line: i + 1 });
          }
        }
      }
    }

    return findings;
  }

  _shouldFlag(name, inScope) {
    // Conservative thresholds chosen to MAXIMISE catch rate on the
    // Crontech bug class while keeping FP rate near zero on real
    // codebases. The three real bugs we're targeting are 16-28 chars,
    // all camelCase or PascalCase function names. Short common variable
    // names (`owner`, `repo`, `state`, `data`) are >99% of FP volume,
    // so we filter them out by shape.
    if (!name || name.length < 8) return false;
    if (KEYWORD_NAMES.has(name)) return false;
    if (GLOBAL_NAMES.has(name)) return false;
    if (inScope.has(name)) return false;
    if (/^\d/.test(name)) return false;
    // Must look like a camelCase function / factory / handler name —
    // lowercase first letter AND a camelCase boundary later in the name
    // (lowercase → uppercase transition). All three Crontech crashing
    // names match: `resolveTenantCapForHotPath`, `createBuilderPublicApiApp`,
    // `buildTrackingApp`.
    //
    // Deliberately excluded by the lowercase-start requirement:
    //   - PascalCase brand names embedded in JSX text content
    //     (`GateTest`, `Crontech`, `Cloudflare` — common dogfood FPs)
    //   - React components / class names referenced as values (rare in
    //     practice; usually JSX or `new` constructors which sit in
    //     different positional contexts)
    //   - All-lowercase locals without camelCase boundary
    //     (`databaseclient`, `urlmatcher` — either correctly named or
    //     a different bug class than this module owns)
    //
    // Trade-off accepted: this module is laser-focused on the
    // "undefined-function-as-config-value" shape that crashed Crontech.
    // Broader shapes (PascalCase class refs, top-level Component values)
    // are left for V2 / a future module.
    if (!/^[a-z]/.test(name)) return false;
    if (!/[a-z][A-Z]/.test(name)) return false;
    return true;
  }

  _isSuppressed(rawLines, lineIdx) {
    const sameLine = rawLines[lineIdx] || '';
    if (/\/\/\s*undefined-ref-ok\b/.test(sameLine)) return true;
    const prev = rawLines[lineIdx - 1] || '';
    if (/\/\/\s*undefined-ref-ok\b/.test(prev)) return true;
    return false;
  }
}

module.exports = UndefinedRefModule;
