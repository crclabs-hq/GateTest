'use strict';

// =============================================================================
// /admin/secrets — the infra-secrets panel UI (owner directive 2026-09-30).
// =============================================================================
// Source-level guards for the rules the owner set on this panel, plus the
// pure logic in website/app/admin/secrets/logic.js executed for real:
//   - the route exists and is admin-gated server-side; the nav links to it
//   - api.ts calls exactly the backend contract's paths and methods, same-
//     origin, and a value only ever travels in a JSON body (proved by
//     transpiling api.ts and running it against a recording fetch)
//   - no console.*, no localStorage / sessionStorage anywhere in the panel
//   - value inputs are password-type with autocomplete and spellcheck off
//   - reveal clears after 30 s (fake timers)
//   - no red / orange / yellow: no Tailwind hue classes, no danger/warning
//     tokens, no colour literals
// =============================================================================

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'website', 'app', 'admin', 'secrets');
const rel = (p) => path.join(DIR, p);
const read = (p) => fs.readFileSync(p, 'utf8');

const logic = require('../website/app/admin/secrets/logic.js');

function panelFiles() {
  return fs
    .readdirSync(DIR)
    .filter((f) => /\.(tsx?|jsx?|css)$/.test(f))
    .map((f) => rel(f));
}

// The dialogs, one file each since the split (GateTest's per-file ceiling).
const DIALOG_FILES = ['SetSecretDialog.tsx', 'RevealDialog.tsx', 'DeleteDialog.tsx', 'StepUpDialog.tsx', 'DropKeysDialog.tsx'];
const PANEL_TSX = ['SecretsPanel.tsx', 'PanelHeader.tsx', 'SecretsTable.tsx', 'AuditDrawer.tsx', ...DIALOG_FILES];

// Strip comments so a doc comment that NAMES a forbidden thing ("never
// console.log", "no localStorage") cannot fail the guard, while code can.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, pre) => pre);
}

