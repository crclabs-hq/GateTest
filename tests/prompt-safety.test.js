const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PromptSafetyModule = require('../src/modules/prompt-safety');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new PromptSafetyModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('PromptSafetyModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no JS/TS/Python files exist', async () => {
    write(tmp, 'README.md', '# hello\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'prompt-safety:no-files'));
  });

  it('skips when files exist but none are AI-adjacent', async () => {
    write(tmp, 'src/a.js', 'function add(a, b) { return a + b; }\n');
    write(tmp, 'src/b.py', 'def sub(a, b):\n    return a - b\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'prompt-safety:no-ai-code'));
  });

  it('detects AI-adjacency via openai import', async () => {
    write(tmp, 'src/a.js', [
      'const OpenAI = require("openai");',
      'const client = new OpenAI();',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'prompt-safety:scanning'));
  });

  it('detects AI-adjacency via anthropic SDK', async () => {
    write(tmp, 'src/a.ts', [
      'import Anthropic from "@anthropic-ai/sdk";',
      'const client = new Anthropic();',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'prompt-safety:scanning'));
  });

  it('detects AI-adjacency via NEXT_PUBLIC_ env prefix', async () => {
    write(tmp, 'src/a.js', [
      'const key = process.env.NEXT_PUBLIC_OPENAI_API_KEY;',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'prompt-safety:scanning'));
  });
});

describe('PromptSafetyModule — browser-exposed API keys', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-key-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on NEXT_PUBLIC_*_API_KEY', async () => {
    write(tmp, 'src/a.js', [
      'const key = process.env.NEXT_PUBLIC_OPENAI_API_KEY;',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('prompt-safety:public-api-key:'));
    assert.ok(hit, 'expected public-api-key finding');
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on VITE_*_SECRET', async () => {
    write(tmp, 'src/a.ts', [
      'const s = import.meta.env.VITE_ANTHROPIC_SECRET;',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('prompt-safety:public-api-key:')));
  });

  it('errors on REACT_APP_*_TOKEN', async () => {
    write(tmp, 'src/a.jsx', [
      'const t = process.env.REACT_APP_API_TOKEN;',
      'const openai = "openai";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('prompt-safety:public-api-key:')));
  });

  it('does NOT flag server-only OPENAI_API_KEY', async () => {
    write(tmp, 'src/a.js', [
      'const OpenAI = require("openai");',
      'const key = process.env.OPENAI_API_KEY;',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('prompt-safety:public-api-key:')),
      undefined,
    );
  });

  it('does NOT flag NEXT_PUBLIC_ without a keyish suffix', async () => {
    write(tmp, 'src/a.js', [
      'const url = process.env.NEXT_PUBLIC_SITE_URL;',
      'const openai = "openai";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('prompt-safety:public-api-key:')),
      undefined,
    );
  });
});

describe('PromptSafetyModule — max_tokens', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-mt-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on openai.chat.completions.create without max_tokens (JS)', async () => {
    write(tmp, 'src/a.js', [
      'const OpenAI = require("openai");',
      'const openai = new OpenAI();',
      'const r = await openai.chat.completions.create({',
      '  model: "gpt-4o",',
      '  messages: [{ role: "user", content: "hi" }],',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('prompt-safety:no-max-tokens:'));
    assert.ok(hit, 'expected no-max-tokens finding');
    assert.strictEqual(hit.severity, 'error');
  });

  it('does NOT flag openai.chat.completions.create with max_tokens', async () => {
    write(tmp, 'src/a.js', [
      'const OpenAI = require("openai");',
      'const openai = new OpenAI();',
      'const r = await openai.chat.completions.create({',
      '  model: "gpt-4o",',
      '  max_tokens: 256,',
      '  messages: [{ role: "user", content: "hi" }],',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('prompt-safety:no-max-tokens:')),
      undefined,
    );
  });

  it('errors on anthropic.messages.create without max_tokens (Python)', async () => {
    write(tmp, 'src/a.py', [
      'from anthropic import Anthropic',
      'client = Anthropic()',
      'resp = client.messages.create(',
      '    model="claude-sonnet-5",',
      '    messages=[{"role": "user", "content": "hi"}],',
      ')',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('prompt-safety:no-max-tokens:')));
  });

  it('does NOT flag anthropic.messages.create with max_tokens (Python)', async () => {
    write(tmp, 'src/a.py', [
      'from anthropic import Anthropic',
      'client = Anthropic()',
      'resp = client.messages.create(',
      '    model="claude-sonnet-5",',
      '    max_tokens=1024,',
      '    messages=[{"role": "user", "content": "hi"}],',
      ')',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('prompt-safety:no-max-tokens:')),
      undefined,
    );
  });
});

