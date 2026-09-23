#!/usr/bin/env node
'use strict';
/**
 * Admin screenshots — both themes, 1440px (issue #691, item 5).
 *
 * Bounded, one-shot: builds the website with `next build --webpack`
 * (Turbopack fails in a worktree because of the node_modules junction —
 * same reason the signed-in smoke test uses it, see
 * tests/heavy/admin-signed-in-smoke.test.js), starts it, signs in with a
 * throwaway admin password, screenshots every /admin/* page in light and
 * dark, then exits. Playwright is already a dev dependency (@playwright/test).
 *
 * Usage: node scripts/ops/admin-screenshots.js [--skip-build]
 *   --skip-build   reuse an existing website/.next (faster iteration)
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const REPO = path.join(__dirname, '..', '..');
const WEBSITE = path.join(REPO, 'website');
// `playwright` (via @playwright/test) is a website devDependency, not a
// root one — resolve it from there rather than adding a root dependency.
const { chromium } = require(path.join(WEBSITE, 'node_modules', 'playwright'));
const OUT_DIR = path.join(REPO, 'docs', 'screenshots', 'issue-691');
const BUILD_TIMEOUT_MS = 300_000;
const START_TIMEOUT_MS = 60_000;
const TEST_PASSWORD = 'gatetest-admin-screenshots-691';
const SKIP_BUILD = process.argv.includes('--skip-build');

const PAGES = [
  { path: '/admin', name: 'overview' },
  { path: '/admin/health', name: 'health' },
  { path: '/admin/triage', name: 'triage' },
  { path: '/admin/compliance', name: 'compliance' },
  { path: '/admin/feedback', name: 'feedback' },
  { path: '/admin/learning', name: 'learning' },
  { path: '/admin/pipeline-trace', name: 'pipeline-trace' },
  { path: '/admin/integrations/tallrig', name: 'integrations-tallrig' },
  { path: '/admin/hn-launch', name: 'launch' },
];

const THEMES = ['light', 'dark'];

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForServer(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become ready: ${url}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (!SKIP_BUILD) {
    console.log('Building website (next build --webpack)...');
    execFileSync('npx', ['next', 'build', '--webpack'], {
      cwd: WEBSITE,
      stdio: 'inherit',
      shell: true,
      timeout: BUILD_TIMEOUT_MS,
    });
  }

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Starting server on ${baseUrl} ...`);

  const server = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: WEBSITE,
    shell: true,
    env: { ...process.env, GATETEST_ADMIN_PASSWORD: TEST_PASSWORD, NEXT_PUBLIC_BASE_URL: baseUrl },
    stdio: 'inherit',
  });

  try {
    await waitForServer(baseUrl, Date.now() + START_TIMEOUT_MS);

    const loginRes = await fetch(`${baseUrl}/api/admin/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    if (!loginRes.ok) throw new Error(`login failed: HTTP ${loginRes.status}`);
    const setCookie = loginRes.headers.get('set-cookie') || '';
    const [cookieName, cookieRest] = setCookie.split(';')[0].split('=');
    if (!cookieName || cookieRest === undefined) throw new Error('login did not return a session cookie');

    const browser = await chromium.launch({ headless: true });

    for (const theme of THEMES) {
      console.log(`\n[${theme}]`);
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
      });
      await context.addCookies([
        { name: cookieName, value: cookieRest, domain: '127.0.0.1', path: '/' },
      ]);
      // Stamp the explicit choice BEFORE any page script runs, so the admin
      // pre-hydration script (getAdminThemeScript, app/admin/theme-script.ts)
      // applies it deterministically instead of following the OS preference.
      await context.addInitScript(
        (t) => {
          try {
            window.localStorage.setItem('gatetest-admin-theme', t);
          } catch {
            /* ignore */
          }
        },
        theme,
      );
      const page = await context.newPage();

      for (const p of PAGES) {
        try {
          await page.goto(`${baseUrl}${p.path}`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(500);
          const file = path.join(OUT_DIR, `${p.name}-${theme}-1440.png`);
          await page.screenshot({ path: file, fullPage: true });
          console.log(`  ✓ ${p.path} -> ${path.relative(REPO, file)}`);
        } catch (err) {
          console.error(`  ✗ ${p.path}: ${err.message}`);
        }
      }
      await context.close();
    }

    await browser.close();
  } finally {
    server.kill();
  }

  console.log(`\nDone. Screenshots in ${path.relative(REPO, OUT_DIR)}/`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
