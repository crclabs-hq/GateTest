// =============================================================================
// PUBLIC COPY IS VENDOR-NEUTRAL — no AI vendor or model name on any surface a
// customer or reviewer can read.
// =============================================================================
// Rule (2026-09-14): the site, the READMEs, the marketplace listings, the
// action, the extension, the CLI upsell text — nothing public says which AI
// vendor the engine is built on or which model runs where. Capability
// language only ("the fix engine", "AI-powered", "deeper analysis on the
// fix tiers").
//
// What IS allowed, and why (every entry is deliberate — add to the list only
// with a reason):
//   - MCP *client* names in install instructions. A user with Claude Desktop
//     or Claude Code needs to know the server installs there, the same way
//     Cursor and Windsurf are named. ("Claude Code", "Claude Desktop",
//     "claude.ai", `claude mcp add …`, the `.claude` config paths.)
//   - Env var names and key-acquisition URLs on the bring-your-own-key paths
//     (`ANTHROPIC_API_KEY`, console.anthropic.com). The CLI/Action/local MCP
//     server run on the customer's own key; the copy must say where to get
//     one. Renaming the variable is a breaking change.
//   - Crawler user-agents in robots.ts (ClaudeBot etc.) — those are the bots'
//     names, not ours.
//   - Code identifiers (`claudeCompliance` is a module id and renaming it
//     changes finding ids; `askClaude`, `anthropicApiUrl`, …) and file names
//     (`CLAUDE.md`, `.claude/`). These are stripped as tokens, not prose.
//   - Legal documents (privacy, DPA, terms, trust) name the sub-processors.
//     That is a disclosure obligation, so those files are out of this guard.
//
// Anything else — "powered by Claude", "Sonnet 5 everywhere else", "Fable on
// the fix tiers", "Anthropic Claude" — fails with file:line.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Scope — rendered-source level. Everything here is read by a customer, a
// reviewer, an npm/Marketplace visitor, or an MCP client.
// ---------------------------------------------------------------------------
const SCOPE_DIRS = [
  'website/app',            // pages, components, layout metadata, OG images, robots, sitemap
  'src/reporters',          // console upsell footers etc.
  'vscode-extension/src',
  'wp-plugin',
  'integrations/github-actions',
  'docs/marketplace',
];
const SCOPE_FILES = [
  'README.md',
  'action.yml',
  'server.json',
  'packages/mcp-server/README.md',
  'packages/mcp-server/package.json',
  'packages/mcp-remote/README.md',
  'packages/mcp-remote/package.json',
  'integrations/README.md',
  'integrations/scripts/install.sh',
  'integrations/marketplace/listing.md',
  'integrations/wordpress/gatetest/readme.txt',
  'vscode-extension/package.json',
  'bin/gatetest.js',
  'bin/gatetest-mcp.mjs',
  'website/app/lib/chat-system-prompt.js', // the chat widget's self-description reaches the customer
];
// Excluded from SCOPE_DIRS walks, with the reason.
const EXCLUDE = [
  /^website\/app\/lib\//,            // internal libs; chat-system-prompt.js is added back explicitly above
  /^website\/app\/api\//,            // route internals (identifiers, upstream calls); customer-facing messages are covered by the tests below
  /^website\/app\/admin\//,          // admin-only UI behind auth
  /^website\/app\/legal\//,          // sub-processor disclosures must name vendors
  /^website\/app\/trust\//,          // same — trust centre lists the sub-processors
  /^website\/app\/data\/changelog\.json$/, // commit titles — history, out of scope
  /\.(png|jpg|jpeg|ico|svg|woff2?|lock)$/,
];
const SCAN_EXT = /\.(tsx?|jsx?|mjs|cjs|md|txt|json|yml|yaml|sh|php)$/;

// ---------------------------------------------------------------------------
// Forbidden — vendor and model names. `gpt-4`-style ids and OpenAI included so
// a future "second opinion" mention doesn't leak either.
// ---------------------------------------------------------------------------
const FORBIDDEN = /\b(claude|anthropic|fable|sonnet|opus|haiku|openai|gpt-?\d)\b/i;

