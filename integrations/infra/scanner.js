// quality:file-length-ok — infra scanner is a single-file self-contained tool by design; splitting would break drop-in usage
/**
 * GateTest Infra Scanner — validates a live server's state against expected config.
 *
 * Given a target spec (YAML or JSON), SSHes to a host and verifies:
 *   - expected systemd services are `active (running)` (not failed / auto-restart)
 *   - expected ports are listening
 *   - expected directories / files exist with expected owner + group + mode
 *   - TLS certs on configured domains have > min_days until expiry
 *   - expected HTTP endpoints return the expected status (local probe + public probe)
 *   - disk free % above threshold
 *   - systemd restart counter below threshold (catches silent crash loops)
 *
 * READ-ONLY — never modifies the target host.
 *
 * Zero npm dependencies. Uses Node.js built-ins (https, tls, child_process)
 * and shells out to the system `ssh` client for transport. Matches the rest of
 * the GateTest engine ("no dependencies — runs anywhere").
 *
 * Inject a custom executor in the constructor for unit tests (see tests/infra/).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const tls = require('tls');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// YAML loader — minimal, enough for infra specs. Zero-dependency.
// Supports: scalars, quoted strings, lists ("- item"), nested maps via indent,
// inline flow arrays ([80, 443, 3000]), inline flow objects ({k: v}), comments.
// Not a general YAML engine; intentionally small + predictable.
// ---------------------------------------------------------------------------

function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  // Strip comments + blank lines, keep indent.
  const cleaned = [];
  for (const raw of lines) {
    const noComment = stripYamlComment(raw);
    if (noComment.trim() === '') continue;
    cleaned.push(noComment);
  }
  const [value] = parseYamlBlock(cleaned, 0, 0);
  return value;
}

function stripYamlComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '#' && !inSingle && !inDouble) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function indentOf(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

function parseYamlBlock(lines, startIdx, indent) {
  // Decide list vs map by peeking at the first sibling line.
  if (startIdx >= lines.length) return [null, startIdx];
  const first = lines[startIdx];
  if (indentOf(first) < indent) return [null, startIdx];
  const trimmed = first.slice(indent);
  if (trimmed.startsWith('- ') || trimmed === '-') {
    return parseYamlList(lines, startIdx, indent);
  }
  return parseYamlMap(lines, startIdx, indent);
}

function parseYamlMap(lines, startIdx, indent) {
  const result = {};
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      // Skip — shouldn't happen at this level; parent will have consumed.
      i++;
      continue;
    }
    const content = line.slice(indent);
    const colon = findMapColon(content);
    if (colon < 0) {
      // Treat as bare string; unlikely in well-formed specs.
      i++;
      continue;
    }
    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();
    if (rest !== '') {
      result[key] = parseYamlScalarOrFlow(rest);
      i++;
    } else {
      // Nested block starts on next line.
      const childIndent = i + 1 < lines.length ? indentOf(lines[i + 1]) : indent + 2;
      if (childIndent <= indent) {
        result[key] = null;
        i++;
      } else {
        const [value, nextIdx] = parseYamlBlock(lines, i + 1, childIndent);
        result[key] = value;
        i = nextIdx;
      }
    }
  }
  return [result, i];
}

function findMapColon(s) {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ':' && depth === 0) {
        const next = s[i + 1];
        if (next === undefined || next === ' ' || next === '\t') return i;
      }
    }
  }
  return -1;
}

function parseYamlList(lines, startIdx, indent) {
  const result = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      i++;
      continue;
    }
    const content = line.slice(indent);
    if (!content.startsWith('-')) break;
    const afterDash = content.slice(1).replace(/^\s*/, '');
    if (afterDash === '') {
      // Nested block under this dash.
      const childIndent = i + 1 < lines.length ? indentOf(lines[i + 1]) : indent + 2;
      if (childIndent <= indent) {
        result.push(null);
        i++;
      } else {
        const [value, nextIdx] = parseYamlBlock(lines, i + 1, childIndent);
        result.push(value);
        i = nextIdx;
      }
    } else {
      // The dash-line may itself be the first key of an inline map.
      const inlineColon = findMapColon(afterDash);
      if (inlineColon >= 0) {
        const firstKey = afterDash.slice(0, inlineColon).trim();
        const firstVal = afterDash.slice(inlineColon + 1).trim();
        const obj = {};
        if (firstVal !== '') {
          obj[firstKey] = parseYamlScalarOrFlow(firstVal);
        } else {
          obj[firstKey] = null;
        }
        // Subsequent lines at indent + 2 (relative to dash) extend the map.
        const contIndent = indent + (content.indexOf('-') + 2);
        let j = i + 1;
        while (j < lines.length) {
          const ln = lines[j];
          const ind = indentOf(ln);
          if (ind < contIndent) break;
          const txt = ln.slice(contIndent);
          const colon = findMapColon(txt);
          if (colon < 0) break;
          const k = txt.slice(0, colon).trim();
          const v = txt.slice(colon + 1).trim();
          if (v !== '') {
            obj[k] = parseYamlScalarOrFlow(v);
            j++;
          } else {
            const ci = j + 1 < lines.length ? indentOf(lines[j + 1]) : contIndent + 2;
            if (ci <= contIndent) {
              obj[k] = null;
              j++;
            } else {
              const [val, ni] = parseYamlBlock(lines, j + 1, ci);
              obj[k] = val;
              j = ni;
            }
          }
        }
        result.push(obj);
        i = j;
      } else {
        result.push(parseYamlScalarOrFlow(afterDash));
        i++;
      }
    }
  }
  return [result, i];
}

