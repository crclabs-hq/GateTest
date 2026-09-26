/**
 * Is a file part of the SHIPPED APPLICATION, or is it an illustration?
 *
 * Every module was answering this for itself, and mostly answering it about
 * GateTest's own repo. Measured 2026-09-01 on third-party code:
 *
 *   axios @81df7a5   — 54 blocking findings, 30 of them (56%) inside
 *                      `examples/` and `sandbox/`: a11y, visual and
 *                      hardcoded-url all reporting on demo HTML.
 *   express @023767f — all 12 authBypass findings inside `examples/`, i.e.
 *                      100% of that module's output on that repo.
 *
 * axios and chalk are among the most-depended-on packages in the ecosystem.
 * A gate that blocks them has not found 54 defects; it has found one, and
 * reported it 54 times. A developer evaluating us draws the obvious
 * conclusion and leaves.
 *
 * The lesson already existed in two places and had not been generalised:
 *   - src/modules/security.js excludes examples/samples/demos for its posture
 *     checks, and its comment names expressjs/express explicitly.
 *   - src/modules/accessibility.js has an exclusion list — but it is
 *     `website/app/admin/`, `website/app/dashboard/`, `website/public/`.
 *     Those are OUR paths. On a customer's repo it excludes nothing, which is
 *     how a rule can look well-behaved on the repo it was written in and be
 *     unusable everywhere else.
 *
 * WHAT THIS IS NOT FOR. This is a scope question, never a severity question.
 * Do not use it to quiet a rule that fires too often on real application
 * code — that is a precision bug in the rule, fixed with a control pair.
 * In particular, Craig ruled 2026-09-01 that accessibility findings BLOCK:
 * "keep the a11y blocking, thats quality." Nothing here changes that. An
 * `<img>` with no alt in a customer's app still fails the gate; the same tag
 * in a library's `examples/` folder is documentation.
 *
 * And it is deliberately NOT applied to secrets, dependency or dangerous-
 * pattern scanning. A credential committed under `examples/` is a real
 * credential, and an `eval()` in a demo still executes.
 */

// Segment-anchored, always. The loose `path.includes('test')` style checks
// elsewhere in this codebase also match `src/latest/`, and repeating that
// would silence real application code in `src/exampleService/`.
const ILLUSTRATION_DIR_RE =
  /(^|\/)(examples?|samples?|demos?|fixtures?|__fixtures__|__mocks__|sandbox|playground|scratch)\//i;

/**
 * True when `relPath` sits inside a directory whose contents illustrate the
 * software rather than constitute it.
 *
 * @param {string} relPath - path relative to the project root; either slash
 *                           style is accepted.
 */
function isIllustrationPath(relPath) {
  if (!relPath) return false;
  return ILLUSTRATION_DIR_RE.test(String(relPath).replace(/\\/g, '/'));
}

// Test and benchmark HARNESS directories. Separate from illustrations because
// the two answer different questions: an illustration is not the application,
// a harness is not a PAGE A USER VISITS. The presentation modules (a11y,
// visual, seo) care about the second distinction, and so does hardcoded-url:
// a `localhost` URL in a benchmark is the harness addressing the server it
// measures. authBypass handles test paths its own way, and secrets/security
// must keep scanning both — a credential in `benchmarks/` is still a
// credential.
// The compound names matter as much as the bare ones. honojs/hono keeps its
// harnesses in `runtime-tests/` and `perf-measures/`, neither of which is
// `tests/` or `perf/`, so both were audited as application code: 3 and 2
// blocking findings respectively, plus 12 more under `benchmarks/`. A
// segment that IS a harness word, ENDS in one (`runtime-tests`,
// `integration-tests`), or is a `perf-`/`bench-` compound (`perf-measures`,
// `bench-target`) is a harness.
const HARNESS_DIR_RE =
  // `testdata` (Go), `test-resources` / `test-fixtures` (Maven, Gradle):
  // ktor's `test-resources/testdir/test.html` was scored as a public page
  // and produced 14 of its 21 blocking findings (2026-09-05).
  /(^|\/)(?:tests?|spec|specs|__tests__|e2e|cypress|playwright|perf|bench|benchmarks?|testdata|test[-_]?resources|test[-_]?fixtures|[a-z0-9]+[-_](?:tests?|specs?|benchmarks?)|(?:perf|bench)[-_][a-z0-9_-]+)\//i;

