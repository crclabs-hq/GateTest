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
      '    model="claude-sonnet-4-6",',
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
      '    model="claude-sonnet-4-6",',
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
      'await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 100, messages: [] });',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('prompt-safety:deprecated-model:')),
      undefined,
    );
  });

  it('does NOT flag claude-opus-4-8', async () => {
    write(tmp, 'src/a.js', [
      'const Anthropic = require("@anthropic-ai/sdk");',
      'const client = new Anthropic();',
      'await client.messages.create({ model: "claude-opus-4-8", max_tokens: 100, messages: [] });',
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
