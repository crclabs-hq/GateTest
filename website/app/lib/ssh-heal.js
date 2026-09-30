'use strict';
/**
 * SSH auto-heal — every decision behind POST /api/heal/ssh, kept out of the
 * route so node tests can run it with an injected SSH client.
 *
 * WHY THE HOSTNAME ALLOWLIST. The route connects only to GATETEST_SSH_HOST —
 * never a body-chosen host, which would hand our SSH credentials to any
 * server. But the Forensic Scan tab called it after scanning ANY domain, so
 * "Fix Everything" on someone else's site ran sudo playbooks on OUR
 * production box and could come back "Server Healed". GATETEST_SSH_HOSTNAMES
 * names the public hostnames that box actually serves; a scan of anything
 * else never reaches SSH:
 *
 *   list unset / empty          → 409 { error: "target_not_configured" }
 *   hostname not in the list    → 409 { error: "target_mismatch" }
 *   in the list, dryRun: true   → 200 { allowed: true, hostname, ready, missing }
 *   in the list                 → connect to GATETEST_SSH_HOST, run playbooks
 *
 * No connection is opened in either 409 case, nor for a dry run, nor when no
 * playbook matches the issues.
 *
 * WHAT THE PLAYBOOKS MAY DO. Read-only diagnostics, plus a restart of the
 * app's own systemd units. Nothing starts, restarts, reloads, enables or
 * reconfigures caddy / nginx / apache, and nothing runs certbot: the
 * deployment doctrine (CLAUDE.md) gives ports 80/443, TLS and certificates to
 * the platform gateway and bans every other proxy on this box. The box is
 * shared, so nothing vacuums the journal or clears package caches either.
 *
 * A command that RAN is not an issue that is FIXED — the answer says "ran",
 * and the caller re-runs the scan to confirm.
 */

const MAX_ISSUES = 100;
const DEFAULT_TIMEOUT_MS = 15000;

/** `https://Example.com:443/x` / `example.com.` / ` EXAMPLE.com ` → `example.com`; junk → ''. */
function normaliseHostname(value) {
  let s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return '';
    }
  }
  s = s.replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(s) ? s : '';
}

/** GATETEST_SSH_HOSTNAMES (comma list) → normalised hostnames. */
function allowedHostnames(env) {
  return String((env && env.GATETEST_SSH_HOSTNAMES) || '')
    .split(',')
    .map(normaliseHostname)
    .filter(Boolean);
}

/**
 * Is `requested` a hostname the SSH box serves?
 * @returns {{ ok: true, hostname: string } | { ok: false, status: 409, body: object }}
 */
function resolveHealTarget(env, requested) {
  const allowed = allowedHostnames(env);
  if (allowed.length === 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'target_not_configured',
        reason: 'GATETEST_SSH_HOSTNAMES is not set, so no scanned hostname is known to be served by the SSH box. Nothing was run.',
      },
    };
  }
  const hostname = normaliseHostname(requested);
  if (!hostname || !allowed.includes(hostname)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'target_mismatch',
        hostname: hostname || null,
        reason: 'This hostname is not in GATETEST_SSH_HOSTNAMES — the SSH box does not serve it. Nothing was run.',
      },
    };
  }
  return { ok: true, hostname };
}

/** SSH connection settings — from the environment only, never the request. */
function sshSettings(env) {
  const e = env || {};
  const host = String(e.GATETEST_SSH_HOST || '').trim();
  const password = String(e.GATETEST_SSH_PASSWORD || '');
  const privateKey = String(e.GATETEST_SSH_KEY || '');
  const missing = [];
  if (!host) missing.push('GATETEST_SSH_HOST');
  if (!password && !privateKey) missing.push('GATETEST_SSH_PASSWORD or GATETEST_SSH_KEY');
  return {
    host,
    port: Number(e.GATETEST_SSH_PORT) || 22,
    username: String(e.GATETEST_SSH_USER || '').trim() || 'root',
    password,
    privateKey,
    missing,
  };
}

/**
 * A command that changes a proxy / web server or its certificates. The
 * playbooks must contain none (tests/heal-ssh-target.test.js).
 */
