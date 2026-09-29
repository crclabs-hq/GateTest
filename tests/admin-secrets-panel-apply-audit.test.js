'use strict';

// =============================================================================
// /admin/secrets — the apply and audit fixes from the PR #847 audit.
// =============================================================================
//   a. Apply can recover from `would_drop_keys`: applySecrets() sends
//      { allowRemoving }, the answer's `dropped` reaches the panel, and the
//      panel lists the names behind a confirm that re-calls apply with them.
//   b. `out_of_sync` (store changed, not applied yet) is a neutral pending
//      state with an Apply action — never "Could not write the env file".
//   c. The audit drawer shows the chain: intact / broken at entry N /
//      cannot tell, and never defaults to intact.
//   d. Verify rows in the audit drawer are inked by liveness, not as failures.
//   e. IPs in the drawer are middle-truncated with the full value in `title`.
// Each is driven through the backend's own functions where one exists, so
// the panel and the server cannot drift apart on a field name.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'website', 'app', 'admin', 'secrets');
const LIB = path.join(ROOT, 'website', 'app', 'lib', 'secrets');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

const logic = require('../website/app/admin/secrets/logic.js');
const { verifyAuditChain, appendAudit } = require(path.join(LIB, 'audit.js'));
const { applyStateOf } = require(path.join(LIB, 'panel.js'));
const { renderEnv } = require(path.join(LIB, 'render-env.js'));
const { fingerprint } = require(path.join(LIB, 'crypto.js'));
const { createMemoryAdapter } = require('./helpers/secrets-memory-adapter');

let ts = null;
try {
  ts = require(path.join(ROOT, 'website', 'node_modules', 'typescript'));
} catch { /* error-ok — no website install; the api.ts runtime tests skip loudly below */ }
const NEEDS_TS = { skip: ts ? false : 'SKIPPED: website/node_modules/typescript not installed' };

function loadApi(respond) {
  const out = ts.transpileModule(read('api.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    return { ok: true, status: 200, json: async () => respond(url) };
  };
  const mod = { exports: {} };
  vm.compileFunction(out, ['module', 'exports', 'fetch'], { filename: 'api.ts' })(mod, mod.exports, fetchImpl);
  return { api: mod.exports, calls };
}

describe('a. would_drop_keys is recoverable', () => {
  it('applySecrets(names) sends exactly { allowRemoving: names }; a plain apply sends no body', NEEDS_TS, async () => {
    const { api, calls } = loadApi(() => ({ applied: true, path: '/x', count: 1 }));
    await api.applySecrets();
    await api.applySecrets([]);
    await api.applySecrets(['B_TOKEN', 'C_TOKEN']);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), Array(3).fill('POST /api/admin/secrets/apply'));
    assert.equal(calls[0].body, undefined);
    assert.equal(calls[1].body, undefined, 'an empty list is a plain apply');
    assert.deepEqual(JSON.parse(calls[2].body), { allowRemoving: ['B_TOKEN', 'C_TOKEN'] });
  });

  it('the answer carries `dropped` through to the caller', NEEDS_TS, async () => {
    const refusal = { applied: false, reason: 'would_drop_keys', dropped: ['B_TOKEN'], path: '/x', count: 1 };
    const { api } = loadApi(() => refusal);
    assert.deepEqual(await api.applySecrets(), refusal);
  });

  it('the field names match the server: the route reads allowRemoving, the service answers dropped', () => {
    const route = fs.readFileSync(path.join(ROOT, 'website', 'app', 'api', 'admin', 'secrets', 'apply', 'route.ts'), 'utf8');
    assert.match(route, /body\.allowRemoving/);
    assert.match(fs.readFileSync(path.join(LIB, 'panel.js'), 'utf8'), /out\.dropped = result\.dropped/);
    assert.match(read('api.ts'), /\{ allowRemoving: \[\.\.\.allowRemoving\] \}/);
  });

  it('namesToDrop: only a would_drop_keys refusal asks, and only for string names', () => {
    assert.deepEqual(logic.namesToDrop({ applied: false, reason: 'would_drop_keys', dropped: ['B_TOKEN', 7, '', 'C_TOKEN'] }), ['B_TOKEN', 'C_TOKEN']);
    assert.deepEqual(logic.namesToDrop({ applied: true, reason: 'would_drop_keys', dropped: ['B_TOKEN'] }), []);
    assert.deepEqual(logic.namesToDrop({ applied: false, reason: 'permission_denied', dropped: ['B_TOKEN'] }), []);
    assert.deepEqual(logic.namesToDrop({ applied: false, reason: 'would_drop_keys' }), []);
    assert.deepEqual(logic.namesToDrop(undefined), []);
    assert.doesNotMatch(logic.applyReasonCopy('would_drop_keys'), /would_drop_keys/, 'reads as a sentence');
  });

  it('the panel opens the confirm for apply, set and delete answers; the confirm re-applies with exactly those names', () => {
    const panel = read('SecretsPanel.tsx');
    assert.match(panel, /function onApplyAnswer\(r: ApplyResult\)[\s\S]*?namesToDrop\(r\)[\s\S]*?setDropNames\(drop\)/);
    assert.equal((panel.match(/askToDrop\(result\.apply\)/g) || []).length, 2, 'set and delete both offer the confirm');
    assert.match(panel, /<DropKeysDialog\s+names=\{dropNames\}/);
    const dialog = read('DropKeysDialog.tsx');
    assert.match(dialog, /guarded\(\(\) => applySecrets\(names\)\)/, 'confirm goes through step-up and names only what the server reported');
    assert.match(dialog, /names\.map\(\(n\) =>/, 'the names are listed');
  });
});

