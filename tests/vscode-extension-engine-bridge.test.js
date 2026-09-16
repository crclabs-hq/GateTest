// =============================================================================
// vscode-extension-engine-bridge.test.js
//
// The VS Code extension runs the engine IN-PROCESS through
// vscode-extension/engine/engine-bridge.js. Before this the extension spawned
// `gatetest --format json --file <f>` — two flags the CLI never had — so every
// editor scan printed "unknown option" and JSON.parse'd a console banner.
//
// The bridge has no `vscode` import on purpose: these tests load it directly
// and pin (a) engine resolution order, (b) the finding → diagnostic mapping,
// (c) the one-line verdict, and (d) the pure helpers behind "Fix This Finding
// (your own key)": model allow-list lookup, cost formatting, the cap decision,
// the pre-run estimate, and the post-apply "still present" check. The end-to-end
// worker runs live in tests/heavy/vscode-extension-engine-worker.test.js (scan)
// and tests/heavy/vscode-extension-fix-worker.test.js (fix, stub transport).
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'vscode-extension');
const bridge = require(path.join(EXT_DIR, 'engine', 'engine-bridge.js'));

describe('engine-bridge: resolveEngineEntry', () => {
  it('finds the sibling checkout when the extension lives inside the repo', () => {
    const hit = bridge.resolveEngineEntry({ extensionDir: EXT_DIR, workspaceRoot: os.tmpdir() });
    assert.ok(hit.entry, 'an entry is resolved');
    // Either the bundled node_modules copy (after npm install) or the checkout —
    // both are legitimate; neither is a CLI binary on PATH. The version is
    // whatever that package.json says, so pin it to the resolved package.
    assert.strictEqual(hit.version, require(path.join(hit.packageDir, 'package.json')).version);
    assert.match(hit.version, /^\d+\.\d+\.\d+/);
    assert.ok(['bundled', 'checkout'].includes(hit.source), `source is ${hit.source}`);
    assert.ok(fs.existsSync(hit.entry));
    assert.match(path.basename(hit.entry), /index\.js$/);
  });

  it('prefers the workspace-pinned @gatetest/cli over everything else', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ws-'));
    const pkgDir = path.join(ws, 'node_modules', '@gatetest', 'cli');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@gatetest/cli', version: '0.0.1-ws', main: 'src/index.js' }));
    fs.writeFileSync(path.join(pkgDir, 'src', 'index.js'), 'module.exports = {};');
    try {
      const hit = bridge.resolveEngineEntry({ extensionDir: EXT_DIR, workspaceRoot: ws });
      assert.strictEqual(hit.source, 'workspace');
      assert.strictEqual(hit.version, '0.0.1-ws');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('honours gatetest.enginePath given as a checkout dir OR as a file inside it', () => {
    const asDir = bridge.resolveEngineEntry({ configuredPath: ROOT });
    assert.strictEqual(asDir.source, 'setting');
    assert.strictEqual(asDir.entry, path.join(ROOT, 'src', 'index.js'));

    const asFile = bridge.resolveEngineEntry({ configuredPath: path.join(ROOT, 'src', 'index.js') });
    assert.strictEqual(asFile.source, 'setting');
    assert.strictEqual(asFile.version, require(path.join(ROOT, 'package.json')).version);
  });

  it('reports every path it tried when nothing resolves', () => {
    const miss = bridge.resolveEngineEntry({ configuredPath: path.join(os.tmpdir(), 'nope-gatetest'), workspaceRoot: os.tmpdir(), extensionDir: os.tmpdir() });
    assert.strictEqual(miss.entry, null);
    assert.ok(Array.isArray(miss.attempts) && miss.attempts.length >= 3);
    assert.ok(miss.attempts.every((a) => a.ok === false));
  });

  it('does not accept a directory that is not @gatetest/cli', () => {
    assert.strictEqual(bridge.entryFromPath(EXT_DIR), null, 'the extension itself is not the engine');
  });
});

describe('engine-bridge: findingsToDiagnostics', () => {
  const root = path.join(os.tmpdir(), 'proj');
  const summary = {
    gateStatus: 'BLOCKED',
    findings: [
      { module: 'secrets', rule: 'secrets:aws-key', severity: 'error', file: 'src/a.js', line: 12, message: 'AWS key', suggestion: 'move to env', blocking: true },
      { module: 'lint', rule: 'lint:unused', severity: 'warning', file: 'src/a.js', line: 3, message: 'unused var' },
      { module: 'lint', rule: 'lint:dup', severity: 'warning', file: 'src/a.js', line: 4, message: 'dup', duplicateOf: 'lint:unused' },
      { module: 'ciSecurity', rule: 'ci:none', severity: 'info', file: null, line: null, message: 'no CI config' },
      { module: 'deadCode', rule: 'dead', severity: 'weird', file: path.join(root, 'src', 'b.js'), line: 0, message: 'dead fn' },
    ],
  };

  it('maps file findings to absolute paths, sorted error → warning → info then by line', () => {
    const { inFiles, repoLevel } = bridge.findingsToDiagnostics(summary, root);
    assert.deepStrictEqual(inFiles.map((d) => [path.basename(d.file), d.line, d.severity]), [
      ['a.js', 12, 'error'],
      ['a.js', 3, 'warning'],
      ['b.js', 1, 'info'],
    ]);
    assert.ok(inFiles.every((d) => path.isAbsolute(d.file)));
    assert.strictEqual(inFiles[0].suggestion, 'move to env');
    assert.strictEqual(inFiles[0].blocking, true);
    assert.strictEqual(inFiles[2].severity, 'info', 'an unknown severity degrades to info, never to error');
  });

  it('keeps repo-level findings (no file) out of the diagnostics but returns them', () => {
    const { repoLevel } = bridge.findingsToDiagnostics(summary, root);
    assert.strictEqual(repoLevel.length, 1);
    assert.strictEqual(repoLevel[0].module, 'ciSecurity');
  });

  it('drops cross-module duplicates the registry already folded', () => {
    const { inFiles } = bridge.findingsToDiagnostics(summary, root);
    assert.ok(!inFiles.some((d) => d.message === 'dup'));
  });

  it('scopes to one file for "Scan This File"', () => {
    const { inFiles } = bridge.findingsToDiagnostics(summary, root, { onlyFile: path.join(root, 'src', 'b.js') });
    assert.deepStrictEqual(inFiles.map((d) => path.basename(d.file)), ['b.js']);
  });

  it('tolerates a summary with no findings at all', () => {
    const { inFiles, repoLevel } = bridge.findingsToDiagnostics({ gateStatus: 'PASSED' }, root);
    assert.deepStrictEqual(inFiles, []);
    assert.deepStrictEqual(repoLevel, []);
  });
});

describe('engine-bridge: summarize', () => {
  it('reads the verdict from gateStatus and the counts from checks/modules', () => {
    const v = bridge.summarize({
      gateStatus: 'BLOCKED',
      modules: { total: 42, passed: 40 },
      checks: { blockingErrors: 2, warnings: 5 },
      deferred: ['mutation', 'chaos'],
    }, { inFilesCount: 7 });
    assert.strictEqual(v.passed, false);
    assert.strictEqual(v.errors, 2);
    assert.match(v.text, /^BLOCKED · 40\/42 modules passed · 2 blocking, 5 warning\(s\) · 7 finding\(s\)/);
    assert.match(v.text, /deferred to CI: mutation, chaos/);
  });

  it('says so when the engine checked nothing — an empty scan must never read as clean', () => {
    const v = bridge.summarize({ gateStatus: 'PASSED', nothingChecked: true, modules: {}, checks: {} });
    assert.strictEqual(v.passed, true);
    assert.match(v.text, /nothing was checked/);
  });
});

describe('engine-bridge: local fix — depth → model lookup (the table is the engine\'s)', () => {
  const engine = bridge.resolveEngineEntry({ configuredPath: ROOT });
  const models = require(path.join(ROOT, 'src', 'core', 'engine-models.js'));

  it('lists the engine depth tiers with their labels', () => {
    assert.deepStrictEqual(bridge.fixDepthChoices(engine.packageDir),
      Object.keys(models.FIX_DEPTHS).map((id) => ({ id, label: models.FIX_DEPTHS[id].label })));
    assert.deepStrictEqual(Object.keys(models.FIX_DEPTHS), ['standard', 'deep']);
  });

  it('standard → the engine default fix model, deep → the engine fix-tier model, empty → standard', () => {
    assert.deepStrictEqual(bridge.resolveFixDepth(engine.packageDir, 'standard'), { ok: true, depth: 'standard', model: models.CHEAP_MODEL });
    assert.deepStrictEqual(bridge.resolveFixDepth(engine.packageDir, 'deep'), { ok: true, depth: 'deep', model: models.FIX_MODEL });
    assert.deepStrictEqual(bridge.resolveFixDepth(engine.packageDir, ' DEEP '), { ok: true, depth: 'deep', model: models.FIX_MODEL });
    assert.deepStrictEqual(bridge.resolveFixDepth(engine.packageDir, ''), { ok: true, depth: 'standard', model: models.CHEAP_MODEL });
    for (const id of Object.keys(models.FIX_DEPTHS)) {
      assert.ok(models.allowedModelIds().includes(models.FIX_DEPTHS[id].model), `${id} maps onto the allow-list`);
    }
  });

  it('rejects an unknown depth with the engine error text', () => {
    const bad = bridge.resolveFixDepth(engine.packageDir, 'ultra');
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /Unknown fix depth "ultra"\. Allowed: standard, deep\./);
  });

  it('an engine without the depth table still runs standard on its default and asks for an upgrade on deep', () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-olddepth-'));
    try {
      fs.mkdirSync(path.join(fake, 'src', 'core'), { recursive: true });
      fs.writeFileSync(path.join(fake, 'src', 'core', 'engine-models.js'), "module.exports = { CHEAP_MODEL: 'default-model-id' };");
      assert.strictEqual(bridge.fixDepthChoices(fake), null);
      assert.deepStrictEqual(bridge.resolveFixDepth(fake, 'standard'), { ok: true, depth: 'standard', model: 'default-model-id' });
      const deep = bridge.resolveFixDepth(fake, 'deep');
      assert.strictEqual(deep.ok, false);
      assert.match(deep.error, /no "deep" fix depth — upgrade/);
      const none = bridge.resolveFixDepth(path.join(fake, 'nowhere'), 'standard');
      assert.strictEqual(none.ok, false);
      assert.match(none.error, /engine-models\.js missing/);
    } finally {
      fs.rmSync(fake, { recursive: true, force: true });
    }
  });

  it('the manifest enum for gatetest.fixDepth IS the engine depth table, and no model id is in the manifest', () => {
    const raw = fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8');
    const manifest = JSON.parse(raw);
    const prop = manifest.contributes.configuration.properties['gatetest.fixDepth'];
    assert.deepStrictEqual(prop.enum, Object.keys(models.FIX_DEPTHS));
    assert.strictEqual(prop.default, 'standard');
    assert.ok(!manifest.contributes.configuration.properties['gatetest.fixModel'], 'the model-id setting is gone');
    for (const id of models.allowedModelIds()) assert.ok(!raw.includes(id), `${id} must not appear in the manifest`);
  });
});

