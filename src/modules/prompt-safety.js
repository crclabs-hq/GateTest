/**
 * Prompt / LLM Safety Module — AI-app-specific security scanner.
 *
 * Every AI app gets the same classes of mistake, and nobody in the
 * traditional QA space (Sonar, Snyk, Lighthouse, kube-score) even
 * knows they exist. This is a GateTest lead we can lap everybody on.
 *
 * Rules (line-heuristic, JS/TS/Python):
 *
 *   error:   NEXT_PUBLIC_*_API_KEY / NEXT_PUBLIC_*_SECRET / VITE_*_API_KEY
 *            — these are bundled to the browser. The value ends up in
 *            every user's devtools.
 *   error:   openai.chat.completions.create({...}) with no `max_tokens`
 *            — unbounded output = cost DoS vector via long prompts.
 *   error:   anthropic.messages.create({...}) with no `max_tokens`
 *            — same class. Anthropic requires it anyway; missing here
 *            is a bug.
 *   warning: Prompt template interpolating a user-input-shaped variable
 *            with no delimiter — prompt injection surface.
 *            Matches both f-strings (Python) and template literals
 *            (JS/TS) whose left-hand side looks like a prompt.
 *   warning: Model references that are deprecated / known-unsafe
 *            (text-davinci-*, gpt-3.5-turbo-0301, claude-v1, claude-2.0,
 *             claude-instant, palm-*).
 *   info:    LLM call with `temperature >= 1.5` — hallucination risk.
 *
 * Pattern-keyed names (`prompt-safety:public-api-key:<rel>:<line>` etc.)
 * feed the memory module's fix-pattern engine.
 *
 * TODO(gluecron): when Gluecron ships AI-pipeline YAML, mirror these
 * rules to whatever prompt-config schema it lands on.
 */

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');

// Recommendation text comes from the engine's own model policy, so a future
// model upgrade doesn't leave us advising customers to migrate ONTO a model we
// ourselves have already moved off. Falls back to a literal if the core module
// isn't resolvable (e.g. a trimmed install).
let RECOMMENDED_MODEL = 'claude-sonnet-5';
try {
  ({ CHEAP_MODEL: RECOMMENDED_MODEL } = require('../core/engine-models'));
} catch { /* error-ok — keep the literal default */ }

// Paths that define detection patterns — scanning them would produce FPs
// because the pattern strings match the very rules they implement.
const MODULE_SOURCE_RE = /(?:^|\/)src[\\/]modules[\\/]/;

const SCAN_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);

// A file is "AI-adjacent" — and its lines are worth the rules below — when
// it names a provider or gateway in ANY of the ways real code does. Until
// 2026-09-05 (KI #106) only the literal tokens `openai` / `anthropic`
// opened a file: a raw `fetch('https://api.openai.com/v1/chat/completions')`
// gateway, Bedrock, Vertex / Gemini, Ollama, the Vercel AI SDK and LangChain
// were never read, although the deprecated-model, temperature, public-key
// and injection rules key on nothing provider-specific.
const AI_ADJACENT_RE = new RegExp([
  // the two names, any casing, as words
  String.raw`\b(?:openai|anthropic)\b`,
  // SDK packages / imports (JS and Python)
  String.raw`@anthropic-ai\/sdk|@anthropic\/sdk|openai\/openai|@google\/generative-ai|@google\/genai|@google-cloud\/vertexai|@aws-sdk\/client-bedrock-runtime|@azure\/openai|@azure-rest\/ai-inference|@mistralai\/|cohere-ai|groq-sdk|together-ai|openrouter|@ai-sdk\/|@langchain\/|['"]langchain|['"]ollama['"]|['"]ai['"]|['"]replicate['"]`,
  String.raw`\bfrom\s+(?:openai|anthropic|google\.generativeai|google\.genai|vertexai|langchain\w*|litellm|ollama|cohere|mistralai|groq)\b\s+import|\bimport\s+(?:openai|anthropic|google\.generativeai|vertexai|langchain\w*|litellm|ollama|cohere|mistralai|groq)\b`,
  String.raw`boto3[\s\S]{0,60}?bedrock-runtime|['"]bedrock-runtime['"]`,
  // raw endpoints — the gateway shape
  String.raw`api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com|openrouter\.ai\/api|api\.mistral\.ai|api\.groq\.com|api\.together\.xyz|api\.cohere\.(?:ai|com)|openai\.azure\.com|:11434\b`,
  // model identifiers in a string
  String.raw`['"\x60](?:gpt-[345o]|o[134](?:-mini)?\b|claude-|gemini-|text-davinci|text-bison|palm-|mistral-(?:large|medium|small|tiny)|mixtral-|llama-?[23]|command-r)`,
  // the SDK client classes / calls the max_tokens rule understands
  String.raw`\bGoogleGenerativeAI\b|\bInvokeModel(?:WithResponseStream)?Command\b|\bChat(?:OpenAI|Anthropic|GoogleGenerativeAI|Bedrock|VertexAI|Ollama|Groq|Mistral)\b|\b(?:generateText|streamText|generateObject|streamObject)\s*\(`,
].join('|'), 'i');

