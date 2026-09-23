'use strict';
/**
 * SIGNED-IN ADMIN SMOKE TEST (issue #691, item 4).
 *
 * Builds the real website, starts it, logs in with a test password, then
 * requests every /admin/* page and every /api/admin/* "index" route (the
 * GET routes with no required parameters — a POST-only mutation route or
 * one that needs a query the operator would supply, like
 * /api/admin/hn-launch/poll?storyId=, isn't an "index" route and is out of
 * scope here) — so an unreachable page or a route that 500s fails CI
 * instead of being noticed by an operator first.
 *
 * PAGES are asserted strictly 200: none of them do server-side DB work (the
 * heavy lifting happens client-side, behind their own fetches), so a real
 * failure here is a real regression regardless of environment.
 *
 * API routes are asserted 200 OR 503 with a "not configured" body — never
 * 500+. This environment (and this repo's CI, which sets no DATABASE_URL —
 * see .github/workflows/ci.yml) has no live Postgres, and this codebase's
 * own convention (audit-log/route.ts's documented "DEGRADATION: If
 * DATABASE_URL is unset, returns 503" behaviour) treats a missing DB as a
 * graceful, reported degradation rather than a crash. Several routes were
 * fixed in this same change to follow that convention consistently
 * (compliance-status.ts, keys/route.ts, metrics/launch/route.ts,
 * stats/route.ts all threw/500'd on a missing DATABASE_URL before this).
 * A genuine 500 anywhere still fails the test.
 *
 * `github-profiles` uses a different auth scheme (X-Admin-Password header,
 * not the admin session cookie) — sent alongside the cookie on every
 * request so it authenticates either way without a special case.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const REPO = path.join(__dirname, '..', '..');
const WEBSITE = path.join(REPO, 'website');
const BUILD_TIMEOUT_MS = 300_000;
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

const TEST_PASSWORD = 'gatetest-smoke-691-' + Math.random().toString(36).slice(2);

const PAGES = [
  '/admin',
  '/admin/health',
  '/admin/triage',
  '/admin/compliance',
  '/admin/feedback',
  '/admin/learning',
  '/admin/pipeline-trace',
  '/admin/integrations/tallrig',
  '/admin/hn-launch',
];

// GET-capable, no-required-query "index" routes for each admin API area.
// Excluded deliberately: POST-only mutation routes (auth, triage,
// hn-launch/draft, seo/submit, triage/pipeline); hn-launch/poll (400s
// without a real HN storyId — not an index route); learning/cron
// (CRON_SECRET-bearer gated, not admin-cookie gated — a different contract).
const API_ROUTES = [
  '/api/admin/audit-log',
  '/api/admin/compliance',
  '/api/admin/feedback',
  '/api/admin/fleet-intelligence',
  '/api/admin/github-profiles',
  '/api/admin/health',
  '/api/admin/keys',
  '/api/admin/learning',
  '/api/admin/learning/refresh',
  '/api/admin/learning/trend',
  '/api/admin/platform-siblings',
  '/api/admin/platforms',
  '/api/admin/repos',
  '/api/admin/stats',
  '/api/admin/integrations/tallrig',
  '/api/admin/metrics/launch',
  '/api/admin/watchdog/briefing',
  '/api/admin/build-status',
  '/api/admin/overview',
];

let port;
let baseUrl;
let serverProc;
let cookie;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function waitForServer(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(url, { method: 'GET' });
      if (res.status < 500) return;
    } catch {
      // not up yet — error-ok, keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become ready within the deadline: ${url}`);
}

before(async () => {
  // Turbopack's build fails in a worktree because of the node_modules
  // junction — --webpack is the documented workaround (issue #691 brief).
  execFileSync('npx', ['next', 'build', '--webpack'], {
    cwd: WEBSITE,
    stdio: 'pipe',
    shell: true,
    timeout: BUILD_TIMEOUT_MS,
    // The build's own stdout (the full route listing) comfortably exceeds
    // execFileSync's 1MB default maxBuffer, which throws "Command failed"
    // with the exit code truncated away — a build that actually succeeded
    // was misreported as a failure this way the first time this test ran.
    maxBuffer: 1024 * 1024 * 64,
  });

  port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  serverProc = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: WEBSITE,
    shell: true,
    env: {
      ...process.env,
      GATETEST_ADMIN_PASSWORD: TEST_PASSWORD,
      NEXT_PUBLIC_BASE_URL: baseUrl,
      PORT: String(port),
    },
    stdio: 'pipe',
  });

  await waitForServer(baseUrl, Date.now() + START_TIMEOUT_MS);

  const loginRes = await fetchWithTimeout(`${baseUrl}/api/admin/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  assert.equal(loginRes.status, 200, 'signed-in smoke test could not log in');
  const setCookie = loginRes.headers.get('set-cookie') || '';
  cookie = setCookie.split(';')[0];
  assert.ok(cookie && cookie.includes('='), 'login did not return a session cookie');
});

after(() => {
  if (!serverProc || serverProc.killed) return;
  // `spawn(..., { shell: true })` on Windows makes `serverProc` the cmd.exe
  // wrapper, not the `next start` process it launches — killing just the
  // wrapper leaves the real server (and the port) alive, which then keeps
  // this file's event loop alive past its run-tests.js file timeout (the
  // very first run of this test measured that: 28/29 passed, the 29th
  // failure was "still running at the file timeout", not a real assertion).
  // `taskkill /T` kills the whole process tree; POSIX gets a plain kill.
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // error-ok — process may have already exited
    }
  } else {
    serverProc.kill('SIGKILL');
  }
});

function authedHeaders() {
  return {
    Cookie: cookie,
    // github-profiles/route.ts authenticates via this header instead of the
    // session cookie — sent unconditionally so one login covers every route.
    'X-Admin-Password': TEST_PASSWORD,
  };
}

describe('admin pages render when signed in', () => {
  for (const p of PAGES) {
    it(`GET ${p} → 200, no server error`, async () => {
      const res = await fetchWithTimeout(`${baseUrl}${p}`, { headers: authedHeaders() });
      assert.equal(res.status, 200, `${p} returned ${res.status}`);
      const body = await res.text();
      assert.ok(
        !/Application error: a (server-side|client-side) exception has occurred/i.test(body),
        `${p} rendered a Next.js error boundary`,
      );
    });
  }
});

describe('admin API index routes respond when signed in', () => {
  for (const route of API_ROUTES) {
    it(`GET ${route} → 200 or a documented 503, never a server error`, async () => {
      const res = await fetchWithTimeout(`${baseUrl}${route}`, { headers: authedHeaders() });
      if (res.status !== 200 && res.status !== 503) {
        const body = await res.text().catch(() => '');
        assert.fail(`${route} returned ${res.status}: ${body.slice(0, 300)}`);
      }
    });
  }
});
