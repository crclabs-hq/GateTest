/**
 * Visual Regression Module — full-page screenshot diffing across deploys.
 *
 * Static analysis (TypeScript errors, lint, security) cannot see what a
 * page actually LOOKS like. A redesign that ships unreviewed, a CSS change
 * that breaks the mobile layout, a component that silently overrides
 * existing styles — none of that trips a syntax check. This module gives
 * GateTest eyes: it screenshots every configured route at desktop (1280px)
 * and mobile (390px) widths, diffs the pixels against a stored baseline,
 * and fails the gate when more than `threshold`% of pixels changed.
 *
 * Baselines are stored on disk (default `.gatetest/visual-baselines/`, or
 * an explicit `baselineDir` for callers who manage baselines outside the
 * scanned project — e.g. an external monitor snapshotting several
 * platforms into a shared directory tree). The first run for a route/
 * viewport pair always creates the baseline (info-level, never blocks).
 * Every run after that compares against it.
 *
 * On a failing diff, an optional Slack notification is sent: a bot-token
 * upload of a baseline|current|diff composite image when `slackBotToken`
 * + `slackChannel` are configured, or a text summary via
 * `slackWebhook` / `SLACK_WEBHOOK_URL` otherwise. Both are best-effort —
 * Slack delivery failures never fail the check itself (Forbidden #15:
 * errors are wrapped and logged, never bubbled to the user).
 *
 * Requires: Playwright (already an approved GateTest dependency — see
 * chaos.js / runtime-errors.js) + pixelmatch/pngjs (pure JS, no native
 * bindings). Gracefully degrades to an info-level skip when either is
 * unavailable or no target URL is configured.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const BaseModule = require('./base-module');
const { compareScreenshots, buildSideBySideComposite } = require('../core/visual-diff-engine');

const DEFAULT_VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const DEFAULT_THRESHOLD_PERCENT = 5;
const DEFAULT_WAIT_MS = 1000;
const DEFAULT_PIXEL_THRESHOLD = 0.1;

function slugifyRoute(route) {
  const cleaned = route.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!cleaned) return 'index';
  return cleaned.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
}

function safePlatformName(baseUrl) {
  try {
    return new URL(baseUrl).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown-platform';
  }
}

function resolvePlaywright() {
  try {
    return require('playwright');
  } catch {
    const candidates = [
      path.join(__dirname, '..', '..', 'website'),
      path.join(process.cwd(), 'website'),
    ];
    for (const fromDir of candidates) {
      try {
        const resolved = require.resolve('playwright', { paths: [fromDir] });
        return require(resolved);
      } catch { /* try next candidate */ }
    }
  }
  return null;
}

/** Post a Block-Kit text summary to a Slack Incoming Webhook. Best-effort. */
function postSlackWebhookText(webhookUrl, text) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(webhookUrl);
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    const body = JSON.stringify({ text });
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 }));
      },
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

