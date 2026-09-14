/**
 * Env-Vars Module — cross-check code references against declared env.
 *
 * Two silent footguns every team has:
 *
 *   1. `process.env.STRIPE_SECRET_KEY` appears in code but isn't in
 *      `.env.example`. The developer has it locally; nobody else
 *      does. Production deploy: app boots, endpoint 500s on first
 *      request. "Works on my machine" squared.
 *
 *   2. `.env.example` lists `FEATURE_FLAG_OLD_CHECKOUT` that no code
 *      reads anymore. Dead config accumulates. New engineers copy
 *      it into their `.env`, wonder what it does, ship pull requests
 *      toggling a flag that no longer exists.
 *
 * Competitors:
 *   - `dotenv-linter` (Rust) checks `.env` file syntax only — not
 *     cross-reference with code.
 *   - `@dotenvx/dotenvx` has a `diff` subcommand but only between two
 *     `.env` files — not against source.
 *   - Nothing unifies code-↔-env contract verification.
 *
 * Approach (two-phase, line-heuristic):
 *
 *   Phase 1 — Harvest declared env keys from:
 *     - `.env.example` / `.env.sample` / `.env.template` /
 *       `.env.local.example` (these are the public contract)
 *     - `.env` (local defaults — counts as "declared" for the purpose
 *       of "is this accessible")
 *     - `config.yml` / `docker-compose.yml` env blocks
 *     - `.github/workflows/*.yml` `env:` blocks
 *     - `vercel.json` / `netlify.toml` env blocks
 *
 *   Phase 2 — Harvest referenced env keys from source:
 *     - JS/TS: `process.env.<KEY>` / `process.env["<KEY>"]`
 *     - Python: `os.environ["FOO"]` / `os.environ.get("FOO")` /
 *       `os.getenv("FOO")`
 *     - Go: `os.Getenv("FOO")` / `os.LookupEnv("FOO")`
 *     - Next.js: `process.env.NEXT_PUBLIC_*` (client-exposed)
 *
 *   Phase 3 — Cross-reference and flag:
 *     - Referenced in code, NOT declared anywhere → error
 *     - Declared in `.env.example`, NOT referenced in code → warning
 *     - `NEXT_PUBLIC_*` referenced server-side only → info
 *
 * Rules:
 *
 *   error:   `process.env.X` read in source but `X` is absent from
 *            every declared env source (deploy will boot a broken app).
 *            (rule: `env-vars:missing-from-example:<KEY>`)
 *
 *   warning: `X=...` declared in `.env.example` but nothing reads it
 *            anywhere in source.
 *            (rule: `env-vars:unused-in-code:<KEY>`)
 *
 *   info:    `NEXT_PUBLIC_*` key — recorded for visibility (these
 *            are bundled into client code and visible to end users,
 *            so "secret-shaped" names here are dangerous).
 *            (rule: `env-vars:client-exposed:<KEY>`)
 *
 * TODO(gluecron): host-neutral — but the CI env harvest will need a
 * Gluecron adapter once Gluecron publishes its workflow schema.
 */

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');

// Directory excludes beyond what `BaseModule._collectFiles` already skips
// (node_modules, .git, dist, build, coverage, .next, out, …). The old
// private walk (removed under KI #104) also skipped these.
const EXTRA_EXCLUDES = ['.terraform'];

const CODE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go',
]);

const ENV_BASENAME_RE = /^\.env(?:\.(?:example|sample|template|local\.example|production\.example))?$/i;

const CI_WORKFLOW_RE = /\.ya?ml$/i;

// Test paths contain scanner fixtures like `"process.env.SOME_KEY"` embedded
// as string literals; they'd pollute the reference set with keys that
// are not real app env reads. Skip.

// Local-dev config files legitimately read env vars (BASE_URL, CI)
// that CI sets at runtime; they don't need `.env.example` entries.
const DEV_CONFIG_BASENAME_RE = /^(?:playwright|vitest|jest|cypress|webpack|vite|rollup|next|tailwind|postcss|babel|eslint|prettier)\.config\.(?:js|mjs|cjs|ts|mts|cts)$/i;