/**
 * Evidence that this file actually SENDS a prompt to an LLM — narrower than
 * AI_ADJACENT_RE (which also opens a file, correctly, on nothing stronger
 * than the bare word `openai`/`anthropic` appearing anywhere, e.g. inside an
 * unrelated package name like `openai-tokenizer`, or a `NEXT_PUBLIC_*`
 * env var that has nothing to do with prompting at all).
 *
 * Issue #633 (Tallrig, 76-workspace monorepo): the prompt-injection rule
 * fired on a plain identifier interpolated into a "you are ..." shaped
 * string in a file whose ONLY AI-adjacency signal was an unrelated
 * `NEXT_PUBLIC_*` env var elsewhere in the file — there was no LLM call on
 * that code path at all. `_looksAiAdjacent` deciding "read this file" is a
 * cheap, deliberately loose gate (missing a real prompt call is worse than
 * a wasted read); "flag this line as prompt injection" is a claim about
 * data flowing into a live API call and needs the stronger signal below —
 * a real SDK import/require, a recognised provider endpoint or model
 * string, or an actual call-site construct (`.messages.create(`,
 * `generateText(`, a LangChain `Chat*` constructor, etc.).
 *
 * Deliberately file-scoped rather than function-scoped: this module has no
 * AST, and a prompt string built in a helper is routinely passed to the
 * call site in a different function in the same file (every existing
 * positive control in tests/prompt-safety.test.js does exactly this — the
 * template is built in one function, `require("openai")` sits at module
 * scope). Fails toward detection: a file that also happens to construct
 * an unrelated prompt-shaped string is still scanned, just more precisely.
 */
const LLM_CALL_EVIDENCE_RE = new RegExp([
  // a real SDK import/require, not a bare word mention
  String.raw`require\(\s*['"](?:openai|@anthropic-ai\/sdk|@anthropic\/sdk)['"]\s*\)`,
  String.raw`import\s+[\s\S]{0,80}?from\s+['"](?:openai|@anthropic-ai\/sdk|@anthropic\/sdk)['"]`,
  String.raw`@anthropic-ai\/sdk|@anthropic\/sdk|openai\/openai|@google\/generative-ai|@google\/genai|@google-cloud\/vertexai|@aws-sdk\/client-bedrock-runtime|@azure\/openai|@azure-rest\/ai-inference|@mistralai\/|cohere-ai|groq-sdk|together-ai|openrouter|@ai-sdk\/|@langchain\/|['"]langchain|['"]ollama['"]|['"]replicate['"]`,
  String.raw`\bfrom\s+(?:openai|anthropic|google\.generativeai|google\.genai|vertexai|langchain\w*|litellm|ollama|cohere|mistralai|groq)\b\s+import|\bimport\s+(?:openai|anthropic|google\.generativeai|vertexai|langchain\w*|litellm|ollama|cohere|mistralai|groq)\b`,
  String.raw`boto3[\s\S]{0,60}?bedrock-runtime|['"]bedrock-runtime['"]`,
  // a recognised provider endpoint — the gateway shape
  String.raw`api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com|openrouter\.ai\/api|api\.mistral\.ai|api\.groq\.com|api\.together\.xyz|api\.cohere\.(?:ai|com)|openai\.azure\.com|:11434\b`,
  // a model identifier in a string — nobody writes `claude-...` / `gpt-...`
  // in a quoted literal except to name the model a call is invoking
  String.raw`['"\x60](?:gpt-[345o]|o[134](?:-mini)?\b|claude-|gemini-|text-davinci|text-bison|palm-|mistral-(?:large|medium|small|tiny)|mixtral-|llama-?[23]|command-r)`,
  // an actual call-site construct
  String.raw`\.(?:chat\.completions\.create|messages\.create)\s*\(|\bgenerateContent(?:Stream)?\s*\(|\bgenerate_content\s*\(|\bInvokeModel(?:WithResponseStream)?Command\s*\(|\b(?:generateText|streamText|generateObject|streamObject)\s*\(|\bnew\s+Chat(?:OpenAI|Anthropic|GoogleGenerativeAI|Bedrock|VertexAI|Ollama|Groq|Mistral)\s*\(|\bChat(?:OpenAI|Anthropic|Bedrock|GoogleGenerativeAI|VertexAI|Groq|MistralAI)\s*\(`,
].join('|'), 'i');

// Client-bundled env prefixes. NEXT_PUBLIC_* (Next.js), VITE_* (Vite),
// REACT_APP_* (CRA), EXPO_PUBLIC_* (Expo), PUBLIC_* (SvelteKit).
const PUBLIC_ENV_PREFIX = /\b(NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|PUBLIC_)/;
const KEYISH_SUFFIX = /(?:API_KEY|APIKEY|SECRET|TOKEN|PRIVATE_KEY)\b/;