describe('PromptSafetyModule — prompt injection', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-inj-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on JS template literal interpolating user input into a prompt', async () => {
    write(tmp, 'src/a.js', [
      'const OpenAI = require("openai");',
      'function build(userInput) {',
      '  return `Summarize the following: ${userInput}`;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('prompt-safety:prompt-injection:'));
    assert.ok(hit, 'expected prompt-injection finding');
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on Python f-string interpolating user input into a prompt', async () => {
    write(tmp, 'src/a.py', [
      'from anthropic import Anthropic',
      'def build(user_input):',
      '    return f"Answer the question: {user_input}"',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('prompt-safety:prompt-injection:')));
  });

  it('does NOT flag template literal interpolating a non-user variable', async () => {
    write(tmp, 'src/a.js', [
      'const OpenAI = require("openai");',
      'function build(now) {',
      '  return `Summarize the latest headlines from ${now}`;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('prompt-safety:prompt-injection:')),
      undefined,
    );
  });

  it('does NOT flag template literal without prompt-shaped prefix', async () => {
    write(tmp, 'src/a.js', [
      'const openai = require("openai");',
      'function url(userInput) {',
      '  return `https://example.com/search?q=${userInput}`;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('prompt-safety:prompt-injection:')),
      undefined,
    );
  });

  // Issue #633 (Tallrig): a "you are ..."-shaped string interpolating a
  // hint-named variable was flagged as prompt injection in a file whose
  // ONLY AI-adjacency signal was an unrelated NEXT_PUBLIC_* env var
  // elsewhere in the file — there was no LLM call anywhere on that code
  // path. AI-adjacency (file worth reading) and "this string reaches a
  // live LLM call" (safe to accuse) are different claims; LLM_CALL_EVIDENCE_RE
  // draws the line the rule was missing.
  it('does NOT flag a prompt-shaped template when the only AI-adjacency signal is an unrelated NEXT_PUBLIC_* env var (issue #633)', async () => {
    write(tmp, 'src/a.js', [
      "const config = { NEXT_PUBLIC_ANALYTICS_TOKEN: 'xyz' };",
      'function describeUser(userMessage) {',
      '  return `You are being shown this message: ${userMessage}`;',
      '}',
      'module.exports = { describeUser };',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('prompt-safety:prompt-injection:')),
      undefined,
      'a file with no LLM call anywhere must not accuse a plain string of prompt injection',
    );
  });

  // Control: the identical shape, but the file ALSO makes a real LLM call —
  // the rule must still fire. A rule that stops looking altogether would
  // pass the negative control above for the wrong reason.
  it('still flags the same shape when the file also makes a real LLM call (control pair for issue #633)', async () => {
    write(tmp, 'src/a.js', [
      'const OpenAI = require("openai");',
      'const client = new OpenAI();',
      "const config = { NEXT_PUBLIC_ANALYTICS_TOKEN: 'xyz' };",
      'function describeUser(userMessage) {',
      '  return `You are being shown this message: ${userMessage}`;',
      '}',
      'async function ask(userMessage) {',
      '  return client.chat.completions.create({ model: "gpt-4o", max_tokens: 100, messages: [{ role: "user", content: describeUser(userMessage) }] });',
      '}',
      'module.exports = { describeUser, ask };',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(
      r.checks.find((c) => c.name.startsWith('prompt-safety:prompt-injection:')),
      'a file that really does call an LLM must still be flagged',
    );
  });
});

describe('PromptSafetyModule — deprecated models', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-dep-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on claude-2.0', async () => {
    write(tmp, 'src/a.js', [
      'const Anthropic = require("@anthropic-ai/sdk");',
      'const client = new Anthropic();',
      'await client.messages.create({ model: "claude-2.0", max_tokens: 100, messages: [] });',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('prompt-safety:deprecated-model:'));
    assert.ok(hit, 'expected deprecated-model finding');
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on text-davinci-003', async () => {
    write(tmp, 'src/a.py', [
      'import openai',
      'openai.Completion.create(model="text-davinci-003", prompt="hi", max_tokens=10)',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('prompt-safety:deprecated-model:')));
  });

  it('warns on claude-3-opus-20240229', async () => {
    write(tmp, 'src/a.js', [
      'const Anthropic = require("@anthropic-ai/sdk");',
      'const client = new Anthropic();',
      'await client.messages.create({ model: "claude-3-opus-20240229", max_tokens: 100, messages: [] });',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('prompt-safety:deprecated-model:')), 'expected deprecated-model finding for claude-3-opus');
  });

  it('warns on claude-3-5-sonnet-20241022', async () => {
    write(tmp, 'src/a.js', [
      'const Anthropic = require("@anthropic-ai/sdk");',
      'const client = new Anthropic();',
      'await client.messages.create({ model: "claude-3-5-sonnet-20241022", max_tokens: 100, messages: [] });',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('prompt-safety:deprecated-model:')), 'expected deprecated-model finding for claude-3-5-sonnet');
  });

  it('warns on claude-3-7-sonnet-20250219', async () => {
    write(tmp, 'src/a.js', [
      'const Anthropic = require("@anthropic-ai/sdk");',
      'const client = new Anthropic();',
      'await client.messages.create({ model: "claude-3-7-sonnet-20250219", max_tokens: 100, messages: [] });',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('prompt-safety:deprecated-model:')), 'expected deprecated-model finding for claude-3-7-sonnet');
  });

  it('does NOT flag current models', async () => {
    write(tmp, 'src/a.js', [
      'const Anthropic = require("@anthropic-ai/sdk");',
      'const client = new Anthropic();',
      'await client.messages.create({ model: "claude-sonnet-5", max_tokens: 100, messages: [] });',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('prompt-safety:deprecated-model:')),
      undefined,
    );
  });

  it('does NOT flag claude-sonnet-5 (current model)', async () => {
    write(tmp, 'src/a.js', [
      'const Anthropic = require("@anthropic-ai/sdk");',
      'const client = new Anthropic();',
      'await client.messages.create({ model: "claude-sonnet-5", max_tokens: 100, messages: [] });',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('prompt-safety:deprecated-model:')),
      undefined,
    );
  });
});

describe('PromptSafetyModule — extreme temperature', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-temp-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits info for temperature >= 1.5', async () => {
    write(tmp, 'src/a.js', [
      'const OpenAI = require("openai");',
      'const openai = new OpenAI();',
      'await openai.chat.completions.create({',
      '  model: "gpt-4o",',
      '  temperature: 1.8,',
      '  max_tokens: 256,',
      '  messages: [],',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('prompt-safety:high-temperature:'));
    assert.ok(hit, 'expected high-temperature finding');
    assert.strictEqual(hit.severity, 'info');
  });

  it('does NOT flag normal temperature', async () => {
    write(tmp, 'src/a.js', [
      'const OpenAI = require("openai");',
      'const openai = new OpenAI();',
      'await openai.chat.completions.create({',
      '  model: "gpt-4o",',
      '  temperature: 0.7,',
      '  max_tokens: 256,',
      '  messages: [],',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('prompt-safety:high-temperature:')),
      undefined,
    );
  });
});

