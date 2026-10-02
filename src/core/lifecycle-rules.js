'use strict';

/**
 * Lifecycle rules — what happens to a running resource, and to the owner's
 * account state, outside the request that created it. Built against Tallrig's
 * bug corpus (scored by scripts/cross-test-score.js):
 *
 *   delete-without-teardown   a delete handler for an entity that runs
 *                             something (project, app, deployment, service,
 *                             worker, container, instance) whose only effect is
 *                             a DB DELETE — the process keeps running and the
 *                             dashboard says it is gone (TALLRIG-2026-029)
 *   stop-keeps-claim          the inverse: a handler stops the process
 *                             (`/undeploy`, `undeploy(`, `stopApp(`) and never
 *                             releases the port/host its row still claims, so
 *                             the router keeps sending traffic there and the
 *                             allocator hands it to the next tenant
 *                             (TALLRIG-2026-048)
 *   job-ignores-account-state a background job (tick / worker / queue consumer
 *                             / build runner) that picks up owned work and acts
 *                             on it without reading the owner's account state —
 *                             a suspension that lands while work waits never
 *                             stops it (TALLRIG-2026-023, -047)
 *
 * Warnings, on masked source. Pure: (relPath, content) → findings. Control
 * pairs in tests/lifecycle-rules.test.js.
 */

const { maskSource } = require('./source-strip');