function parseYamlScalarOrFlow(raw) {
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    return splitFlow(s.slice(1, -1)).map(parseYamlScalarOrFlow);
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const obj = {};
    for (const pair of splitFlow(s.slice(1, -1))) {
      const colon = findMapColon(pair);
      if (colon < 0) continue;
      obj[pair.slice(0, colon).trim()] = parseYamlScalarOrFlow(pair.slice(colon + 1).trim());
    }
    return obj;
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function splitFlow(s) {
  const parts = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(buf.trim());
        buf = '';
        continue;
      }
    }
    buf += c;
  }
  if (buf.trim() !== '') parts.push(buf.trim());
  return parts;
}

// ---------------------------------------------------------------------------
// Spec loader
// ---------------------------------------------------------------------------

function loadSpec(filePath) {
  const resolved = path.resolve(filePath);
  const raw = fs.readFileSync(resolved, 'utf8');
  if (resolved.endsWith('.json')) {
    return JSON.parse(raw);
  }
  return parseYaml(raw);
}

// ---------------------------------------------------------------------------
// Auth-material redaction — scrubs anything that LOOKS like a secret from logs
// ---------------------------------------------------------------------------

const REDACT_PATTERNS = [
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, // PEM blocks
  /ghp_[A-Za-z0-9]{20,}/g,                                 // GitHub PAT
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glc_[A-Fa-f0-9]{64}/g,                                  // Gluecron
  /sk_(?:live|test)_[A-Za-z0-9]{20,}/g,                    // Stripe
  /AKIA[0-9A-Z]{16}/g,                                     // AWS
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,                         // Slack
  /Bearer\s+[A-Za-z0-9._-]+/gi,                            // Authorization: Bearer
  /password[=:]\s*\S+/gi,                                  // password=...
  /authorization:\s*\S+/gi,
];

function redact(value) {
  if (value == null) return value;
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  for (const pat of REDACT_PATTERNS) {
    s = s.replace(pat, '[REDACTED]');
  }
  return s;
}

// ---------------------------------------------------------------------------
// SSH executor — shells out to the system ssh client.
// Replaceable for tests via constructor injection.
// ---------------------------------------------------------------------------