describe('PromptSafetyModule — summary', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-sum-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('records a summary when AI-adjacent files are scanned', async () => {
    write(tmp, 'src/a.js', [
      'const OpenAI = require("openai");',
      'const openai = new OpenAI();',
      'await openai.chat.completions.create({',
      '  model: "gpt-4o",',
      '  max_tokens: 100,',
      '  messages: [],',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'prompt-safety:summary');
    assert.ok(summary);
    assert.match(summary.message, /1 file\(s\)/);
  });
});

describe('PromptSafetyModule — self-scan fixture false positives', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-self-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag a test-fixture public API key nested in a string arg', async () => {
    write(
      tmp,
      'tests/prompt-safety.test.js',
      "write(tmp, 'src/a.js', 'const key = process.env.NEXT_PUBLIC_OPENAI_API_KEY;');\n",
    );
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(hits.length, 0);
  });

  it('does NOT flag a test-fixture deprecated model nested in a string arg', async () => {
    write(
      tmp,
      'tests/prompt-safety.test.js',
      "write(tmp, 'src/a.js', 'const model = \"claude-2.0\";');\n",
    );
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(hits.length, 0);
  });

  it('does NOT flag a test-fixture prompt-injection template nested in a string arg', async () => {
    write(
      tmp,
      'tests/prompt-safety.test.js',
      "write(tmp, 'src/a.js', 'return `Summarize the following: ${userInput}`;');\n",
    );
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(hits.length, 0);
  });

  it('still flags the same public API key when it is real (unquoted) source', async () => {
    write(tmp, 'src/a.js', 'const key = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('prompt-safety:public-api-key:')));
  });

  it('still flags the same prompt-injection template when it is real (unquoted) source', async () => {
    write(
      tmp,
      'src/a.js',
      [
        'const OpenAI = require("openai");',
        'function build(userInput) {',
        '  return `Summarize the following: ${userInput}`;',
        '}',
        '',
      ].join('\n'),
    );
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('prompt-safety:prompt-injection:')));
  });
});