const RUNNING_TABLE = '(?:projects?|apps?|applications?|deployments?|services?|workers?|containers?|instances?|sites?|functions?|machines?|servers?)';
const TEARDOWN_RE = /\b(?:undeploy\w*|Undeploy\w*|teardown\w*|Teardown\w*|stop\w*|Stop\w*|kill\w*|terminate\w*|destroy\w*|deprovision\w*|Deprovision\w*|shutdown\w*|removeRoute\w*|deleteRoute\w*)\s*\(|["'`]\/(?:undeploy|stop|destroy|teardown)\b/;
const STOP_CALL_RE = /["'`]\/undeploy\b|\b(?:undeploy|stopApp|stopProcess|killProcess|stopContainer|undeployApp)\w*\s*\(/;
// A claim word as a token or a camelCase segment — never inside `export` / `import` / `report`.
const CLAIM_RELEASE_RE = /\b(?:ports?|hostnames?|sockets?)\b|[a-z](?:Ports?|Hostnames?|Sockets?)(?:[A-Z_]|\b)|\b(?:release|Release|clearClaim|freeClaim)\w*/;
const OWNER_STATE_RE = /\b(?:suspend\w*|Suspend\w*|SUSPEND\w*|removed\w*|Removed\w*|REMOVED\w*|eligib\w*|Eligib\w*|\w*(?:ACTIVE|Active)\w*|accountBlock\w*|accountState\w*|ownerState\w*|blocked\w*|Blocked\w*|offboard\w*|Offboard\w*|disabled\w*|banned\w*)\b/;
const JOB_PATH_RE = /(?:^|\/)(?:jobs?|workers?|queues?|cron|schedul\w*|automation|tasks?|consumers?|runners?)(?:\/|\.[jt]sx?$)|(?:scheduler|worker|runner|consumer|cron|queue)[^/]*\.[jt]sx?$/i;
const JOB_FN_RE = /\b(?:async\s+)?function\s+(\w*(?:Tick|tick|Worker|worker|Consumer|consumer|Cron|cron|runBuild|runJob|processJob|processQueue|drain\w*|handleJob)\w*)\s*\(/;

/** [{ start, end, head }] for each function / procedure body in `masked`. */
function bodies(masked) {
  const out = [];
  const OPEN_RE = /\b(?:async\s+)?function\b[^(]*\(|\.mutation\s*\(\s*async\b|\b[A-Za-z_$][\w$]*\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{|\bconst\s+[A-Za-z_$][\w$]*\s*=\s*async\b/;
  for (let i = 0; i < masked.length; i += 1) {
    if (!OPEN_RE.test(masked[i])) continue;
    let depth = 0;
    let seen = false;
    for (let k = i; k < Math.min(masked.length, i + 200); k += 1) {
      for (const ch of masked[k]) {
        if (ch === '{') { depth += 1; seen = true; } else if (ch === '}') depth -= 1;
      }
      if (seen && depth <= 0) { out.push({ start: i, end: k, head: masked.slice(Math.max(0, i - 4), i + 1).join('\n') }); break; }
    }
  }
  // A fragment with no opener (a corpus snippet, a handler body) is one body.
  out.push({ start: 0, end: masked.length - 1, head: masked.slice(0, 4).join('\n') });
  return out;
}

function deleteWithoutTeardown(relPath, masked) {
  const findings = [];
  const delRe = new RegExp(`\\.delete\\(\\s*(${RUNNING_TABLE})\\s*\\)`);
  const seen = new Set();
  for (const { start, end, head } of bodies(masked)) {
    if (!/\bdelete\w*\s*[:=(]|\bremove\w*\s*[:=(]|\bdestroy\w*\s*[:=(]/i.test(head)) continue;
    const body = masked.slice(start, end + 1);
    const at = body.findIndex((l) => delRe.test(l));
    if (at < 0) continue;
    // Masking blanks string contents; a `"/undeploy"` route is read raw.
    if (TEARDOWN_RE.test(body.join('\n')) || TEARDOWN_RE.test(masked.raw.slice(start, end + 1).join('\n'))) continue;
    const line = start + at + 1;
    if (seen.has(line)) continue;
    seen.add(line);
    const table = body[at].match(delRe)[1];
    findings.push({
      rule: 'delete-without-teardown',
      line,
      severity: 'warning',
      message: `${relPath}:${line} deletes the \`${table}\` row with no teardown before it — whatever it was running (process, port, route) keeps running, and the caller is told it is gone`,
      suggestion: 'Stop the running resource first (undeploy / stop, confirmed from the runtime, not from our own 200), then delete the row; refuse the delete if the stop is not proven.',
    });
  }
  return findings;
}

function stopKeepsClaim(relPath, masked) {
  const findings = [];
  const seen = new Set();
  for (const { start, end } of bodies(masked)) {
    const body = masked.slice(start, end + 1);
    const raw = masked.raw.slice(start, end + 1);
    const at = raw.findIndex((l, j) => STOP_CALL_RE.test(l) && !/^\s*(?:\/\/|\*)/.test(body[j] === '' ? l : body[j] + l.slice(0, 0)) && body[j].trim() !== '');
    if (at < 0) continue;
    const text = body.join('\n');
    if (CLAIM_RELEASE_RE.test(text)) continue;
    // Only handlers whose job is the stop: the stop call is the last effect.
    const line = start + at + 1;
    if (seen.has(line)) continue;
    seen.add(line);
    findings.push({
      rule: 'stop-keeps-claim',
      line,
      severity: 'warning',
      message: `${relPath}:${line} stops a running app but never releases the port / host its row still claims — the router keeps sending that tenant's traffic there, and the allocator can hand the port to the next deploy`,
      suggestion: 'Release every claim the stopped resource held (port, hostname, socket) in the same handler, and read it back; a stop is not done while a row still points at the resource.',
    });
  }
  return findings;
}

function jobIgnoresAccountState(relPath, masked) {
  const findings = [];
  const pathIsJob = JOB_PATH_RE.test(relPath);
  const seen = new Set();
  for (const { start, end, head } of bodies(masked)) {
    const fn = (head.match(JOB_FN_RE) || [])[1];
    if (!fn && !pathIsJob) continue;
    const body = masked.slice(start, end + 1);
    const text = body.join('\n');
    // Owned work being picked up: a queued/pending/scheduled select, or the
    // owning project / tenant loaded for a job.
    const pick = body.findIndex((l) => /\beq\(\s*[\w$.]+\.status\s*,\s*["'`]\s*["'`]\s*\)|\bscheduledAt\b|\bloadProject\s*\(|\bload(?:Owner|Tenant|Account)\w*\s*\(|\.projectId\b/.test(l));
    if (pick < 0) continue;
    if (!fn && !/\b(?:select|from|loadProject)\b/.test(text)) continue;
    if (OWNER_STATE_RE.test(text)) continue;
    const line = start + pick + 1;
    if (seen.has(line)) continue;
    seen.add(line);
    findings.push({
      rule: 'job-ignores-account-state',
      line,
      severity: 'warning',
      message: `${relPath}:${line} a background job picks up owned work and acts on it without reading the owner's account state — a suspension or removal that lands while the work waits never stops it`,
      suggestion: 'Check the owner (user / tenant) in the consumer, between dequeue and the side effect, through the same shared eligibility predicate the request path uses — fail closed.',
    });
  }
  return findings.slice(0, 1);
}

function scanLifecycle(relPath, content) {
  const masked = maskSource(String(content), relPath).split(/\r?\n/);
  masked.raw = String(content).split(/\r?\n/);
  return [...deleteWithoutTeardown(relPath, masked), ...stopKeepsClaim(relPath, masked), ...jobIgnoresAccountState(relPath, masked)];
}

module.exports = { scanLifecycle, deleteWithoutTeardown, stopKeepsClaim, jobIgnoresAccountState };