describe('engine-bridge: local fix — cost formatting', () => {
  it('formatUsd: four decimals under ten cents, two above, n/a for nothing', () => {
    assert.strictEqual(bridge.formatUsd(0.0135), '$0.0135');
    assert.strictEqual(bridge.formatUsd(0.099), '$0.0990');
    assert.strictEqual(bridge.formatUsd(0.1), '$0.10');
    assert.strictEqual(bridge.formatUsd(2), '$2.00');
    assert.strictEqual(bridge.formatUsd(null), 'n/a');
    assert.strictEqual(bridge.formatUsd(NaN), 'n/a');
  });

  it('formatCost prints tokens, USD, depth and calls from a priced run — never the model id', () => {
    const line = bridge.formatCost({ tokensIn: 1500, tokensOut: 600, usdEstimated: 0.0135, depth: 'standard', model: 'claude-sonnet-5', calls: 1, priced: true, knownPrice: true, exact: true });
    assert.strictEqual(line, '1,500 in / 600 out tokens · $0.0135 · standard depth · 1 call(s)');
    assert.ok(!line.includes('claude-sonnet-5'), 'the model id is never printed');
  });

  it('formatCost never prints $0.00 for an unpriced run — it says USD is unavailable and why', () => {
    const line = bridge.formatCost({ tokensIn: 1500, tokensOut: 600, usdEstimated: null, model: 'claude-sonnet-5', calls: 1, priced: false, priceNote: 'engine 1.61.0 has no price table' });
    assert.match(line, /USD unavailable \(engine 1\.61\.0 has no price table\)/);
    assert.ok(!/\$/.test(line), 'no dollar figure at all');
  });

  it('formatCost flags inexact token counts and the worst-case rate for an unknown model', () => {
    const inexact = bridge.formatCost({ tokensIn: 100, tokensOut: 20, usdEstimated: 0.0006, model: 'm', calls: 1, priced: true, knownPrice: false, exact: false });
    assert.match(inexact, /no rate at this depth — worst-case rate/);
    assert.match(inexact, /token counts estimated/);
    const zero = bridge.formatCost({ tokensIn: 0, tokensOut: 0, usdEstimated: 0, model: 'm', calls: 0, priced: true, knownPrice: true, exact: false });
    assert.ok(!/estimated —/.test(zero), 'nothing to flag when nothing was counted');
  });

  it('issueTextFor matches the `module:check — message` line runFixBatch builds', () => {
    assert.strictEqual(bridge.issueTextFor({ module: 'secrets', rule: 'secrets:aws-key', message: 'AWS key' }), 'secrets:secrets:aws-key — AWS key');
    assert.strictEqual(bridge.issueTextFor({ module: 'lint', rule: null, message: 'unused' }), 'lint:check — unused');
  });
});