// KI #106 (the Fifty, move 11): a file was "AI-adjacent" only if it carried
// the literal token `openai` or `anthropic`. A raw-fetch gateway, Bedrock,
// Gemini / Vertex, the Vercel AI SDK, LangChain and Ollama were never read,
// although the deprecated-model, temperature, public-key and injection rules
// key on nothing provider-specific — and the output-cap rule knew only two
// call shapes. Each new shape below has its positive and negative control.
describe('PromptSafetyModule — every provider opens the file, every call shape has its cap (KI #106)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-gate-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const noCap = (r) => r.checks.filter((c) => !c.passed && c.name.startsWith('prompt-safety:no-max-tokens:')).map((c) => c.name);
  const scannedAi = (r) => !r.checks.some((c) => c.name === 'prompt-safety:no-ai-code');

  it('a raw-fetch gateway to api.openai.com is opened; no max_tokens in the JSON body fires; with it, quiet', async () => {
    write(tmp, 'src/gateway.ts', [
      'export async function complete(messages: unknown[]) {',
      '  const r = await fetch("https://api.openai.com/v1/chat/completions", {',
      '    method: "POST", headers: { Authorization: `Bearer ${process.env.KEY}` },',
      '    body: JSON.stringify({ model: "gpt-4o", messages }),',
      '  });',
      '  return r.json();',
      '}',
      '',
    ].join('\n'));
    let r = await run(tmp);
    assert.ok(scannedAi(r), 'the gateway file must be AI-adjacent');
    assert.strictEqual(noCap(r).length, 1, noCap(r).join());
    assert.ok(noCap(r)[0].includes(':gateway:'));
    write(tmp, 'src/gateway.ts', 'fetch("https://api.openai.com/v1/chat/completions", { body: JSON.stringify({ model: "gpt-4o", messages, max_tokens: 512 }) });\n');
    r = await run(tmp);
    assert.deepStrictEqual(noCap(r), []);
  });

  it('Gemini generateContent without generationConfig.maxOutputTokens fires; with it, quiet; a CMS generateContent with no AI signal is never opened', async () => {
    write(tmp, 'src/gemini.ts', 'import { GoogleGenerativeAI } from "@google/generative-ai";\nconst model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-1.5-pro" });\nconst out = await model.generateContent({ contents: [{ role: "user", parts: [{ text: q }] }] });\n');
    let r = await run(tmp);
    assert.ok(noCap(r).some((n) => n.includes(':gemini:')), noCap(r).join());
    write(tmp, 'src/gemini.ts', 'import { GoogleGenerativeAI } from "@google/generative-ai";\nconst out = await model.generateContent({ contents, generationConfig: { maxOutputTokens: 1024 } });\n');
    r = await run(tmp);
    assert.deepStrictEqual(noCap(r), []);
    fs.rmSync(path.join(tmp, 'src', 'gemini.ts'));
    write(tmp, 'src/cms.ts', 'export function generateContent({ template, data }) { return render(template, data); }\n');
    r = await run(tmp);
    assert.ok(!scannedAi(r), 'a CMS helper with no provider signal is not AI code');
  });

  it('Bedrock InvokeModelCommand with no cap in the body fires; max_gen_len (Llama) or maxTokenCount (Titan) is a cap', async () => {
    write(tmp, 'src/bedrock.js', 'const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");\nconst cmd = new InvokeModelCommand({ modelId: "anthropic.claude-3", body: JSON.stringify({ messages }) });\n');
    let r = await run(tmp);
    assert.ok(noCap(r).some((n) => n.includes(':bedrock:')), noCap(r).join());
    write(tmp, 'src/bedrock.js', 'const cmd = new InvokeModelCommand({ modelId: "meta.llama3", body: JSON.stringify({ prompt, max_gen_len: 512 }) });\nconst t = new InvokeModelCommand({ modelId: "amazon.titan", body: JSON.stringify({ inputText, textGenerationConfig: { maxTokenCount: 256 } }) });\n');
    r = await run(tmp);
    assert.deepStrictEqual(noCap(r), []);
  });

  it('Vercel AI SDK generateText / streamText without maxOutputTokens fires; LangChain ChatOpenAI without maxTokens fires; each with the cap is quiet', async () => {
    write(tmp, 'src/ai.ts', 'import { generateText } from "ai";\nimport { openai } from "@ai-sdk/openai";\nconst { text } = await generateText({ model: openai("gpt-4o"), prompt });\n');
    write(tmp, 'src/chain.ts', 'import { ChatOpenAI } from "@langchain/openai";\nconst llm = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });\n');
    let r = await run(tmp);
    assert.ok(noCap(r).some((n) => n.includes(':ai-sdk:')), noCap(r).join());
    assert.ok(noCap(r).some((n) => n.includes(':langchain:')), noCap(r).join());
    write(tmp, 'src/ai.ts', 'import { streamText } from "ai";\nconst s = streamText({ model, prompt, maxOutputTokens: 800 });\n');
    write(tmp, 'src/chain.ts', 'import { ChatOpenAI } from "@langchain/openai";\nconst llm = new ChatOpenAI({ model: "gpt-4o", maxTokens: 400 });\n');
    r = await run(tmp);
    assert.deepStrictEqual(noCap(r), []);
  });

  it('Python: google.generativeai generate_content without max_output_tokens fires; langchain ChatAnthropic(max_tokens=…) is quiet', async () => {
    write(tmp, 'app/llm.py', 'import google.generativeai as genai\nmodel = genai.GenerativeModel("gemini-1.5-flash")\nresp = model.generate_content(prompt)\n');
    write(tmp, 'app/chain.py', 'from langchain_anthropic import ChatAnthropic\nllm = ChatAnthropic(model="claude-sonnet-5", max_tokens=1024)\n');
    const r = await run(tmp);
    assert.ok(noCap(r).some((n) => n.includes(':gemini-py:')), noCap(r).join());
    assert.ok(!noCap(r).some((n) => n.includes('chain.py')), noCap(r).join());
  });

  it('a deprecated model id in an Ollama / OpenRouter file is found now that the file is opened; a file that merely mentions "AI" in prose is not', async () => {
    write(tmp, 'src/router.ts', 'const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { body: JSON.stringify({ model: "claude-2.1", messages, max_tokens: 200 }) });\n');
    write(tmp, 'src/about.ts', 'export const blurb = "We use AI to summarise your inbox.";\n');
    const r = await run(tmp);
    assert.ok(r.checks.some((c) => !c.passed && c.name.startsWith('prompt-safety:deprecated-model:claude-2.1:src/router.ts')), r.checks.filter((c) => !c.passed).map((c) => c.name).join());
    const scanning = r.checks.find((c) => c.name === 'prompt-safety:scanning');
    assert.ok(scanning && /1 AI/.test(scanning.message), JSON.stringify(scanning));
  });
});

