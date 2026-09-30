'use strict';
/**
 * /api/heal/ssh — the hostname allowlist, the playbooks, and the honest
 * answer. Runs website/app/lib/ssh-heal.js (every decision the route makes)
 * with an injected SSH client, so "never connects" is observed, not assumed.
 *
 * The defect: the route always connects to GATETEST_SSH_HOST (our own box;
 * a body-chosen host would leak the credentials), but the Forensic Scan tab
 * called it after scanning ANY domain — so "Fix Everything" on someone
 * else's site ran sudo playbooks, including caddy/nginx restarts and
 * certbot, on our production server and could answer "Server Healed".
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const heal = require(path.join(ROOT, 'website', 'app', 'lib', 'ssh-heal.js'));

const ISSUES = [
  { category: 'HTTP', title: 'Homepage', detail: 'request failed with 502' },
  { category: 'SSL', title: 'Certificate', detail: 'handshake failed' },
];

const BASE_ENV = Object.freeze({
  GATETEST_SSH_HOST: '203.0.113.10',
  GATETEST_SSH_USER: 'deploy',
  GATETEST_SSH_KEY: 'test-key-material',
  GATETEST_SSH_HOSTNAMES: 'gatetest.example, www.gatetest.example',
});

/** A fake ssh2 session factory that records everything. */
function fakeConnect({ failConnect = false, failOn = null } = {}) {
  const calls = { connects: [], execs: [], ended: 0 };
  const connect = async (config) => {
    calls.connects.push(config);
    if (failConnect) throw new Error('connect refused');
    return {
      async exec(cmd) {
        calls.execs.push(cmd);
        if (failOn && failOn.test(cmd)) throw new Error('boom');
        return `ok: ${cmd.slice(0, 20)}`;
      },
      end() { calls.ended += 1; },
    };
  };
  return { connect, calls };
}

const run = (env, body, opts) => {
  const f = fakeConnect(opts);
  return heal.runHeal({ env, body, svc: 'tallrig', connect: f.connect }).then((r) => ({ ...r, calls: f.calls }));
};

describe('target allowlist — refuse before connecting', () => {
  it('GATETEST_SSH_HOSTNAMES unset → 409 target_not_configured, no SSH connect', async () => {
    const env = { ...BASE_ENV };
    delete env.GATETEST_SSH_HOSTNAMES;
    const r = await run(env, { hostname: 'gatetest.example', issues: ISSUES });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'target_not_configured');
    assert.equal(r.calls.connects.length, 0, 'never connects');
    assert.equal(r.calls.execs.length, 0);
  });

  it('an empty / whitespace list is the same as unset', async () => {
    const r = await run({ ...BASE_ENV, GATETEST_SSH_HOSTNAMES: ' , ' }, { hostname: 'gatetest.example', issues: ISSUES });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'target_not_configured');
    assert.equal(r.calls.connects.length, 0);
  });

  it('a scanned hostname that is not ours → 409 target_mismatch, no SSH connect', async () => {
    const r = await run(BASE_ENV, { hostname: 'someone-else.example', issues: ISSUES });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'target_mismatch');
    assert.equal(r.body.hostname, 'someone-else.example');
    assert.equal(r.calls.connects.length, 0, 'never connects');
  });

  it('a missing hostname, a look-alike suffix and junk are mismatches too', async () => {
    for (const hostname of [undefined, '', 'evil-gatetest.example', 'gatetest.example.evil.test', 'gatetest.example;rm -rf /', 42]) {
      const r = await run(BASE_ENV, { hostname, issues: ISSUES });
      assert.equal(r.status, 409, `hostname ${String(hostname)}`);
      assert.equal(r.body.error, 'target_mismatch');
      assert.equal(r.calls.connects.length, 0);
    }
  });

  it('a body "host" is ignored — the target is never taken from the request', async () => {
    const r = await run(BASE_ENV, { host: '198.51.100.66', hostname: 'gatetest.example', issues: ISSUES });
    assert.equal(r.status, 200);
    assert.equal(r.calls.connects.length, 1);
    assert.equal(r.calls.connects[0].host, '203.0.113.10', 'connects to GATETEST_SSH_HOST only');
  });
});

