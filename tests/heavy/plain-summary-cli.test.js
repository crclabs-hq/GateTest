'use strict';

// =============================================================================
// CLI plain-English recap (WS3) — after a scan, an entry-level user sees a
// short "what happened + one next command" block. Machine-output modes
// (--sarif) suppress it. Real subprocess runs against a scratch project.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.resolve(__dirname, '../../bin/gatetest.js');

function runScan(cwd, extraArgs) {
  try {
    const out = execFileSync(process.execPath, [CLI, '--module', 'secrets', ...extraArgs], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
      env: { ...process.env, GATETEST_NO_TELEMETRY: '1', NODE_TEST_CONTEXT: undefined },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: String(err.stdout || '') + String(err.stderr || '') };
  }
}

describe('CLI plain-English recap', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-plain-'));
    // A source file with NO .gitignore guarantees a blocking secrets finding
    // (secrets:gitignore-exists) — no secret-shaped literal, so this fixture
    // never trips GitHub push-protection.
    fs.writeFileSync(path.join(dir, 'app.js'), 'export const x = 1;\n');
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('shows the "What now?" recap with the next command on a blocked scan', () => {
    const { out } = runScan(dir, []);
    assert.match(out, /What now\?/);
    assert.match(out, /gatetest fix --apply/);
    assert.match(out, /\.gatetestignore/);
  });

  it('suppresses the recap under --sarif (machine output)', () => {
    const { out } = runScan(dir, ['--sarif']);
    assert.doesNotMatch(out, /What now\?/);
  });
});