// Keys that are _always_ considered declared — they come from the
// runtime/platform, not from the app.
const RUNTIME_ENV_ALLOWLIST = new Set([
  'NODE_ENV', 'PORT', 'HOST', 'HOME', 'PATH', 'USER', 'PWD', 'LANG',
  'TZ', 'TMPDIR', 'TEMP', 'TMP', 'CI', 'VERCEL', 'VERCEL_ENV',
  'VERCEL_URL', 'VERCEL_REGION', 'VERCEL_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_REF', 'VERCEL_GIT_COMMIT_MESSAGE',
  'VERCEL_GIT_COMMIT_AUTHOR_LOGIN', 'VERCEL_GIT_REPO_SLUG',
  'VERCEL_GIT_REPO_OWNER', 'NEXT_RUNTIME', 'NEXT_PHASE',
  'RENDER', 'HEROKU', 'NETLIFY', 'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_EXECUTION_ENV',
  'GITLAB_CI', 'CI_COMMIT_SHA', 'CI_PIPELINE_ID',
  'DEBUG', '__NEXT_PRIVATE_ORIGIN',
  // Windows OS variables — never app-controlled
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'WINDIR', 'SYSTEMROOT',
  'COMPUTERNAME', 'USERNAME', 'USERDOMAIN', 'PROCESSOR_ARCHITECTURE',
  // Terminal — every shell sets this; never app-controlled.
  'TERM', 'COLORTERM', 'TERM_PROGRAM', 'SHELL', 'EDITOR', 'VISUAL',
  // Flask framework runtime vars — same role as NODE_ENV: framework
  // reads them at boot. Never put in .env.example.
  'FLASK_DEBUG', 'FLASK_ENV', 'FLASK_APP', 'FLASK_RUN_HOST',
  'FLASK_RUN_PORT', 'FLASK_RUN_CERT', 'FLASK_RUN_KEY',
  'FLASK_RUN_FROM_CLI', 'FLASK_SKIP_DOTENV',
  // Django framework runtime vars
  'DJANGO_SETTINGS_MODULE', 'DJANGO_ALLOW_ASYNC_UNSAFE',
  // FastAPI / uvicorn / gunicorn runtime
  'UVICORN_HOST', 'UVICORN_PORT', 'GUNICORN_CMD_ARGS',
  // Python runtime
  'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONDONTWRITEBYTECODE',
  'PYTHONUNBUFFERED', 'PYTHONIOENCODING', 'PYTHONHASHSEED',
  // Ruby / Rails runtime
  'RAILS_ENV', 'RACK_ENV', 'BUNDLE_GEMFILE', 'BUNDLE_PATH',
  // Go runtime
  'GOPATH', 'GOROOT', 'GOPROXY', 'GOCACHE', 'GOMODCACHE',
  // Node tooling
  'NPM_CONFIG_LOGLEVEL', 'NPM_TOKEN', 'NODE_OPTIONS',
  'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED',
]);

// Runtime-allowlist by PREFIX — covers ecosystems where the runtime
// sets a wide family of env vars and any of them might be read from
// user code. Listing every `GITHUB_*` / `RUNNER_*` exhaustively is
// brittle (GitHub adds new ones — GITHUB_REPOSITORY_ID, GITHUB_OUTPUT,
// GITHUB_STEP_SUMMARY, GITHUB_TRIGGERING_ACTOR etc — without notice).
// Prefix matching keeps the allowlist correct as GitHub evolves the
// Actions runtime contract.
//
// References:
//   GitHub Actions default env vars:
//     https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables
//   Runner env vars: same page, RUNNER_* section.
const RUNTIME_ENV_PREFIX_ALLOWLIST = [
  'GITHUB_',   // GitHub Actions default env (GITHUB_RUN_ID, _EVENT_NAME, _EVENT_PATH, _WORKSPACE, _SERVER_URL, _HEAD_REF, etc.)
  'RUNNER_',   // GitHub Actions runner env (RUNNER_OS, RUNNER_TEMP, RUNNER_TOOL_CACHE, RUNNER_ARCH, RUNNER_DEBUG, RUNNER_ENVIRONMENT, RUNNER_NAME)
];

