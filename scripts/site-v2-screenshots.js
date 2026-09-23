#!/usr/bin/env node
/**
 * site-v2-screenshots.js — bounded verification script for issue #686/#690.
 *
 * Builds the website, starts ONE `next start` server, waits for the port,
 * screenshots a fixed list of pages at 1440x900 and 375x812 in both the
 * light and dark theme (via Playwright's emulateMedia — this exercises the
 * globals.css `prefers-color-scheme` path added for #690), then kills the
 * server and exits. Never detaches, never backgrounds — this process owns
 * the server's whole lifetime and the `finally` block always kills it, even
 * on a thrown error, so a failed run cannot leave a listener behind.
 *
 * Usage (from repo root):
 *   node scripts/site-v2-screenshots.js [outDir] [--pages=/a,/b] [--port=4173]
 *
 * outDir defaults to a scratch directory outside the repo (screenshots are
 * verification artefacts, not something to commit).
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const WEBSITE = path.join(ROOT, 'website');

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 4173;
const OUT_DIR = process.argv[2] && !process.argv[2].startsWith('--')
  ? path.resolve(process.argv[2])
  : path.join(require('node:os').tmpdir(), 'gatetest-v2-screenshots');

const pagesArg = process.argv.find((a) => a.startsWith('--pages='));

// Default set: every page issue #690 explicitly asks for screenshots of,
// plus the #686 pages this branch has restyled so far. /admin is
// deliberately excluded — issue #691 owns admin theming, not this branch.
const DEFAULT_PAGES = [
  '/',
  '/pricing',
  '/developers',
  '/docs/configuration',
  '/playground',
  '/web',
  '/status',
  '/trust',
  '/changelog',
];

const PAGES = pagesArg ? pagesArg.split('=')[1].split(',') : DEFAULT_PAGES;

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '375', width: 375, height: 812 },
];

const THEMES = ['light', 'dark'];

function loadPlaywright() {
  const resolved = require.resolve('playwright', { paths: [WEBSITE] });
  return require(resolved);
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`port ${port} did not open within timeout`));
        else setTimeout(tryOnce, 500);
      });
      req.on('timeout', () => { req.destroy(); if (Date.now() > deadline) reject(new Error('timeout waiting for port')); else setTimeout(tryOnce, 500); });
    };
    tryOnce();
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Turbopack refuses to resolve through this worktree's junctioned
  // node_modules ("Symlink [...] points out of the filesystem root") —
  // the same issue noted in PR #625. --webpack builds cleanly; CI builds
  // with the default bundler on a real checkout, not a worktree junction.
  // stdio is captured (not 'inherit') and printed after the fact: piping
  // this script's own stdout through another process (e.g. `| tail`) was
  // observed to corrupt a Windows child's inherited pipe mid-build and
  // fail the build with no useful message. Buffering here is immune to
  // whatever the parent shell does with this process's own output.
  console.log(`[1/4] next build --webpack (cwd=${WEBSITE})`);
  const build = spawnSync('npx', ['next', 'build', '--webpack'], {
    cwd: WEBSITE,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  const buildOut = `${build.stdout || ''}\n${build.stderr || ''}`;
  console.log(buildOut.split('\n').slice(-120).join('\n'));
  if (build.status !== 0) {
    throw new Error(`next build failed (status=${build.status}, signal=${build.signal}, error=${build.error})`);
  }

  console.log(`[2/4] starting next start on port ${PORT}`);
  const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: WEBSITE,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: process.platform === 'win32',
  });
  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });
  server.stderr.on('data', (d) => { serverOutput += d.toString(); });

  try {
    console.log('[3/4] waiting for port...');
    await waitForPort(PORT, 60000);
    console.log('server is up');

    const { chromium } = loadPlaywright();
    const browser = await chromium.launch();
    try {
      const manifest = [];
      for (const pagePath of PAGES) {
        for (const theme of THEMES) {
          for (const vp of VIEWPORTS) {
            const context = await browser.newContext({
              viewport: { width: vp.width, height: vp.height },
              colorScheme: theme,
            });
            const page = await context.newPage();
            const url = `http://127.0.0.1:${PORT}${pagePath}`;
            const errors = [];
            page.on('pageerror', (e) => errors.push(String(e)));
            page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
            try {
              await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
              // Let any reveal-on-scroll / count-up animation settle so the
              // screenshot shows the resting state, not a mid-transition frame.
              await page.waitForTimeout(500);
              const safeName = pagePath === '/' ? 'home' : pagePath.replace(/^\//, '').replace(/\//g, '-');
              const fileName = `${safeName}.${theme}.${vp.name}.png`;
              const filePath = path.join(OUT_DIR, fileName);
              await page.screenshot({ path: filePath, fullPage: true });
              // Horizontal-scroll check at 375px — issue #686/#690's hard rule.
              const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
              const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
              const overflow = vp.name === '375' && scrollWidth > clientWidth + 1;
              manifest.push({
                page: pagePath, theme, viewport: vp.name, file: fileName,
                overflowX: overflow ? `${scrollWidth}px scrollWidth vs ${clientWidth}px clientWidth` : null,
                consoleErrors: errors,
              });
              console.log(`  ${overflow ? 'OVERFLOW ' : 'ok       '} ${pagePath} ${theme} ${vp.name}px -> ${fileName}${errors.length ? ` (${errors.length} console error(s))` : ''}`);
            } catch (err) {
              manifest.push({ page: pagePath, theme, viewport: vp.name, error: String(err) });
              console.log(`  FAILED   ${pagePath} ${theme} ${vp.name}px -> ${err}`);
            } finally {
              await context.close();
            }
          }
        }
      }
      fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
      console.log(`[4/4] wrote ${manifest.length} entries to ${path.join(OUT_DIR, 'manifest.json')}`);
      const failures = manifest.filter((m) => m.error || m.overflowX);
      if (failures.length > 0) {
        console.log(`\n${failures.length} problem(s):`);
        for (const f of failures) console.log(`  ${f.page} ${f.theme} ${f.viewport}: ${f.error || f.overflowX}`);
      }
    } finally {
      await browser.close();
    }
  } finally {
    console.log('[cleanup] stopping next start');
    server.kill();
    // On Windows, `npx next start` spawns a detached child process tree;
    // a plain kill() on the npx wrapper can leave `next-server` listening.
    // Give it a moment, then force-kill by port owner if still alive.
    await new Promise((r) => setTimeout(r, 1000));
    if (process.platform === 'win32') {
      try {
        const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
        const line = out.split('\n').find((l) => l.includes(`:${PORT}`) && l.includes('LISTENING'));
        const pid = line && line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) spawnSync('taskkill', ['/PID', pid, '/F', '/T']);
      } catch { /* best-effort cleanup */ }
    }
    if (serverOutput.includes('Error')) {
      console.log('--- server output (contained "Error") ---');
      console.log(serverOutput.slice(-4000));
    }
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