/** Upload an image to a Slack channel via the bot-token files.upload API. Best-effort. */
function postSlackImageUpload({ token, channel, buffer, filename, title, initialComment }) {
  return new Promise((resolve) => {
    const boundary = `----gatetest${Date.now().toString(16)}`;
    const fields = { channels: channel, filename, title, initial_comment: initialComment };
    const parts = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!value) continue;
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`),
      );
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    const body = Buffer.concat(parts);

    const req = https.request(
      {
        hostname: 'slack.com',
        path: '/api/files.upload',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString());
            resolve({ ok: !!parsed.ok, error: parsed.error });
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        });
      },
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

class VisualRegressionModule extends BaseModule {
  constructor() {
    super('visualRegression', 'Visual Regression Screenshot Diffing');
  }

  async run(result, config) {
    const moduleCfg = config.getModuleConfig('visualRegression') || {};
    const baseUrl =
      process.env.GATETEST_VISUAL_URL ||
      moduleCfg.url ||
      config.get('explorer.url') ||
      config.get('liveCrawler.url') ||
      config.get('webUrl') ||
      config.get('wpUrl') ||
      config.get('targetUrl');

    if (!baseUrl) {
      result.addCheck('visual-regression:config', true, {
        severity: 'info',
        message:
          'No target URL configured — set GATETEST_VISUAL_URL or modules.visualRegression.url in .gatetest/config.json',
      });
      return;
    }

    const playwright = resolvePlaywright();
    if (!playwright) {
      result.addCheck('visual-regression:playwright-missing', true, {
        severity: 'info',
        message: 'Playwright not available in this environment — visual regression checks skipped.',
        suggestion: 'npm install playwright && npx playwright install chromium',
      });
      return;
    }

    const routes = Array.isArray(moduleCfg.routes) && moduleCfg.routes.length ? moduleCfg.routes : ['/'];
    const viewports =
      Array.isArray(moduleCfg.viewports) && moduleCfg.viewports.length ? moduleCfg.viewports : DEFAULT_VIEWPORTS;
    const threshold =
      typeof moduleCfg.threshold === 'number' ? moduleCfg.threshold : DEFAULT_THRESHOLD_PERCENT;
    const waitMs = typeof moduleCfg.waitMs === 'number' ? moduleCfg.waitMs : DEFAULT_WAIT_MS;
    const platform = moduleCfg.platform || safePlatformName(baseUrl);
    const baselineDir = moduleCfg.baselineDir || path.join(config.projectRoot, '.gatetest', 'visual-baselines');
    const maskSelectors = Array.isArray(moduleCfg.maskSelectors) ? moduleCfg.maskSelectors : [];

    let browser;
    try {
      browser = await playwright.chromium.launch({ headless: true, timeout: 15000 });
    } catch (err) {
      result.addCheck('visual-regression:browser-launch', true, {
        severity: 'info',
        message: `Browser launch failed (${err.message || err}) — environment likely lacks chromium binaries.`,
      });
      return;
    }

    try {
      for (const route of routes) {
        for (const viewport of viewports) {
          await this._checkRoute({
            browser,
            baseUrl,
            route,
            viewport,
            platform,
            baselineDir,
            threshold,
            waitMs,
            maskSelectors,
            moduleCfg,
            result,
          });
        }
      }
    } finally {
      try {
        await browser.close();
      } catch {
        /* swallow close errors */
      }
    }
  }

  async _captureScreenshot(browser, baseUrl, route, viewport, waitMs, maskSelectors) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      userAgent: 'GateTest/1.0 (+https://gatetest.ai/bot) VisualRegression',
    });
    const page = await context.newPage();
    try {
      const url = new URL(route, baseUrl).toString();
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      } catch {
        await page.goto(url, { waitUntil: 'load', timeout: 20000 });
      }
      if (maskSelectors.length) {
        const css = maskSelectors.map((sel) => `${sel}{visibility:hidden !important;}`).join('\n');
        await page.addStyleTag({ content: css }).catch(() => {});
      }
      await page.waitForTimeout(waitMs);
      return await page.screenshot({ fullPage: true });
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  async _checkRoute({ browser, baseUrl, route, viewport, platform, baselineDir, threshold, waitMs, maskSelectors, moduleCfg, result }) {
    const checkName = `visual-regression:${platform}:${viewport.name}:${route}`;
    const slug = slugifyRoute(route);
    const viewportDir = path.join(baselineDir, platform, viewport.name);
    const baselinePath = path.join(viewportDir, `${slug}.png`);
    const relBaselinePath = path.relative(process.cwd(), baselinePath);

    let currentBuffer;
    try {
      currentBuffer = await this._captureScreenshot(browser, baseUrl, route, viewport, waitMs, maskSelectors);
    } catch (err) {
      result.addCheck(checkName, false, {
        severity: 'warning',
        message: `Could not capture screenshot for ${route} (${viewport.name}): ${err.message || err}`,
      });
      return;
    }

    if (!fs.existsSync(baselinePath) || moduleCfg.updateBaseline) {
      fs.mkdirSync(viewportDir, { recursive: true });
      fs.writeFileSync(baselinePath, currentBuffer);
      result.addCheck(checkName, true, {
        severity: 'info',
        message: `Baseline ${moduleCfg.updateBaseline ? 'updated' : 'created'} for ${route} (${viewport.name})`,
        file: relBaselinePath,
      });
      return;
    }

    const baselineBuffer = fs.readFileSync(baselinePath);
    let diff;
    try {
      diff = compareScreenshots(baselineBuffer, currentBuffer, { pixelThreshold: DEFAULT_PIXEL_THRESHOLD });
    } catch (err) {
      result.addCheck(checkName, false, {
        severity: 'warning',
        message: `Could not diff screenshot for ${route} (${viewport.name}): ${err.message || err}`,
      });
      return;
    }

    const currentDir = path.join(viewportDir, 'current');
    const diffDir = path.join(viewportDir, 'diff');
    fs.mkdirSync(currentDir, { recursive: true });
    fs.mkdirSync(diffDir, { recursive: true });
    const currentPath = path.join(currentDir, `${slug}.png`);
    const diffPath = path.join(diffDir, `${slug}.png`);
    fs.writeFileSync(currentPath, currentBuffer);
    fs.writeFileSync(diffPath, diff.diffPngBuffer);

    const passed = diff.diffPercent <= threshold;
    const pct = diff.diffPercent.toFixed(2);

    result.addCheck(checkName, passed, {
      severity: passed ? 'info' : 'error',
      message: passed
        ? `Visual diff ${pct}% within ${threshold}% threshold on ${route} (${viewport.name})`
        : `Visual regression: ${pct}% of pixels changed on ${route} (${viewport.name}) — exceeds ${threshold}% threshold${diff.dimensionMismatch ? ' (page dimensions also changed)' : ''}`,
      file: relBaselinePath,
      diffPercent: diff.diffPercent,
      baselineFile: baselinePath,
      currentFile: currentPath,
      diffFile: diffPath,
      suggestion: passed
        ? undefined
        : 'Review the diff image. If this change is an intentional redesign, re-run with modules.visualRegression.updateBaseline=true to accept the new baseline.',
    });

    if (!passed) {
      await this._notifySlack({ platform, route, viewport, diffPercent: diff.diffPercent, threshold, baselineBuffer, currentBuffer, diffBuffer: diff.diffPngBuffer, moduleCfg }).catch(() => {});
    }
  }

  async _notifySlack({ platform, route, viewport, diffPercent, threshold, baselineBuffer, currentBuffer, diffBuffer, moduleCfg }) {
    const webhook = moduleCfg.slackWebhook || process.env.SLACK_WEBHOOK_URL;
    const botToken = moduleCfg.slackBotToken || process.env.SLACK_BOT_TOKEN;
    const channel = moduleCfg.slackChannel || process.env.SLACK_CHANNEL;
    if (!webhook && !botToken) return;

    const pct = diffPercent.toFixed(1);
    const summary = `:warning: Visual regression on *${platform}* — \`${route}\` (${viewport.name}): ${pct}% of pixels changed (threshold ${threshold}%).`;

    if (botToken && channel) {
      let composite;
      try {
        composite = buildSideBySideComposite(baselineBuffer, currentBuffer, diffBuffer);
      } catch {
        composite = null;
      }
      if (composite) {
        const upload = await postSlackImageUpload({
          token: botToken,
          channel,
          buffer: composite,
          filename: `${platform}-${slugifyRoute(route)}-${viewport.name}-diff.png`,
          title: `${platform} ${route} (${viewport.name}) — ${pct}% changed`,
          initialComment: summary,
        });
        if (upload.ok) return;
      }
    }

    if (webhook) {
      await postSlackWebhookText(webhook, summary);
    }
  }
}

module.exports = VisualRegressionModule;
