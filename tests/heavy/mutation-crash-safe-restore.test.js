// =============================================================================
// MUTATION — a killed scan must not leave a mutant in the user's source
// =============================================================================
// The mutation module used to write a mutant into the REAL source file, run
// the project's tests against it, and restore the original in a `finally`
// plus signal handlers. Observed three times in a single session on this
// repo before the handlers existed — a `-` left as `+`, a `+` flipped inside
// a string literal, a mutant in a config file. Handlers cannot cover SIGKILL
// or a power cut, so mutants now live in a SANDBOX COPY (src/core/tree-copy.js,
// the Fifty move 20) and the user's file is never opened for writing at all.
//
// This test therefore proves the stronger invariant: while the module is
// inside the mutation window — the sandbox copy of the file IS a mutant and
// the suite is running against it — the real file reads as the original on
// every poll, a SIGTERM lands in that window, the real file is still the
// original afterwards, and the sandbox is gone. The victim project is built
// so the window is genuinely open when the signal arrives (baseline exits at
// once, the first mutant run blocks); a test that kills the scan before any
// mutant exists passes whether the sandbox works or not, so it fails loudly
// when the window never opened.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'gatetest.js');
const ORIGINAL = 'function subtract(a, b) { return a - b; }\nmodule.exports = { subtract };\n';

function buildVictim() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mut-victim-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  // The module skips a project whose deps are not installed.
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'math.js'), ORIGINAL);
  fs.writeFileSync(
    path.join(root, 't.js'),
    [
      "const fs = require('fs');",
      "const marker = __dirname + '/.baseline-done';",
      '// Baseline: exit at once so the module proceeds to mutants.',
      "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); process.exit(0); }",
      '// Mutant runs: hold the window open.',
      'setTimeout(() => process.exit(1), 30000);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'victim', version: '1.0.0', scripts: { test: 'node t.js' } }, null, 2),
  );
  return root;
}

const read = (root) => fs.readFileSync(path.join(root, 'src', 'math.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sandboxes = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gt-mutate-')).map((n) => path.join(os.tmpdir(), n));

describe('mutation — the working tree survives a killed scan', () => {
  it('the real file is never touched, even when the scan is SIGTERMed mid-mutation; the sandbox is removed', async () => {
    const root = buildVictim();
    const before = new Set(sandboxes());
    try {
      const child = spawn(process.execPath, [CLI, 'scan', '--module', 'mutation', '--project', root], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      });
      const exited = new Promise((resolve) => child.on('exit', resolve));

      // Wait for the module to actually mutate the SANDBOX copy, reading the
      // real file on every poll. Without the window this test proves nothing.
      let sawMutation = false;
      let sandbox = null;
      let realEverChanged = false;
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        if (read(root) !== ORIGINAL) realEverChanged = true;
        const fresh = sandboxes().filter((d) => !before.has(d));
        for (const d of fresh) {
          try {
            if (fs.readFileSync(path.join(d, 'src', 'math.js'), 'utf8') !== ORIGINAL) { sawMutation = true; sandbox = d; }
          } catch { /* error-ok — the copy is still being written */ }
        }
        if (sawMutation || child.exitCode !== null) break;
      }

      assert.ok(
        sawMutation,
        'the victim project never reached the mutation window — this test would ' +
          'pass against a broken sandbox, so it must fail loudly instead',
      );
      assert.strictEqual(realEverChanged, false, 'the real source file was modified during the scan');

      child.kill('SIGTERM');
      await exited;
      // The handler removes the sandbox before the process exits; on Windows
      // the directory entry can lag the exit by a few ms. Poll for it,
      // bounded, rather than betting a fixed grace period covers it.
      for (let i = 0; i < 20 && fs.existsSync(sandbox); i++) await sleep(50);

      assert.strictEqual(read(root), ORIGINAL, 'a SIGTERMed scan left a mutant behind in the source file');
      assert.strictEqual(fs.existsSync(sandbox), false, `the sandbox ${sandbox} was not removed on SIGTERM`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
