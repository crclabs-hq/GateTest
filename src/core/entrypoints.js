'use strict';
/**
 * Entrypoints — the one definition of "a file nobody needs to import".
 *
 * Reachability analysis (deadCode's orphan-file rule) asks "does any file
 * import this one?". The honest answer is only meaningful once the files
 * that are RUN rather than imported are set aside: package mains and bins,
 * CLI scripts, test files, framework route files, git hooks, browser assets,
 * tool configs, and fixture corpora that are data rather than code. KI #96
 * measured three false-positive classes before this file existed:
 *   - a nested Next.js app (`website/app/...`) never matched `app/` because
 *     the check was a prefix on the repo-relative path, not a segment;
 *   - tool configs (eslint.config.mjs, next.config.ts, playwright.config.ts)
 *     are loaded by their tooling, never imported;
 *   - fixture corpora (a reliability corpus, benchmark targets) are inputs.
 * Segments, not substrings (Doctrine §5).
 */

const fs = require('fs');
const path = require('path');
const { compiledToSources } = require('./module-resolution');

// Not `app`: a Next.js app directory holds ordinary components and libs
// beside its route files, and only the route files (FRAMEWORK_FILE_RE) are
// entrypoints — exempting the whole segment hid a planted orphan in the
// module's own positive control. `pages` stays: every file there is a route.
const ENTRYPOINT_SEGMENTS = new Set([
  'bin', 'tests', 'test', '__tests__', 'scripts', 'migrations', 'pages',
  'api', 'public', 'integrations', 'hooks', 'assets', 'static',
]);

// Python-only directory conventions — every one is a place Django loads code
// from BY NAME OR BY SETTINGS STRING, so "nothing imports it" is its normal
// state. Scoped to `.py` files: an Express app's `middleware/auth.js` is
// ordinary imported code and an unimported one is a real orphan.
//   templatetags/   `{% load name %}` → get_installed_libraries() imports every
//                   module under `<app>/templatetags/`.
//   backends/       import_string(settings.X) — SESSION_ENGINE, CACHES BACKEND,
//                   DATABASES ENGINE, EMAIL_BACKEND, TEMPLATES BACKEND, TASKS
//                   BACKEND, AUTHENTICATION_BACKENDS (13 of django's 23
//                   residual orphans on 2026-09-05 were these plug-points).
//   middleware/     MIDDLEWARE setting strings (django/middleware/locale.py).
//   management/commands/  find_commands() imports `<name>.py` for `manage.py <name>`.
const PY_ENTRYPOINT_SEGMENTS = new Set(['templatetags', 'backends', 'middleware']);
const MANAGEMENT_COMMANDS_RE = /(?:^|\/)management\/commands\//;

// Inputs and scaffolding, not modules: fixture data, example apps, docs,
// benchmark scripts, and the application-under-test trees an integration
// or e2e suite spins up (nest's `integration/<case>/src` is imported only by
// `integration/<case>/e2e/*.spec.ts` — test code by any honest reading; 134
// findings on nest before this segment was added).
const FIXTURE_SEGMENTS = new Set([
  'fixtures', '__fixtures__', '__mocks__', 'mocks', 'examples', 'example', 'docs', 'sandbox',
  'demo', 'sample', 'samples', 'bench', 'benchmarks', 'corpus', 'integration', 'e2e', 'testing',
]);