/**
 * True when `relPath` is a document nobody navigates to as a user: a demo, a
 * fixture, or a test/benchmark harness page.
 *
 * Measured 2026-09-01 on lodash @a666ba5 — 33 of its 47 blocking findings
 * (70%) were in `test/` and `perf/`. The offenders were `test/index.html`
 * (titled "lodash Test Suite", loading qunit.css) and `perf/index.html`
 * ("lodash Performance Suite") being audited for landmark regions, viewport
 * tags and meta descriptions. A QUnit runner having no `<main>` landmark is
 * not an accessibility defect; it is not a page.
 *
 * Again: SCOPE, NOT SEVERITY. Craig ruled 2026-09-01 that a11y findings
 * block — "keep the a11y blocking, thats quality" — and they still do, on
 * every page a user can actually reach.
 */
function isNonUserFacingPage(relPath) {
  if (!relPath) return false;
  const norm = String(relPath).replace(/\\/g, '/');
  return isIllustrationPath(norm) || HARNESS_DIR_RE.test(norm);
}

/**
 * A single-page-app SHELL: a full HTML document whose body is only the mount
 * point the framework renders into (`<app-root>`, `<div id="root">`,
 * `<div id="app">`). Angular's and React's `index.html` are this shape.
 * It has no title copy, no h1, no meta description and no landmarks because
 * the application supplies those at runtime — scoring it as a public page
 * produced 26 of CleanArchitecture's 39 blocking findings (2026-09-05).
 * @param {string} content
 */
function isSpaShell(content) {
  const html = String(content || '');
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!m) return false;
  const body = m[1]
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const hasMount = /<app-root\b|<(?:div|main)[^>]*\bid=["'](?:root|app|__next|__nuxt|svelte|q-app)["']/i.test(body);
  const text = body.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  return hasMount && text.length < 40;
}

/**
 * JSX that is RASTERISED, not served: `new ImageResponse(<div>…</div>)` from
 * `@vercel/og` / `next/og`, or a satori / workers-og render. The markup
 * becomes a PNG — no screen reader, no keyboard, no DOM, no links. An
 * `<img>` without alt or an `href="#"` inside it is a paint instruction
 * (trpc www/og-image/pages/api/_ref/vercel.tsx, 2026-09-05). Identified by
 * the call or the import, never by path: the playground page beside it
 * (www/og-image/pages/index.tsx) IS a page.
 * @param {string} content
 */
