'use strict';

/**
 * Production readiness probe — proves the CUSTOMER JOURNEY works against a
 * live deployment, rather than proving the code compiles.
 *
 * WHY THIS EXISTS. On 2026-07-27/28 the test suite was green — 6,700+ tests
 * passing, website build clean, self-scan gate PASSED — while all of the
 * following were true in production:
 *
 *   * the deployment was 102 commits and one minor version stale
 *   * `/billing`, the self-serve Stripe portal, returned 404
 *   * `POST /api/watches/tick` returned 405, so the Continuous tier's
 *     scheduler silently did nothing
 *   * paid MCP customers received no API key, because the env var was
 *     stored under a typo'd name
 *
 * Not one of those is visible to a test suite. Every one is obvious to
 * something that asks the live site a question. "Tests pass" is not a
 * readiness signal; "a stranger can arrive, get value, pay, and get value
 * again, with no human involved" is.
 *
 * DESIGN RULES
 *   1. SIDE-EFFECT FREE. This runs on a schedule against production. It
 *      never completes a payment, never writes customer data, never mutates
 *      anything. Every step is a GET, a POST that we expect to be REJECTED
 *      (auth probes), or the free public scan of our OWN public repo —
 *      read-only, no third party's resources, no customer data. That last
 *      one was added 2026-08-16: see checkProductWorks() for why a probe
 *      that never runs the product cannot tell you the product works.
 *   2. NO SECRETS REQUIRED. Every check is unauthenticated, so it can run
 *      from CI or a laptop without handing credentials to a cron job.
 *   3. A step reports WHY, not just red. A failure that does not tell you
 *      what to do next is barely better than silence.
 *
 * Pure module: no I/O at import, `fetch` injected, so it is testable without
 * a network.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/** Severity of a failed step. `critical` fails the probe. */
const CRITICAL = 'critical';
const WARNING = 'warning';

/**
 * How old a production build may get before it is a defect rather than a
 * quiet week. Two days warns; a week is the point at which "we shipped that
 * fix" has become false without anyone noticing.
 */
const STALE_BUILD_WARN_DAYS = 2;
const STALE_BUILD_CRITICAL_DAYS = 7;

/** Our own public repo — the canary target. No third party is involved. */
const DEFAULT_CANARY_REPO = 'https://github.com/ccantynz-alt/GateTest';

/** Build age in days from an ISO timestamp, or null if unusable. */
function buildAgeDays(builtAt, now = Date.now()) {
  if (!builtAt) return null;
  const t = Date.parse(builtAt);
  if (Number.isNaN(t)) return null;
  return (now - t) / 86_400_000;
}

function ok(name, detail, extra = {}) {
  return { name, ok: true, detail, ...extra };
}
function fail(name, detail, severity, fix, extra = {}) {
  return { name, ok: false, detail, severity, fix, ...extra };
}

/**
 * One HTTP call with a timeout that never throws — a network blip must be a
 * reported step failure, not a crashed probe.
 */