function defaultSshExecutor(opts) {
  return function sshRun(cmd, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const sshArgs = [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `ConnectTimeout=${Math.max(5, Math.floor(timeoutMs / 2000))}`,
        '-o', 'PasswordAuthentication=no',
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=2',
      ];
      if (opts.keyPath) {
        sshArgs.push('-i', expandHome(opts.keyPath));
      }
      if (opts.port) {
        sshArgs.push('-p', String(opts.port));
      }
      sshArgs.push(`${opts.user}@${opts.host}`);
      sshArgs.push(cmd);
      const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({ stdout, stderr: `timed out after ${timeoutMs}ms`, code: -1 });
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 0 });
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: err.message, code: -1 });
      });
    });
  };
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return path.join(home, p.slice(1));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Local HTTP probe (public-side endpoint check)
// ---------------------------------------------------------------------------

function httpProbe(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    try {
      const client = url.startsWith('https') ? https : http;
      const req = client.request(url, {
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'GateTest-InfraScanner/1.0' },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: true, status: res.statusCode }));
        res.on('error', (err) => resolve({ ok: false, error: err.message }));
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve({ ok: false, error: 'timeout' });
      });
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

// ---------------------------------------------------------------------------
// TLS expiry probe
// ---------------------------------------------------------------------------

