/**
 * Fix-workspace hydrator — closes the Phase 1.2b production gap.
 *
 * The cross-fix scanner gate, contextual grounding, stack detection and
 * prior-art recall all need `originalFileContents` (the pre-fix
 * workspace) and the scanner gate additionally needs
 * `originalFindingsByModule` (the baseline findings to diff against).
 * Until now both had to be supplied by the CALLER of /api/scan/fix —
 * and no production caller (scan/status page, admin Command Center,
 * watchdog tick) supplied them, so the gate was a silent no-op in
 * production.
 *
 * This helper lets the route hydrate BOTH server-side:
 *   - file contents: fetched from the repo (tree + blobs), prioritising
 *     (1) the files being fixed, (2) convention/config files that
 *     grounding + stack detection read, (3) remaining source files up
 *     to a cap.
 *   - baseline findings: computed by running the deterministic scanner
 *     tier against the hydrated original workspace — the same runTier
 *     the gate uses for the post-fix workspace, so the diff is
 *     symmetric by construction.
 *
 * Pure JS, dependency-injected (fetchTree / fetchBlob / runTier), never
 * throws — a hydration failure degrades to the pre-hydration behaviour
 * (gate skips, grounding empty) and reports why.
 */

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.rb', '.php', '.cs', '.md', '.json', '.yml', '.yaml', '.toml'];

const EXCLUDED_PATH_FRAGMENTS = ['node_modules', '.next/', 'dist/', 'build/', 'coverage/', 'vendor/', '.min.', '.bundle.'];

/**
 * Convention files that contextual-grounding and stack-detector read.
 * Fetched even when they wouldn't make the source-file cap.
 */
const CONVENTION_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
  'lerna.json',
  'README.md',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CONTRIBUTING.md',
  'tsconfig.json',
  'vercel.json',
  'Dockerfile',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'composer.json',
];

function isExcluded(path) {
  return EXCLUDED_PATH_FRAGMENTS.some((frag) => path.includes(frag));
}

function isSourceFile(path) {
  return SOURCE_EXTS.some((ext) => path.endsWith(ext)) && !isExcluded(path);
}

/**
 * Choose which tree paths to hydrate, in priority order, capped.
 * Exposed for tests.
 *
 * @param {object} opts
 * @param {string[]} opts.treePaths   All paths in the repo tree.
 * @param {string[]} opts.issueFiles  Files the fix loop is about to touch.
 * @param {number}   [opts.maxFiles]
 * @returns {string[]}
 */
function selectFilesToHydrate({ treePaths, issueFiles = [], maxFiles = 60 }) {
  const tree = new Set(treePaths);
  const picked = [];
  const seen = new Set();

  const push = (p) => {
    if (!seen.has(p) && tree.has(p) && picked.length < maxFiles) {
      seen.add(p);
      picked.push(p);
    }
  };

  // 1. The files being fixed — the scanner gate is meaningless without them.
  for (const f of issueFiles) push(f);
  // 2. Convention/config files at the repo root.
  for (const f of CONVENTION_FILES) push(f);
  // 3. Remaining source files until the cap.
  for (const p of treePaths) {
    if (picked.length >= maxFiles) break;
    if (isSourceFile(p)) push(p);
  }
  return picked;
}

/**
 * Convert a runTier result into the findings-by-module baseline shape
 * the scanner gate expects. Exposed for tests.
 */
function findingsByModuleFromScan(scan) {
  const byModule = {};
  for (const mod of (scan && scan.modules) || []) {
    const details = Array.isArray(mod.details) ? mod.details.filter((d) => typeof d === 'string') : [];
    if (details.length > 0) byModule[mod.name] = details;
  }
  return byModule;
}

/**
 * Hydrate the original workspace + baseline findings for /api/scan/fix.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.token
 * @param {string} opts.tier
 * @param {string[]} opts.issueFiles                 Files about to be fixed.
 * @param {Array<{path: string, content: string}>} [opts.existingFileContents]
 * @param {Record<string, string[]>|null} [opts.existingFindings]
 * @param {(owner, repo, ref, token) => Promise<string[]>} opts.fetchTree
 * @param {(owner, repo, path, ref, token) => Promise<string|null>} opts.fetchBlob
 * @param {(tier, ctx) => Promise<{modules: Array, totalIssues: number}>} [opts.runTier]
 *        When provided and findings are missing, the baseline is computed.
 * @param {number} [opts.maxFiles]
 * @returns {Promise<{
 *   fileContents: Array<{path: string, content: string}>,
 *   findingsByModule: Record<string, string[]>|null,
 *   hydratedFiles: boolean,
 *   hydratedFindings: boolean,
 *   reason: string|null,
 * }>}
 */
async function hydrateFixWorkspace({
  owner,
  repo,
  token,
  tier = 'full',
  issueFiles = [],
  existingFileContents = [],
  existingFindings = null,
  fetchTree,
  fetchBlob,
  runTier,
  maxFiles = 60,
}) {
  const hasFiles = Array.isArray(existingFileContents) && existingFileContents.length > 0;
  const hasFindings = existingFindings && typeof existingFindings === 'object' && Object.keys(existingFindings).length > 0;

  // Caller supplied everything — nothing to do.
  if (hasFiles && hasFindings) {
    return { fileContents: existingFileContents, findingsByModule: existingFindings, hydratedFiles: false, hydratedFindings: false, reason: null };
  }

  let fileContents = hasFiles ? existingFileContents : [];
  let hydratedFiles = false;
  let reason = null;

  if (!hasFiles) {
    try {
      const treePaths = await fetchTree(owner, repo, 'HEAD', token);
      if (Array.isArray(treePaths) && treePaths.length > 0) {
        const wanted = selectFilesToHydrate({ treePaths, issueFiles, maxFiles });
        const blobs = await Promise.all(
          wanted.map(async (path) => {
            try {
              const content = await fetchBlob(owner, repo, path, 'HEAD', token);
              return content ? { path, content } : null;
            } catch {
              return null;
            }
          })
        );
        fileContents = blobs.filter(Boolean);
        hydratedFiles = fileContents.length > 0;
        if (!hydratedFiles) reason = 'tree fetched but no file contents could be read';
      } else {
        reason = 'empty repo tree';
      }
    } catch (err) {
      reason = `workspace fetch failed: ${err && err.message ? err.message : String(err)}`;
    }
  }

  let findingsByModule = hasFindings ? existingFindings : null;
  let hydratedFindings = false;

  if (!hasFindings && typeof runTier === 'function' && fileContents.length > 0) {
    try {
      const baseline = await runTier(tier, {
        owner,
        repo,
        files: fileContents.map((f) => f.path),
        fileContents,
      });
      findingsByModule = findingsByModuleFromScan(baseline);
      hydratedFindings = true;
    } catch (err) {
      // Baseline scan failure means the gate will skip — record why, but
      // never block the fix flow itself.
      reason = reason || `baseline scan failed: ${err && err.message ? err.message : String(err)}`;
      findingsByModule = null;
    }
  }

  return { fileContents, findingsByModule, hydratedFiles, hydratedFindings, reason };
}

module.exports = {
  hydrateFixWorkspace,
  selectFilesToHydrate,
  findingsByModuleFromScan,
  CONVENTION_FILES,
};