function isProxyMutation(cmd) {
  const c = String(cmd);
  return (
    /\bcertbot\b/i.test(c) ||
    /systemctl\s+(?:start|restart|reload|enable|reenable|disable|stop|mask)\s+(?:caddy|nginx|apache2|httpd)\b/i.test(c) ||
    /\b(?:caddy|nginx)\s+(?:-s\s+\w+|reload|start|stop)\b/i.test(c) ||
    (/\/etc\/(?:caddy|nginx|apache2|httpd)\//i.test(c) && /(?:sed\s+-i|>>?|\btee\b|\bcp\b|\bmv\b|\brm\b)/.test(c)) ||
    /\b(?:apt|apt-get|yum|dnf|snap)\s+(?:install|remove|purge)\b/i.test(c)
  );
}

/**
 * The playbooks. `svc` is the platform's systemd unit prefix
 * (platformServicePrefix()); vapron-* / crontech-* are fallbacks until the
 * box renames its units.
 */
// hardcoded-url-ok — localhost here is the TARGET remote server being
// diagnosed over SSH, not this application's own localhost.
function buildPlaybooks(svc) {
  const S = /^[a-z][a-z0-9-]*$/.test(String(svc || '')) ? svc : 'tallrig';
  const listeners = (ports) => `sudo ss -tlnp 2>&1 | grep -E '${ports}' | head -10 || echo 'nothing listening on ${ports}'`;
  const services = `sudo systemctl list-units --type=service --state=running 2>&1 | grep -E '${S}|vapron|crontech|gateway|caddy|nginx|node|bun|pm2|docker' | head -15`;
  return [
    {
      id: 'tls',
      match: (i) => i.category === 'SSL' || (i.title.toLowerCase().includes('ssl') && i.detail.includes('failed')),
      commands: [
        { label: 'What owns port 443 (TLS belongs to the platform gateway)', cmd: listeners(':443 ') },
        { label: 'Running services', cmd: services },
        { label: 'Verify HTTPS', cmd: 'curl -sI https://localhost -k 2>&1 | head -5' }, // hardcoded-url-ok
      ],
    },
    {
      id: 'port-443',
      match: (i) => i.title.includes('Port 443') && i.detail.includes('CLOSED'),
      commands: [
        { label: 'Listeners on 443 / 80 / app ports', cmd: listeners(':443|:80|:3000|:3001') },
        { label: 'Running services', cmd: services },
      ],
    },
    {
      id: 'port-80',
      match: (i) => i.title.includes('Port 80') && i.detail.includes('CLOSED'),
      commands: [
        { label: 'Listeners on 80', cmd: listeners(':80 ') },
        { label: 'Running services', cmd: services },
      ],
    },
    {
      id: 'compression',
      match: (i) => i.title.toLowerCase().includes('compression') && i.detail.toLowerCase().includes('disabled'),
      commands: [
        { label: 'Verify compression', cmd: "curl -sI -H 'Accept-Encoding: gzip' https://localhost -k 2>&1 | grep -i content-encoding || echo 'no content-encoding header'" }, // hardcoded-url-ok
      ],
    },
    {
      id: 'security-headers',
      match: (i) => i.title.toLowerCase().includes('hsts') || i.title.toLowerCase().includes('security header'),
      commands: [
        { label: 'Verify headers', cmd: "curl -sI https://localhost -k 2>&1 | grep -iE 'strict-transport|x-content-type|x-frame' || echo 'none of the checked headers present'" }, // hardcoded-url-ok
      ],
    },
    {
      id: 'disk',
      match: (i) => i.detail.toLowerCase().includes('disk') || i.title.toLowerCase().includes('disk'),
      commands: [
        { label: 'Disk usage', cmd: 'df -h / 2>&1' },
        { label: 'Largest log directories', cmd: 'sudo du -xh --max-depth=1 /var/log 2>/dev/null | sort -h | tail -5' },
      ],
    },
    {
      id: 'redirect',
      match: (i) => i.detail.toLowerCase().includes('http') && i.detail.toLowerCase().includes('redirect'),
      commands: [
        { label: 'Verify redirect', cmd: 'curl -sI http://localhost 2>&1 | head -5' }, // hardcoded-url-ok
      ],
    },
    {
      id: 'http',
      match: (i) => i.category === 'HTTP' && i.detail.includes('failed'),
      commands: [
        { label: 'Running services', cmd: services },
        { label: 'App ports', cmd: listeners(':3000|:3001|:8080|:443|:80') },
        { label: `${S} service logs`, cmd: `sudo journalctl -u ${S}-web -n 20 --no-pager 2>&1 || sudo journalctl -u ${S}-api -n 20 --no-pager 2>&1 || sudo journalctl -u vapron-web -n 20 --no-pager 2>&1 || sudo journalctl -u crontech-web -n 20 --no-pager 2>&1 || echo 'no ${S} services found'` },
        { label: `Restart the app's own ${S} units`, cmd: `sudo systemctl restart ${S}-web 2>&1 || sudo systemctl restart vapron-web 2>&1 || sudo systemctl restart crontech-web 2>&1 || true; sudo systemctl restart ${S}-api 2>&1 || sudo systemctl restart vapron-api 2>&1 || sudo systemctl restart crontech-api 2>&1 || true` },
        { label: 'Verify HTTP', cmd: 'curl -sI http://localhost:3000 2>&1 | head -3 || curl -sI http://localhost 2>&1 | head -3' }, // hardcoded-url-ok
      ],
    },
  ];
}

/** Keep only well-formed issues; every field a string. */
function cleanIssues(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((i) => i && typeof i === 'object')
    .slice(0, MAX_ISSUES)
    .map((i) => ({ category: String(i.category || ''), title: String(i.title || ''), detail: String(i.detail || '') }));
}

/** Issues → the commands to run (first matching playbook per issue) + the unmatched rest. */
function planActions(issues, playbooks) {
  const actions = [];
  const unmatched = [];
  for (const issue of issues) {
    const book = playbooks.find((p) => p.match(issue));
    if (!book) {
      unmatched.push(issue);
      continue;
    }
    for (const step of book.commands) {
      actions.push({ issue: `${issue.category}: ${issue.title}`, label: step.label, command: step.cmd, output: '', status: 'skipped' });
    }
  }
  return { actions, unmatched };
}

const describeIssue = (i) => `${i.category}: ${i.title} — ${i.detail}`;

/**
 * Run one heal request.
 *
 * @param {object} args
 * @param {Record<string,string|undefined>} args.env   process.env (or a test double)
 * @param {unknown} args.body                          the parsed request body (validated here)
 * @param {string} args.svc                            platformServicePrefix()
 * @param {(cfg: Record<string, unknown>) => Promise<{ exec(cmd: string, timeoutMs?: number): Promise<string>, end(): void }>} args.connect
 * @returns {Promise<{ status: number, body: object }>}
 */
async function runHeal({ env, body, svc, connect }) {
  const input = body && typeof body === 'object' ? body : {};
  const target = resolveHealTarget(env, input.hostname);
  if (!target.ok) return { status: target.status, body: target.body };

  const ssh = sshSettings(env);
  if (input.dryRun === true) {
    return { status: 200, body: { allowed: true, hostname: target.hostname, ready: ssh.missing.length === 0, missing: ssh.missing } };
  }
  if (ssh.missing.length > 0) {
    return { status: 400, body: { error: 'ssh_not_configured', missing: ssh.missing, reason: `Set ${ssh.missing.join(' and ')} in the server environment. Nothing was run.` } };
  }

  const issues = cleanIssues(input.issues);
  if (issues.length === 0) return { status: 400, body: { error: 'no_issues', reason: 'No issues to heal. Nothing was run.' } };

  const { actions, unmatched } = planActions(issues, buildPlaybooks(svc));
  if (actions.length === 0) {
    return {
      status: 200,
      body: {
        status: 'no_playbook', hostname: target.hostname, actionsRun: 0, ran: 0, failed: 0, actions: [],
        unmatchedIssues: unmatched.map(describeIssue),
        message: 'No heal playbook matches these issues. Nothing was run.',
      },
    };
  }

  const config = { host: ssh.host, port: ssh.port, username: ssh.username, readyTimeout: 10000 };
  if (ssh.privateKey) config.privateKey = ssh.privateKey.replace(/\\n/g, '\n');
  else config.password = ssh.password;

  let session;
  try {
    session = await connect(config);
  } catch (err) {
    return {
      status: 502,
      body: {
        error: 'ssh_connect_failed',
        reason: `SSH connection failed: ${err && err.message ? err.message : String(err)}. Nothing was run.`,
        hint: 'Check GATETEST_SSH_HOST, GATETEST_SSH_PORT, GATETEST_SSH_USER and the password or key.',
      },
    };
  }

  try {
    for (const action of actions) {
      try {
        action.output = await session.exec(action.command, DEFAULT_TIMEOUT_MS);
        action.status = 'ran';
      } catch (err) {
        action.output = err && err.message ? err.message : String(err);
        action.status = 'failed';
      }
    }
  } finally {
    try {
      session.end();
    } catch {
      // error-ok — a close failure after the commands ran changes nothing we report
    }
  }

  const ran = actions.filter((a) => a.status === 'ran').length;
  const failed = actions.filter((a) => a.status === 'failed').length;
  return {
    status: 200,
    body: {
      status: failed === 0 ? 'completed' : ran > 0 ? 'partial' : 'failed',
      hostname: target.hostname,
      host: ssh.host,
      actionsRun: actions.length,
      ran,
      failed,
      actions,
      unmatchedIssues: unmatched.map(describeIssue),
      message:
        `${ran} of ${actions.length} command${actions.length === 1 ? '' : 's'} ran on the server for ${target.hostname}` +
        (failed > 0 ? `, ${failed} failed` : '') +
        '. A command that ran is not proof an issue is fixed — re-run the scan to confirm.' +
        (unmatched.length > 0 ? ` ${unmatched.length} issue(s) have no playbook and need manual review.` : ''),
    },
  };
}

module.exports = {
  normaliseHostname,
  allowedHostnames,
  resolveHealTarget,
  sshSettings,
  isProxyMutation,
  buildPlaybooks,
  cleanIssues,
  planActions,
  runHeal,
};