function tlsDaysToExpiry(domain, timeoutMs = 10000) {
  return new Promise((resolve) => {
    try {
      const socket = tls.connect({
        host: domain,
        port: 443,
        servername: domain,
        timeout: timeoutMs,
      }, () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) {
          socket.end();
          resolve({ ok: false, error: 'no certificate' });
          return;
        }
        const expiry = new Date(cert.valid_to);
        const days = Math.floor((expiry - Date.now()) / (1000 * 60 * 60 * 24));
        socket.end();
        resolve({ ok: true, days, validTo: cert.valid_to });
      });
      socket.on('error', (err) => resolve({ ok: false, error: err.message }));
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        resolve({ ok: false, error: 'timeout' });
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

class InfraScanner {
  /**
   * @param {object} opts
   * @param {function} [opts.sshExecutor] - (sshOpts) => (cmd, timeoutMs) => Promise<{stdout,stderr,code}>
   *                                         Override for tests; defaults to shelling out to `ssh`.
   * @param {function} [opts.httpProbe]   - (url, timeoutMs) => Promise<{ok, status?, error?}>
   * @param {function} [opts.tlsProbe]    - (domain, timeoutMs) => Promise<{ok, days?, validTo?, error?}>
   * @param {function} [opts.logger]      - (level, msg) => void. Auth material is redacted before logging.
   */
  constructor(opts = {}) {
    this.sshExecutorFactory = opts.sshExecutor || defaultSshExecutor;
    this.httpProbe = opts.httpProbe || httpProbe;
    this.tlsProbe = opts.tlsProbe || tlsDaysToExpiry;
    this.logger = opts.logger || (() => {});
  }

  log(level, msg) {
    this.logger(level, redact(msg));
  }

  /**
   * Run the full scan against a spec.
   * @param {object} spec - parsed target spec
   * @returns {Promise<object>} structured report
   */
  async scan(spec) {
    validateSpec(spec);

    const started = Date.now();
    const ssh = this.sshExecutorFactory({
      host: spec.host,
      user: spec.ssh_user,
      keyPath: spec.ssh_key_path,
      port: spec.ssh_port,
    });

    this.log('info', `infra-scan: target=${spec.ssh_user}@${spec.host}`);

    const sections = await Promise.all([
      this._checkServices(ssh, spec.services || []),
      this._checkPorts(ssh, spec.ports || []),
      this._checkPaths(ssh, spec.paths || []),
      this._checkCerts(spec.certs || []),
      this._checkEndpoints(ssh, spec.endpoints || []),
      this._checkDisk(ssh, spec.disk),
      this._checkCrashLoop(ssh, spec.services || [], spec.crash_loop),
    ]);

    const [services, ports, paths, certs, endpoints, disk, crashLoop] = sections;

    const report = {
      host: spec.host,
      user: spec.ssh_user,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - started,
      sections: { services, ports, paths, certs, endpoints, disk, crash_loop: crashLoop },
      summary: summarise(sections),
    };

    // Redact the serialised form once more as a belt-and-braces check.
    return JSON.parse(redact(JSON.stringify(report)));
  }

  async _checkServices(ssh, services) {
    const section = { name: 'services', status: 'passed', checks: [], issues: 0 };
    if (!services.length) return section;

    const results = await Promise.all(services.map(async (svc) => {
      const name = typeof svc === 'string' ? svc : svc.name;
      const expected = (typeof svc === 'object' && svc.state) || 'active';
      const cmd = `systemctl is-active ${shellEscape(name)} 2>&1; systemctl show ${shellEscape(name)} --property=SubState,ActiveState,NRestarts --value 2>&1`;
      const res = await ssh(cmd);
      const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      const activeState = (lines[0] || '').toLowerCase();
      const passed = activeState === expected.toLowerCase();
      return {
        service: name,
        expected,
        actual: activeState || 'unknown',
        raw: lines,
        ok: passed,
        detail: passed ? `pass: ${name} is ${activeState}` : `error: ${name} is ${activeState || 'unreachable'} (expected ${expected})`,
      };
    }));

    for (const r of results) {
      section.checks.push(r);
      if (!r.ok) section.issues++;
    }
    section.status = section.issues > 0 ? 'failed' : 'passed';
    return section;
  }

  async _checkPorts(ssh, ports) {
    const section = { name: 'ports', status: 'passed', checks: [], issues: 0 };
    if (!ports.length) return section;

    // One command for all ports — ss is present on every modern Linux.
    const cmd = 'ss -tlnH 2>/dev/null || netstat -tlnH 2>/dev/null || true';
    const res = await ssh(cmd);
    const listening = parseListeningPorts(res.stdout);

    for (const port of ports) {
      const p = typeof port === 'object' ? port.port : port;
      const ok = listening.has(Number(p));
      section.checks.push({
        port: Number(p),
        ok,
        detail: ok ? `pass: port ${p} listening` : `error: port ${p} NOT listening`,
      });
      if (!ok) section.issues++;
    }
    section.status = section.issues > 0 ? 'failed' : 'passed';
    return section;
  }

  async _checkPaths(ssh, paths) {
    const section = { name: 'paths', status: 'passed', checks: [], issues: 0 };
    if (!paths.length) return section;

    const results = await Promise.all(paths.map(async (entry) => {
      const target = entry.path;
      // stat --format gives us %U %G %a in a single call
      const cmd = `stat -c '%F|%U|%G|%a' ${shellEscape(target)} 2>&1`;
      const res = await ssh(cmd);
      const line = (res.stdout || '').trim().split('\n')[0] || '';
      if (!line.includes('|')) {
        return {
          path: target,
          ok: false,
          detail: `error: ${target} does not exist or is not readable`,
        };
      }
      const [, owner, group, modeStr] = line.split('|');
      const mode = modeStr.padStart(3, '0');
      const problems = [];
      if (entry.owner && owner !== entry.owner) {
        problems.push(`owner=${owner} expected=${entry.owner}`);
      }
      if (entry.group && group !== entry.group) {
        problems.push(`group=${group} expected=${entry.group}`);
      }
      if (entry.mode) {
        const want = String(entry.mode).padStart(3, '0');
        if (mode !== want) problems.push(`mode=${mode} expected=${want}`);
      }
      const ok = problems.length === 0;
      return {
        path: target,
        owner,
        group,
        mode,
        ok,
        detail: ok
          ? `pass: ${target} ${owner}:${group} ${mode}`
          : `error: ${target} ${problems.join(', ')}`,
      };
    }));

    for (const r of results) {
      section.checks.push(r);
      if (!r.ok) section.issues++;
    }
    section.status = section.issues > 0 ? 'failed' : 'passed';
    return section;
  }

  async _checkCerts(certs) {
    const section = { name: 'certs', status: 'passed', checks: [], issues: 0 };
    if (!certs.length) return section;

    const results = await Promise.all(certs.map(async (c) => {
      const domain = c.domain;
      const minDays = Number.isFinite(c.min_days) ? c.min_days : 14;
      const probe = await this.tlsProbe(domain);
      if (!probe.ok) {
        return {
          domain,
          ok: false,
          detail: `error: ${domain} TLS probe failed — ${probe.error}`,
        };
      }
      const ok = probe.days >= minDays;
      return {
        domain,
        days_remaining: probe.days,
        valid_to: probe.validTo,
        ok,
        detail: ok
          ? `pass: ${domain} valid for ${probe.days}d (min ${minDays})`
          : `error: ${domain} expires in ${probe.days}d (min ${minDays})`,
      };
    }));

    for (const r of results) {
      section.checks.push(r);
      if (!r.ok) section.issues++;
    }
    section.status = section.issues > 0 ? 'failed' : 'passed';
    return section;
  }

  async _checkEndpoints(ssh, endpoints) {
    const section = { name: 'endpoints', status: 'passed', checks: [], issues: 0 };
    if (!endpoints.length) return section;

    const results = await Promise.all(endpoints.map(async (ep) => {
      const url = ep.url;
      const expected = Number(ep.expect_status || 200);

      // Local probe — curl from the server itself (catches firewall-passthrough bugs
      // where the public URL works but the box can't reach its own service).
      const localCmd = `curl -k -s -o /dev/null -w '%{http_code}' --max-time 8 ${shellEscape(url)}`;
      const localRes = await ssh(localCmd);
      const localCode = parseInt((localRes.stdout || '').trim(), 10);
      const localOk = localCode === expected;

      // Public probe — from wherever the scanner is running.
      const pub = await this.httpProbe(url);
      const publicCode = pub.ok ? pub.status : null;
      const publicOk = publicCode === expected;

      const ok = localOk && publicOk;
      const detail = ok
        ? `pass: ${url} → ${expected} (local + public)`
        : `error: ${url} local=${localCode || 'fail'} public=${publicCode || pub.error || 'fail'} expected=${expected}`;
      return { url, expected, local_status: localCode || null, public_status: publicCode, ok, detail };
    }));

    for (const r of results) {
      section.checks.push(r);
      if (!r.ok) section.issues++;
    }
    section.status = section.issues > 0 ? 'failed' : 'passed';
    return section;
  }

  async _checkDisk(ssh, disk) {
    const section = { name: 'disk', status: 'passed', checks: [], issues: 0 };
    if (!disk) return section;

    const target = disk.path || '/';
    const minFreePct = Number.isFinite(disk.min_free_pct) ? disk.min_free_pct : 20;
    const cmd = `df -P ${shellEscape(target)} | tail -n 1`;
    const res = await ssh(cmd);
    const line = (res.stdout || '').trim();
    const cols = line.split(/\s+/);
    // cols: [filesystem, 1024-blocks, used, available, capacity%, mountpoint]
    if (cols.length < 5) {
      section.checks.push({ path: target, ok: false, detail: `error: unable to read df on ${target}` });
      section.issues++;
      section.status = 'failed';
      return section;
    }
    const usedPct = parseInt(cols[4].replace('%', ''), 10);
    const freePct = 100 - usedPct;
    const ok = freePct >= minFreePct;
    section.checks.push({
      path: target,
      free_pct: freePct,
      used_pct: usedPct,
      threshold_pct: minFreePct,
      ok,
      detail: ok
        ? `pass: ${target} ${freePct}% free (min ${minFreePct}%)`
        : `error: ${target} ${freePct}% free (below min ${minFreePct}%)`,
    });
    if (!ok) section.issues++;
    section.status = section.issues > 0 ? 'failed' : 'passed';
    return section;
  }

  async _checkCrashLoop(ssh, services, crashLoop) {
    const section = { name: 'crash_loop', status: 'passed', checks: [], issues: 0 };
    if (!services.length || !crashLoop) return section;

    const threshold = Number.isFinite(crashLoop.max_restarts_per_hour)
      ? crashLoop.max_restarts_per_hour
      : 10;

    const results = await Promise.all(services.map(async (svc) => {
      const name = typeof svc === 'string' ? svc : svc.name;
      // journalctl counts "Started" events in the last hour — matches systemd
      // restart behaviour for Restart=on-failure / always services and catches
      // silent crash loops that `is-active` misses (still shows "active" between
      // restarts on a loop).
      const cmd =
        `journalctl -u ${shellEscape(name)} --since '1 hour ago' --no-pager 2>/dev/null | ` +
        `grep -E 'Started |Starting ' | wc -l`;
      const res = await ssh(cmd);
      const count = parseInt((res.stdout || '0').trim(), 10) || 0;
      const ok = count <= threshold;
      return {
        service: name,
        restarts_last_hour: count,
        threshold,
        ok,
        detail: ok
          ? `pass: ${name} ${count} restart(s) in last hour (max ${threshold})`
          : `error: ${name} ${count} restarts in last hour — CRASH LOOP (max ${threshold})`,
      };
    }));

    for (const r of results) {
      section.checks.push(r);
      if (!r.ok) section.issues++;
    }
    section.status = section.issues > 0 ? 'failed' : 'passed';
    return section;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('infra-scanner: spec must be an object');
  }
  if (!spec.host || typeof spec.host !== 'string') {
    throw new Error('infra-scanner: spec.host is required');
  }
  if (!spec.ssh_user || typeof spec.ssh_user !== 'string') {
    throw new Error('infra-scanner: spec.ssh_user is required');
  }
}

function shellEscape(s) {
  // Single-quote escape for safe remote execution. Never build shell commands
  // from spec values without this.
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function parseListeningPorts(output) {
  const ports = new Set();
  for (const line of (output || '').split('\n')) {
    // Match ss output: "LISTEN 0 128 0.0.0.0:80 0.0.0.0:*"
    // Match netstat output: "tcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN"
    const m = line.match(/[:[](\d{1,5})\s/) || line.match(/:(\d{1,5})\s+[\d.:*]+\s+LISTEN/);
    if (m) {
      const port = parseInt(m[1], 10);
      if (port > 0 && port <= 65535) ports.add(port);
    }
  }
  return ports;
}

function summarise(sections) {
  let issues = 0;
  let checks = 0;
  const failing = [];
  for (const sec of sections) {
    issues += sec.issues || 0;
    checks += (sec.checks || []).length;
    if (sec.issues > 0) failing.push(sec.name);
  }
  return {
    total_checks: checks,
    total_issues: issues,
    passed: issues === 0,
    failing_sections: failing,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(argv) {
  const specPath = argv[2];
  if (!specPath) {
    process.stderr.write('usage: node integrations/infra/scanner.js <spec.yaml|spec.json>\n');
    process.exit(2);
  }
  const spec = loadSpec(specPath);
  const scanner = new InfraScanner({
    logger: (level, msg) => process.stderr.write(`[${level}] ${msg}\n`),
  });
  const report = await scanner.scan(spec);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.summary.passed ? 0 : 1);
}

if (require.main === module) {
  main(process.argv).catch((err) => {
    process.stderr.write(`infra-scanner: ${redact(err.message)}\n`);
    process.exit(1);
  });
}

module.exports = {
  InfraScanner,
  loadSpec,
  parseYaml,
  redact,
  parseListeningPorts,
  shellEscape,
  validateSpec,
};