const ENTRYPOINT_BASENAMES = new Set([
  'index.js', 'index.ts', 'index.mjs', 'index.cjs', 'index.jsx', 'index.tsx',
  'main.js', 'main.ts', 'main.py', '__init__.py', '__main__.py',
  'app.js', 'app.ts', 'server.js', 'server.ts',
  'conftest.py', 'setup.py', 'manage.py',
  // Python files a framework or the interpreter loads BY NAME. The loading
  // rule is the justification; a name without one does not belong here.
  'apps.py',     // Django: AppConfig.create() imports `<app>.apps` for every INSTALLED_APPS entry (3.2+)
  'models.py',   // Django: AppConfig.import_models() imports `<app>.models` at registry setup
  'admin.py',    // Django: admin.autodiscover() → autodiscover_modules('admin') on every app
  'urls.py',     // Django: ROOT_URLCONF / include('app.urls') name it by dotted string, never by import
  'settings.py', // Django: DJANGO_SETTINGS_MODULE names it from the environment
  'wsgi.py',     // WSGI server loads `project.wsgi:application` from its command line; `flask run` also probes it
  'asgi.py',     // ASGI server loads `project.asgi:application` the same way
  'app.py',      // Flask: `flask run` auto-detects app.py in the working directory
  'tasks.py',    // Celery: autodiscover_tasks() imports `<app>.tasks` for every installed app
  'middleware.py', // Django: MIDDLEWARE setting names `<app>.middleware.Class` by string (Next's middleware.ts is in TOOL_FILE_RE)
  // NOT here: signals.py — Django has no loader for it; a project imports it
  // from apps.py ready(), an ordinary import the Python graph sees.
]);

// Framework conventions: Next.js route files and metadata files, plus the
// files Next / Vite / test runners load by name.
const FRAMEWORK_FILE_RE = /\b(page|layout|route|loading|error|not-found|template|default|global-error)\.(tsx?|jsx?)$/;
const METADATA_FILE_RE = /^(opengraph-image|twitter-image|icon|apple-icon|favicon|robots|sitemap|manifest)(\.[^.]+)?\.(tsx?|jsx?|ts|js)$/;
// `proxy.ts` is what Next 16 renamed `middleware.ts` to; both are loaded by name.
const TOOL_FILE_RE = /^(?:[\w.-]+\.config\.(?:[cm]?js|ts)|instrumentation(?:-client)?\.[jt]s|(?:middleware|proxy)\.[jt]s|next-env\.d\.ts|[\w.-]+\.d\.ts)$/;

// Exports a framework reads BY NAME from a file it loads by convention.
// Nothing imports them, so "no file imports this export" is their healthy
// state and deadCode's unused-export rule must stay quiet. Two tables:
//   FRAMEWORK_EXPORT_NAMES — names any framework file may carry (Next.js /
//     Remix / Nuxt segment config, route handlers, metadata, image files,
//     test-runner hooks, the VS Code extension contract);
//   FRAMEWORK_FILE_EXPORTS — names only ONE file carries. `register` in
//     `instrumentation.ts` is Next's server-start hook; `register` anywhere
//     else is an ordinary function and an unused one is dead. Until
//     2026-09-13 deadCode reported `register` / `onRequestError` /
//     `onRouterTransitionStart` on this repo's own instrumentation files.
const FRAMEWORK_EXPORT_NAMES = new Set([
  'default', 'metadata', 'generateMetadata', 'generateStaticParams',
  'generateViewport', 'viewport',
  'loader', 'action', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS',
  'HEAD', 'middleware', 'config',
  'dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime',
  'preferredRegion', 'maxDuration',
  'alt', 'size', 'contentType',
  'ErrorBoundary', 'NotFound',
  'setUp', 'tearDown', 'setup', 'teardown', 'setup_module', 'teardown_module',
  // VS Code extension contract — the editor calls these; nothing imports them.
  'activate', 'deactivate',
]);
const FRAMEWORK_FILE_EXPORTS = [
  // Next.js server instrumentation: register() once per server start,
  // onRequestError() on every server-side throw.
  [/^instrumentation\.[jt]s$/, ['register', 'onRequestError']],
  // Next.js 15.3+ client instrumentation: called on every App Router navigation.
  [/^instrumentation-client\.[jt]s$/, ['onRouterTransitionStart']],
  // Next.js middleware / Next 16 proxy: the handler and its `config.matcher`.
  [/^(?:middleware|proxy)\.[jt]s$/, ['middleware', 'proxy', 'config']],
];

/**
 * Is `name`, exported from `file`, consumed by a framework rather than imported?
 * @param {string} file repo-relative or absolute path
 * @param {string} name exported binding
 */