// ---------------------------------------------------------------------------
// Allowlist — exact substrings removed before the forbidden regex runs.
// Global entries apply everywhere; per-file entries only in that file.
// ---------------------------------------------------------------------------
const GLOBAL_ALLOW = [
  // MCP clients the user installs the server into
  'Claude Code', 'Claude Desktop', 'claude.ai', 'claude mcp add',
  "'Claude Code'", '.claude.json', '.claude/', 'claude_desktop_config',
  // env var names / key acquisition on BYOK paths
  'ANTHROPIC_API_KEY', 'NEXT_PUBLIC_ANTHROPIC_API_KEY', 'NEXT_PUBLIC_ANTHROPIC_KEY',
  'ANTHROPIC_KEY_PRESENT', 'CLAUDE_MODEL', 'console.anthropic.com', 'api.anthropic.com', 'sk-ant-',
  // crawler user-agents (robots.ts)
  'ClaudeBot', 'Claude-Web', 'anthropic-ai',
  // file names / module ids / code paths
  'CLAUDE.md', 'claude-md', 'claudeCompliance', 'anthropic-config', 'anthropic-version', 'claude-code',
];
const FILE_ALLOW = {
  // `--model` alias values are CLI flag values, not prose. The descriptions
  // around them are capability language.
  'bin/gatetest.js': ['sonnet (default) | opus | fable', 'fable is the most capable at'],
  'bin/gatetest-mcp.mjs': ['sonnet | opus | fable', 'sonnet (default — fastest, cheapest)', 'fable (the most capable', 'opus (sits between)'],
  // Config keys / values for the MCP client auto-configuration — the IDE ids.
  'vscode-extension/src/extension.ts': ["'claude'", 'claude:'],
};

// Comments in source files are not rendered. Strip them so a `// see CLAUDE.md`
// or a historical note does not fail the guard; prose in strings/JSX stays.
// Only comment shapes that START a line (or follow a statement) are stripped —
// a `/*` or `//` inside a string or a URL is left alone so a glob or a link in
// prose cannot swallow the text after it.
function stripComments(rel, src) {
  if (/\.(tsx?|jsx?|mjs|cjs|php)$/.test(rel)) {
    return src
      .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?/gm, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^[ \t]*\/\/[^\n]*/gm, '')
      .replace(/([;{}(,])[ \t]*\/\/[^\n]*/g, (_, pre) => pre);
  }
  return src;
}

// Code identifiers glued to other word characters (askClaude, anthropicApiUrl,
// ANTHROPIC_API_URL, claudeError) are not prose. A bare word is.
function stripIdentifiers(src) {
  return src.replace(/\w*(?:claude|anthropic)\w*/gi, (m) => (/^(?:claude|anthropic)$/i.test(m) ? m : ' '));
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function scopeFiles() {
  const files = new Set();
  for (const d of SCOPE_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs, [])) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      if (!SCAN_EXT.test(rel)) continue;
      if (EXCLUDE.some((re) => re.test(rel))) continue;
      files.add(rel);
    }
  }
  for (const f of SCOPE_FILES) if (fs.existsSync(path.join(ROOT, f))) files.add(f);
  return [...files].sort();
}

function offendersIn(rel) {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  src = stripComments(rel, src);
  for (const a of [...GLOBAL_ALLOW, ...(FILE_ALLOW[rel] || [])]) src = src.split(a).join(' ');
  src = stripIdentifiers(src);
  const out = [];
  src.split('\n').forEach((line, i) => {
    const m = line.match(FORBIDDEN);
    if (m) out.push(`${rel}:${i + 1}: "${m[0]}" — ${line.trim().slice(0, 120)}`);
  });
  return out;
}

