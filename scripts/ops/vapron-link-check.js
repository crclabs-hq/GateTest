const path = require('path');
const { chromium } = require(path.join(__dirname, '../../website/node_modules/playwright'));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const issues = { critical: [], warning: [], info: [] };

  console.log('Checking vapron.ai for broken buttons and links...\n');

  await page.goto('https://vapron.ai', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // ── Links ──────────────────────────────────────────────────────────────────
  const links = await page.$$eval('a', els => els.map(el => ({
    text: el.innerText?.trim().slice(0, 60) || '[no text]',
    href: el.getAttribute('href'),
    visible: el.offsetParent !== null,
  })));

  for (const link of links) {
    if (!link.href || link.href === '#' || link.href === '') {
      issues.critical.push(`LINK missing href: "${link.text}"`);
    } else if (link.href.startsWith('javascript:')) {
      issues.warning.push(`LINK uses javascript: href: "${link.text}"`);
    } else if (link.href === 'https://vapron.ai/#' || link.href.endsWith('/#')) {
      issues.warning.push(`LINK href is placeholder "#": "${link.text}"`);
    }
  }

  // ── Buttons ────────────────────────────────────────────────────────────────
  const buttons = await page.$$eval('button, [role="button"], input[type="submit"], input[type="button"]', els => els.map(el => ({
    text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 60),
    disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
    hasClick: el.onclick !== null || el.getAttribute('data-action') !== null,
    type: el.tagName.toLowerCase(),
    visible: el.offsetParent !== null,
  })));

  for (const btn of buttons) {
    if (!btn.text) {
      issues.critical.push(`BUTTON has no text/label (${btn.type})`);
    }
    if (btn.disabled && btn.visible) {
      issues.warning.push(`BUTTON is disabled: "${btn.text || '[no label]'}"`);
    }
  }

  // ── Nav links ──────────────────────────────────────────────────────────────
  const navLinks = await page.$$eval('nav a, header a', els => els.map(el => ({
    text: el.innerText?.trim(),
    href: el.getAttribute('href'),
  })));

  for (const link of navLinks) {
    if (!link.href || link.href === '#') {
      issues.critical.push(`NAV link missing destination: "${link.text}"`);
    }
  }

  // ── Check additional pages ─────────────────────────────────────────────────
  const internalLinks = [...new Set(
    links
      .filter(l => l.href && (l.href.startsWith('/') || l.href.includes('vapron.ai')))
      .map(l => l.href.startsWith('/') ? `https://vapron.ai${l.href}` : l.href)
      .filter(l => !l.includes('#'))
      .slice(0, 10)
  )];

  console.log(`Checking ${internalLinks.length} internal pages for broken links...\n`);

  for (const url of internalLinks) {
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = res?.status();
      if (status >= 400) {
        issues.critical.push(`DEAD LINK ${status}: ${url}`);
      } else {
        issues.info.push(`OK ${status}: ${url}`);
      }
    } catch (e) {
      issues.critical.push(`DEAD LINK (timeout/error): ${url}`);
    }
  }

  await browser.close();

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log('=== VAPRON.AI — BUTTON & LINK AUDIT ===\n');

  if (issues.critical.length) {
    console.log(`CRITICAL (${issues.critical.length}):`);
    issues.critical.forEach(i => console.log(`  ✗ ${i}`));
  }
  if (issues.warning.length) {
    console.log(`\nWARNING (${issues.warning.length}):`);
    issues.warning.forEach(i => console.log(`  ~ ${i}`));
  }
  if (issues.info.length) {
    console.log(`\nINFO (${issues.info.length}):`);
    issues.info.forEach(i => console.log(`  ✓ ${i}`));
  }

  console.log(`\nTotal links: ${links.length} | Buttons: ${buttons.length} | Nav links: ${navLinks.length}`);
  console.log(`Issues: ${issues.critical.length} critical, ${issues.warning.length} warnings`);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