describe('PromptSafetyModule — one stripper: the masked line decides', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-mask-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a public API key or a retired model inside a string, a template or a comment is not a finding; the real ones beside them are (2026-09-05)', async () => {
    write(tmp, 'src/llm.js', [
      'import OpenAI from "openai";',
      'const doc = "model: \'text-davinci-003\'";',
      'const tpl = `',
      '  const key = process.env.NEXT_PUBLIC_OPENAI_API_KEY;',
      '  model: "text-davinci-003",',
      '`;',
      '/* a block comment that starts on this line',
      '   process.env.NEXT_PUBLIC_OPENAI_API_KEY',
      '   model: "text-davinci-003" */',
      'const key = process.env.NEXT_PUBLIC_OPENAI_API_KEY;',
      'const model = "text-davinci-003";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const keys = r.checks.filter((c) => c.name.startsWith('prompt-safety:public-api-key:'));
    assert.deepStrictEqual(keys.map((c) => c.line), [10]);
    const models = r.checks.filter((c) => c.name.startsWith('prompt-safety:deprecated-model:'));
    assert.deepStrictEqual(models.map((c) => c.line), [11]);
  });

  it('Python keeps the per-line guard: a retired model nested in a string arg is quiet, the real one fires, and an apostrophe in a # comment does not blank the next line (2026-09-05)', async () => {
    write(tmp, 'src/llm.py', [
      'import openai',
      'write("a.py", "model = \'text-davinci-003\'")',
      "# don't do this",
      'model = "text-davinci-003"',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const models = r.checks.filter((c) => c.name.startsWith('prompt-safety:deprecated-model:'));
    assert.deepStrictEqual(models.map((c) => c.line), [4]);
  });
});

// #669: no-max-tokens is wrapper-aware. Tallrig's in-process client wraps
// every provider call and sets a 4096-token default server-side, so the
// call-site pattern (`anthropic.messages.create({...})` with no `max_tokens`
// in the body) still matches although every request is actually capped.
describe('PromptSafetyModule — no-max-tokens is wrapper-aware (#669)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-wrap-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const noMaxTokens = (r) => r.checks.find((c) => c.name.startsWith('prompt-safety:no-max-tokens:'));

  it('downgrades to info when the in-repo client the call comes from sets a max_tokens default', async () => {
    write(tmp, 'lib/anthropic-client.js', [
      'const Anthropic = require("@anthropic-ai/sdk");',
      'const anthropic = new Anthropic();',
      'const rawCreate = anthropic.messages.create.bind(anthropic.messages);',
      'anthropic.messages.create = (params) => rawCreate({ max_tokens: 4096, ...params });',
      'module.exports = { anthropic };',
      '',
    ].join('\n'));
    write(tmp, 'src/a.js', [
      'const { anthropic } = require("../lib/anthropic-client");',
      'async function run() {',
      '  return anthropic.messages.create({ model: "claude-sonnet-5", messages: [] });',
      '}',
      'module.exports = { run };',
      '',
    ].join('\n'));

    const r = await run(tmp);
    const hit = noMaxTokens(r);
    assert.ok(hit, 'expected a no-max-tokens check to still be recorded');
    assert.strictEqual(hit.severity, 'info', 'a call through a client that caps by default must be downgraded to info');
    assert.match(hit.message, /cap applied in lib[/\\]anthropic-client\.js/);
  });

  it('a direct vendor-SDK call with no cap stays an error (control)', async () => {
    write(tmp, 'src/a.js', [
      'const Anthropic = require("@anthropic-ai/sdk");',
      'const anthropic = new Anthropic();',
      'async function run() {',
      '  return anthropic.messages.create({ model: "claude-sonnet-5", messages: [] });',
      '}',
      'module.exports = { run };',
      '',
    ].join('\n'));

    const r = await run(tmp);
    const hit = noMaxTokens(r);
    assert.ok(hit, 'expected a no-max-tokens failure');
    assert.strictEqual(hit.severity, 'error', 'a direct vendor-SDK caller with no cap must stay an error');
  });

  it('a wrapper that sets no default keeps the caller an error and names the wrapper', async () => {
    write(tmp, 'lib/anthropic-client.js', [
      'const Anthropic = require("@anthropic-ai/sdk");',
      'const anthropic = new Anthropic();',
      'module.exports = { anthropic };',
      '',
    ].join('\n'));
    write(tmp, 'src/a.js', [
      'const { anthropic } = require("../lib/anthropic-client");',
      'async function run() {',
      '  return anthropic.messages.create({ model: "claude-sonnet-5", messages: [] });',
      '}',
      'module.exports = { run };',
      '',
    ].join('\n'));

    const r = await run(tmp);
    const hit = noMaxTokens(r);
    assert.ok(hit, 'expected a no-max-tokens failure');
    assert.strictEqual(hit.severity, 'error', 'a wrapper that sets no default must not downgrade the caller');
    assert.match(hit.message, /lib[/\\]anthropic-client\.js/, 'message must name the wrapper');
  });
});