async function request(fetchFn, url, { method = 'GET', timeoutMs = DEFAULT_TIMEOUT_MS, json = null } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const headers = { accept: 'application/json,text/html' };
    if (json) headers['content-type'] = 'application/json';
    const res = await fetchFn(url, {
      method,
      headers,
      body: json ? JSON.stringify(json) : undefined,
      signal: controller ? controller.signal : undefined,
    });
    let body = '';
    try { body = await res.text(); } catch { /* error-ok — body is optional */ }
    return { ok: true, status: res.status, body };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return { ok: false, status: 0, error: aborted ? `timeout after ${timeoutMs}ms` : (err && err.message) || 'network error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseJson(body) {
  try { return JSON.parse(body); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Is the deployed build the one we think it is?
 *
 * This is the single most valuable check here. The stale deploy went
 * unnoticed for 11 days and broke four customer-facing things at once; it is
 * invisible to every test and obvious to this one question.
 */
async function checkDeployFreshness(fetchFn, base, expectedCommit) {
  const r = await request(fetchFn, `${base}/api/platform-status`);
  if (!r.ok) return fail('deploy/reachable', `/api/platform-status unreachable: ${r.error}`, CRITICAL, 'Is the site up? Check the host and DNS.');
  if (r.status !== 200) return fail('deploy/reachable', `/api/platform-status returned HTTP ${r.status}`, CRITICAL, 'The app is not serving. Check the process and the reverse proxy.');

  const data = parseJson(r.body);
  if (!data) return fail('deploy/reachable', '/api/platform-status returned non-JSON', CRITICAL, 'Something other than the app is answering — check the proxy.');

  const commit = String(data.commit || '');
  if (!commit || commit === 'unknown') {
    return fail(
      'deploy/stamped', `commit reports "${commit || 'missing'}"`, CRITICAL,
      'Build with `npm run build` (the prebuild step stamps the git SHA), or set GIT_COMMIT in the build env. Without this you cannot tell a fresh deploy from a stale one.',
      { commit },
    );
  }
  if (expectedCommit && !commit.startsWith(expectedCommit) && !expectedCommit.startsWith(commit)) {
    return fail(
      'deploy/fresh', `live commit ${commit.slice(0, 12)} != expected ${expectedCommit.slice(0, 12)}`, CRITICAL,
      'The deploy did not take. Redeploy before trusting anything else in this report — every check below is measuring the OLD build.',
      { commit, expectedCommit },
    );
  }
  // A commit stamp only proves we can TELL fresh from stale — it does not
  // prove fresh. On 2026-08-16 this step printed a green "deploy/fresh" for a
  // build that was ten days old, because it only asserted the stamp existed.
  // A check named "fresh" that passes a stale deploy is worse than no check:
  // it answers the question the reader actually asked, wrongly.
  //
  // Scheduled runs still must not demand an exact HEAD match (main moves
  // ahead of production between deploys, and a job that is red by design
  // trains everyone to ignore it) — but age is not a matter of opinion. A
  // build older than the ceiling means deploys have stopped reaching
  // production, which is exactly the failure that hid for eleven days once
  // and ten days again.
  const age = buildAgeDays(data.builtAt);
  if (age !== null && age >= STALE_BUILD_CRITICAL_DAYS) {
    return fail(
      'deploy/fresh', `live build is ${age.toFixed(1)} days old (commit ${commit.slice(0, 12)}, built ${data.builtAt})`, CRITICAL,
      'Deploys have stopped reaching production. Check that BOX_SSH_KEY / BOX_SSH_HOST are set on the repo so .github/workflows/deploy-box.yml can actually ship, then compare /api/platform-status `commit` against `git rev-parse HEAD`.',
      { commit, ageDays: age },
    );
  }
  if (age !== null && age >= STALE_BUILD_WARN_DAYS) {
    return fail(
      'deploy/fresh', `live build is ${age.toFixed(1)} days old (commit ${commit.slice(0, 12)})`, WARNING,
      'Not yet critical, but nothing has shipped in a while — confirm that is deliberate and not a broken deploy path.',
      { commit, ageDays: age },
    );
  }
  const agePart = age === null ? '' : `, ${age.toFixed(1)}d old`;
  return ok('deploy/fresh', `commit ${commit.slice(0, 12)}${data.version ? ` (v${data.version})` : ''}${agePart}`, { commit, ageDays: age });
}

/** Is the deployment actually configured, by its own account? */
async function checkConfig(fetchFn, base) {
  const r = await request(fetchFn, `${base}/api/status`);
  if (!r.ok || r.status !== 200) {
    return [fail('config/reachable', `/api/status ${r.ok ? `HTTP ${r.status}` : r.error}`, CRITICAL, 'The status endpoint is the deployment self-report. If it is down, treat everything else as unknown.')];
  }
  const data = parseJson(r.body);
  if (!data) return [fail('config/reachable', '/api/status returned non-JSON', CRITICAL, 'Check the proxy.')];

  const steps = [];
  const missingRequired = Array.isArray(data.missing_required) ? data.missing_required : [];
  const missingImportant = Array.isArray(data.missing_important) ? data.missing_important : [];

  steps.push(missingRequired.length === 0
    ? ok('config/required', 'all required env vars set')
    : fail('config/required', `missing: ${missingRequired.map((m) => m.name || m).join(', ')}`, CRITICAL,
      'The site returns 503 until these are set. Set them on the host and restart.'));

  // "Important" means a paid feature silently degrades — which is worse than
  // an outage, because nobody notices while money still changes hands.
  steps.push(missingImportant.length === 0
    ? ok('config/important', 'all important env vars set')
    : fail('config/important', `missing: ${missingImportant.map((m) => m.name || m).join(', ')}`, CRITICAL,
      'These do not break the site, they break a feature a customer has PAID for, silently. Treat as critical.'));

  // A SET-BUT-WRONG secret is invisible to every "missing" list — the var is
  // present, so `missing_required` is empty and `config/required` goes green.
  // /api/status has reported GATETEST_PRIVATE_KEY under `invalid_placeholders`
  // (the pasted documentation example, not the real .pem) since 2026-08-06,
  // and this probe read straight past it for ten days while printing "all
  // required env vars set". scripts/marketplace-preflight.js already read this
  // field; the two disagreed about whether production was configured, and the
  // one running every 30 minutes was the one that was wrong.
  const placeholders = Array.isArray(data.invalid_placeholders) ? data.invalid_placeholders : [];
  steps.push(placeholders.length === 0
    ? ok('config/placeholders', 'no documentation filler in live secrets')
    : fail('config/placeholders',
      `documentation filler: ${placeholders.map((p) => p.name || p).join(', ')}`, CRITICAL,
      'The variable is SET but holds the example value from the docs, so every call it authenticates fails. Replace it with the real secret on the host and restart. GATETEST_PRIVATE_KEY in this state means GitHub App auth is dead: no commit statuses, no PR comments, and no repo reads.'));

  return steps;
}

/**
 * Surfaces a paying customer needs. A 404 here is exactly the shape the
 * stale deploy took: the code existed, the deployment did not have it.
 */
async function checkCustomerSurfaces(fetchFn, base, surfaces) {
  const steps = [];
  for (const s of surfaces) {
    const r = await request(fetchFn, `${base}${s.path}`);
    if (!r.ok) {
      steps.push(fail(`surface${s.path}`, r.error, s.severity || CRITICAL, `${s.why} — the page is unreachable.`));
      continue;
    }
    if (r.status === 404) {
      steps.push(fail(`surface${s.path}`, 'HTTP 404', s.severity || CRITICAL,
        `${s.why} This is what a stale deploy looks like: the route exists in the repo but not in the running build.`));
      continue;
    }
    if (r.status >= 400) {
      steps.push(fail(`surface${s.path}`, `HTTP ${r.status}`, s.severity || CRITICAL, s.why));
      continue;
    }
    // A 200 is not the same as "the page still does its job" — a route can
    // survive a refactor with its content gutted.
    if (s.content && !String(r.body || '').includes(s.content)) {
      steps.push(fail(`surface${s.path}`, `HTTP 200 but missing ${s.content}`, s.severity || CRITICAL, s.contentWhy || s.why));
      continue;
    }
    steps.push(ok(`surface${s.path}`, `HTTP ${r.status}${s.content ? ` (contains ${s.content})` : ''}`));
  }
  return steps;
}

/**
 * Scheduler endpoints must accept BOTH methods and must be authenticated.
 *
 * Two distinct past failures, both silent: `/api/watches/tick` was GET-only
 * so every POST scheduler got a 405 while reporting success; and an older
 * build failed OPEN when CRON_SECRET was unset, leaving the worker publicly
 * triggerable. A 401/403 is the PASS here — 405 means the scheduler is
 * broken, 200 means it is unauthenticated.
 */
async function checkSchedulerEndpoints(fetchFn, base, paths) {
  const steps = [];
  for (const p of paths) {
    for (const method of ['GET', 'POST']) {
      const r = await request(fetchFn, `${base}${p}`, { method });
      const name = `cron${p}[${method}]`;
      if (!r.ok) { steps.push(fail(name, r.error, CRITICAL, 'Endpoint unreachable.')); continue; }
      if (r.status === 405) {
        steps.push(fail(name, 'HTTP 405 Method Not Allowed', CRITICAL,
          `Any scheduler using ${method} silently fails while reporting success. Both methods must be accepted.`));
        continue;
      }
      if (r.status === 200) {
        // Two very different causes, and the probe cannot tell them apart
        // from outside — so say both rather than assert the scarier one.
        // The first draft claimed "publicly triggerable"; the actual cause
        // on /api/scan/worker/tick was a GET handler that returned a
        // self-documenting blob and did no work. Both are real problems,
        // but reporting the wrong one sends the reader down the wrong path.
        steps.push(fail(name, 'HTTP 200 without credentials', CRITICAL,
          `Either this endpoint is publicly triggerable (it must require Authorization: Bearer $CRON_SECRET and fail CLOSED when unset), `
          + `or ${method} is a documentation stub that does no work — in which case a ${method}-based scheduler reports success while nothing runs. `
          + 'Check the handler: a 200 here is the one status nobody investigates.'));
        continue;
      }
      steps.push(ok(name, `HTTP ${r.status} (rejected unauthenticated, as it should)`));
    }
  }
  return steps;
}

/**
 * Does the product actually DO ITS JOB?
 *
 * Every other check here asks whether a page loads or a variable is set. None
 * of them run the product. On 2026-08-16 all of them were green while the free
 * scan — the top of the entire funnel — returned "appears to be empty or
 * unreachable" for expressjs/express, vercel/next.js and every other repo on
 * earth, because production's GitHub credential was a placeholder returning
 * 401. A visitor was told THEIR repo was broken. That had been true for ten
 * days, through roughly 480 runs of this probe, and this probe reported the
 * site 10/11 healthy the whole time.
 *
 * A monitor that never exercises the product cannot tell you the product
 * works. This step is the difference between "the site is up" and "the site
 * is useful", and they are not the same claim.
 *
 * Read-only and free: it scans our own public repo through the same public
 * endpoint a stranger uses. No third party's resources, no payment, no
 * customer data, no credentials.
 */
async function checkProductWorks(fetchFn, base, repoUrl) {
  const name = 'product/scan';
  const r = await request(fetchFn, `${base}/api/scan/preview`, {
    method: 'POST',
    json: { repoUrl },
    // A real scan does real work — the 10s default would report our own
    // impatience as an outage.
    timeoutMs: 45_000,
  });

  if (!r.ok) return fail(name, `free scan unreachable: ${r.error}`, CRITICAL, 'The free preview is the top of the funnel. If it does not answer, no visitor can ever become a customer.');

  const data = parseJson(r.body);
  if (r.status === 429 || (data && typeof data.error === 'string' && /rate limit/i.test(data.error))) {
    // Self-inflicted and not a product defect — say so rather than crying wolf.
    return ok(name, 'rate-limited (probe ran too soon after the last one) — not a product failure');
  }
  if (r.status !== 200 || !data) {
    const why = data && data.error ? data.error : `HTTP ${r.status}`;
    return fail(name, `free scan failed: ${why}`, CRITICAL,
      'Run it yourself: POST /api/scan/preview {"repoUrl":"' + repoUrl + '"}. If it reports the repo is empty or unreachable, check config/placeholders above — a dead GitHub credential surfaces here as a lie about the customer\'s repository.',
      { status: r.status, body: String(r.body || '').slice(0, 300) });
  }
  if (data.ok === false) {
    return fail(name, `free scan returned an error: ${data.error || 'unspecified'}`, CRITICAL,
      'The endpoint answered but refused to scan a known-good public repo. This is the exact shape of the 2026-08-16 outage.',
      { body: String(r.body || '').slice(0, 300) });
  }

  // Answered 200 but found nothing in a repo we know has findings — that is
  // an empty scan dressed as a successful one, which is the failure mode a
  // naive "did it return 200" check would wave through.
  // /api/scan/preview answers { moduleSummary: [...], findings: [...], total }
  // — not { modules, filesScanned }. Reading only the latter made a HEALTHY
  // funnel read as "scanned nothing" the moment it came back (2026-08-18).
  const moduleCount = Array.isArray(data.modules) ? data.modules.length
    : Array.isArray(data.moduleSummary) ? data.moduleSummary.length : 0;
  const fileCount = Number(data.filesScanned || data.files || 0);
  const findingCount = Array.isArray(data.findings) ? data.findings.length : Number(data.total || 0);
  if (moduleCount === 0 && fileCount === 0 && findingCount > 0) {
    return ok(name, `free scan works (${findingCount} finding(s))`);
  }
  if (moduleCount === 0 && fileCount === 0) {
    return fail(name, 'free scan returned 200 but scanned nothing (no modules, no files)', CRITICAL,
      'A scan that reads zero files is a failure wearing a success status code. Check that the git host credential can read the tree.',
      { body: String(r.body || '').slice(0, 300) });
  }
  return ok(name, `free scan works (${moduleCount} module result(s)${fileCount ? `, ${fileCount} files` : ''})`);
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * NOT a guess at what "should" exist — every entry was checked against the
 * repo. The first draft of this list included `/pricing`, which 404s in
 * production and looked like more stale-deploy damage. It is not: pricing is
 * an anchor on the home page (`/#pricing`, rendered by components/Pricing.tsx)
 * and `website/app/pricing/` has never existed. That was a bug in the PROBE.
 *
 * Worth stating plainly, because a monitor that cries wolf gets muted, and a
 * muted monitor is worse than none. Anything added here must be verified to
 * exist at HEAD first — see the `content` check below for surfaces that are
 * sections rather than routes.
 */
const DEFAULT_SURFACES = [
  { path: '/', why: 'The front door.', content: 'id="pricing"', contentWhy: 'Pricing is a section on the home page, not a route. If the anchor is gone, nobody can see what anything costs.' },
  { path: '/billing', why: 'Self-serve subscription management. Without it every cancellation becomes a support email, then a dispute.' },
  { path: '/checkout', why: 'The payment entry point.' },
  { path: '/mcp', why: 'The $29/mo tier landing page.' },
];

const DEFAULT_CRON_PATHS = ['/api/watches/tick', '/api/scan/worker/tick'];

/**
 * Run the probe.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} [opts.expectedCommit] — usually `git rev-parse HEAD` of main
 * @param {Function} [opts.fetchFn]
 * @param {Array}  [opts.surfaces]
 * @param {Array}  [opts.cronPaths]
 * @returns {Promise<{ready: boolean, steps: Array, failures: Array, summary: object}>}
 */
async function runReadinessProbe(opts = {}) {
  const base = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('runReadinessProbe: baseUrl is required');
  const fetchFn = opts.fetchFn || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) throw new Error('runReadinessProbe: no fetch available');

  const steps = [];
  steps.push(await checkDeployFreshness(fetchFn, base, opts.expectedCommit));
  steps.push(...await checkConfig(fetchFn, base));
  steps.push(...await checkCustomerSurfaces(fetchFn, base, opts.surfaces || DEFAULT_SURFACES));
  steps.push(...await checkSchedulerEndpoints(fetchFn, base, opts.cronPaths || DEFAULT_CRON_PATHS));
  if (opts.skipProductCheck !== true) {
    steps.push(await checkProductWorks(fetchFn, base, opts.canaryRepo || DEFAULT_CANARY_REPO));
  }

  const failures = steps.filter((s) => !s.ok);
  const critical = failures.filter((s) => s.severity === CRITICAL);
  return {
    ready: critical.length === 0,
    steps,
    failures,
    summary: {
      total: steps.length,
      passed: steps.length - failures.length,
      failed: failures.length,
      critical: critical.length,
      warnings: failures.length - critical.length,
      // The headline. This probe has sat red for 100 consecutive runs over
      // missing env vars, and a permanently-red alarm is one nobody can read
      // a NEW failure out of. Splitting "the product does not work" from
      // "something is misconfigured" keeps the first legible while the
      // second is still outstanding — they need different people and
      // different urgency.
      productBroken: failures.some((s) => s.name.startsWith('product/') && s.severity === CRITICAL),
      brokenAreas: [...new Set(critical.map((s) => s.name.split('/')[0]))].sort(),
    },
  };
}

module.exports = {
  runReadinessProbe,
  DEFAULT_SURFACES,
  DEFAULT_CRON_PATHS,
  DEFAULT_CANARY_REPO,
  STALE_BUILD_WARN_DAYS,
  STALE_BUILD_CRITICAL_DAYS,
  buildAgeDays,
  CRITICAL,
  WARNING,
  // exposed for tests
  _checkDeployFreshness: checkDeployFreshness,
  _checkConfig: checkConfig,
  _checkCustomerSurfaces: checkCustomerSurfaces,
  _checkSchedulerEndpoints: checkSchedulerEndpoints,
  _checkProductWorks: checkProductWorks,
};