// Hints that a variable is carrying user-supplied input. Treat these as
// untrusted when interpolated into a prompt-shaped string.
const USER_INPUT_HINTS = [
  'user_input', 'userInput', 'user_message', 'userMessage',
  'user_query', 'userQuery', 'question', 'userQuestion',
  'message', 'prompt',
  'req.body', 'request.body', 'req.query', 'request.query',
  'req.params', 'request.params',
];

// Prompt-shaped left-hand side: the literal before the interpolation
// looks like instructions / a prompt scaffold.
const PROMPT_SHAPE = /(?:^|[:,\s])(?:you are|summari[sz]e|translate|rewrite|answer|analy[sz]e|classify|extract|generate|write a|act as|please|respond with|respond as)/i;

// ---------------------------------------------------------------------------
// Model lifecycle table — the ONE place to update when a provider retires a
// model. Each entry is [id, retiresOn] where retiresOn is the announced
// retirement date (ISO) or null for models already long gone / never dated.
//
// This table is the module's "melting iceberg" surface: it is the only part of
// GateTest whose staleness ships INTO a customer's repo as wrong advice. A
// model missing here means we hand a customer a clean bill of health right up
// until their production calls start 404ing. Re-check it against
// platform.claude.com/docs/en/about-claude/models/overview whenever a new
// model generation ships, and add the NEXT generation's retirement dates as
// soon as they are announced — not after they pass.
//
// Last reconciled: 2026-07-26.
// ---------------------------------------------------------------------------
const MODEL_LIFECYCLE = [
  // --- OpenAI / Google legacy ---
  ['text-davinci-001', null], ['text-davinci-002', null], ['text-davinci-003', null],
  ['code-davinci-002', null],
  ['gpt-3.5-turbo-0301', null], ['gpt-3.5-turbo-0613', null],
  ['palm-2', null], ['text-bison-001', null],

  // --- Claude 1.x / 2.x — retired 2025-07-21 ---
  ['claude-v1', null], ['claude-v1.2', null], ['claude-v1.3', null],
  ['claude-instant-v1', null], ['claude-instant-1', null],
  ['claude-instant-1.1', null], ['claude-instant-1.2', null],
  ['claude-2', '2025-07-21'], ['claude-2.0', '2025-07-21'], ['claude-2.1', '2025-07-21'],

  // --- Claude 3.x / 3.5 / 3.7 — all retired ---
  ['claude-3-sonnet-20240229', '2025-07-21'],
  ['claude-3-5-sonnet-20240620', '2025-10-28'],
  ['claude-3-5-sonnet-20241022', '2025-10-28'],
  ['claude-3-opus-20240229', '2026-01-05'],
  ['claude-3-5-haiku-20241022', '2026-02-19'],
  ['claude-3-7-sonnet-20250219', '2026-02-19'],
  ['claude-3-haiku-20240307', '2026-04-19'],

  // --- Claude 4.0 / 4.1 — the generation most customer repos are pinned to.
  // These were missing entirely until 2026-07-26, which meant a repo pinned to
  // claude-opus-4-1 scanned clean with days left before its retirement.
  ['claude-opus-4-20250514', '2026-06-15'],
  ['claude-sonnet-4-20250514', '2026-06-15'],
  ['claude-opus-4-0', '2026-06-15'],
  ['claude-sonnet-4-0', '2026-06-15'],
  ['claude-opus-4-1', '2026-08-05'],
  ['claude-opus-4-1-20250805', '2026-08-05'],
];

// The output-cap field each provider's call takes — named in the finding so
// the fix is copy-paste, not a translation exercise.
const CAP_FIELD_NAME = {
  openai: '`max_tokens`', 'openai-py': '`max_tokens`', anthropic: '`max_tokens`', 'anthropic-py': '`max_tokens`',
  gateway: '`max_tokens` in the JSON body', gemini: '`generationConfig.maxOutputTokens`', 'gemini-py': '`max_output_tokens`',
  bedrock: '`max_tokens` / `maxTokens` / `max_gen_len` in the body', 'ai-sdk': '`maxOutputTokens`',
  langchain: '`maxTokens`', 'langchain-py': '`max_tokens=`',
};
const DEPRECATED_MODELS = MODEL_LIFECYCLE.map(([id]) => id);
const RETIREMENT_DATES = new Map(MODEL_LIFECYCLE);

/**
 * Describe a model's retirement status relative to now.
 * @param {string} id model id from MODEL_LIFECYCLE
 * @returns {{retired: boolean, days: number|null, on: string|null}}
 */