describe('public copy is vendor-neutral', () => {
  const files = scopeFiles();

  it('the scope is populated (anti-vacuity)', () => {
    assert.ok(files.length > 100, `expected >100 scoped files, got ${files.length}`);
    for (const must of ['website/app/page.tsx', 'website/app/layout.tsx', 'website/app/components/Hero.tsx',
      'website/app/mcp/page.tsx', 'website/app/how-it-works/page.tsx', 'website/app/llms.txt/route.ts',
      'website/app/robots.ts', 'README.md', 'action.yml', 'packages/mcp-server/README.md',
      'integrations/github-actions/gatetest-gate.yml', 'wp-plugin/readme.txt', 'vscode-extension/package.json',
      'src/reporters/console-reporter.js', 'bin/gatetest.js']) {
      assert.ok(files.includes(must), `${must} must be in scope`);
    }
  });

  it('no vendor or model name survives on any public surface', () => {
    const offenders = files.flatMap(offendersIn);
    assert.deepStrictEqual(offenders, [],
      `vendor/model names on public surfaces (rewrite as capability language, or add a justified allowlist entry):\n  ${offenders.join('\n  ')}`);
  });

  it('POSITIVE CONTROL: the matcher catches the phrases the rule exists for', () => {
    const cases = [
      'Built on Claude — Fable 5 on the fix tiers, Sonnet 5 everywhere else.',
      'AI code review (Claude reads your code)',
      'AI layer: Anthropic Claude',
      'a second Claude pair-reviews every fix',
      'powered by Claude',
      'Opus 4.8 sits between',
      'consensus pass with OpenAI',
      'gpt-5 second opinion',
    ];
    for (const c of cases) {
      let s = c;
      for (const a of GLOBAL_ALLOW) s = s.split(a).join(' ');
      s = stripIdentifiers(s);
      assert.match(s, FORBIDDEN, `matcher must flag: ${c}`);
    }
  });

  it('NEGATIVE CONTROL: the allowlist admits client-install mentions, env vars, and identifiers, not prose', () => {
    const ok = [
      'claude mcp add gatetest -- npx -y @gatetest/mcp-server',
      'Works with Claude Code, Cursor, Windsurf, Continue, and Cline.',
      'Requires ANTHROPIC_API_KEY. Get one at console.anthropic.com',
      'const r = await askClaude(prompt); anthropicApiUrl(); claudeError',
      'user-agent: ClaudeBot',
      'the claudeCompliance module',
      '// see CLAUDE.md',
      'use it from claude.ai web and mobile or the Claude Desktop app',
    ];
    for (const c of ok) {
      let s = c;
      for (const a of GLOBAL_ALLOW) s = s.split(a).join(' ');
      s = stripIdentifiers(s);
      assert.ok(!FORBIDDEN.test(s), `allowlist must admit: ${c} → ${s}`);
    }
  });

  it('the allowlist is not hiding prose (every global entry is a client name, env var, URL, crawler, or identifier)', () => {
    for (const a of GLOBAL_ALLOW) {
      assert.ok(!/\b(powered|built on|uses|model|fable|sonnet|opus)\b/i.test(a), `allowlist entry reads like prose: ${a}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Customer-facing API strings. The route files are excluded from the source
// walk (their internals are identifiers and upstream calls), so the messages
// that reach a paying customer are pinned here instead.
// ---------------------------------------------------------------------------
describe('customer-facing API messages are vendor-neutral', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('/api/scan/fix retry / degraded / syntax-gate messages do not name the vendor', () => {
    const src = read('website/app/api/scan/fix/route.ts');
    const messages = [...src.matchAll(/(?:message|error|reason|summary):\s*[`"']([^`"'\n]*)[`"']/g)].map((m) => m[1]);
    assert.ok(messages.length > 5, 'anti-vacuity: expected to find message literals');
    const bad = messages.filter((m) => FORBIDDEN.test(stripIdentifiers(m.split('ANTHROPIC_API_KEY').join(' '))));
    assert.deepStrictEqual(bad, []);
  });

  it('/api/status (public unless GATETEST_STATUS_TOKEN is set) masks vendor-named secrets behind a neutral label', () => {
    const src = read('website/app/api/status/route.ts');
    assert.match(src, /GATETEST_STATUS_TOKEN/, 'the only lock is the optional operator token — so the masking below must hold');
    // Every list that reaches the response goes through publicName().
    assert.match(src, /const publicName = \(name: string\) => \(\/ANTHROPIC\|OPENAI\|CLAUDE\/i\.test\(name\) \? "AI_PROVIDER_API_KEY" : name\)/);
    assert.ok(src.includes('const missing = REQUIRED.filter((v) => !isSet(v.name)).map((v) => ({ name: publicName(v.name), why: v.why }));'));
    assert.ok(src.includes('const importantMissing = IMPORTANT.filter((v) => !isSet(v.name)).map((v) => ({ name: publicName(v.name), why: v.why }));'));
    assert.ok(src.includes('const optionalMissing = OPTIONAL.filter((n) => !isSet(n)).map(publicName);'));
    // The entry itself survives (readiness probe + marketplace preflight still fail on it) — only the name is neutral.
    assert.match(src, /missing_required: missing\.map\(\(v\) => \(\{ name: v\.name, why: v\.why \}\)\)/);
  });
});