describe('an allowed hostname proceeds', () => {
  it('match (case, trailing dot, URL form all normalise) → connects to GATETEST_SSH_HOST and runs the plan', async () => {
    for (const hostname of ['gatetest.example', 'GATETEST.example.', 'https://www.gatetest.example/path', 'www.gatetest.example:443']) {
      const r = await run(BASE_ENV, { hostname, issues: ISSUES });
      assert.equal(r.status, 200, `hostname ${hostname}`);
      assert.equal(r.calls.connects.length, 1);
      assert.deepEqual(
        { host: r.calls.connects[0].host, port: r.calls.connects[0].port, username: r.calls.connects[0].username },
        { host: '203.0.113.10', port: 22, username: 'deploy' },
      );
      assert.equal(r.calls.connects[0].privateKey, 'test-key-material');
      assert.ok(r.calls.execs.length > 0, 'commands ran');
      assert.equal(r.calls.ended, 1, 'the session is closed');
      assert.equal(r.body.status, 'completed');
      assert.equal(r.body.ran, r.calls.execs.length);
    }
  });

  it('dryRun answers allowed + ready without connecting', async () => {
    const r = await run(BASE_ENV, { hostname: 'gatetest.example', dryRun: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { allowed: true, hostname: 'gatetest.example', ready: true, missing: [] });
    assert.equal(r.calls.connects.length, 0);
  });

  it('dryRun says what is missing when the box credentials are not set — names only, never values', async () => {
    const r = await run({ GATETEST_SSH_HOSTNAMES: 'gatetest.example' }, { hostname: 'gatetest.example', dryRun: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.ready, false);
    assert.deepEqual(r.body.missing, ['GATETEST_SSH_HOST', 'GATETEST_SSH_PASSWORD or GATETEST_SSH_KEY']);
    assert.equal(r.calls.connects.length, 0);
  });

  it('dryRun for a mismatch is still 409 — the tab offers template fixes only', async () => {
    const r = await run(BASE_ENV, { hostname: 'someone-else.example', dryRun: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'target_mismatch');
  });

  it('allowed but no credentials → 400 ssh_not_configured, no connect', async () => {
    const r = await run({ GATETEST_SSH_HOSTNAMES: 'gatetest.example', GATETEST_SSH_HOST: '203.0.113.10' }, { hostname: 'gatetest.example', issues: ISSUES });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'ssh_not_configured');
    assert.equal(r.calls.connects.length, 0);
  });
});

describe('the answer is honest', () => {
  it('no playbook matches → "no_playbook", nothing connects (was: status "healed" with zero actions)', async () => {
    const r = await run(BASE_ENV, { hostname: 'gatetest.example', issues: [{ category: 'Email', title: 'SPF', detail: 'missing' }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'no_playbook');
    assert.equal(r.body.actionsRun, 0);
    assert.equal(r.calls.connects.length, 0);
    assert.doesNotMatch(JSON.stringify(r.body), /healed/i);
  });

  it('a command that ran is "ran", never "fixed"; the message says re-scan to confirm', async () => {
    const r = await run(BASE_ENV, { hostname: 'gatetest.example', issues: ISSUES });
    assert.ok(r.body.actions.every((a) => a.status === 'ran'));
    assert.doesNotMatch(JSON.stringify(r.body), /"fixed"|healed/i);
    assert.match(r.body.message, /re-run the scan to confirm/);
  });

  it('a failing command → partial; a connect failure → 502 and nothing ran', async () => {
    const partial = await run(BASE_ENV, { hostname: 'gatetest.example', issues: ISSUES }, { failOn: /journalctl/ });
    assert.equal(partial.body.status, 'partial');
    assert.ok(partial.body.failed >= 1);
    const down = await run(BASE_ENV, { hostname: 'gatetest.example', issues: ISSUES }, { failConnect: true });
    assert.equal(down.status, 502);
    assert.equal(down.body.error, 'ssh_connect_failed');
    assert.equal(down.calls.execs.length, 0);
  });
});

describe('the playbooks never touch a proxy or its certificates', () => {
  const books = heal.buildPlaybooks('tallrig');
  const commands = books.flatMap((b) => b.commands.map((c) => c.cmd));

  it('POSITIVE CONTROL: the detector flags every command the old playbooks ran', () => {
    for (const bad of [
      'sudo systemctl restart caddy 2>&1',
      'sudo systemctl start caddy 2>&1 && sudo systemctl enable caddy 2>&1',
      'sudo systemctl restart nginx 2>&1 && (sudo certbot renew --force-renewal 2>&1 | tail -5)',
      'sudo systemctl start caddy 2>&1 || sudo systemctl start nginx 2>&1 || sudo systemctl start apache2 2>&1',
      "sudo sed -i '/^[^#]*{$/a\\    encode gzip' /etc/caddy/Caddyfile 2>&1 && sudo systemctl reload caddy 2>&1",
      "sudo bash -c 'cat > /etc/nginx/conf.d/security-headers.conf << EOFH' && sudo systemctl reload nginx",
      'sudo systemctl restart caddy 2>&1; sudo systemctl restart tallrig-web 2>&1',
    ]) {
      assert.ok(heal.isProxyMutation(bad), `must flag: ${bad}`);
    }
  });

  it('NEGATIVE CONTROL: read-only diagnostics and the app unit restart are not flagged', () => {
    for (const ok of [
      "sudo systemctl status caddy --no-pager -l 2>&1 | head -20 || echo 'caddy not found'",
      "sudo systemctl list-units --type=service --state=running 2>&1 | grep -E 'caddy|nginx' | head -10",
      'sudo systemctl restart tallrig-web 2>&1 || true',
      'curl -sI https://localhost -k 2>&1 | head -5',
    ]) {
      assert.ok(!heal.isProxyMutation(ok), `must not flag: ${ok}`);
    }
  });

  it('no playbook command starts / restarts / reloads / enables caddy, nginx or apache, edits their config, or runs certbot', () => {
    assert.ok(commands.length >= 10, 'anti-vacuity');
    const offenders = commands.filter((c) => heal.isProxyMutation(c));
    assert.deepEqual(offenders, []);
    for (const c of commands) assert.doesNotMatch(c, /certbot/i);
  });

  it('nothing clears shared-box state (journal vacuum, package caches)', () => {
    for (const c of commands) assert.doesNotMatch(c, /--vacuum|apt-get clean|cache clean/);
  });

  it('the only mutation left is the app\'s own unit restart', () => {
    const mutating = commands.filter((c) => /systemctl\s+(?:start|restart|reload|enable|stop)\b/.test(c));
    assert.equal(mutating.length, 1);
    assert.match(mutating[0], /systemctl restart tallrig-web/);
    assert.doesNotMatch(mutating[0], /caddy|nginx|apache|gateway/);
  });

  it('an unsafe service prefix never reaches a command', () => {
    const cmds = heal.buildPlaybooks('rm -rf /').flatMap((b) => b.commands.map((c) => c.cmd));
    assert.ok(cmds.every((c) => !c.includes('rm -rf')));
  });
});

describe('wiring', () => {
  const route = fs.readFileSync(path.join(ROOT, 'website', 'app', 'api', 'heal', 'ssh', 'route.ts'), 'utf8');
  const tab = fs.readFileSync(path.join(ROOT, 'website', 'app', 'admin', 'tabs', 'NuclearScanTab.tsx'), 'utf8');

  it('the route delegates to runHeal after the admin gate and opens ssh2 only inside connect', () => {
    assert.match(route, /const refused = requireAdminRoute\(req, \{ mutating: true \}\);\s*if \(refused\) return refused;/);
    assert.match(route, /await runHeal\(\{ env: process\.env, body, svc: platformServicePrefix\(\), connect: connectSsh \}\)/);
    assert.equal((route.match(/require\(modName\)/g) || []).length, 1);
    assert.ok(route.indexOf('require(modName)') > route.indexOf('async function connectSsh'), 'ssh2 loads inside connectSsh');
  });

  it('the tab asks the route (dryRun) and only runs SSH heal when told the hostname is ours', () => {
    assert.match(tab, /body: JSON\.stringify\(\{ hostname, dryRun: true \}\)/);
    assert.match(tab, /if \(healGate\.kind === "available" && issueFindings\.length > 0\)/);
    assert.match(tab, /target_mismatch/);
    assert.match(tab, /target_not_configured/);
    assert.match(tab, /Fix Everything generates config snippets only/);
    assert.doesNotMatch(tab, /Server Healed/);
    assert.doesNotMatch(tab, /host: ip\b/, 'the tab no longer sends the scanned IP as a target');
  });

  it('GATETEST_SSH_HOSTNAMES is documented where operators look', () => {
    const catalogue = require(path.join(ROOT, 'website', 'app', 'lib', 'env-catalogue.js'));
    assert.ok(catalogue.OPTIONAL.includes('GATETEST_SSH_HOSTNAMES'));
    assert.match(catalogue.OPTIONAL_WHY.GATETEST_SSH_HOSTNAMES, /hostnames/);
    assert.match(fs.readFileSync(path.join(ROOT, 'website', '.env.example'), 'utf8'), /^GATETEST_SSH_HOSTNAMES=$/m);
  });

  it('the tab uses no red / orange / amber / yellow hue classes (owner design rule)', () => {
    assert.match(tab, /className=/, 'positive control');
    assert.doesNotMatch(tab, /\b(?:text|bg|border|border-l|ring|from|to|via|fill|stroke|divide|outline|decoration|shadow|accent|caret|placeholder)-(?:red|orange|amber|yellow)-\d/);
  });
});