describe('engine-bridge: local fix — the estimate shown BEFORE a run', () => {
  const engine = bridge.resolveEngineEntry({ configuredPath: ROOT });
  const budget = require(path.join(ROOT, 'src', 'core', 'budget-tracker.js'));
  const { FIX_CALL_SHAPE } = require(path.join(ROOT, 'src', 'core', 'cli-fix-orchestrator.js'));

  it('uses the engine price table and the orchestrator request shape — no typed numbers', () => {
    const text = 'const a = 1;\n'.repeat(200);
    const r = bridge.estimateBeforeFix({ packageDir: engine.packageDir, model: 'claude-fable-5', fileText: text, engineVersion: engine.version });
    assert.strictEqual(r.available, true);
    assert.deepStrictEqual(r.estimate, budget.estimateFixCost({ model: 'claude-fable-5', fileText: text, ...FIX_CALL_SHAPE }));
    const line = bridge.formatEstimate(r, 2);
    assert.match(line, /^Estimated \$[\d.]+ per attempt \(~[\d,]+ in \/ up to [\d,]+ out tokens\), up to \$[\d.]+ over 3 attempts, at this depth's price of \$10\/\$50 per million tokens in\/out\. Cap: \$2\.00\.$/);
    assert.ok(!line.includes('claude-fable-5'), 'the model id is never printed');
    assert.match(bridge.formatEstimate(r, 0), /No cap set\.$/);
  });

  it('reports "estimate unavailable" with the reason when the engine has no price table, never a guessed figure', () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-oldengine-'));
    try {
      const r = bridge.estimateBeforeFix({ packageDir: fake, model: 'claude-sonnet-5', fileText: 'x', engineVersion: '1.61.0' });
      assert.strictEqual(r.available, false);
      assert.match(r.reason, /engine 1\.61\.0 has no price table/);
      const line = bridge.formatEstimate(r, 2);
      assert.match(line, /^Cost estimate unavailable: engine 1\.61\.0 has no price table/);
      assert.match(line, /the USD cap cannot be enforced/);
      assert.ok(!/\$\d/.test(line), 'no dollar figure');
    } finally {
      fs.rmSync(fake, { recursive: true, force: true });
    }
  });
});

