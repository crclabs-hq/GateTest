import { chromium, devices } from 'playwright';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const TARGET_URL   = process.env.TARGET_URL   || 'https://gatetest.ai';
const BASELINE_DIR = process.env.BASELINE_DIR || 'C:/Program Files/Git/opt/jarvis/visual-baselines/gatetest';

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
ensureDir(join(BASELINE_DIR, 'desktop'));
ensureDir(join(BASELINE_DIR, 'mobile'));

console.log(`\n=== GateTest Visual Baseline Capture ===`);
console.log(`Target:   ${TARGET_URL}`);
console.log(`Baseline: ${BASELINE_DIR}\n`);

const browser = await chromium.launch({ headless: true });
const results = [];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile',  width: 390,  height: 844 },
];

for (const vp of VIEWPORTS) {
  console.log(`\n[${vp.name.toUpperCase()}] ${vp.width}×${vp.height}`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(`PAGE ERROR: ${e.message}`));

  console.log(`  → loading ${TARGET_URL}/`);
  await page.goto(TARGET_URL + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);

  // Full-page screenshot
  const fullPath = join(BASELINE_DIR, vp.name, 'homepage.png');
  await page.screenshot({ path: fullPath, fullPage: true });
  console.log(`  ✓ ${fullPath}`);

  // Above-the-fold screenshot
  const foldPath = join(BASELINE_DIR, vp.name, 'homepage-fold.png');
  await page.screenshot({ path: foldPath, fullPage: false });
  console.log(`  ✓ ${foldPath} (above fold)`);

  // Page audit
  const info = await page.evaluate(() => ({
    title:            document.title,
    h1:               document.querySelector('h1')?.innerText?.trim(),
    url:              location.href,
    moduleCount:      document.body.innerText.match(/(\d+)\s*modules?/i)?.[0],
    versionBadge:     Array.from(document.querySelectorAll('*')).find(el =>
                        /v\d+\.\d+/.test(el.innerText) && el.innerText.length < 60
                      )?.innerText?.trim(),
    hasPricing:       !!document.querySelector('[id*="pricing"],[class*="pricing"],[class*="price"]'),
    navItems:         Array.from(document.querySelectorAll('nav a, header a'))
                        .map(a => a.innerText.trim()).filter(Boolean).slice(0, 10),
    ctaText:          Array.from(document.querySelectorAll('button,a'))
                        .map(el => el.innerText?.trim())
                        .filter(t => t && t.length > 3 && t.length < 60)
                        .filter((t, i, arr) => arr.indexOf(t) === i)
                        .slice(0, 15),
    pricingText:      document.body.innerText.match(/\$\d+[^\n]{0,50}/g)?.slice(0,10),
    bodyText:         document.body.innerText.slice(0, 3000),
    inputPlaceholders: Array.from(document.querySelectorAll('input')).map(i => i.placeholder).filter(Boolean),
    formCount:        document.querySelectorAll('form').length,
    imageAlts:        Array.from(document.querySelectorAll('img')).map(i => i.alt).filter(Boolean).slice(0,5),
    hasFooter:        !!document.querySelector('footer'),
  }));

  results.push({ viewport: vp.name, info, consoleErrors, paths: { full: fullPath, fold: foldPath } });
  await ctx.close();
}

await browser.close();

// ─── REPORT ────────────────────────────────────────────────────────────────
console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
console.log('║     VISUAL ASSESSMENT REPORT — gatetest.ai                  ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

for (const r of results) {
  console.log(`━━ ${r.viewport.toUpperCase()} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Page title:     ${r.info.title}`);
  console.log(`  H1:             ${r.info.h1 || '(no h1 found)'}`);
  console.log(`  Module count:   ${r.info.moduleCount || '(not found in copy)'}`);
  console.log(`  Version badge:  ${r.info.versionBadge || '(not found)'}`);
  console.log(`  Has pricing UI: ${r.info.hasPricing}`);
  console.log(`  Has footer:     ${r.info.hasFooter}`);
  console.log(`  Form inputs:    ${r.info.inputPlaceholders.join(' | ') || '(none)'}`);
  console.log(`  Nav items:      ${r.info.navItems.join(' · ')}`);
  console.log(`\n  CTA elements:`);
  (r.info.ctaText || []).forEach(t => console.log(`    • ${t}`));
  if (r.info.pricingText?.length) {
    console.log(`\n  Pricing copy found on page:`);
    r.info.pricingText.forEach(p => console.log(`    ${p}`));
  }
  if (r.consoleErrors.length) {
    console.log(`\n  ⚠ Console errors (${r.consoleErrors.length}):`);
    r.consoleErrors.slice(0, 8).forEach(e => console.log(`    ${e.slice(0, 140)}`));
  }
  console.log(`\n  Full body text (first 2000 chars):`);
  console.log(r.info.bodyText.slice(0, 2000).split('\n').map(l => `    ${l}`).join('\n'));
  console.log();
}

const reportPath = join(BASELINE_DIR, 'assessment-report.json');
writeFileSync(reportPath, JSON.stringify({ capturedAt: new Date().toISOString(), url: TARGET_URL, results }, null, 2));
console.log(`✓ Screenshots: ${join(BASELINE_DIR, '{desktop,mobile}')}/`);
console.log(`✓ Report JSON: ${reportPath}`);