function isFrameworkExport(file, name) {
  if (FRAMEWORK_EXPORT_NAMES.has(name)) return true;
  const base = path.basename(file);
  return FRAMEWORK_FILE_EXPORTS.some(([re, names]) => re.test(base) && names.includes(name));
}

/** package.json fields whose string values name files that are run, not imported. */
const MANIFEST_FILE_FIELDS = ['main', 'module', 'browser', 'bin', 'types', 'typings', 'exports', 'scripts'];
const FILE_TOKEN_RE = /(?:^|[\s"'=])(\.?\/?[A-Za-z0-9_\-./]+\.(?:[cm]?js|jsx|tsx?|mts|cts))(?=$|[\s"'&|;)])/g;

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
}

/**
 * Every file a package.json in `dirs` names as main / bin / module / exports /
 * a script's argument — resolved to absolute paths. One package.json per
 * directory, read once; unreadable or unparseable manifests contribute
 * nothing rather than throwing.
 * @param {Iterable<string>} dirs absolute directories to look in
 * @returns {Set<string>}
 */
function manifestEntrypoints(dirs) {
  const out = new Set();
  for (const dir of new Set(dirs)) {
    angularEntrypoints(dir, out);
    const file = path.join(dir, 'package.json');
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { continue; } // error-ok — no manifest here
    for (const field of MANIFEST_FILE_FIELDS) {
      const strings = [];
      collectStrings(pkg[field], strings);
      for (const s of strings) {
        if (field === 'scripts') {
          FILE_TOKEN_RE.lastIndex = 0;
          let m = FILE_TOKEN_RE.exec(s);
          while (m !== null) { out.add(path.resolve(dir, m[1])); m = FILE_TOKEN_RE.exec(s); }
        } else if (/\.(?:[cm]?js|jsx|tsx?|mts|cts)$/.test(s)) {
          out.add(path.resolve(dir, s));
          for (const src of compiledToSources(dir, s)) out.add(src);
        }
      }
    }
  }
  return out;
}

/**
 * Angular names files in angular.json rather than package.json: the browser /
 * server entry, polyfills, global styles and scripts, and the
 * `fileReplacements` a build configuration swaps in (`environment.prod.ts`
 * is imported by nothing — the CLI substitutes it for `environment.ts`;
 * CleanArchitecture's ClientApp reported it as an orphan). Every string
 * under `architect` with a source extension counts, resolved from the
 * angular.json directory.
 */
function angularEntrypoints(dir, out) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'angular.json'), 'utf-8')); } catch { return; } // error-ok — not an Angular workspace
  const projects = cfg && typeof cfg.projects === 'object' ? Object.values(cfg.projects) : [];
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    const strings = [];
    collectStrings(project.architect || project.targets, strings);
    for (const s of strings) {
      if (/\.(?:[cm]?js|jsx|tsx?|mts|cts)$/.test(s) && !s.includes('*')) out.add(path.resolve(dir, s));
    }
  }
}

/**
 * @param {string} file absolute path
 * @param {string} projectRoot
 * @param {Set<string>} [manifestRefs] from manifestEntrypoints()
 */
function isEntryPoint(file, projectRoot, manifestRefs) {
  const rel = path.relative(projectRoot, file).split(path.sep).join('/');
  const base = path.basename(file);
  if (ENTRYPOINT_BASENAMES.has(base)) return true;
  if (FRAMEWORK_FILE_RE.test(base) || METADATA_FILE_RE.test(base) || TOOL_FILE_RE.test(base)) return true;
  const segments = rel.split('/').slice(0, -1);
  const py = base.endsWith('.py');
  for (const seg of segments) {
    if (ENTRYPOINT_SEGMENTS.has(seg) || FIXTURE_SEGMENTS.has(seg) || seg.endsWith('-corpus')) return true;
    if (py && PY_ENTRYPOINT_SEGMENTS.has(seg)) return true;
  }
  if (py && MANAGEMENT_COMMANDS_RE.test(rel)) return true;
  if (manifestRefs && manifestRefs.has(path.resolve(file))) return true;
  return false;
}

module.exports = { isEntryPoint, manifestEntrypoints, isFrameworkExport };