describe('engine-bridge: local fix — the cap decision', () => {
  it('no cap → allowed and not enforced', () => {
    for (const maxUsd of [0, -1, Infinity, NaN, undefined]) {
      const d = bridge.capDecision({ usd: 99, maxUsd, priced: true });
      assert.deepStrictEqual([d.allowed, d.enforced], [true, false], `maxUsd=${maxUsd}`);
      assert.match(d.reason, /no USD cap set/);
    }
  });

  it('a figure over the cap is blocked; under it is allowed and enforced', () => {
    const over = bridge.capDecision({ usd: 2.5, maxUsd: 2, priced: true });
    assert.deepStrictEqual([over.allowed, over.enforced], [false, true]);
    assert.match(over.reason, /\$2\.50 is over the cap of \$2\.00/);
    const under = bridge.capDecision({ usd: 0.05, maxUsd: 2, priced: true });
    assert.deepStrictEqual([under.allowed, under.enforced], [true, true]);
    assert.strictEqual(bridge.capDecision({ usd: 2, maxUsd: 2, priced: true }).allowed, true, 'equal is not over');
  });

  it('a cap with no price table cannot be enforced — allowed only with confirmation, and it says so', () => {
    const d = bridge.capDecision({ usd: null, maxUsd: 2, priced: false });
    assert.deepStrictEqual([d.allowed, d.enforced, d.needsConfirmation], [true, false, true]);
    assert.match(d.reason, /cannot be enforced — no price table/);
  });
});