describe('route, gating and navigation', () => {
  it('the page, client panel, api helpers and logic all exist (anti-vacuity)', () => {
    for (const f of ['page.tsx', ...PANEL_TSX, 'Modal.tsx', 'errors.ts', 'api.ts', 'logic.js', 'audit-logic.js', 'secrets.css']) {
      assert.ok(fs.existsSync(rel(f)), `missing website/app/admin/secrets/${f}`);
    }
    assert.ok(panelFiles().length >= 16);
  });

  it('every panel file stays well under the 500-line per-file ceiling', () => {
    for (const f of panelFiles()) {
      const lines = read(f).split('\n').length;
      assert.ok(lines <= 450,`${path.basename(f)} is ${lines} lines; split it before it reaches the 500-line ceiling`);
    }
  });

  it('page.tsx is a server component gated by the shared admin-session helper before mounting the panel', () => {
    const src = read(rel('page.tsx'));
    assert.doesNotMatch(src, /^\s*["']use client["']/m, 'the gate must run on the server');
    assert.match(src, /import\s*\{\s*getAdminLoginFromCookies\s*\}\s*from\s*["'][./]*lib\/admin-session["']/);
    assert.match(src, /getAdminLoginFromCookies\(\s*await cookies\(\)\s*\)/);
    const gate = src.indexOf('if (!adminLogin)');
    const mount = src.indexOf('<SecretsPanel');
    assert.ok(gate > -1 && mount > gate, 'the panel must only mount after the signed-out branch returns');
    assert.match(src.slice(gate, mount), /return\s*\(/, 'the signed-out branch returns before the panel');
  });

  it('the route sits under the admin layout, which gates the shell with the same helper', () => {
    const layout = read(path.join(ROOT, 'website', 'app', 'admin', 'layout.tsx'));
    assert.match(layout, /getAdminLoginFromCookies/);
  });

  it('the admin nav links to /admin/secrets as "Secrets"', () => {
    const shell = read(path.join(ROOT, 'website', 'app', 'admin', 'AdminShell.tsx'));
    const nav = shell.slice(shell.indexOf('const NAV_ITEMS'), shell.indexOf('];', shell.indexOf('const NAV_ITEMS')));
    assert.match(nav, /\{\s*href:\s*"\/admin\/secrets",\s*label:\s*"Secrets"\s*\}/);
  });
});

describe('api.ts matches the backend contract exactly', () => {
  const src = read(rel('api.ts'));

  it('only the two contract roots appear as /api/ literals', () => {
    const literals = [...src.matchAll(/["'`](\/api\/[^"'`$]*)/g)].map((m) => m[1]).sort();
    assert.deepEqual(literals, ['/api/admin/secrets', '/api/admin/step-up']);
  });

  it('every request is same-origin with credentials and no-store', () => {
    assert.equal((src.match(/fetch\(/g) || []).length, 1, 'one fetch call site, in call()');
    assert.match(src, /credentials:\s*"same-origin"/);
    assert.match(src, /cache:\s*"no-store"/);
  });

  // Transpile api.ts with the website's own TypeScript and run every helper
  // against a recording fetch — the paths, methods and bodies it really sends.
  let ts = null;
  try {
    ts = require(path.join(ROOT, 'website', 'node_modules', 'typescript'));
  } catch { /* error-ok — no website install; the runtime contract test skips loudly below */ }

  function loadApi(fetchImpl) {
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod = { exports: {} };
    // Compiled as a function body in this realm, with the recording fetch
    // passed in as a parameter so it shadows the global one.
    vm.compileFunction(out, ['module', 'exports', 'fetch'], { filename: 'api.ts' })(mod, mod.exports, fetchImpl);
    return mod.exports;
  }

  function recorder(status = 200, body = {}) {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url, method: init.method, credentials: init.credentials, body: init.body });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    return { calls, f };
  }

  it('each helper hits its contract path and method', { skip: ts ? false : 'SKIPPED: website/node_modules/typescript not installed' }, async () => {
    const { calls, f } = recorder();
    const api = loadApi(f);
    const VALUE = 'sk_test_do_not_put_me_in_a_url';
    await api.listSecrets();
    await api.setSecret('MY_TOKEN', VALUE);
    await api.deleteSecret('MY_TOKEN');
    await api.revealSecret('MY_TOKEN');
    await api.verifySecret('MY_TOKEN');
    await api.applySecrets();
    await api.listAudit();
    await api.stepUp('pw-value');
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        'GET /api/admin/secrets',
        'PUT /api/admin/secrets/MY_TOKEN',
        'DELETE /api/admin/secrets/MY_TOKEN',
        'POST /api/admin/secrets/MY_TOKEN/reveal',
        'POST /api/admin/secrets/MY_TOKEN/verify',
        'POST /api/admin/secrets/apply',
        'GET /api/admin/secrets/audit?limit=50',
        'POST /api/admin/step-up',
      ],
    );
    assert.ok(calls.every((c) => c.credentials === 'same-origin'));
    assert.deepEqual(JSON.parse(calls[1].body), { value: VALUE });
    assert.deepEqual(JSON.parse(calls[7].body), { password: 'pw-value' });
    assert.ok(calls.every((c) => !c.url.includes(VALUE) && !c.url.includes('pw-value')), 'values never in a URL');
    assert.equal(calls.filter((c) => c.body !== undefined).length, 2, 'only PUT and step-up carry a body');
  });

  it('a non-2xx answer surfaces the contract error code and status', { skip: ts ? false : 'SKIPPED: website/node_modules/typescript not installed' }, async () => {
    const api = loadApi(recorder(403, { error: 'step_up_required' }).f);
    await assert.rejects(api.setSecret('A', 'b'), (e) => e.code === 'step_up_required' && e.status === 403);
    const api2 = loadApi(recorder(409, { code: 'reserved_name' }).f);
    await assert.rejects(api2.deleteSecret('A'), (e) => e.code === 'reserved_name' && e.status === 409);
    const api3 = loadApi(async () => { throw new Error('offline'); });
    await assert.rejects(api3.listSecrets(), (e) => e.code === 'network' && e.status === 0);
  });
});

describe('value hygiene', () => {
  it('no console.* and no localStorage / sessionStorage anywhere in the panel', () => {
    for (const f of panelFiles()) {
      const c = code(read(f));
      assert.doesNotMatch(c, /\bconsole\s*\./, `${path.basename(f)} must not call console.*`);
      assert.doesNotMatch(c, /\b(localStorage|sessionStorage)\b/, `${path.basename(f)} must not touch browser storage`);
    }
  });

  it('every <input> is password-type with autocomplete and spellcheck off, except the name/confirm text fields', () => {
    const src = PANEL_TSX.map((f) => read(rel(f))).join('\n');
    const inputs = src.match(/<input\b[\s\S]*?\/>/g) || [];
    assert.ok(inputs.length >= 5, `expected the dialogs' inputs, found ${inputs.length}`);
    let valueInputs = 0;
    let passwordInputs = 0;
    for (const tag of inputs) {
      assert.match(tag, /spellCheck=\{false\}/, `spellcheck must be off:\n${tag}`);
      if (/value=\{value/.test(tag)) {
        valueInputs++;
        assert.match(tag, /type=\{showValue \? "text" : "password"\}/, `value input must be password-type by default:\n${tag}`);
        assert.match(tag, /autoComplete="off"/, `value input must have autocomplete off:\n${tag}`);
      } else if (/value=\{password\}/.test(tag)) {
        passwordInputs++;
        assert.match(tag, /type="password"/);
        assert.match(tag, /autoComplete="current-password"/);
      } else {
        assert.match(tag, /type="text"/);
        assert.match(tag, /autoComplete="off"/);
      }
    }
    assert.equal(valueInputs, 2, 'set dialog + reveal dialog');
    assert.equal(passwordInputs, 1, 'step-up dialog');
  });

  it('value state is cleared on success and on unmount', () => {
    const set = read(rel('SetSecretDialog.tsx'));
    assert.match(set, /useEffect\(\(\) => \(\) => setValue\(""\), \[\]\)/, 'set dialog clears on unmount');
    assert.match(set, /await guarded\(\(\) => setSecret\(n, value\)\);\s*setValue\(""\)/, 'set dialog clears on success');
    const reveal = read(rel('RevealDialog.tsx'));
    assert.match(reveal, /scheduleRevealClear\(\(\) => \{\s*setValue\(null\)/, 'reveal clears on the timer');
    assert.match(reveal, /return \(\) => \{[\s\S]*?cancelClear\?\.\(\);[\s\S]*?setValue\(null\);/, 'reveal clears on unmount');
    for (const f of PANEL_TSX.filter((x) => x !== 'SetSecretDialog.tsx' && x !== 'RevealDialog.tsx')) {
      assert.doesNotMatch(code(read(rel(f))), /\bsetValue\b|\brevealSecret\b/, `${f} must not hold or fetch a value`);
    }
    const panel = code(read(rel('SecretsPanel.tsx')));
    assert.doesNotMatch(panel, /\bvalue\s*:\s*string/, 'the panel itself never holds a value');
  });
});

describe('design rule: no red, orange or yellow', () => {
  const HUE_CLASS = /\b(?:text|bg|border|ring|fill|stroke|from|to|via|outline|decoration|divide|shadow|accent|caret|placeholder)-(?:red|orange|amber|yellow|rose|pink|fuchsia|lime)-\d{2,3}\b/;
  it('no Tailwind hue classes', () => {
    for (const f of panelFiles()) assert.doesNotMatch(read(f), HUE_CLASS, path.basename(f));
  });
  it('no danger / warning tokens and no colour literals', () => {
    for (const f of panelFiles()) {
      const c = code(read(f));
      assert.doesNotMatch(c, /--(?:gt-admin-)?(?:danger|warning)\b/, `${path.basename(f)} must not use a red/amber token`);
      assert.doesNotMatch(c, /(?<!&)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|rgba?\(|hsla?\(/, path.basename(f));
    }
  });
  it('POSITIVE CONTROL: the hue matcher catches what it must', () => {
    for (const c of ['text-red-600', 'bg-amber-500', 'border-yellow-200', 'ring-orange-300', 'bg-rose-50']) assert.match(c, HUE_CLASS);
    assert.doesNotMatch('text-[var(--gt-admin-fg)]', HUE_CLASS);
  });
});

describe('logic.js', () => {
  it('groups by tier in order, drops empty tiers, sorts names, unknown tier → custom', () => {
    const g = logic.groupByTier([
      { name: 'Z', tier: 'optional' },
      { name: 'B', tier: 'required' },
      { name: 'A', tier: 'required' },
      { name: 'Q', tier: 'weird' },
    ]);
    assert.deepEqual(g.map((x) => x.label), ['Required', 'Optional', 'Custom']);
    assert.deepEqual(g[0].items.map((i) => i.name), ['A', 'B']);
    assert.deepEqual(logic.groupByTier([]), []);
  });

  it('state marks are shape + ink, never a hue', () => {
    assert.deepEqual(logic.stateMark('set'), { shape: 'dot', ink: 'accent', label: 'Set', strong: false });
    assert.deepEqual(logic.stateMark('missing'), { shape: 'dot', ink: 'ink', label: 'Missing', strong: true });
    assert.deepEqual(logic.stateMark('placeholder'), { shape: 'ring', ink: 'muted', label: 'Placeholder', strong: false });
  });

  it('liveness: dead is ink semibold, alive accent, others muted; the time is labelled', () => {
    assert.deepEqual(logic.livenessMark('dead'), { ink: 'ink', label: 'Dead', strong: true });
    assert.equal(logic.livenessMark('alive').ink, 'accent');
    assert.equal(logic.livenessMark('cannot-tell').ink, 'muted');
    assert.equal(logic.livenessMark('unchecked').ink, 'muted');
    const now = Date.parse('2026-09-30T12:00:00Z');
    assert.equal(logic.livenessDetail('alive', '2026-09-30T11:57:00Z', now), 'checked 3 min ago');
    assert.equal(logic.livenessDetail('unchecked', undefined, now), 'never checked');
  });

  it('every contract error code has plain-language copy', () => {
    for (const c of ['invalid_name', 'value_empty', 'value_too_long', 'value_invalid_chars', 'step_up_required', 'reserved_name', 'store_unavailable', 'bad_password', 'throttled']) {
      const text = logic.errorCopy(c);
      assert.ok(text && !text.includes(c), `${c} must read as a sentence, not the code: ${text}`);
      assert.notEqual(text, logic.errorCopy('definitely_unknown_code'));
    }
    assert.match(logic.errorCopy('store_unavailable'), /docs\/ops\/secrets-panel\.md/);
    assert.match(logic.errorCopy(null, 401), /Not signed in/);
  });

  it('apply copy: applied says the service restarts itself; not applied says why', () => {
    assert.equal(logic.applyResultCopy({ applied: true }).text, 'Applied — the service restarts automatically when the env file changes.');
    const no = logic.applyResultCopy({ applied: false, reason: 'target-missing' });
    assert.equal(no.ok, false);
    assert.match(no.text, /does not exist/);
    assert.match(logic.applyStateCopy({ applied: false, reason: 'EACCES', lastAppliedAt: null }).text, /permission denied/);
  });

  it('warnings: same_value_as becomes a neutral sentence', () => {
    assert.equal(logic.warningCopy('same_value_as:OTHER_NAME'), 'This value is also stored as OTHER_NAME.');
  });

  it('shadow copy names the winner', () => {
    assert.equal(logic.shadowCopy('env'), 'Shadowed: the env file value wins at runtime');
    assert.equal(logic.shadowCopy('store'), 'Shadowed: the store value wins at runtime');
  });

  it('fingerprints render as 8 hex chars and anything non-hex renders as nothing', () => {
    assert.equal(logic.shortFingerprint('ABCDEF0123456789'), 'abcdef01');
    assert.equal(logic.shortFingerprint('sk_live_looks_like_a_value'), '');
    assert.equal(logic.shortFingerprint(undefined), '');
  });

  it('names: UPPER_SNAKE_CASE only; delete needs the exact name', () => {
    assert.equal(logic.nameProblem('MY_TOKEN_2'), null);
    assert.ok(logic.nameProblem('my_token'));
    assert.ok(logic.nameProblem('2TOKEN'));
    assert.ok(logic.nameProblem(''));
    assert.equal(logic.deleteConfirmed('MY_TOKEN', 'MY_TOKEN'), true);
    assert.equal(logic.deleteConfirmed('my_token', 'MY_TOKEN'), false);
    assert.equal(logic.deleteConfirmed('', ''), false);
  });

  it('clockTime is HH:MM', () => {
    assert.match(logic.clockTime('2026-09-30T08:05:00'), /^08:05$/);
    assert.equal(logic.clockTime('nonsense'), '');
  });

  it('generate: 48 random bytes, base64url, no padding, different every time', () => {
    const a = logic.generateSecretValue();
    const b = logic.generateSecretValue();
    assert.match(a, /^[A-Za-z0-9_-]{64}$/);
    assert.notEqual(a, b);
  });
});

describe('step-up retry', () => {
  const stepUpErr = Object.assign(new Error('step_up_required'), { code: 'step_up_required', status: 403 });

  it('asks once and retries the original action once', async () => {
    let n = 0;
    let asked = 0;
    const out = await logic.runWithStepUp(
      async () => { n++; if (n === 1) throw stepUpErr; return 'ok'; },
      async () => { asked++; return true; },
    );
    assert.equal(out, 'ok');
    assert.equal(n, 2);
    assert.equal(asked, 1);
  });

  it('never loops: a second step_up_required is thrown, cancel is thrown, other errors pass through unasked', async () => {
    let n = 0;
    await assert.rejects(logic.runWithStepUp(async () => { n++; throw stepUpErr; }, async () => true), /step_up_required/);
    assert.equal(n, 2);
    await assert.rejects(logic.runWithStepUp(async () => { throw stepUpErr; }, async () => false), /step_up_required/);
    let asked = 0;
    await assert.rejects(
      logic.runWithStepUp(async () => { throw Object.assign(new Error('x'), { code: 'reserved_name' }); }, async () => { asked++; return true; }),
      /x/,
    );
    assert.equal(asked, 0);
  });
});

describe('reveal clears after 30 seconds', () => {
  it('REVEAL_MS is 30 s and the clear fires exactly then, once', () => {
    assert.equal(logic.REVEAL_MS, 30000);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let cleared = 0;
      logic.scheduleRevealClear(() => { cleared++; });
      mock.timers.tick(29999);
      assert.equal(cleared, 0);
      mock.timers.tick(1);
      assert.equal(cleared, 1);
      mock.timers.tick(60000);
      assert.equal(cleared, 1);
    } finally {
      mock.timers.reset();
    }
  });

  it('cancel stops the clear (used on unmount, where state is dropped directly)', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let cleared = 0;
      const cancel = logic.scheduleRevealClear(() => { cleared++; });
      cancel();
      mock.timers.tick(30000);
      assert.equal(cleared, 0);
    } finally {
      mock.timers.reset();
    }
  });

  it('the reveal dialog uses the helper with REVEAL_MS and masks by default', () => {
    const src = read(rel('RevealDialog.tsx'));
    assert.match(src, /scheduleRevealClear\([\s\S]*?, REVEAL_MS\)/);
    assert.match(src, /const \[showValue, setShowValue\] = useState\(false\)/);
    assert.match(src, /navigator\.clipboard\.writeText\(value\)/);
  });
});