function retirementStatus(id, now = Date.now()) {
  const on = RETIREMENT_DATES.get(id) || null;
  if (!on) return { retired: true, days: null, on: null };
  const ms = Date.parse(`${on}T00:00:00Z`);
  if (Number.isNaN(ms)) return { retired: true, days: null, on };
  const days = Math.ceil((ms - now) / 86400000);
  return { retired: days <= 0, days, on };
}

// ---------------------------------------------------------------------------
// #669: no-max-tokens is wrapper-aware. Tallrig's gateway sets a 4096-token
// default server-side inside an in-process client that wraps every provider
// call — the call-site pattern below still matches (`anthropic.messages.
// create({...})` with no `max_tokens` in the body) because the client object
// is genuinely named `anthropic`/`openai` at the call site, but that call is
// SAFE: the wrapper it was imported from always injects the cap before the
// request goes out. Without this, every one of those call sites reads as an
// unbounded-cost bug although every request is actually capped.
//
// The fix asks three questions, in order, about the identifier used at the
// call site (e.g. `anthropic` in `anthropic.messages.create(...)`):
//   1. Where was it imported from? (`_findClientIdentifierOrigin`)
//   2. Is that source a vendor SDK (`openai`, `@anthropic-ai/sdk`, `from
//      anthropic import ...`, ...) or an in-repo module — a relative import
//      or a workspace package? A vendor SDK answer means this is a DIRECT
//      caller; the existing error-severity finding is unchanged.
//      (`_resolveClientModule`)
//   3. Does that in-repo module — or a module it re-exports from within the
//      same package — set a `max_tokens` / `maxTokens` / `max_output_tokens`
//      DEFAULT on the outgoing request? If yes, downgrade this call site to
//      info: the wrapper already caps it. If the module resolves but sets no
//      default, the caller stays an error/warning, and the message names the
//      wrapper instead of leaving the customer to guess why a capped-looking
//      setup still fired. (`_wrapperSetsCap`)
// ---------------------------------------------------------------------------

// Package/module specifiers that are a vendor SDK itself, JS or Python —
// never a customer's own wrapper. Kept separate from AI_ADJACENT_RE /
// LLM_CALL_EVIDENCE_RE (which decide "is this file worth reading at all")
// because this one decides "is THIS specific import a vendor package",
// matched against a whole specifier, not searched for as a substring.
const VENDOR_SDK_SPECIFIER_RE = /^(?:openai|anthropic|ai|replicate|ollama|cohere|cohere-ai|groq|groq-sdk|together-ai|openrouter|litellm|mistralai|vertexai|google\.generativeai|google\.genai|@anthropic-ai\/sdk|@anthropic\/sdk|@google\/generative-ai|@google\/genai|@google-cloud\/vertexai|@aws-sdk\/client-bedrock-runtime|@azure\/openai|@azure-rest\/ai-inference|@mistralai\/.*|@ai-sdk\/.*|@langchain\/.*|langchain(?:[-_.].*)?)$/i;

// A wrapper module "sets a default" when the cap field is assigned a literal
// value (almost always a number) rather than merely forwarded
// (`max_tokens: opts.max_tokens`) or read without a fallback.
const WRAPPER_CAP_DEFAULT_RE = /\b(?:max_tokens|maxTokens|max_output_tokens)\s*[:=]\s*\d+/;

// A module re-exporting its cap-setting internals — followed one level (or a
// short chain, cycle-safe) so a thin `index.js` that just re-exports the real
// client still counts as "the module sets a default".
const REEXPORT_RE = /module\.exports\s*=\s*require\(\s*['"`]([^'"`]+)['"`]\s*\)|export\s*(?:\*|\{[^}]*\})\s*from\s*['"`]([^'"`]+)['"`]/g;

const CLIENT_MODULE_EXTS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py'];

/**
 * Resolve a relative/absolute specifier to a real file on disk, probing the
 * extensions a bare `require('./client')`-style specifier could mean.
 */
function _resolveRelativeModule(specifier, fromFile) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [];
  for (const ext of CLIENT_MODULE_EXTS) candidates.push(`${base}${ext}`);
  for (const ext of CLIENT_MODULE_EXTS) candidates.push(path.join(base, `index${ext}`));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* error-ok — try the next candidate extension */ }
  }
  return null;
}

/**
 * Where was `identifier` imported from in `content`? Covers CommonJS
 * `require`, ESM `import`, and Python `import` — plus one indirection for
 * `const anthropic = new Anthropic(...)`, where the call-site object is a
 * local instance and the SDK/wrapper class name is what was actually
 * imported.
 */