describe('engine-bridge: local fix — verifying after the re-scan', () => {
  const file = path.join(os.tmpdir(), 'proj', 'src', 'a.js');
  const target = { file, module: 'secrets', rule: 'secrets:aws-key', message: 'AWS key', line: 12 };

  it('matches on file + module + rule and ignores the line (a fix moves lines)', () => {
    assert.strictEqual(bridge.findingStillPresent([{ ...target, line: 40 }], target), true);
    assert.strictEqual(bridge.findingStillPresent([{ ...target, rule: 'secrets:other' }], target), false);
    assert.strictEqual(bridge.findingStillPresent([{ ...target, module: 'lint' }], target), false);
    assert.strictEqual(bridge.findingStillPresent([{ ...target, file: path.join(os.tmpdir(), 'proj', 'src', 'b.js') }], target), false);
    assert.strictEqual(bridge.findingStillPresent([], target), false);
  });

  it('falls back to the message when the finding has no rule', () => {
    const noRule = { file, module: 'lint', rule: null, message: 'unused var', line: 3 };
    assert.strictEqual(bridge.findingStillPresent([{ ...noRule, line: 9 }], noRule), true);
    assert.strictEqual(bridge.findingStillPresent([{ ...noRule, message: 'other' }], noRule), false);
  });
});

describe('vscode-extension: the CLI-spawn design is gone', () => {
  const src = fs.readFileSync(path.join(EXT_DIR, 'src', 'extension.ts'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));

  it('never spawns a child process or passes flags the CLI does not have', () => {
    assert.ok(!/child_process/.test(src), 'no child_process import');
    assert.ok(!/--format/.test(src), 'no --format flag');
    assert.ok(!/'--file'/.test(src), 'no --file flag');
    assert.match(src, /worker_threads/);
    assert.match(src, /engine-worker\.js/);
  });

  it('does not write global settings on activation', () => {
    assert.ok(!/autoRegisterMcpServer/.test(src));
    assert.ok(!/ConfigurationTarget\.Global/.test(src));
  });

  it('bundles the engine and exposes enginePath instead of gatePath', () => {
    assert.ok(manifest.dependencies && manifest.dependencies['@gatetest/cli'], '@gatetest/cli is a runtime dependency');
    const props = manifest.contributes.configuration.properties;
    assert.ok(props['gatetest.enginePath']);
    assert.ok(!props['gatetest.gatePath']);
    assert.ok(manifest.contributes.commands.some((c) => c.command === 'gatetest.cancelScan'));
  });

  it('contributes the local-fix commands and settings, and keeps the provider key out of settings.json', () => {
    const commands = manifest.contributes.commands.map((c) => c.command);
    assert.ok(commands.includes('gatetest.fixFindingLocal'));
    assert.ok(commands.includes('gatetest.setProviderKey'));
    const palette = manifest.contributes.menus.commandPalette.map((c) => c.command);
    assert.ok(palette.includes('gatetest.fixFindingLocal') && palette.includes('gatetest.setProviderKey'));
    const props = manifest.contributes.configuration.properties;
    assert.strictEqual(props['gatetest.fixMaxUsd'].default, 2);
    assert.strictEqual(props['gatetest.fixMaxUsd'].type, 'number');
    assert.ok(!Object.keys(props).some((k) => /key|token|secret/i.test(k)), 'no setting carries the provider key');
    assert.match(src, /context\.secrets|extensionContext\.secrets/);
    assert.match(src, /password: true/);
    assert.ok(!/getConfiguration\([^)]*\)\.get<string>\(['\"]providerKey/.test(src), 'the key is never read from configuration');
  });

  it('never writes a proposed fix to disk without Apply, and never claims fixed without the re-scan', () => {
    assert.match(src, /vscode\.diff/);
    assert.match(src, /'Apply', 'Discard'/);
    assert.match(src, /findingStillPresent/);
    assert.match(src, /STILL PRESENT/);
    assert.match(src, /NOT CHECKED/);
    assert.match(src, /VERIFIED/);
  });

  it('ships the engine files in the vsix', () => {
    const ignore = fs.readFileSync(path.join(EXT_DIR, '.vscodeignore'), 'utf8');
    assert.ok(!/^engine/m.test(ignore), 'engine/ is not ignored');
    assert.ok(fs.existsSync(path.join(EXT_DIR, 'engine', 'engine-worker.js')));
  });
});
