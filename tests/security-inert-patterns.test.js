// =============================================================================
// SECURITY MODULE — dangerous patterns inside strings and comments are INERT
// =============================================================================
// The dangerous-pattern scan in src/modules/security.js had no string or
// comment guard, so prose ABOUT eval() was reported as a call TO eval().
//
// Measured before the fix on a fixture whose every dangerous token sat in a
// doc string or a comment: 13 BLOCKING errors on a file where nothing
// executes. False positives that stop the gate are the worst kind — Bible
// Forbidden #25, "we are the painkiller, not the bottleneck".
//
// Found 2026-07-28 by scanning a deliberately all-inert fixture rather than
// by reading the module, which is the same method that surfaced KI #85-#88.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SecurityModule = require('../src/modules/security');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sec-inert-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function scan(source) {
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(tmp, 'src', 'x.js'), source);
  const mod = new SecurityModule();
  const result = makeResult();
  await mod.run(result, { projectRoot: tmp });
  return result.checks
    .filter((c) => !c.passed && /^security:(eval|innerHTML|document|shell)/.test(c.name))
    .map((c) => c.name);
}

describe('security — dangerous tokens inside STRING literals are not calls', () => {
  it('eval() inside a doc string is not reported', async () => {
    assert.deepStrictEqual(
      await scan('const DOCS = {\n  warn: "eval(userInput) is dangerous — never do this",\n};\nmodule.exports = { DOCS };\n'),
      [],
    );
  });

  it('innerHTML / document.write / exec inside strings are not reported', async () => {
    const found = await scan([
      'const DOCS = {',
      '  a: "element.innerHTML = userInput",',
      '  b: "document.write(x) is forbidden",',
      '  c: "child_process.exec(\'rm -rf \' + dir)",',
      '};',
      'module.exports = { DOCS };',
    ].join('\n'));
    assert.deepStrictEqual(found, []);
  });
});

describe('security — dangerous tokens inside COMMENTS are not calls', () => {
  it('a line comment mentioning eval() is not reported', async () => {
    assert.deepStrictEqual(
      await scan('// eval(userInput) must never be used\nconst a = 1;\nmodule.exports = { a };\n'),
      [],
    );
  });

  it('a JSDoc block mentioning innerHTML is not reported', async () => {
    assert.deepStrictEqual(
      await scan('/**\n * Never do element.innerHTML = userInput\n */\nconst a = 1;\nmodule.exports = { a };\n'),
      [],
    );
  });
});

describe('security — real dangerous code is STILL reported', () => {
  // The guard must not have turned detection off. This is the half that
  // matters: a false negative here is a security hole.
  it('a real eval() call blocks', async () => {
    const found = await scan('function r(u) {\n  eval(u);\n}\nmodule.exports = { r };\n');
    assert.ok(found.some((n) => n.includes('eval()')), `expected eval finding, got ${JSON.stringify(found)}`);
  });

  it('a real innerHTML assignment blocks', async () => {
    const found = await scan('function r(el, u) {\n  el.innerHTML = u;\n}\nmodule.exports = { r };\n');
    assert.ok(found.some((n) => n.includes('innerHTML')), `expected innerHTML finding, got ${JSON.stringify(found)}`);
  });

  it('a real document.write() blocks', async () => {
    const found = await scan('function r(u) {\n  document.write(u);\n}\nmodule.exports = { r };\n');
    assert.ok(found.some((n) => n.includes('document.write')), `expected document.write finding, got ${JSON.stringify(found)}`);
  });

  it('code on a line that also carries a trailing comment still blocks', async () => {
    // _isCommentLine is whole-line only, deliberately: real code followed by
    // a note is still real code.
    const found = await scan('function r(u) {\n  eval(u); // yes this is deliberate\n}\nmodule.exports = { r };\n');
    assert.ok(found.some((n) => n.includes('eval()')));
  });
});

describe('security — the scan carries a column for the confidence scorer', () => {
  it('findings include the match column', async () => {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(tmp, 'src', 'x.js'), 'function r(u) {\n  eval(u);\n}\nmodule.exports = { r };\n');
    const mod = new SecurityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    const hit = result.checks.find((c) => !c.passed && c.name.includes('security:eval()'));
    assert.ok(hit, 'expected an eval finding');
    assert.strictEqual(typeof hit.column, 'number',
      'without a column the scorer falls back to a whole-line guess');
  });
});