const IMAGE_RENDERER_RE = /\bnew\s+ImageResponse\s*\(|\bsatori\s*\(|from\s+['"](?:satori|workers-og|@cf-wasm\/og|@vercel\/og|next\/og)['"]/;
function isImageRenderer(content) {
  return IMAGE_RENDERER_RE.test(String(content || ''));
}

/**
 * Does the project contain ANY source file for the gate to check?
 *
 * Reproduced 2026-09-14: a directory holding only a package.json printed
 * `GATE: PASSED … ✓ You're good` — 42 modules, each walked the tree, each
 * found nothing to look at, each passed. A gate that passes an empty room
 * is indistinguishable from one that checked it, and the summary said
 * nothing about the difference.
 *
 * "Source" is code, markup or styles — the things the modules exist to
 * read. Manifests, lockfiles, licences and docs alone are not a codebase:
 * a repo of only README.md gets the warning, because none of the code
 * rules ran on anything. Walks the same excludes every module walks
 * (WALK_EXCLUDES) and stops at the first hit, so on a real repository this
 * costs one readdir.
 *
 * @param {string} projectRoot
 * @returns {boolean}
 */
const SOURCE_FILE_EXT_RE = /\.(?:[cm]?jsx?|tsx?|mts|cts|vue|svelte|astro|py|pyi|rb|go|rs|java|kt|kts|scala|cs|fs|php|swift|m|mm|c|cc|cpp|cxx|h|hh|hpp|dart|ex|exs|erl|hs|lua|pl|pm|r|sh|bash|zsh|ps1|sql|html?|css|scss|sass|less)$/i;

function hasSourceFiles(projectRoot) {
  const fs = require('fs');
  const path = require('path');
  const { WALK_EXCLUDE_SET } = require('./walk-excludes');
  const walk = (dir, depth) => {
    if (depth > 12) return false;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false; // unreadable: nothing here can be checked
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (WALK_EXCLUDE_SET.has(entry.name)) continue;
        if (walk(path.join(dir, entry.name), depth + 1)) return true;
      } else if (entry.isFile() && SOURCE_FILE_EXT_RE.test(entry.name)) {
        return true;
      }
    }
    return false;
  };
  return walk(projectRoot, 0);
}

/**
 * How big is the tree a scan is about to walk — before running a single
 * module. Issue #630: a customer on a 76-package monorepo saw no file
 * count and no ETA before the CLI went quiet, so they could not tell a
 * large-but-healthy scan from a hang. Counted with the SAME exclude set
 * every module's walk honours (`WALK_EXCLUDE_SET`, `hasSourceFiles` above)
 * — never a second, hand-typed estimate — plus the workspace-member count
 * from the one definition of "what packages make up this repo"
 * (`workspaces.js`). A tree with no declared/conventional workspace
 * members is one package (the project itself), never zero.
 *
 * This is a real second file-system walk (readdirSync per directory, no
 * file reads) run once, up front — cheap next to the module runs that
 * follow, and the only way to report a real number instead of a guess.
 *
 * `pathFilter` (move 4, the time-to-verdict contract) is the SAME
 * `.gatetest.json` `paths` filter every module's file set is scoped to
 * (`scan-paths.js` — one definition of "in scope for this gate"). Passing
 * it counts `inScopeCount` in the same walk rather than a second pass, so
 * the ETA line can say "N files (M in scope)" without lying about which M
 * it means.
 *
 * @param {string} projectRoot
 * @param {{include:RegExp[], exclude:RegExp[]}|null} [pathFilter]
 * @returns {{ fileCount: number, packageCount: number, inScopeCount: number }}
 */
function scanInventory(projectRoot, pathFilter = null) {
  const fs = require('fs');
  const path = require('path');
  const { WALK_EXCLUDE_SET } = require('./walk-excludes');
  const { pathInScope } = pathFilter ? require('./scan-paths') : { pathInScope: null };

  let fileCount = 0;
  let inScopeCount = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable: nothing here to count
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (WALK_EXCLUDE_SET.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        fileCount += 1;
        if (!pathFilter) {
          inScopeCount += 1;
        } else {
          const rel = path.relative(projectRoot, path.join(dir, entry.name)).split(path.sep).join('/');
          if (pathInScope(pathFilter, rel)) inScopeCount += 1;
        }
      }
    }
  };
  walk(projectRoot);

  let packageCount = 1;
  try {
    // Lazy require: workspaces.js imports walk-excludes.js too, and a
    // top-level require here would be a load-order cycle with no runtime
    // benefit — this file never needs it outside this function.
    const { listWorkspacePackages } = require('./workspaces');
    const members = listWorkspacePackages(projectRoot);
    if (members.length > 0) packageCount = members.length;
  } catch { /* error-ok — no workspace config: the whole tree is one package */ }

  return { fileCount, packageCount, inScopeCount };
}

module.exports = {
  isIllustrationPath,
  isNonUserFacingPage,
  isSpaShell,
  isImageRenderer,
  hasSourceFiles,
  scanInventory,
  ILLUSTRATION_DIR_RE,
  HARNESS_DIR_RE,
  SOURCE_FILE_EXT_RE,
};
