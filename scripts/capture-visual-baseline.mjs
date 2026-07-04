#!/usr/bin/env node
/**
 * Capture visual baselines for gatetest.ai — desktop + mobile full-page.
 * Saves to /opt/jarvis/visual-baselines/gatetest/{desktop,mobile}/
 * Then runs a diff pass to compare vs any existing baseline.
 *
 * Usage: node scripts/capture-visual-baseline.mjs [--diff-only]
 */

import { chromium, devices } from 'playwright';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const TARGET_URL   = process.env.TARGET_URL   || 'https://gatetest.ai';
const BASELINE_DIR = process.env.BASELINE_DIR || '/opt/jarvis/visual-baselines/gatetest';
const DIFF_ONLY    = process.argv.includes('--diff-only');

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900, device: null },
  { name: 'mobile',  width: 390,  height: 844, device: 'iPhone 14' },
];

const ROUTES = [
  { slug: 'homepage', path: '/' },
];

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function captureRoute(page, route, viewportName) {
  const url = TARGET_URL + route.path;
  console.log(`  → navigating to ${url} (${viewportName})`);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  // Wait for animations to settle
  await page.waitForTimeout(2000);

  // Collect console errors and warnings
  const consoleMessages = [];
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleMessages.push({ type: msg.type(), text: msg.text() });
    }
  });

  // Collect page title and key text
  const pageInfo = await page.evaluate(() => ({
    title: document.title,
    h1: document.querySelector('h1')?.innerText?.trim(),
    navLinks: Array.from(document.querySelectorAll('nav a')).map(a => ({
      text: a.innerText.trim(),
      href: a.href,
    })).filter(a => a.text),
    ctaButtons: Array.from(document.querySelectorAll('button, a[class*="btn"], a[href*="pricing"], a[href*="checkout"]'))
      .map(el => ({ tag: el.tagName, text: el.innerText?.trim(), href: el.href || null }))
      .filter(el => el.text && el.text.length < 80)
      .slice(0, 12),
    hasHeroSection: !!document.querySelector('section, [class*="hero"]'),
    hasPricingSection: !!document.querySelector('[id*="pricing"], [class*="pricing"]'),
    visibleText: document.body.innerText.slice(0, 2000),
    statusBadgeText: document.querySelector('[class*="badge"], [class*="pill"], [class*="status"]')?.innerText?.trim(),
    moduleCount: document.body.innerText.match(/(\d+)\s*(modules?)/i)?.[0],
    pricingMentions: document.body.innerText.match(/\$\d+[^$\n]{0,40}/g)?.slice(0, 8),
    formInputs: Array.from(document.querySelectorAll('input[type="text"], input[type="url"], input[placeholder]'))
      .map(el => ({ type: el.type, placeholder: el.placeholder }))
      .slice(0, 5),
  }));

  // Full-page screenshot
  const screenshotPath = join(BASELINE_DIR, viewportName, `${route.slug}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`  ✓ saved ${screenshotPath}`);

  // Also get viewport-only (above-the-fold)
  const aboveFoldPath = join(BASELINE_DIR, viewportName, `${route.slug}-above-fold.png`);
  await page.screenshot({ path: aboveFoldPath, fullPage: false });
  console.log(`  ✓ saved ${aboveFoldPath} (above fold)`);

  return { route, viewportName, pageInfo, screenshotPath, consoleErrors: consoleMessages };
}

async function main() {
  console.log(`\n=== GateTest Visual Baseline Capture ===`);
  console.log(`Target:   ${TARGET_URL}`);
  console.log(`Baseline: ${BASELINE_DIR}`);
  console.log(`Mode:     ${DIFF_ONLY ? 'DIFF ONLY (no baseline update)' : 'CAPTURE + REPORT'}\n`);

  ensureDir(join(BASELINE_DIR, 'desktop'));
  ensureDir(join(BASELINE_DIR, 'mobile'));

  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (const vp of VIEWPORTS) {
    console.log(`\n[${vp.name.toUpperCase()}] ${vp.width}×${vp.height}`);

    let context;
    if (vp.device) {
      const deviceConfig = devices[vp.device] || {};
      context = await browser.newContext({
        ...deviceConfig,
        viewport: { width: vp.width, height: vp.height },
      });
    } else {
      context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      });
    }

    const page = await context.newPage();

    for (const route of ROUTES) {
      try {
        const result = await captureRoute(page, route, vp.name);
        results.push(result);
      } catch (err) {
        console.error(`  ✗ failed: ${err.message}`);
        results.push({ route, viewportName: vp.name, error: err.message });
      }
    }

    await context.close();
  }

  await browser.close();

  // ─── REPORT ───────────────────────────────────────────────────────────────
  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('  VISUAL ASSESSMENT REPORT — gatetest.ai');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const result of results) {
    if (result.error) {
      console.log(`[${result.viewportName}/${result.route.slug}] ERROR: ${result.error}`);
      continue;
    }

    const { pageInfo, viewportName, route } = result;
    console.log(`── ${viewportName.toUpperCase()} / ${route.slug} ─────────────────────`);
    console.log(`  Title:          ${pageInfo.title}`);
    console.log(`  H1:             ${pageInfo.h1 || '(none found)'}`);
    console.log(`  Module count:   ${pageInfo.moduleCount || '(not mentioned)'}`);
    console.log(`  Status badge:   ${pageInfo.statusBadgeText || '(none)'}`);
    console.log(`  Has hero:       ${pageInfo.hasHeroSection}`);
    console.log(`  Has pricing:    ${pageInfo.hasPricingSection}`);

    if (pageInfo.pricingMentions?.length) {
      console.log(`  Pricing copy:   ${pageInfo.pricingMentions.join(' | ')}`);
    }

    if (pageInfo.navLinks?.length) {
      console.log(`  Nav links:      ${pageInfo.navLinks.map(l => l.text).join(' · ')}`);
    }

    if (pageInfo.ctaButtons?.length) {
      console.log(`  CTA buttons:    ${pageInfo.ctaButtons.map(b => b.text).join(' · ')}`);
    }

    if (pageInfo.formInputs?.length) {
      console.log(`  Input fields:   ${pageInfo.formInputs.map(f => f.placeholder || f.type).join(' | ')}`);
    }

    if (result.consoleErrors?.length) {
      console.log(`  Console errors: ${result.consoleErrors.length}`);
      result.consoleErrors.slice(0, 5).forEach(e => {
        console.log(`    [${e.type}] ${e.text.slice(0, 120)}`);
      });
    }

    console.log(`\n  VISIBLE TEXT (first 800 chars):`);
    console.log(`  ${pageInfo.visibleText.slice(0, 800).replace(/\n/g, '\n  ')}`);
    console.log();
  }

  // Save JSON report
  const reportPath = join(BASELINE_DIR, 'assessment-report.json');
  writeFileSync(reportPath, JSON.stringify({ capturedAt: new Date().toISOString(), url: TARGET_URL, results }, null, 2));
  console.log(`\n✓ Full report saved: ${reportPath}`);
  console.log(`✓ Screenshots saved in: ${BASELINE_DIR}/{desktop,mobile}/`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