// =============================================================================
// FALSE NEGATIVE: command injection in its most common form
// =============================================================================
// Found 2026-07-28 by inverting the inert-fixture technique — scanning a
// fixture of genuinely-vulnerable code to measure what is MISSED rather than
// what is over-reported.
//
// The only shell-exec rule was /child_process.*exec\s*\(/, which requires
// `child_process` on the SAME LINE. So it caught the inline
// `require('child_process').exec(...)` and missed the ordinary shape:
//
//     const cp = require('child_process');
//     cp.execSync('ls ' + req.query.dir);
//
// Command injection is an OWASP staple and this is how it actually appears.
// =============================================================================

describe('security — command injection via an aliased child_process', () => {
  let tmp2;
  beforeEach(() => { tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sec-cmd-')); });
  afterEach(() => { fs.rmSync(tmp2, { recursive: true, force: true }); });

  async function scanCmd(source) {
    fs.mkdirSync(path.join(tmp2, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp2, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(tmp2, 'src', 'x.js'), source);
    const mod = new SecurityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp2 });
    return result.checks
      .filter((c) => !c.passed && /shell exec/.test(c.name))
      .map((c) => c.name);
  }

  it('flags execSync with concatenated user input', async () => {
    const found = await scanCmd([
      "const cp = require('child_process');",
      'function run(req) {',
      "  return cp.execSync('ls ' + req.query.dir);",
      '}',
      'module.exports = { run };',
    ].join('\n'));
    assert.ok(found.length > 0, `command injection must be caught, got ${JSON.stringify(found)}`);
  });

  it('flags exec with an interpolated template literal', async () => {
    const found = await scanCmd([
      "const { exec } = require('child_process');",
      'function run(req) {',
      '  return exec(`rm -rf ${req.query.path}`);',
      '}',
      'module.exports = { run };',
    ].join('\n'));
    assert.ok(found.length > 0);
  });

  // The safe alternatives must NOT be punished — flagging them would push
  // people away from the correct fix.
  it('does NOT flag execFileSync with an argv array', async () => {
    const found = await scanCmd([
      "const cp = require('child_process');",
      'function run(dir) { return cp.execFileSync("ls", [dir]); }',
      'module.exports = { run };',
    ].join('\n'));
    assert.deepStrictEqual(found, []);
  });

  it('does NOT flag spawnSync with an argv array', async () => {
    const found = await scanCmd([
      "const cp = require('child_process');",
      'function run(dir) { return cp.spawnSync("ls", ["-la", dir]); }',
      'module.exports = { run };',
    ].join('\n'));
    assert.deepStrictEqual(found, []);
  });

  it('does NOT flag a static command string', async () => {
    const found = await scanCmd([
      "const cp = require('child_process');",
      'function run() { return cp.execSync("git rev-parse HEAD"); }',
      'module.exports = { run };',
    ].join('\n'));
    assert.deepStrictEqual(found, []);
  });

  it('does NOT flag an exec mentioned only inside a doc string', async () => {
    const found = await scanCmd([
      'const DOCS = { bad: "cp.execSync(\'ls \' + req.query.dir)" };',
      'module.exports = { DOCS };',
    ].join('\n'));
    assert.deepStrictEqual(found, []);
  });
});

// =============================================================================
// FALSE NEGATIVE: MD5/SHA-1 used to hash a credential
// =============================================================================
// `grep -rln md5 src/modules/` returned NOTHING before 2026-07-28 — the
// engine had no weak-hash check at all, while every competitor ships one
// (KI #89).
//
// The hard part is not detecting md5. It is not drowning the customer in
// false positives: md5/sha1 are legitimate and everywhere for cache keys,
// ETags, content addressing and checksums. A rule that flagged every
// createHash('md5') would fire constantly on correct code and train people
// to ignore the module. So it fires only on CREDENTIAL context.
// =============================================================================

describe('security — weak hashing of credentials', () => {
  let tmp3;
  beforeEach(() => { tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sec-hash-')); });
  afterEach(() => { fs.rmSync(tmp3, { recursive: true, force: true }); });

  async function scanHash(source) {
    fs.mkdirSync(path.join(tmp3, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp3, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(tmp3, 'src', 'x.js'), source);
    const mod = new SecurityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp3 });
    return result.checks.filter((c) => !c.passed && /weak-password-hash/.test(c.name));
  }

  it('flags md5 hashing a password (camelCase function name)', async () => {
    // `\bpassword\b` does NOT match `hashPassword` — that boundary broke the
    // first version of this rule, and camelCase is how this is really written.
    const found = await scanHash([
      "const crypto = require('crypto');",
      'function hashPassword(pw) {',
      "  return crypto.createHash('md5').update(pw).digest('hex');",
      '}',
      'module.exports = { hashPassword };',
    ].join('\n'));
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].severity, 'error');
    assert.match(found[0].suggestion, /bcrypt|scrypt|argon2/i);
    assert.match(found[0].suggestion, /does NOT fix/i,
      'the suggestion must say switching to SHA-256 is not the fix');
  });

  it('flags sha1 hashing a secret', async () => {
    const found = await scanHash([
      "const crypto = require('crypto');",
      'function digestSecret(secret) {',
      "  return crypto.createHash('sha1').update(secret).digest('hex');",
      '}',
      'module.exports = { digestSecret };',
    ].join('\n'));
    assert.strictEqual(found.length, 1);
  });

  // The negatives are the whole point of the rule's design.
  it('does NOT flag md5 for a cache key', async () => {
    const found = await scanHash([
      "const crypto = require('crypto');",
      'function cacheKey(fileContent) {',
      "  return crypto.createHash('md5').update(fileContent).digest('hex');",
      '}',
      'module.exports = { cacheKey };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag sha1 for an ETag', async () => {
    const found = await scanHash([
      "const crypto = require('crypto');",
      'function etagFor(buffer) {',
      "  return crypto.createHash('sha1').update(buffer).digest('base64');",
      '}',
      'module.exports = { etagFor };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag md5 for an asset fingerprint', async () => {
    const found = await scanHash([
      "const crypto = require('crypto');",
      'function assetFingerprint(bytes) {',
      "  return crypto.createHash('md5').update(bytes).digest('hex').slice(0, 8);",
      '}',
      'module.exports = { assetFingerprint };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT let an ambiguous short word drag in an innocent hash', async () => {
    // `pin` inside "spinner" and `token` inside "tokenizer" must not count —
    // those stay word-bounded while password/secret match as substrings.
    const found = await scanHash([
      "const crypto = require('crypto');",
      'function spinnerTokenizerKey(bytes) {',
      "  return crypto.createHash('md5').update(bytes).digest('hex');",
      '}',
      'module.exports = { spinnerTokenizerKey };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag a weak hash mentioned only in a doc string', async () => {
    const found = await scanHash([
      'const DOCS = { bad: "crypto.createHash(\'md5\').update(password)" };',
      'module.exports = { DOCS };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag sha256 for a password (correct-ish algorithm choice)', async () => {
    // Still not ideal, but this rule is specifically about md5/sha1. A rule
    // that also fired here would be making a different argument.
    const found = await scanHash([
      "const crypto = require('crypto');",
      'function hashPassword(pw) {',
      "  return crypto.createHash('sha256').update(pw).digest('hex');",
      '}',
      'module.exports = { hashPassword };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });
});

// =============================================================================
// FALSE NEGATIVE: prototype pollution
// =============================================================================
// There was no __proto__ detection anywhere in the engine before 2026-07-28
// (KI #89). The difficulty is precision, not detection: `obj[key] = value` is
// one of the most common lines in JavaScript and is almost always fine, so a
// rule flagging dynamic assignment generally would bury the customer.
//
// It therefore requires the key to trace DIRECTLY to request input, and it
// stands down when the author has visibly defended the sink.
// =============================================================================

describe('security — prototype pollution', () => {
  let tmp4;
  beforeEach(() => { tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sec-proto-')); });
  afterEach(() => { fs.rmSync(tmp4, { recursive: true, force: true }); });

  async function scanProto(source) {
    fs.mkdirSync(path.join(tmp4, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp4, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(tmp4, 'src', 'x.js'), source);
    const mod = new SecurityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp4 });
    return result.checks.filter((c) => !c.passed && /prototype-pollution/.test(c.name));
  }

  it('flags a user-controlled key written straight into an object', async () => {
    const found = await scanProto([
      'function merge(target, req) {',
      '  target[req.body.key] = req.body.value;',
      '  return target;',
      '}',
      'module.exports = { merge };',
    ].join('\n'));
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].severity, 'error');
    assert.match(found[0].suggestion, /Map|Object\.create/);
  });

  it('flags req.query and req.params keys too', async () => {
    for (const src of [
      'function m(t, req) { t[req.query.k] = 1; return t; }\nmodule.exports = { m };',
      'function m(t, req) { t[req.params.k] = 1; return t; }\nmodule.exports = { m };',
    ]) {
      assert.strictEqual((await scanProto(src)).length, 1, src);
    }
  });

  // The negatives carry this rule. Each is correct code that must stay quiet.
  it('does NOT flag when a key denylist is present', async () => {
    const found = await scanProto([
      "const BLOCKED = ['__proto__', 'constructor', 'prototype'];",
      'function merge(target, req) {',
      '  if (BLOCKED.includes(req.body.key)) throw new Error("bad key");',
      '  target[req.body.key] = req.body.value;',
      '  return target;',
      '}',
      'module.exports = { merge };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag an Object.create(null) sink', async () => {
    const found = await scanProto([
      'function safe(req) {',
      '  const store = Object.create(null);',
      '  store[req.body.key] = req.body.value;',
      '  return store;',
      '}',
      'module.exports = { safe };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag ordinary dynamic assignment with a local key', async () => {
    // The single most common shape in JS. Flagging it would be unusable.
    const found = await scanProto([
      'function set(obj, key, value) {',
      '  obj[key] = value;',
      '  return obj;',
      '}',
      'module.exports = { set };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag a Map-based store', async () => {
    const found = await scanProto([
      'function store(req) {',
      '  const m = new Map();',
      '  m.set(req.body.key, req.body.value);',
      '  return m;',
      '}',
      'module.exports = { store };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag the same sink quoted in a doc string', async () => {
    const found = await scanProto([
      'const DOCS = { bad: "target[req.body.key] = req.body.value" };',
      'module.exports = { DOCS };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });
});

// =============================================================================
// FALSE NEGATIVE: path traversal
// =============================================================================
// Only `.createReadStream(req.` was matched before 2026-07-28, so the common
// readFile/writeFile forms were invisible (KI #89).
//
// The trap worth catching is that path.join LOOKS like a fix and is not one:
//
//     fs.readFileSync(path.join('/data', req.query.file))
//
// join normalises `..` rather than rejecting it, so ?file=../../etc/passwd
// escapes /data cleanly. Plenty of code is written this way believing it is
// safe — which is the whole reason the rule earns its place.
// =============================================================================

describe('security — path traversal', () => {
  let tmp5;
  beforeEach(() => { tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sec-path-')); });
  afterEach(() => { fs.rmSync(tmp5, { recursive: true, force: true }); });

  async function scanPath(source) {
    fs.mkdirSync(path.join(tmp5, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp5, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(tmp5, 'src', 'x.js'), source);
    const mod = new SecurityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp5 });
    return result.checks.filter((c) => !c.passed && /path-traversal/.test(c.name));
  }

  it('flags path.join with request input — join is NOT a defence', async () => {
    const found = await scanPath([
      "const fs = require('fs');",
      "const path = require('path');",
      'function read(req) {',
      "  return fs.readFileSync(path.join('/data', req.query.file));",
      '}',
      'module.exports = { read };',
    ].join('\n'));
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].severity, 'error');
    assert.match(found[0].suggestion, /basename|startsWith/);
    assert.match(found[0].message, /path\.join normalises/);
  });

  it('flags writeFile and res.sendFile with request input', async () => {
    for (const src of [
      "const fs = require('fs');\nfunction w(req) { fs.writeFileSync('/d/' + req.body.name, 'x'); }\nmodule.exports = { w };",
      'function s(req, res) { res.sendFile(req.query.p); }\nmodule.exports = { s };',
    ]) {
      assert.strictEqual((await scanPath(src)).length, 1, src);
    }
  });

  // The negatives are the three real defences plus the no-user-input case.
  it('does NOT flag a basename() guard', async () => {
    const found = await scanPath([
      "const fs = require('fs');",
      "const path = require('path');",
      'function read(req) {',
      "  return fs.readFileSync(path.join('/data', path.basename(req.query.file)));",
      '}',
      'module.exports = { read };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag a resolve + startsWith containment check', async () => {
    const found = await scanPath([
      "const fs = require('fs');",
      "const path = require('path');",
      "const ROOT = '/data';",
      'function read(req) {',
      '  const full = path.resolve(ROOT, req.query.file);',
      "  if (!full.startsWith(ROOT)) throw new Error('escape');",
      '  return fs.readFileSync(full);',
      '}',
      'module.exports = { read };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag an explicit ".." rejection', async () => {
    const found = await scanPath([
      "const fs = require('fs');",
      "const path = require('path');",
      'function read(req) {',
      "  if (req.query.file.includes('..')) throw new Error('nope');",
      "  return fs.readFileSync(path.join('/data', req.query.file));",
      '}',
      'module.exports = { read };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag a filesystem call with no request input', async () => {
    const found = await scanPath([
      "const fs = require('fs');",
      "const path = require('path');",
      "function read(name) { return fs.readFileSync(path.join('/data', name)); }",
      'module.exports = { read };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag the same sink quoted in a doc string', async () => {
    const found = await scanPath([
      'const DOCS = { bad: "fs.readFileSync(path.join(root, req.query.file))" };',
      'module.exports = { DOCS };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });
});

// ── secrets scan precision (2026-08-18 audit) ──────────────────────────────
async function scanSecrets(source, file = 'src/config.rb') {
  fs.mkdirSync(path.join(tmp, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(tmp, file), source);
  const mod = new SecurityModule();
  const result = makeResult();
  await mod.run(result, { projectRoot: tmp });
  return result.checks.filter((c) => !c.passed && /^security:secret:/.test(c.name));
}

describe('security — secrets in comments / placeholders / overlapping patterns', () => {
  it('a doc comment showing a credential-shaped example is not a secret (sinatra docs)', async () => {
    const hits = await scanSecrets([
      '# Configure like so:',
      '#   set :session_secret, "CHANGEME_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"',
      '#   password = "hunter2hunter2"',
      'set :sessions, true',
    ].join('\n'));
    assert.deepStrictEqual(hits.map((h) => h.name), []);
  });

  it('obvious placeholders (CHANGEME / your-key / process.env on the line) are not secrets', async () => {
    const hits = await scanSecrets([
      'const apiKey = "YOUR_API_KEY_GOES_HERE_1234";',
      'const token = process.env.TOKEN || "fallback-token-value";',
      'password: "CHANGEME_please_rotate_me"',
    ].join('\n'), 'src/config.js');
    assert.deepStrictEqual(hits.map((h) => h.name), []);
  });

  it('one line with one secret yields ONE finding even when hex and base64 patterns both match', async () => {
    const hits = await scanSecrets('const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";\n', 'src/keys.js');
    assert.strictEqual(hits.length, 1, JSON.stringify(hits.map((h) => h.name)));
  });

  it('POSITIVE CONTROL: a real hardcoded credential in code still fires', async () => {
    const hits = await scanSecrets('const dbUrl = "postgres://admin:s3cretpassw0rd@db.internal:5432/app";\n', 'src/db.js');
    assert.strictEqual(hits.length, 1, JSON.stringify(hits.map((h) => h.name)));
  });
});

// =============================================================================
// FALSE POSITIVE: `eval` as the tail of a longer identifier
// =============================================================================
// The rule was /eval\s*\(/ with no boundary, so Playwright's locator API —
//     const links = await page.$$eval('a', els => els.map(...))
// — reported as CRITICAL eval(). Three blocking errors on one ops script in
// the 2026-08-31 self-scan, on code that evaluates nothing dynamic: the arrow
// function is static source serialised into the page.
// =============================================================================

describe('security — $$eval / $eval are Playwright, not eval()', () => {
  it('page.$$eval and page.$eval are not reported', async () => {
    const found = await scan([
      "const { chromium } = require('playwright');",
      'async function audit(page) {',
      "  const links = await page.$$eval('a', els => els.map(el => el.href));",
      "  const title = await page.$eval('h1', el => el.textContent);",
      '  return { links, title };',
      '}',
      'module.exports = { audit };',
    ].join('\n'));
    assert.deepStrictEqual(found, []);
  });

  it('an identifier merely ending in eval is not reported', async () => {
    const found = await scan('function r(x) {\n  return myeval(x) + _eval(x);\n}\nmodule.exports = { r };\n');
    assert.deepStrictEqual(found, []);
  });

  it('POSITIVE CONTROL: bare eval() and window.eval() must still be caught', async () => {
    // The boundary excludes word chars and `$` — NOT a leading dot, so the
    // indirect global forms stay detected. If this ever goes quiet, the
    // lookbehind has been widened into a blanket mute.
    const bare = await scan('function r(u) {\n  eval(u);\n}\nmodule.exports = { r };\n');
    assert.ok(bare.some((n) => n.includes('eval()')), `bare eval must fire, got ${JSON.stringify(bare)}`);

    const indirect = await scan('function r(u) {\n  window.eval(u);\n}\nmodule.exports = { r };\n');
    assert.ok(indirect.some((n) => n.includes('eval()')), `window.eval must fire, got ${JSON.stringify(indirect)}`);

    const global = await scan('function r(u) {\n  globalThis.eval(u);\n}\nmodule.exports = { r };\n');
    assert.ok(global.some((n) => n.includes('eval()')), `globalThis.eval must fire, got ${JSON.stringify(global)}`);
  });
});

// =============================================================================
// THE AUTHOR OPT-OUT MARKER — controls for src/modules/security.js:~260
// =============================================================================
// `if (/gatetest-self-pattern|gatetest-pattern-ok/.test(line)) continue;` is a
// whole-line skip, the shape tests/suppression-controls.test.js hunts. It is
// legitimate — it silences a line only because a human deliberately typed the
// marker there — but a marker-based escape hatch can rot into a blanket mute
// if the marker regex is ever widened. These are the controls that would catch
// that: the marker works, and nothing WITHOUT the marker is silenced.
// =============================================================================

describe('security — the self-pattern marker is an opt-out, not a mute', () => {
  it('a marked line is not reported', async () => {
    const found = await scan([
      'const PATTERNS = [',
      "  { rule: 'no-eval', match: (s) => s.includes('eval(') }, // gatetest-self-pattern",
      '];',
      'module.exports = { PATTERNS };',
    ].join('\n'));
    assert.deepStrictEqual(found, []);
  });

  it('the second marker spelling works too', async () => {
    const found = await scan([
      'function r(u) {',
      '  return eval(u); // gatetest-pattern-ok',
      '}',
      'module.exports = { r };',
    ].join('\n'));
    assert.deepStrictEqual(found, []);
  });

  it('POSITIVE CONTROL: an unmarked line beside a marked one still fires', async () => {
    // The skip is per line, so it must not spill onto its neighbours. If the
    // marker regex is widened until this goes quiet, the escape hatch has
    // become a mute and this assertion is what says so.
    const found = await scan([
      'function r(u) {',
      '  const a = eval(u); // gatetest-self-pattern',
      '  const b = eval(u);',
      '  return a + b;',
      '}',
      'module.exports = { r };',
    ].join('\n'));
    assert.strictEqual(found.length, 1, `only line 3 may fire, got ${JSON.stringify(found)}`);
    assert.ok(found[0].endsWith(':3'), `expected the UNMARKED line 3, got ${found[0]}`);
  });

  it('POSITIVE CONTROL: a mistyped or paraphrased marker does not silence anything', async () => {
    // The marker is matched as a substring, so `gatetest-self-pattern-x`
    // legitimately still opts out — the author typed the token. What must NOT
    // work is a marker someone only THINKS they wrote. If a future widening
    // (say, matching on "gatetest" alone) made any of these silence a real
    // eval(), the escape hatch would have become a mute; this is the assertion
    // that says so.
    for (const comment of [
      '// gatetest-self-patern',        // typo
      '// gatetest self pattern',       // spaces, not hyphens
      '// gatetest pattern is ok here', // paraphrase
      '// gatetest scanner regex below',
    ]) {
      const found = await scan([
        'function r(u) {',
        `  return eval(u); ${comment}`,
        '}',
        'module.exports = { r };',
      ].join('\n'));
      assert.ok(found.some((n) => n.includes('eval()')),
        `only the real marker may silence a line — "${comment}" must not, got ${JSON.stringify(found)}`);
    }
  });
});

// =============================================================================
// One stripper (2026-09-05): every pattern above is now located on
// BaseModule._maskedLines, which sees a template literal and a block comment
// that span lines — the per-line quote counter it replaced could not, and the
// block-comment case below (a line inside `/* … */` that does not start with
// `*`) was a live finding before. Each rule keeps its positive control beside
// the three inert shapes so "quieter" cannot pass for "working".
// =============================================================================

describe('security — a pattern inside a string, a template or a comment is inert; the real one beside it fires', () => {
  let tmp6;
  beforeEach(() => { tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sec-mask-')); });
  afterEach(() => { fs.rmSync(tmp6, { recursive: true, force: true }); });

  async function scanRule(source, ruleRe) {
    fs.mkdirSync(path.join(tmp6, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp6, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(tmp6, 'src', 'x.js'), source);
    const mod = new SecurityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp6 });
    return result.checks.filter((c) => !c.passed && ruleRe.test(c.name)).map((c) => c.line);
  }

  // Three inert copies of `snippet` (double-quoted string, template literal,
  // block comment opened on an earlier line) followed by the real thing.
  const around = (snippet, real) => [
    `const doc = "${snippet}";`,
    'const tpl = `',
    `  ${snippet}`,
    '`;',
    '/* example:',
    `   ${snippet}`,
    '*/',
    ...real,
    '',
  ].join('\n');

  it('eval() inside a string, a template or a comment is not a call; the real one beside them is (2026-09-05)', async () => {
    const lines = await scanRule(around('eval(userInput)', ['eval(userInput);']), /^security:eval\(\)/);
    assert.deepStrictEqual(lines, [8]);
  });

  it('createHash(md5) inside a string, a template or a comment is not a hash; the real one beside them is (2026-09-05)', async () => {
    const lines = await scanRule(around(
      "hashPassword: crypto.createHash('md5').update(pw)",
      ['function hashPassword(pw) {', "  return crypto.createHash('md5').update(pw).digest('hex');", '}'],
    ), /weak-password-hash/);
    assert.deepStrictEqual(lines, [9]);
  });

  it('target[req.body.key] = inside a string, a template or a comment is not an assignment; the real one beside them is (2026-09-05)', async () => {
    const lines = await scanRule(around(
      'target[req.body.key] = req.body.value',
      ['function merge(target, req) {', '  target[req.body.key] = req.body.value;', '}'],
    ), /prototype-pollution/);
    assert.deepStrictEqual(lines, [9]);
  });

  it('fs.readFileSync(… + req.query.file) inside a string, a template or a comment reads nothing; the real one beside them is (2026-09-05)', async () => {
    const lines = await scanRule(around(
      "fs.readFileSync('/data/' + req.query.file)",
      ['function read(req) {', "  return fs.readFileSync('/data/' + req.query.file);", '}'],
    ), /path-traversal/);
    assert.deepStrictEqual(lines, [9]);
  });

  it("app.disable('csrf') still fires (it reads the string), but not from inside a string, a template or a comment (2026-09-05)", async () => {
    const lines = await scanRule(around("app.disable('csrf')", ["app.disable('csrf');"]), /CSRF protection disabled/);
    assert.deepStrictEqual(lines, [8]);
  });
});

// =============================================================================
// #842 DR-1 (DavenRoe, 2026-09-29): "CSRF protection disabled" fired CRITICAL
// on `desc: '…Cannot be disabled. Examples: login tokens, CSRF protection.'`
// (CookiePolicy.jsx:380). Two causes, both fixed: an apostrophe in JSX text
// two lines up inverted the mask (src/core/source-strip.js), and the rule
// was two words on a line (`disable.*csrf`) rather than a code shape.
// =============================================================================

describe('security — CSRF disablement is a code shape, never prose in a JSX string or JSX text (#842 DR-1)', () => {
  let tmp7;
  beforeEach(() => { tmp7 = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sec-csrf-')); });
  afterEach(() => { fs.rmSync(tmp7, { recursive: true, force: true }); });

  async function scanJsx(source) {
    fs.mkdirSync(path.join(tmp7, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp7, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(tmp7, 'src', 'CookiePolicy.jsx'), source);
    const mod = new SecurityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp7 });
    return result.checks.filter((c) => !c.passed && /CSRF protection disabled/.test(c.name)).map((c) => c.line);
  }

  const PROSE = [
    'export default function CookiePolicy() {',
    '  return (',
    '    <div>',
    "      <p>We have designed DavenRoe's cookie use to be minimal by default,",
    "        and how you can control it. Contact{' '}",
    '        <span>privacy@example.com</span>. You cannot disable CSRF checks here.</p>',
    '      {[',
    "        { type: 'Essential', desc: 'Required for the platform to function. Cannot be disabled. Examples: login tokens, CSRF protection.' },",
    '      ].map((c) => <Row key={c.type} {...c} />)}',
    '    </div>',
    '  );',
    '}',
  ];

  it('NEGATIVE: the DavenRoe page — an apostrophe in JSX text, the sentence in a string, "disable CSRF" in JSX text — is quiet', async () => {
    assert.deepStrictEqual(await scanJsx(PROSE.concat('').join('\n')), []);
  });

  it('POSITIVE: a real disablement beside the same prose still fires CRITICAL, on its own line only', async () => {
    const real = [
      "app.disable('csrf');",
      'const settings = { csrf: false };',
      'csrfProtection = false;',
      'http.csrf().disable();',
    ];
    const lines = await scanJsx(PROSE.concat(real, '').join('\n'));
    assert.deepStrictEqual(lines, [13, 14, 15, 16]);
  });
});

// =============================================================================
// Corpus regression (apollo-server @ 53ac3c13, 2026-09-29): the #842 DR-1
// code-shape rule took `\w*csrf\w*\s*[:=]+\s*false` for "a key set to false",
// and `[:=]+` also swallowed `===`. Two gate-BLOCKING CRITICALs at 1.0 on a
// repository held to a zero ceiling:
//   - packages/server/src/ApolloServer.ts:354 `: config.csrfPrevention === false`
//     — the server COMPARING its option to choose the header list;
//   - packages/integration-testsuite/src/httpSpecTests.ts:20
//     `csrfPrevention: false,` — the conformance suite configuring the server
//     under test; `*-testsuite` was not a test path, so it priced as app code.
// Control pair: the exact apollo-server lines are quiet at the gate, and the
// same `csrfPrevention: false` in application code still blocks.
// =============================================================================

describe('security — CSRF rule reads an assignment, not a comparison; a test suite is harness (apollo-server corpus, 2026-09-29)', () => {
  const { scoreFinding, BLOCK_THRESHOLD } = require('../src/core/confidence');
  let tmp8;
  beforeEach(() => { tmp8 = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sec-csrf-apollo-')); });
  afterEach(() => { fs.rmSync(tmp8, { recursive: true, force: true }); });

  // Every failing CSRF finding with the confidence the runner would give it
  // (src/core/runner.js scores a module check with exactly these inputs).
  async function scanAt(relPath, lines) {
    const abs = path.join(tmp8, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(path.join(tmp8, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    fs.writeFileSync(abs, lines.concat('').join('\n'));
    const mod = new SecurityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp8 });
    return result.checks
      .filter((c) => !c.passed && /CSRF protection disabled/.test(c.name))
      .map((c) => ({
        line: c.line,
        confidence: scoreFinding({ filePath: c.file, ruleKey: c.name, module: 'security', message: c.message, line: c.line }).confidence,
      }));
  }
  const blocking = (findings) => findings.filter((f) => f.confidence >= BLOCK_THRESHOLD).map((f) => f.line);

  // packages/server/src/ApolloServer.ts:350-357, verbatim.
  const APOLLO_SERVER = [
    '      csrfPreventionRequestHeaders:',
    '        config.csrfPrevention === true || config.csrfPrevention === undefined',
    '          ? recommendedCsrfPreventionRequestHeaders',
    '          : config.csrfPrevention === false',
    '            ? null',
    '            : (config.csrfPrevention.requestHeaders ??',
    '              recommendedCsrfPreventionRequestHeaders),',
  ];
  // packages/integration-testsuite/src/httpSpecTests.ts:14-22, verbatim.
  const APOLLO_SUITE = [
    '    beforeAll(async () => {',
    '      createServerResult = await createServer({',
    '        // Any schema will do (the tests just run `{__typename}`).',
    "        typeDefs: 'type Query { x: ID }',",
    '        // The test doesn\'t know we should send apollo-require-preflight along',
    '        // with GETs. We could override `fetchFn` to add it but this seems simple enough.',
    '        csrfPrevention: false,',
    '      });',
    '    });',
  ];

  it('QUIET: ApolloServer.ts:354 `config.csrfPrevention === false` is a comparison — no finding at all', async () => {
    assert.deepStrictEqual(await scanAt('packages/server/src/ApolloServer.ts', APOLLO_SERVER), []);
  });

  it('QUIET at the gate: httpSpecTests.ts:20 in the integration-testsuite workspace is harness — below the block threshold', async () => {
    const findings = await scanAt('packages/integration-testsuite/src/httpSpecTests.ts', APOLLO_SUITE);
    assert.deepStrictEqual(blocking(findings), []);
  });

  it('POSITIVE: the same `csrfPrevention: false` in application code still blocks; `==`/`!==` comparisons stay quiet', async () => {
    const app = [
      "import { ApolloServer } from '@apollo/server';",
      'export const server = new ApolloServer({',
      '  typeDefs,',
      '  csrfPrevention: false,',
      '});',
      'if (opts.csrf == false) warn();',
      'if (opts.csrf !== false) ok();',
      'csrfProtection = false;',
      'const settings = { csrf: false };',
    ];
    const findings = await scanAt('packages/server/src/index.ts', app);
    assert.deepStrictEqual(findings.map((f) => f.line), [4, 8, 9]);
    assert.deepStrictEqual(blocking(findings), [4, 8, 9]);
  });
});