describe('b. out_of_sync is pending, not a failure', () => {
  it('the real listing state for "store changed, not applied" reads as neutral pending copy', () => {
    const text = renderEnv([{ name: 'A_TOKEN', value: 'old-value-1234' }], { now: Date.UTC(2026, 8, 30, 9) });
    const fakeFs = { readFileSync: () => text };
    const state = applyStateOf([{ name: 'A_TOKEN', fingerprint: fingerprint('new-value-5678') }], '/var/lib/x/platform.env', fakeFs);
    assert.equal(state.reason, 'out_of_sync', 'control: the backend really reports out_of_sync here');
    const copy = logic.applyStateCopy(state, Date.UTC(2026, 8, 30, 12));
    assert.equal(copy.pending, true);
    assert.equal(copy.ok, false);
    assert.doesNotMatch(copy.text, /Could not write/);
    assert.equal(copy.text, 'Changes not applied yet (last applied 3 h ago)');
    assert.equal(logic.applyStateCopy({ applied: false, reason: 'out_of_sync', lastAppliedAt: null }).text, 'Changes not applied yet');
  });

  it('a real failure still says so and is not pending (control)', () => {
    const copy = logic.applyStateCopy({ applied: false, reason: 'EACCES', lastAppliedAt: null });
    assert.equal(copy.pending, false);
    assert.match(copy.text, /^Could not write the env file: .*permission denied/);
    assert.equal(logic.applyStateCopy({ applied: true, lastAppliedAt: '2026-09-30T09:00:00Z' }, Date.UTC(2026, 8, 30, 12)).pending, false);
  });

  it('the panel renders a neutral notice with Apply for out_of_sync, and the status card drops the problem weight', () => {
    const panel = read('SecretsPanel.tsx');
    assert.match(panel, /reason === "out_of_sync" \? \(\s*<PendingApplyNotice[\s\S]*?onApply=\{\(\) => void onApply\(\)\}/);
    const header = read('PanelHeader.tsx');
    const notice = header.slice(header.indexOf('export function PendingApplyNotice'));
    assert.match(notice, /className="gs-notice neutral gs-notice-row"/);
    assert.match(notice, /onClick=\{onApply\}[\s\S]*?Apply to service/);
    assert.doesNotMatch(notice, /Could not|failed|error/i);
    assert.match(header, /const problem = !applyLine\.ok && !applyLine\.pending;/);
  });
});

describe('c. the audit chain is shown, and never assumed', () => {
  it('a chain the backend verified reads intact; a tampered row reads broken at its 1-based entry', async () => {
    const adapter = createMemoryAdapter();
    for (const action of ['set', 'verify', 'reveal', 'apply']) {
      await appendAudit(adapter, { actor: 'admin', action, name: 'A_TOKEN', ip: '198.51.100.1', outcome: 'ok' });
    }
    const good = logic.chainStatus(verifyAuditChain(adapter.audit));
    assert.equal(good.state, 'intact');
    assert.equal(good.text, 'Chain intact across all 4 entries');
    const tampered = adapter.audit.map((r) => ({ ...r }));
    tampered[2].outcome = 'not_found';
    const bad = logic.chainStatus(verifyAuditChain(tampered));
    assert.equal(bad.state, 'broken');
    assert.equal(bad.text, 'Chain broken at entry 3, counting from the oldest');
    assert.equal(bad.strong, true);
  });

  it('missing or malformed chain is "cannot tell", never intact', () => {
    for (const c of [undefined, null, {}, { ok: 'true' }, { ok: 1 }, 'ok', { count: 4 }]) {
      const s = logic.chainStatus(c);
      assert.equal(s.state, 'unknown', JSON.stringify(c));
      assert.match(s.text, /cannot tell/);
    }
    assert.equal(logic.chainStatus({ ok: false }).text, 'Chain broken (the server did not say where)');
  });

  it('the drawer keeps the answer\'s chain and renders only what chainStatus says', () => {
    const drawer = read('AuditDrawer.tsx');
    assert.match(drawer, /setChain\(r\.chain\)/);
    assert.match(drawer, /const status = chainStatus\(chain\)/);
    assert.match(drawer, /\{status\.text\}/);
    assert.doesNotMatch(drawer.replace(/\/\*[\s\S]*?\*\//g, ''), /intact/i, 'no hard-coded "intact" in the drawer');
  });
});

describe('d. verify rows are inked by liveness', () => {
  it('alive / cannot-tell / dead take the Liveness column marks, not the failure mark', () => {
    for (const l of ['alive', 'cannot-tell', 'dead', 'unchecked']) {
      const m = logic.auditOutcomeMark({ action: 'verify', outcome: l });
      const want = logic.livenessMark(l);
      assert.deepEqual(m, { ink: want.ink, strong: want.strong, label: want.label }, l);
    }
    assert.equal(logic.auditOutcomeMark({ action: 'verify', outcome: 'alive' }).strong, false);
    assert.equal(logic.auditOutcomeMark({ action: 'verify', outcome: 'cannot-tell' }).ink, 'muted');
  });

  it('other rows: ok is accent, anything else is the failure mark (control)', () => {
    assert.deepEqual(logic.auditOutcomeMark({ action: 'set', outcome: 'ok' }), { ink: 'accent', strong: false, label: 'ok' });
    assert.deepEqual(logic.auditOutcomeMark({ action: 'step_up', outcome: 'bad_password' }), { ink: 'ink', strong: true, label: 'bad_password' });
    assert.equal(logic.auditOutcomeMark({ action: 'set', outcome: 'alive' }).strong, true, 'liveness words only count on verify rows');
  });

  it('the drawer inks each row from auditOutcomeMark', () => {
    const drawer = read('AuditDrawer.tsx');
    assert.match(drawer, /const mark = auditOutcomeMark\(e\)/);
    assert.match(drawer, /className=\{`gs-ink-\$\{mark\.ink\}\$\{mark\.strong \? " gs-strong" : ""\}`\}>\{mark\.label\}/);
    assert.doesNotMatch(drawer, /e\.outcome === "ok"/, 'the old ok-or-failure ternary is gone');
  });
});

describe('e. IPs are middle-truncated with the full value in title', () => {
  it('short addresses pass through; long ones keep both ends', () => {
    assert.equal(logic.middleTruncate('198.51.100.1', 20), '198.51.100.1');
    const v6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
    const short = logic.middleTruncate(v6, 20);
    assert.equal(short.length, 20);
    assert.equal(short, '2001:0db8:\u20260370:7334');
    assert.equal(logic.middleTruncate(null), '');
  });

  it('the drawer renders the truncated IP with title={e.ip}', () => {
    assert.match(read('AuditDrawer.tsx'), /<span className="gs-mono" title=\{e\.ip\}>\s*\{middleTruncate\(e\.ip, IP_MAX\)\}/);
  });
});

describe('api.ts exports only what another panel file imports', () => {
  it('every export is imported elsewhere in the panel (no dead exports)', () => {
    const api = read('api.ts');
    const names = [...api.matchAll(/^export (?:async )?(?:function|class|interface|type|const) (\w+)/gm)].map((m) => m[1]);
    assert.ok(names.length >= 10, `anti-vacuity: found ${names.length} exports`);
    const others = fs.readdirSync(DIR).filter((f) => /\.tsx?$/.test(f) && f !== 'api.ts').map(read).join('\n');
    for (const n of names) assert.match(others, new RegExp(`import[^;]*\\b${n}\\b[^;]*from "\\./api"`), `${n} is exported but never imported`);
    for (const n of ['Tier', 'SecretState', 'SecretSource', 'Liveness', 'ApplyState', 'ApplyOutcome', 'VerifyResult', 'StepUpResult']) {
      assert.ok(!names.includes(n), `${n} is only used inside api.ts and must not be exported`);
    }
  });
});