// #673: WRAPPER_CAP_DEFAULT_RE only ever saw a numeric literal. The
// customer's real wrapper reads `max_tokens: input.maxTokens ??
// DEFAULT_MAX_OUTPUT_TOKENS` — the constant lives in a second file, imported
// at the top of the wrapper. All 21 of their call sites stayed errors
// because the wrapper "looked" uncapped to a regex expecting a bare number.
describe('PromptSafetyModule — wrapper cap resolves through ?? and an imported constant (#673)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-wrapconst-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const noMaxTokens = (r) => r.checks.find((c) => c.name.startsWith('prompt-safety:no-max-tokens:'));

  function writeClientAndConstant(tmpRoot) {
    write(tmpRoot, 'lib/types.ts', [
      'export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;',
      '',
    ].join('\n'));
    write(tmpRoot, 'lib/client.ts', [
      'import Anthropic from "@anthropic-ai/sdk";',
      'import { DEFAULT_MAX_OUTPUT_TOKENS } from "./types";',
      'export const anthropic = new Anthropic();',
      'const rawCreate = anthropic.messages.create.bind(anthropic.messages);',
      'anthropic.messages.create = (params) => rawCreate({',
      '  max_tokens: params.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,',
      '  ...params,',
      '});',
      '',
    ].join('\n'));
  }

  it('the customer\'s two-file shape (?? DEFAULT_MAX_OUTPUT_TOKENS, statically imported) downgrades to info and names the constant', async () => {
    writeClientAndConstant(tmp);
    write(tmp, 'src/a.ts', [
      'import { anthropic } from "../lib/client";',
      'async function run() {',
      '  return anthropic.messages.create({ model: "claude-sonnet-5", messages: [] });',
      '}',
      'export { run };',
      '',
    ].join('\n'));

    const r = await run(tmp);
    const hit = noMaxTokens(r);
    assert.ok(hit, 'expected a no-max-tokens check to still be recorded');
    assert.strictEqual(hit.severity, 'info', 'a wrapper default resolved through ?? and an imported constant must downgrade to info');
    assert.match(hit.message, /cap applied in lib[/\\]client\.ts/);
    assert.match(hit.message, /default 4096 from lib[/\\]types\.ts/, 'message must name the resolved value and the file it came from');
  });

  it('the same shape through a dynamic import-and-destructure caller downgrades to info', async () => {
    writeClientAndConstant(tmp);
    write(tmp, 'src/dyn.ts', [
      'async function run() {',
      '  const { anthropic } = await import("../lib/client");',
      '  return anthropic.messages.create({ model: "claude-sonnet-5", messages: [] });',
      '}',
      'export { run };',
      '',
    ].join('\n'));

    const r = await run(tmp);
    const hit = noMaxTokens(r);
    assert.ok(hit, 'expected a no-max-tokens check to still be recorded');
    assert.strictEqual(hit.severity, 'info', 'a dynamic-import-and-destructure caller must resolve the wrapper the same way a static import does');
    assert.match(hit.message, /cap applied in lib[/\\]client\.ts/);
    assert.match(hit.message, /default 4096 from lib[/\\]types\.ts/);
  });

  it('a wrapper whose fallback identifier resolves to nothing numeric keeps the caller an error and names the wrapper', async () => {
    write(tmp, 'lib/client-bad.ts', [
      'import Anthropic from "@anthropic-ai/sdk";',
      'export const anthropic = new Anthropic();',
      'const rawCreate = anthropic.messages.create.bind(anthropic.messages);',
      'anthropic.messages.create = (params) => rawCreate({',
      '  max_tokens: params.maxTokens ?? UNRESOLVED_DEFAULT,',
      '  ...params,',
      '});',
      '',
    ].join('\n'));
    write(tmp, 'src/b.ts', [
      'import { anthropic } from "../lib/client-bad";',
      'async function run() {',
      '  return anthropic.messages.create({ model: "claude-sonnet-5", messages: [] });',
      '}',
      'export { run };',
      '',
    ].join('\n'));

    const r = await run(tmp);
    const hit = noMaxTokens(r);
    assert.ok(hit, 'expected a no-max-tokens failure');
    assert.strictEqual(hit.severity, 'error', 'an unresolvable fallback identifier must not downgrade the caller');
    assert.match(hit.message, /lib[/\\]client-bad\.ts/, 'message must name the wrapper');
  });

  it('a direct vendor-SDK call with no wrapper at all stays an error (control)', async () => {
    write(tmp, 'src/c.ts', [
      'import Anthropic from "@anthropic-ai/sdk";',
      'const anthropic = new Anthropic();',
      'async function run() {',
      '  return anthropic.messages.create({ model: "claude-sonnet-5", messages: [] });',
      '}',
      'export { run };',
      '',
    ].join('\n'));

    const r = await run(tmp);
    const hit = noMaxTokens(r);
    assert.ok(hit, 'expected a no-max-tokens failure');
    assert.strictEqual(hit.severity, 'error', 'a direct vendor-SDK caller with no wrapper must stay an error');
  });
});