function isRuntimeAllowed(key) {
  if (RUNTIME_ENV_ALLOWLIST.has(key)) return true;
  for (const prefix of RUNTIME_ENV_PREFIX_ALLOWLIST) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

// Env-key shape: UPPER_SNAKE, at least 2 chars.
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,}$/;

// process.env.<KEY>  /  process.env['<KEY>']  /  process.env["<KEY>"]
// Matched on the MASKED line (BaseModule._maskedLines — strings and comments
// blanked, delimiters and offsets kept), so a `process.env.X` quoted in an
// advice string or a doc comment is not a read. The bracket form's key is
// string content, blank on the masked line: the regex stops at the opening
// quote and NODE_ENV_BRACKET_KEY_RE reads the key from the raw line at that
// offset. The per-line quote counter this replaced (2026-09-05) could not see
// a template literal or a block comment spanning lines.
const NODE_ENV_REF_RE = /\bprocess\.env\.([A-Z][A-Z0-9_]+)\b|\bprocess\.env\[\s*['"`]/g;
const NODE_ENV_BRACKET_KEY_RE = /^([A-Z][A-Z0-9_]+)['"`]\s*\]/;

// `env: {` opening a child's environment object, and a `KEY:` / `KEY,`
// member inside it — both on the masked line, so a key inside a string is
// not a member. Matched from the start of a member (after `{`, `,` or the
// line start) so `...process.env` and `NODE_OPTIONS: ''` read as members
// and `foo.BAR:` does not.
const CHILD_ENV_BLOCK_RE = /\benv\s*:\s*\{/;
const CHILD_ENV_KEY_RE = /(?:^|[{,]|\n)\s*([A-Z][A-Z0-9_]+)\s*(?=[:,}]|$)/g;

// os.environ["FOO"] / os.environ.get("FOO") / os.getenv("FOO")
const PY_ENV_REF_RE = /\bos\.(?:environ\[|environ\.get\(|getenv\()\s*['"]([A-Z][A-Z0-9_]+)['"]/g;

// Go: os.Getenv("FOO") / os.LookupEnv("FOO")
const GO_ENV_REF_RE = /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]+)"/g;

// Raw line on purpose: Python and Go lines are never masked, and the
// `.get(K, d)` shape reads the quoted key itself.
function isGuardedRead(raw, end) {
  const tail = raw.slice(end, end + 60);
  return /^\s*(?:\)|\]|\))*\s*(?:\|\||\?\?|\?\.|\?\s|\|\|=)/.test(tail)
    || /^\s*,\s*[^)]+\)/.test(tail) && /(?:\.get|getenv)\s*\(\s*['"]?[A-Z_]+['"]?\s*$/.test(raw.slice(0, end))
    || /\b(?:os\.environ\.get|os\.getenv|getenv)\s*\(\s*['"][A-Z0-9_]+['"]\s*,/.test(raw);
}

class EnvVarsModule extends BaseModule {
  constructor() {
    super(
      'envVars',
      'Env-vars — cross-reference process.env / os.environ reads against .env.example and CI env blocks; flag missing and unused keys',
    );
    // Opt out of incremental: the declared-vs-referenced comparison is a
    // whole-repo set diff — scanning only the changed files would report
    // every key read elsewhere as "declared but unused". Cross-file
    // invariant — always full set.
    this._respectsIncremental = false;
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    const declared = this._harvestDeclared(projectRoot);
    const referenced = this._harvestReferenced(projectRoot);

    if (declared.size === 0 && referenced.size === 0) {
      result.addCheck('env-vars:no-env', true, {
        severity: 'info',
        message: 'No `.env.example` / no `process.env.*` references found — skipping',
      });
      return;
    }

    result.addCheck('env-vars:scanning', true, {
      severity: 'info',
      message: `Env audit: ${declared.size} declared key(s), ${referenced.size} referenced key(s)`,
    });

    let issues = 0;

    // Missing-from-example: referenced in code, not declared.
    // Severity follows RISK: only an UNGUARDED read (no `||`/`??`/`.get(k, d)`
    // fallback) in a repo that HAS an `.env.example` can "boot a broken app".
    // A guarded read, or a repo with no example file at all (nothing to be
    // missing from), is a warning. Message names the language's own idiom
    // (`os.environ["X"]`, not `process.env.X`, on a Python file).
    // (2026-08-18 audit: fastapi's `os.environ.get("FASTAPI_ENV")` with a
    // fallback was a blocking error, worded as `process.env.`.)
    const hasExampleFile = ['.env.example', '.env.sample', '.env.template'].some((f) => fs.existsSync(path.join(projectRoot, f)));
    for (const [key, refs] of referenced) {
      if (isRuntimeAllowed(key)) continue;
      if (declared.has(key)) continue;
      // A key the program only SETS for a child process is not a key the
      // program needs configured — `GIT_TERMINAL_PROMPT: '0'` on a spawn is
      // an output, and nothing boots broken when it is absent from
      // `.env.example`. It still counts as a use above (unused-in-code).
      if (refs.every((r) => r.form === 'child-env')) continue;
      const firstRef = refs[0];
      const unguarded = refs.some((r) => !r.guarded);
      const lang = firstRef.lang || 'js';
      const idiom = lang === 'py' ? `os.environ["${key}"]` : lang === 'go' ? `os.Getenv("${key}")` : `process.env.${key}`;
      issues += this._flag(result, `env-vars:missing-from-example:${key}`, {
        severity: unguarded && hasExampleFile ? 'error' : 'warning',
        key,
        file: firstRef.file,
        line: firstRef.line,
        references: refs.length,
        message: `\`${idiom}\` is read in ${refs.length} location(s) (first: ${firstRef.file}:${firstRef.line}) but \`${key}\` is NOT in \`.env.example\` / \`.env.sample\` / CI env${unguarded ? ' — an unguarded read boots a broken app when it is unset' : ' (every read has a fallback, so this is documentation debt, not a boot risk)'}`,
        suggestion: `Add \`${key}=\` to \`.env.example\` with a comment explaining what it is.${unguarded ? ` If it has a safe default, use a fallback at the call site.` : ''}`,
      });
    }

    // Unused-in-code: declared in .env.example, not referenced.
    for (const key of declared) {
      if (isRuntimeAllowed(key)) continue;
      if (referenced.has(key)) continue;
      issues += this._flag(result, `env-vars:unused-in-code:${key}`, {
        severity: 'warning',
        key,
        message: `\`${key}\` is declared in \`.env.example\` but nothing in the codebase reads it — dead configuration`,
        suggestion: `Either delete \`${key}\` from \`.env.example\`, or add the \`process.env.${key}\` reference that was planned.`,
      });
    }

    // NEXT_PUBLIC_* info pass.
    for (const [key, refs] of referenced) {
      if (!key.startsWith('NEXT_PUBLIC_') && !key.startsWith('VITE_') && !key.startsWith('REACT_APP_')) continue;
      const firstRef = refs[0];
      issues += this._flag(result, `env-vars:client-exposed:${key}`, {
        severity: 'info',
        key,
        file: firstRef.file,
        line: firstRef.line,
        message: `\`${key}\` is a client-bundled env var — its value ships to every browser. Never put secrets here.`,
        suggestion: `If \`${key}\` holds a secret, rename it to drop the \`NEXT_PUBLIC_\` / \`VITE_\` / \`REACT_APP_\` prefix and move reads to server-only code.`,
      });
    }

    result.addCheck('env-vars:summary', true, {
      severity: 'info',
      message: `Env-vars scan: declared=${declared.size}, referenced=${referenced.size}, issues=${issues}`,
    });
  }

  _harvestDeclared(projectRoot) {
    const declared = new Set();
    // Shared walk from BaseModule (KI #104) — '*' because the declaring
    // files (.env*, vercel.json, compose files, CI workflows) share no
    // extension; the basename routing below is unchanged.
    for (const full of this._collectFiles(projectRoot, ['*'], EXTRA_EXCLUDES)) {
      const name = path.basename(full);
      if (ENV_BASENAME_RE.test(name)) {
        this._harvestEnvFile(full, declared);
      } else if (
        name === 'vercel.json' ||
        name === 'netlify.toml' ||
        name === 'docker-compose.yml' ||
        name === 'docker-compose.yaml' ||
        name === 'compose.yml' ||
        name === 'compose.yaml'
      ) {
        this._harvestConfigFile(full, declared);
      } else if (full.replace(/\\/g, '/').includes('.github/workflows/') && CI_WORKFLOW_RE.test(name)) {
        this._harvestWorkflowFile(full, declared);
      }
    }
    return declared;
  }

  _harvestEnvFile(file, out) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return; }
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      // Remove optional `export `
      const body = line.replace(/^export\s+/, '');
      const eq = body.indexOf('=');
      if (eq <= 0) continue;
      const key = body.slice(0, eq).trim();
      if (ENV_KEY_RE.test(key)) out.add(key);
    }
  }

  _harvestConfigFile(file, out) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return; }
    // Match ${VAR} interpolations (docker-compose, netlify.toml).
    const interp = /\$\{([A-Z][A-Z0-9_]+)(?::-[^}]*)?\}/g;
    let m;
    while ((m = interp.exec(content)) !== null) out.add(m[1]);
    // vercel.json has `"env": { "KEY": "@..." }`.
    if (file.endsWith('vercel.json')) {
      try {
        const json = JSON.parse(content);
        const env = json.env || {};
        for (const k of Object.keys(env)) {
          if (ENV_KEY_RE.test(k)) out.add(k);
        }
      } catch { /* ignore */ }
    }
    // docker-compose environment: KEY: value lines (cheap YAML peek).
    // Only consume lines that look like `  KEY: value` inside an
    // `environment:` block. We approximate state with a flag.
    let inEnv = false;
    for (const ln of content.split(/\r?\n/)) {
      if (/^\s*environment\s*:\s*$/.test(ln)) { inEnv = true; continue; }
      if (inEnv) {
        if (/^\S/.test(ln)) { inEnv = false; }
        const match = ln.match(/^\s+-?\s*([A-Z][A-Z0-9_]+)\s*[:=]/);
        if (match) out.add(match[1]);
      }
    }
  }

  _harvestWorkflowFile(file, out) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return; }
    // `env:` block: lines indented under `env:` header look like
    // `  FOO: ${{ secrets.FOO }}` or `  FOO: bar`.
    let inEnv = false;
    let envIndent = -1;
    for (const ln of content.split(/\r?\n/)) {
      const headerMatch = ln.match(/^(\s*)env\s*:\s*$/);
      if (headerMatch) { inEnv = true; envIndent = headerMatch[1].length; continue; }
      if (inEnv) {
        const lineIndent = ln.match(/^(\s*)/)[1].length;
        if (ln.trim() === '' ) continue;
        if (lineIndent <= envIndent) { inEnv = false; continue; }
        const km = ln.match(/^\s+([A-Z][A-Z0-9_]+)\s*:/);
        if (km) out.add(km[1]);
      }
    }
    // Also harvest `secrets.X` and `vars.X` refs — `secrets.X` means
    // the maintainer has decided `X` is a platform secret, so treat as
    // "declared at CI level".
    const secretsRe = /\b(?:secrets|vars)\.([A-Z][A-Z0-9_]+)\b/g;
    let m;
    while ((m = secretsRe.exec(content)) !== null) out.add(m[1]);
  }

  _harvestReferenced(projectRoot) {
    const referenced = new Map(); // key → [{file, line}]
    // Shared walk from BaseModule (KI #104); test-path and dev-config
    // skips are unchanged.
    for (const full of this._collectFiles(projectRoot, [...CODE_EXTS], EXTRA_EXCLUDES)) {
      const rel = repoRelative(projectRoot, full);
      if (this._isTestPath(rel)) continue;
      if (DEV_CONFIG_BASENAME_RE.test(path.basename(full))) continue;
      this._scanReferences(full, projectRoot, referenced);
    }
    return referenced;
  }

  _scanReferences(file, projectRoot, referenced) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return; }
    const rel = repoRelative(projectRoot, file);
    const ext = path.extname(file).toLowerCase();
    const isJs = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(ext);
    const lang = isJs ? 'js' : ext === '.go' ? 'go' : ext === '.py' ? 'py' : null;
    if (!lang) return;

    const lines = content.split(/\r?\n/);
    // JS/TS: the one stripper decides what is a comment or a string. Go and
    // Python keep the line-state trackers below — the stripper is JS-only.
    const masked = isJs ? this._maskedLines(content) : null;
    const state = { inBlockComment: false, inPyDoc: false };
    // Brace depth inside an `env: {` object handed to a child process
    // (`spawn(cmd, args, { env: { ...process.env, KEY: value } })`). A key
    // SET there is a use of the key: the program passes it on, and the child
    // is where it is read — often from source the parent holds as a string
    // (`src/core/playwright-sandbox.js` boots its worker from one, and its
    // two keys went "unused" the day reads inside strings stopped counting,
    // 2026-09-05). Recorded as guarded: an absent value cannot break boot.
    let envDepth = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const code = isJs ? (masked[i] || '') : this._codeOfLine(raw, lang, state);
      if (code === null || !code.trim()) continue;

      if (isJs) {
        let from = 0;
        if (envDepth === 0) {
          const open = CHILD_ENV_BLOCK_RE.exec(code);
          if (open) { envDepth = 1; from = open.index + open[0].length; }
        }
        if (envDepth > 0) {
          const inside = code.slice(from);
          CHILD_ENV_KEY_RE.lastIndex = 0;
          let km;
          while ((km = CHILD_ENV_KEY_RE.exec(inside)) !== null) {
            if (!ENV_KEY_RE.test(km[1])) continue;
            if (!referenced.has(km[1])) referenced.set(km[1], []);
            referenced.get(km[1]).push({ file: rel, line: i + 1, guarded: true, lang, form: 'child-env' });
          }
          for (const ch of inside) {
            if (ch === '{') envDepth += 1;
            else if (ch === '}' && (envDepth -= 1) === 0) break;
          }
        }
      }

      for (const { key, end } of this._envRefsOn(code, raw, lang)) {
        // A read WITH a fallback (`|| default`, `?? default`, `.get(K, d)`,
        // `getenv(K, d)`, `?.`) cannot break boot when the key is absent —
        // that is exactly what the fallback is for. Record it as guarded.
        const guarded = isGuardedRead(raw, end);
        if (!referenced.has(key)) referenced.set(key, []);
        referenced.get(key).push({ file: rel, line: i + 1, guarded, lang });
      }
    }
  }

  // Go: block-comment tracking plus inline comment stripping; Python:
  // triple-quoted docstrings and `#` lines. Returns null for a line that is
  // not code.
  _codeOfLine(raw, lang, state) {
    const trimmed = raw.trim();
    if (lang === 'go') {
      if (state.inBlockComment) {
        if (/\*\//.test(raw)) state.inBlockComment = false;
        return null;
      }
      if (/^\s*\/\*/.test(raw) && !/\*\//.test(raw)) {
        state.inBlockComment = true;
        return null;
      }
      if (trimmed.startsWith('*')) return null;
      return raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    }
    const tripleMatches = (raw.match(/"""/g) || []).length + (raw.match(/'''/g) || []).length;
    if (state.inPyDoc) {
      if (tripleMatches % 2 === 1) state.inPyDoc = false;
      return null;
    }
    if (tripleMatches % 2 === 1) { state.inPyDoc = true; return null; }
    if (trimmed.startsWith('#')) return null;
    return raw;
  }

  // Every env read on one line: `{ key, end }`, `end` being the raw offset
  // just past the reference (where a fallback operator would begin).
  _envRefsOn(code, raw, lang) {
    const re = lang === 'js' ? NODE_ENV_REF_RE : lang === 'go' ? GO_ENV_REF_RE : PY_ENV_REF_RE;
    const refs = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      let key = m[1];
      let end = m.index + m[0].length;
      if (lang === 'js' && !key) {
        const km = NODE_ENV_BRACKET_KEY_RE.exec(raw.slice(end));
        if (!km) continue;
        key = km[1];
        end += km[0].length;
      }
      if (!key || !ENV_KEY_RE.test(key)) continue;
      refs.push({ key, end });
    }
    return refs;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = EnvVarsModule;