function _findClientIdentifierOrigin(content, identifier, depth = 0) {
  const esc = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directPatterns = [
    new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=\\s*require\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)`),
    new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\b\\w+\\s*:\\s*${esc}\\b[^}]*\\}\\s*=\\s*require\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)`),
    new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\b${esc}\\b[^}]*\\}\\s*=\\s*require\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)`),
    new RegExp(`\\bimport\\s+${esc}\\s+from\\s+['"\`]([^'"\`]+)['"\`]`),
    new RegExp(`\\bimport\\s*\\{[^}]*\\b${esc}\\b[^}]*\\}\\s*from\\s+['"\`]([^'"\`]+)['"\`]`),
    new RegExp(`\\bimport\\s*\\*\\s*as\\s+${esc}\\s+from\\s+['"\`]([^'"\`]+)['"\`]`),
    new RegExp(`\\bfrom\\s+([\\w.]+)\\s+import\\s+[^\\n]*\\b${esc}\\b`),
    new RegExp(`\\bimport\\s+([\\w.]+)\\s+as\\s+${esc}\\b`),
  ];
  for (const re of directPatterns) {
    const m = re.exec(content);
    if (m) return m[1];
  }
  if (depth === 0) {
    const ctor = new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=\\s*new\\s+([A-Za-z_$][\\w$.]*)\\s*\\(`).exec(content);
    if (ctor) return _findClientIdentifierOrigin(content, ctor[1].split('.')[0], depth + 1);
  }
  return null;
}

/**
 * Is `source` an in-repo module — a relative import or a workspace package —
 * rather than a vendor SDK? Returns the resolved absolute file path, or null
 * when `source` is a vendor SDK, or resolves outside the project, or cannot
 * be resolved at all (a TS path alias, an unrecognised bare specifier — left
 * alone rather than guessed at).
 */
function _resolveClientModule(source, fromFile, projectRoot) {
  if (!source || VENDOR_SDK_SPECIFIER_RE.test(source)) return null;
  if (source.startsWith('.') || source.startsWith('/')) {
    return _resolveRelativeModule(source, fromFile);
  }
  // Bare specifier: only "in-repo" when it actually resolves to a file that
  // lives inside this project — a workspace package — not some other
  // unrecognised external dependency.
  try {
    const resolved = require.resolve(source, { paths: [path.dirname(fromFile)] });
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(projectRoot);
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  } catch { /* error-ok — cannot resolve; not provably in-repo */ }
  return null;
}

/**
 * Does `filePath` — or a module it re-exports from within the same package —
 * set a default output cap? `visited` guards against re-export cycles and
 * bounds the chain length.
 */
function _wrapperSetsCap(filePath, visited) {
  if (visited.has(filePath) || visited.size > 5) return { capped: false };
  visited.add(filePath);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { capped: false };
  }
  if (WRAPPER_CAP_DEFAULT_RE.test(content)) return { capped: true, module: filePath };

  REEXPORT_RE.lastIndex = 0;
  let m;
  while ((m = REEXPORT_RE.exec(content)) !== null) {
    const source = m[1] || m[2];
    if (!source || !(source.startsWith('.') || source.startsWith('/'))) continue;
    const resolved = _resolveRelativeModule(source, filePath);
    if (resolved) {
      const nested = _wrapperSetsCap(resolved, visited);
      if (nested.capped) return nested;
    }
  }
  return { capped: false };
}

class PromptSafetyModule extends BaseModule {
  constructor() {
    super('promptSafety', 'Prompt / LLM Safety — browser-exposed API keys, unbounded max_tokens, prompt-injection surfaces, deprecated models');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('prompt-safety:no-files', true, {
        severity: 'info',
        message: 'No JS/TS/Python source files found — skipping',
      });
      return;
    }

    // Only scan files that actually reference an AI SDK or a public
    // env var — no point line-scanning the whole codebase.
    const relevant = files.filter((f) => this._looksAiAdjacent(f));
    if (relevant.length === 0) {
      result.addCheck('prompt-safety:no-ai-code', true, {
        severity: 'info',
        message: `No AI SDK or public-env usage detected in ${files.length} file(s) — skipping`,
      });
      return;
    }

    result.addCheck('prompt-safety:scanning', true, {
      severity: 'info',
      message: `Scanning ${relevant.length} AI-adjacent file(s)`,
    });

    let totalIssues = 0;
    for (const file of relevant) {
      totalIssues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('prompt-safety:summary', true, {
      severity: 'info',
      message: `Prompt/LLM safety scan: ${relevant.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  // KI #104: the shared walk replaces a private readdir copy so `--diff` /
  // `--pr` scans only touch changed files. Every exclude the old walk had
  // is already a shared default.
  _findFiles(projectRoot) {
    return this._collectFiles(projectRoot, [...SCAN_EXTS]);
  }

  _looksAiAdjacent(file) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      return AI_ADJACENT_RE.test(content) || PUBLIC_ENV_PREFIX.test(content);
    } catch {
      return false;
    }
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return 0;
    }

    const rel = repoRelative(projectRoot, file);

    // Skip detection-pattern source files — scanning the module that
    // defines the patterns produces false positives on the patterns themselves.
    if (MODULE_SOURCE_RE.test(rel.replace(/\\/g, '/'))) return 0;

    // One definition of "is this a test path" (doctrine §4).
    const isTest = this._isTestPath(rel);

    const lines = content.split(/\r?\n/);
    const isCode = this._codeGuard(rel, content, lines);
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 1. Browser-exposed API key / secret
      // A real env-var reference is never itself nested inside another
      // string literal — that's fixture/example data (e.g. a test writing
      // `write(tmp, 'a.js', 'const key = process.env.NEXT_PUBLIC_X_KEY;')`
      // as a sample file's contents), not a live reference. Found via
      // self-scan: prompt-safety flagging its own test fixtures as real
      // findings (same class as tls-security/redos/cronExpression).
      const pubMatches = [...line.matchAll(/[A-Z][A-Z0-9_]*/g)];
      for (const pm of pubMatches) {
        const tok = pm[0];
        if (PUBLIC_ENV_PREFIX.test(tok) && KEYISH_SUFFIX.test(tok) && isCode(i, pm.index)) {
          issues += this._flag(result, `prompt-safety:public-api-key:${rel}:${i + 1}`, {
            severity: isTest ? 'warning' : 'error',
            file: rel,
            line: i + 1,
            match: tok,
            message: `\`${tok}\` — client-bundled env vars are shipped to every user's browser; the API key is effectively public`,
            suggestion: 'Move the key to a server-only env var (no public prefix) and call the LLM from a server route / edge function.',
          });
          break;
        }
      }

      // 2. Deprecated / unsafe model strings
      for (const m of DEPRECATED_MODELS) {
        const re = new RegExp(`["'\`]${m.replace(/\./g, '\\.')}["'\`]`);
        const modelMatch = re.exec(line);
        if (modelMatch && isCode(i, modelMatch.index)) {
          const status = retirementStatus(m);
          const message = status.retired
            ? `Model \`${m}\` is retired${status.on ? ` (as of ${status.on})` : ''} — these calls return 404`
            : `Model \`${m}\` retires on ${status.on} (${status.days} day${status.days === 1 ? '' : 's'} away) — migrate before then or calls start failing`;
          issues += this._flag(result, `prompt-safety:deprecated-model:${m}:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            model: m,
            retiresOn: status.on,
            daysUntilRetirement: status.days,
            message,
            suggestion: `Upgrade to a current model (e.g. \`${RECOMMENDED_MODEL}\`, or the latest GPT-4o-class model).`,
          });
          break;
        }
      }

      // 3. Extreme temperature
      const tempMatch = line.match(/\btemperature\s*[:=]\s*([0-9.]+)/);
      if (tempMatch) {
        const val = parseFloat(tempMatch[1]);
        if (!Number.isNaN(val) && val >= 1.5) {
          issues += this._flag(result, `prompt-safety:high-temperature:${rel}:${i + 1}`, {
            severity: 'info',
            file: rel,
            line: i + 1,
            value: val,
            message: `temperature=${val} — at this range output is effectively random; hallucination and off-topic responses spike`,
            suggestion: 'Use 0.0-0.3 for deterministic tasks (extraction, classification), 0.5-0.9 for creative. >= 1.5 is rarely wanted.',
          });
        }
      }
    }

    // 4. LLM call without max_tokens — scan object-literal calls
    issues += this._scanLlmCalls(content, lines, rel, result, isTest, isCode, file, projectRoot);

    // 5. Prompt injection: string templates combining a prompt-shaped
    // literal with a user-input-hinted variable, with no delimiter
    // between the literal and the var. Gated on LLM_CALL_EVIDENCE_RE — see
    // its comment: AI-adjacency alone (which may be nothing stronger than
    // an unrelated NEXT_PUBLIC_* env var) is not evidence this string is
    // ever sent to a model.
    if (LLM_CALL_EVIDENCE_RE.test(content)) {
      issues += this._scanPromptInjection(lines, rel, result, isCode);
    }

    return issues;
  }

  /**
   * Is column `idx` of line `i` executable code — not the body of a string,
   * template, regex literal or comment? Every rule in this module starts its
   * match on a non-space character (an env token, a quote, an identifier, a
   * backtick, the `f` of an f-string), so on the masked line
   * (BaseModule._maskedLines — bodies blanked, offsets preserved) that
   * character survives exactly when it is code. The mask is JS grammar: a
   * `#` comment is code to it and an apostrophe in one opens a "string" that
   * runs to the next quote, lines away — so .py keeps the per-line guard
   * until a Python stripper exists (2026-09-05).
   */
  _codeGuard(rel, content, lines) {
    const masked = this._maskedLines(content, rel);
    return (i, idx) => !this._insideLiteral(masked, lines, i, idx);
  }

  _scanLlmCalls(content, lines, rel, result, isTest = false, isCode = () => true, file = null, projectRoot = null) {
    let issues = 0;
    // Match both JS/TS and Python call-expressions. The object/kwarg
    // body is captured greedily; we then check for `max_tokens`.
    // (?:[\s\S]*?\}) catches the closing brace for JS object literals;
    // for Python we also accept `)`.
    // Each entry: the call, the captured argument body, and the field(s)
    // that cap output for THAT provider. A body that carries any of them is
    // fine; a body that carries none is the unbounded-output bug.
    // `identifierGroup`/`bodyGroup` name which capture group holds the
    // call-site client identifier (e.g. `anthropic` in `anthropic.messages.
    // create(...)`) vs the call's argument body — only 'openai'/'anthropic'
    // (JS and Python) name a client object the #669 wrapper check can trace;
    // the other kinds have no such identifier to trace and are unaffected.
    //
    // The anchor excludes a hyphen/slash/`@` neighbour (`(?<![\w/@-])` /
    // `(?![\w-])`) so it cannot latch onto the SAME word inside an unrelated
    // path or package name within the 80-char lookback — e.g. `require("../
    // lib/anthropic-client")` sitting just above a real `anthropic.messages.
    // create(...)` call (#669: an in-repo wrapper import is now a normal
    // shape here) would otherwise win as the leftmost match, anchoring the
    // whole match — and its reported line/isCode check — inside that string
    // instead of at the real call two lines later.
    const patterns = [
      { re: /(?<![\w/@-])(openai|OpenAI)(?![\w-])[\s\S]{0,80}?chat\.completions\.create\s*\(\s*\{([\s\S]*?)\}\s*\)/g,
        kind: 'openai', cap: /max_(?:completion_)?tokens\s*[:=]/, identifierGroup: 1, bodyGroup: 2 },
      { re: /(?<![\w/@-])(anthropic|Anthropic)(?![\w-])[\s\S]{0,80}?messages\.create\s*\(\s*\{([\s\S]*?)\}\s*\)/g,
        kind: 'anthropic', cap: /max_tokens\s*[:=]/, identifierGroup: 1, bodyGroup: 2 },
      { re: /(?<![\w/@-])(openai|OpenAI)(?![\w-])[\s\S]{0,80}?chat\.completions\.create\s*\(([\s\S]*?)\)/g,
        kind: 'openai-py', cap: /max_(?:completion_)?tokens\s*[:=]/, identifierGroup: 1, bodyGroup: 2 },
      { re: /(?<![\w/@-])(anthropic|Anthropic)(?![\w-])[\s\S]{0,80}?messages\.create\s*\(([\s\S]*?)\)/g,
        kind: 'anthropic-py', cap: /max_tokens\s*[:=]/, identifierGroup: 1, bodyGroup: 2 },
      // Raw gateway: fetch/axios/request to the provider's REST endpoint with
      // a JSON body. The body is what the provider bills on.
      { re: /['"\x60]https?:\/\/api\.(?:openai|anthropic)\.com\/[^'"\x60]*['"\x60][\s\S]{0,500}?JSON\.stringify\s*\(\s*\{([\s\S]*?)\}\s*\)/g,
        kind: 'gateway', cap: /max_(?:completion_)?tokens\s*[:=]/, bodyGroup: 1 },
      // Google Gemini / Vertex: generateContent({ generationConfig: { maxOutputTokens } })
      { re: /\bgenerateContent(?:Stream)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g,
        kind: 'gemini', cap: /max_?[oO]utput_?[tT]okens\s*[:=]/, bodyGroup: 1 },
      { re: /\bgenerate_content\s*\(([\s\S]*?)\)/g,
        kind: 'gemini-py', cap: /max_output_tokens\s*[:=]/, bodyGroup: 1 },
      // AWS Bedrock: InvokeModelCommand({ body: JSON.stringify({ max_tokens | maxTokens | max_gen_len | maxTokenCount }) })
      { re: /\bInvokeModel(?:WithResponseStream)?Command\s*\(\s*\{([\s\S]*?)\}\s*\)/g,
        kind: 'bedrock', cap: /max_tokens|maxTokens|max_gen_len|maxTokenCount|max_tokens_to_sample/, bodyGroup: 1 },
      // Vercel AI SDK: generateText / streamText / generateObject / streamObject({ maxTokens | maxOutputTokens })
      { re: /\b(?:generateText|streamText|generateObject|streamObject)\s*\(\s*\{([\s\S]*?)\}\s*\)/g,
        kind: 'ai-sdk', cap: /max(?:Output)?Tokens\s*:/, bodyGroup: 1 },
      // LangChain: new ChatOpenAI({ maxTokens }) / ChatAnthropic({ maxTokens }) / ChatBedrock / ChatGoogleGenerativeAI
      { re: /\bnew\s+Chat(?:OpenAI|Anthropic|Bedrock|GoogleGenerativeAI|VertexAI|Groq|Mistral)\s*\(\s*\{([\s\S]*?)\}\s*\)/g,
        kind: 'langchain', cap: /max_?[tT]okens|maxOutputTokens/, bodyGroup: 1 },
      // (?<!new\s) — the JS form is `new ChatOpenAI({…})`, matched above; the
      // Python constructor has no `new` and takes kwargs, not an object.
      { re: /(?<!new\s)\bChat(?:OpenAI|Anthropic|Bedrock|GoogleGenerativeAI|VertexAI|Groq|MistralAI)\s*\(([\s\S]*?)\)/g,
        kind: 'langchain-py', cap: /max_(?:output_)?tokens\s*=|max(?:Output)?Tokens\s*:/, bodyGroup: 1 },
    ];
    for (const { re, kind, cap, identifierGroup, bodyGroup } of patterns) {
      let m;
      while ((m = re.exec(content)) !== null) {
        const body = m[bodyGroup];
        if (cap.test(body)) continue;
        const idx = m.index;
        const beforeMatch = content.slice(0, idx);
        const lineNo = beforeMatch.split(/\r?\n/).length;
        const lineStart = beforeMatch.lastIndexOf('\n') + 1;
        // Same fixture-data guard as the other rules in this file — a real
        // API call is never itself nested inside another string literal.
        if (!isCode(lineNo - 1, idx - lineStart)) continue;

        let severity = isTest ? 'warning' : 'error';
        let message = `${kind} call sets no output cap (${CAP_FIELD_NAME[kind] || 'max_tokens'}) — an attacker crafting a long prompt can run up your bill indefinitely`;
        let suggestion = `Always set ${CAP_FIELD_NAME[kind] || 'max_tokens'} to the smallest value that fits your use case. This also caps worst-case latency.`;

        // #669: this call site is only a real cost-DoS bug if the client it
        // calls isn't already capping output elsewhere. Only meaningful when
        // we know the identifier (openai/anthropic kinds) and have a real
        // file + project root to resolve imports against (tests that call
        // _scanLlmCalls directly, without a file, skip this — same as before).
        if (identifierGroup && file && projectRoot) {
          const identifier = m[identifierGroup];
          const source = _findClientIdentifierOrigin(content, identifier);
          const wrapperPath = _resolveClientModule(source, file, projectRoot);
          if (wrapperPath) {
            const capResult = _wrapperSetsCap(wrapperPath, new Set());
            const wrapperRel = repoRelative(projectRoot, capResult.module || wrapperPath);
            if (capResult.capped) {
              severity = 'info';
              message = `cap applied in ${wrapperRel}`;
              suggestion = `The in-repo client at ${wrapperRel} already sets a default output cap for every call — no per-call change needed.`;
            } else {
              message = `Model client call sets no output cap, and the in-repo wrapper at ${wrapperRel} it comes from sets no default either — requests are unbounded`;
              suggestion = `Set a default output cap in ${wrapperRel}, or pass one explicitly at this call site.`;
            }
          }
        }

        issues += this._flag(result, `prompt-safety:no-max-tokens:${kind}:${rel}:${lineNo}`, {
          severity,
          file: rel,
          line: lineNo,
          api: kind,
          message,
          suggestion,
        });
      }
    }
    return issues;
  }

  _scanPromptInjection(lines, rel, result, isCode = () => true) {
    let issues = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // JS/TS template literal: `...${var}...`
      const tplMatches = [...line.matchAll(/`([^`]*?)\$\{\s*([^}]+?)\s*\}([^`]*)`/g)];
      for (const m of tplMatches) {
        const before = m[1];
        const varName = m[2];
        if (!isCode(i, m.index)) continue;
        if (PROMPT_SHAPE.test(before) && this._looksUserControlled(varName)) {
          issues += this._flag(result, `prompt-safety:prompt-injection:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            variable: varName,
            message: `Prompt template interpolates \`${varName}\` (user-controlled) with no delimiter — prompt-injection surface`,
            suggestion: 'Wrap untrusted input in a clearly-delimited block like <user_input>...</user_input>, and tell the model to treat it as data, not instructions.',
          });
        }
      }
      // Python f-string: f"...{var}..."
      const pyMatches = [...line.matchAll(/f["']([^"'\n]*?)\{([^}]+?)\}([^"'\n]*)["']/g)];
      for (const m of pyMatches) {
        const before = m[1];
        const varName = m[2];
        if (!isCode(i, m.index)) continue;
        if (PROMPT_SHAPE.test(before) && this._looksUserControlled(varName)) {
          issues += this._flag(result, `prompt-safety:prompt-injection:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            variable: varName,
            message: `f-string prompt interpolates \`${varName}\` (user-controlled) with no delimiter — prompt-injection surface`,
            suggestion: 'Wrap untrusted input in a clearly-delimited block like <user_input>...</user_input>, and tell the model to treat it as data, not instructions.',
          });
        }
      }
    }
    return issues;
  }

  _looksUserControlled(varName) {
    const v = varName.replace(/\s+/g, '');
    return USER_INPUT_HINTS.some((h) => v === h || v.endsWith('.' + h) || v.includes(h));
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = PromptSafetyModule;