// #680 item 1 (Tallrig): call sites import `@vapron/ai-gateway/client` — a
// Bun workspace package whose `/client` subpath resolves through its own
// `exports` map — using the generic SDK method names (`generateObject`,
// `generateText`, `complete`) on the imported client, not the two
// vendor-SDK kinds. Two gaps: the origin finder never resolved a workspace
// package subpath at all, and even when it did, the wrapper-aware downgrade
// only ran for the vendor-SDK kinds.
describe('PromptSafetyModule — workspace subpath + generic-SDK wrapper resolution (#680)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ps-wssub-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const noMaxTokens = (r) => r.checks.filter((c) => c.name.startsWith('prompt-safety:no-max-tokens:'));

  function writeMonorepo(tmpRoot) {
    write(tmpRoot, 'package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['services/*'] }, null, 2));
    write(tmpRoot, 'services/gateway/package.json', JSON.stringify({
      name: '@acme/gateway',
      exports: {
        './client': { import: './src/client.ts', default: './src/client.ts' },
        './nocap': { import: './src/nocap-client.ts', default: './src/nocap-client.ts' },
      },
    }, null, 2));
    write(tmpRoot, 'services/gateway/src/types.ts', [
      'export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;',
      '',
    ].join('\n'));
    write(tmpRoot, 'services/gateway/src/client.ts', [
      'import { DEFAULT_MAX_OUTPUT_TOKENS } from "./types";',
      'export const gatewayClient = {',
      '  generateObject(input) { return send({ maxTokens: input.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, ...input }); },',
      '  generateText(input) { return send({ maxTokens: input.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, ...input }); },',
      '  complete(input) { return send({ maxTokens: input.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, ...input }); },',
      '};',
      '',
    ].join('\n'));
    write(tmpRoot, 'services/gateway/src/nocap-client.ts', [
      'export const nocapClient = {',
      '  generateObject(input) { return send(input); },',
      '};',
      '',
    ].join('\n'));
  }

  it('a static import of a scoped workspace subpath resolves through exports and downgrades to info', async () => {
    writeMonorepo(tmp);
    write(tmp, 'apps/api/src/deploy-summariser.ts', [
      'import { gatewayClient } from "@acme/gateway/client";',
      'async function run() {',
      '  return gatewayClient.generateObject({ model: "x", input: [] });',
      '}',
      'export { run };',
      '',
    ].join('\n'));

    const r = await run(tmp);
    const hits = noMaxTokens(r);
    assert.strictEqual(hits.length, 1, hits.map((h) => h.name).join());
    assert.strictEqual(hits[0].severity, 'info', 'a workspace-subpath wrapper that caps by default must downgrade to info');
    assert.match(hits[0].message, /cap applied in services[/\\]gateway[/\\]src[/\\]client\.ts/);
    assert.match(hits[0].message, /default 4096 from services[/\\]gateway[/\\]src[/\\]types\.ts/);
  });

  it('a dynamic import of the same subpath, using a generic-SDK method name, also downgrades to info', async () => {
    writeMonorepo(tmp);
    write(tmp, 'apps/api/src/deploy-dynamic.ts', [
      'async function run() {',
      '  const { gatewayClient } = await import("@acme/gateway/client");',
      '  return gatewayClient.generateText({ model: "x", input: [] });',
      '}',
      'export { run };',
      '',
    ].join('\n'));

    const r = await run(tmp);
    const hits = noMaxTokens(r);
    assert.strictEqual(hits.length, 1, hits.map((h) => h.name).join());
    assert.strictEqual(hits[0].severity, 'info', 'a dynamic-import generic-SDK caller must resolve the workspace wrapper too');
    assert.match(hits[0].message, /cap applied in services[/\\]gateway[/\\]src[/\\]client\.ts/);
    assert.match(hits[0].message, /default 4096 from services[/\\]gateway[/\\]src[/\\]types\.ts/);
  });

  it('a workspace subpath whose client sets no default keeps the caller an error and names the wrapper', async () => {
    writeMonorepo(tmp);
    write(tmp, 'apps/api/src/nocap-caller.ts', [
      'import { nocapClient } from "@acme/gateway/nocap";',
      'async function run() {',
      '  return nocapClient.generateObject({ model: "x" });',
      '}',
      'export { run };',
      '',
    ].join('\n'));

    const r = await run(tmp);
    const hits = noMaxTokens(r);
    assert.strictEqual(hits.length, 1, hits.map((h) => h.name).join());
    assert.strictEqual(hits[0].severity, 'error', 'a workspace wrapper that sets no default must not downgrade the caller');
    assert.match(hits[0].message, /services[/\\]gateway[/\\]src[/\\]nocap-client\.ts/, 'message must name the wrapper');
  });
});

