/**
 * Form Testing Module — fills every SAFE form with valid test data,
 * submits it, and verifies something actually happened (not a silent
 * failure, not an uncaught error).
 *
 * Safety scope (read before touching this module again): the spec this
 * was built from explicitly lists payment forms and CAPTCHA-bypass as
 * things to handle. This module does NOT do either:
 *
 *   - Payment-shaped forms (card number / CVV / expiry fields, or a
 *     Stripe/Braintree/PayPal iframe/element) are detected and SKIPPED
 *     — never submitted. Simulating a real charge (or even a declined-
 *     card attempt) against a live payment processor without the
 *     customer's own test-mode keys is a money-adjacent action; that's
 *     Boss Rule #9 territory, not something this module decides on its
 *     own.
 *   - Auth-shaped forms (any `input[type=password]`) are SKIPPED —
 *     GateTest has no real credentials, and creating a spurious account
 *     or attempting a login against a live site has real side effects.
 *   - CAPTCHA-protected forms are detected and SKIPPED — this module
 *     never attempts to bypass a CAPTCHA. "Detect and skip," not
 *     "detect and defeat."
 *   - Forms whose submit button reads like a destructive action (the
 *     same short-imperative-label pattern list `interactiveElements`
 *     uses for buttons) are also skipped.
 *
 * Everything else — contact forms, newsletter signup, search, feedback,
 * generic multi-field forms — gets filled with GateTest-branded benign
 * values (the email field always resolves to `test@gatetest.ai` so a
 * form that DOES send a real email never reaches a real inbox) and
 * submitted for real. A checkbox is only checked when its label reads
 * like a required legal consent (terms/privacy) — anything that reads
 * like a newsletter/marketing opt-in is deliberately left unchecked so
 * a test run never subscribes a fake identity to a real mailing list.
 *
 * Requires: Playwright (already an approved GateTest dependency). Skips
 * gracefully when Chromium isn't available, same as its siblings.
 */

'use strict';

const path = require('path');
const BaseModule = require('./base-module');

const PAYMENT_FIELD_PATTERNS = [
  /card.?number/i, /cc.?number/i, /cardnum/i, /\bcvv\b/i, /\bcvc\b/i,
  /security.?code/i, /exp.?(date|month|year)/i, /expiry/i,
];
const PAYMENT_AUTOCOMPLETE = new Set(['cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-name', 'cc-type']);
const PAYMENT_ELEMENT_SELECTORS = [
  'iframe[name*="__privateStripeFrame"]', 'iframe[src*="js.stripe.com"]', '.StripeElement',
  '[data-paypal-button]', 'iframe[src*="braintreegateway"]', 'iframe[src*="paypal.com"]',
];
const CAPTCHA_SELECTORS = [
  '.g-recaptcha', '[data-sitekey]', 'iframe[src*="recaptcha"]', 'iframe[title*="recaptcha" i]',
  '.h-captcha', 'iframe[src*="hcaptcha"]', '.cf-turnstile', 'iframe[src*="turnstile"]',
];
const CONSENT_CHECKBOX_RE = /agree|consent|terms|privacy/i;
const MARKETING_CHECKBOX_RE = /newsletter|marketing|promo|subscribe|updates/i;
const DESTRUCTIVE_SUBMIT_PATTERNS = [
  /\bdelete\b/i, /\bremove\b/i, /\bcancel\b/i, /\bunsubscribe\b/i, /\bdeactivat/i,
  /\bterminate\b/i, /\bclose\s+account\b/i, /\bpermanently\b/i,
];

const SUCCESS_TEXT_RE = /thank you|thanks for|success|received your|confirmed|submitted|message sent|we('| wi)ll be in touch|check your (email|inbox)/i;
const ERROR_TEXT_RE = /\berror\b|failed|invalid|required field|something went wrong|please try again/i;

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_FORMS_PER_PAGE = 10;
const DEFAULT_WAIT_MS = 1000;

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

// `_fillForm` builds selector strings in Node.js, not inside a
// page.evaluate() callback — the browser-only `CSS.escape` global does
// not exist here, so a small Node-side equivalent is needed instead.
function escapeCssIdent(str) {
  return String(str).replace(/([^\w-])/g, '\\$1');
}
function escapeAttrValue(str) {
  return String(str).replace(/(["\\])/g, '\\$1');
}

function inferFieldValue(field) {
  const n = `${field.name || ''} ${field.id || ''} ${field.placeholder || ''} ${field.autocomplete || ''}`.toLowerCase();
  if (field.type === 'email' || /email/.test(n)) return 'test@gatetest.ai';
  if (field.type === 'tel' || /phone|tel\b/.test(n)) return '+15555550100';
  if (field.type === 'url' || /url|website/.test(n)) return 'https://gatetest.ai';
  if (field.type === 'number') return '1';
  if (field.type === 'date') return new Date().toISOString().slice(0, 10);
  if (/message|comment|feedback/.test(n)) return 'GateTest automated form test — please disregard.';
  if (/subject/.test(n)) return 'GateTest automated test';
  if (/(first|last|full)?.?name/.test(n)) return 'GateTest QA';
  if (/company|organi[sz]ation/.test(n)) return 'GateTest';
  if (/zip|postal/.test(n)) return '94103';
  return 'GateTest QA';
}

class FormTestingModule extends BaseModule {
  constructor() {
    super('formTesting', 'Form Testing — fills and submits safe forms, skips payment/auth/CAPTCHA forms');
  }

  async run(result, config) {
    const moduleCfg = config.getModuleConfig('formTesting') || {};
    const baseUrl =
      process.env.GATETEST_FORM_TESTING_URL ||
      moduleCfg.url ||
      config.get('explorer.url') ||
      config.get('liveCrawler.url') ||
      config.get('webUrl') ||
      config.get('wpUrl') ||
      config.get('targetUrl');

    if (!baseUrl) {
      result.addCheck('form-testing:config', true, {
        severity: 'info',
        message: 'No target URL configured — set GATETEST_FORM_TESTING_URL or modules.formTesting.url in .gatetest/config.json',
      });
      return;
    }

    const playwright = resolvePlaywright();
    if (!playwright) {
      result.addCheck('form-testing:playwright-missing', true, {
        severity: 'info',
        message: 'Playwright not available in this environment — form testing checks skipped.',
        suggestion: 'npm install playwright && npx playwright install chromium',
      });
      return;
    }

    let browser;
    try {
      browser = await playwright.chromium.launch({ headless: true, timeout: 15000 });
    } catch (err) {
      result.addCheck('form-testing:browser-launch', true, {
        severity: 'info',
        message: `Browser launch failed (${err.message || err}) — environment likely lacks chromium binaries.`,
      });
      return;
    }

    try {
      const stats = await this._crawl(browser, baseUrl, moduleCfg);
      this._report(result, stats, baseUrl);
    } finally {
      try {
        await browser.close();
      } catch {
        /* swallow close errors */
      }
    }
  }

  async _crawl(browser, baseUrl, moduleCfg) {
    const maxPages = moduleCfg.maxPages || DEFAULT_MAX_PAGES;
    const maxFormsPerPage = moduleCfg.maxFormsPerPage || DEFAULT_MAX_FORMS_PER_PAGE;
    const waitMs = typeof moduleCfg.waitMs === 'number' ? moduleCfg.waitMs : DEFAULT_WAIT_MS;
    const timeout = moduleCfg.timeout || 20000;

    const stats = {
      formsChecked: 0,
      silentFailures: [],
      submitErrors: [],
      possibleErrors: [],
      successes: [],
      skippedPayment: [],
      skippedAuth: [],
      skippedCaptcha: [],
      skippedDestructive: [],
    };

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'GateTest/1.0 (+https://gatetest.ai/bot) FormTesting',
    });
    const page = await context.newPage();
    const visited = new Set();
    const queue = [baseUrl];

    try {
      while (queue.length > 0 && visited.size < maxPages) {
        const url = queue.shift();
        if (!url || visited.has(url)) continue;
        visited.add(url);

        let response;
        try {
          response = await page.goto(url, { timeout, waitUntil: 'networkidle' });
        } catch {
          try {
            response = await page.goto(url, { timeout, waitUntil: 'load' });
          } catch {
            continue;
          }
        }
        if (!response || response.status() >= 400) continue;

        const links = await page.$$eval('a[href]', (anchors, base) =>
          anchors.map((a) => a.href).filter((href) => href.startsWith(base) && !href.includes('#')), baseUrl,
        ).catch(() => []);
        for (const link of links) {
          if (!visited.has(link) && !queue.includes(link)) queue.push(link);
        }

        const forms = await this._discoverForms(page);
        for (const form of forms.slice(0, maxFormsPerPage)) {
          await this._checkForm({ page, pageUrl: url, form, waitMs, timeout, stats });
        }
      }
    } finally {
      await context.close().catch(() => {});
    }

    return stats;
  }

  async _discoverForms(page) {
    return page.evaluate(
      ({ paymentFieldPatterns, paymentAutocomplete, paymentSelectors, captchaSelectors }) => {
        function reFromStrings(list) {
          return list.map((p) => new RegExp(p.source, p.flags));
        }
        const paymentFieldRes = reFromStrings(paymentFieldPatterns);

        const forms = [];
        document.querySelectorAll('form').forEach((formEl, idx) => {
          const rect = formEl.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;

          const fields = [];
          let hasPassword = false;
          formEl.querySelectorAll('input, textarea, select').forEach((el) => {
            const type = (el.getAttribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : 'text')).toLowerCase();
            if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return;
            if (type === 'password') hasPassword = true;
            fields.push({
              type,
              name: el.getAttribute('name') || '',
              id: el.getAttribute('id') || '',
              placeholder: el.getAttribute('placeholder') || '',
              autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
              label: (el.closest('label')?.textContent || document.querySelector(`label[for="${el.id}"]`)?.textContent || '').trim(),
            });
          });

          const nameBlob = fields.map((f) => `${f.name} ${f.id} ${f.placeholder} ${f.label}`).join(' ');
          const paymentByField = paymentFieldRes.some((re) => re.test(nameBlob));
          const paymentByAutocomplete = fields.some((f) => paymentAutocomplete.includes(f.autocomplete));
          const paymentByElement = paymentSelectors.some((sel) => formEl.querySelector(sel));
          const captchaPresent = captchaSelectors.some((sel) => formEl.querySelector(sel) || document.querySelector(sel));

          const submitEl = formEl.querySelector('button[type="submit"], input[type="submit"]') || formEl.querySelector('button');
          const submitText = submitEl ? (submitEl.textContent || submitEl.value || '').trim() : '';

          forms.push({
            index: idx,
            fields,
            hasPassword,
            paymentShaped: paymentByField || paymentByAutocomplete || paymentByElement,
            captchaPresent,
            submitText,
            hasSubmit: !!submitEl,
          });
        });
        return forms;
      },
      {
        paymentFieldPatterns: PAYMENT_FIELD_PATTERNS.map((re) => ({ source: re.source, flags: re.flags })),
        paymentAutocomplete: Array.from(PAYMENT_AUTOCOMPLETE),
        paymentSelectors: PAYMENT_ELEMENT_SELECTORS,
        captchaSelectors: CAPTCHA_SELECTORS,
      },
    );
  }

  async _checkForm({ page, pageUrl, form, waitMs, timeout, stats }) {
    stats.formsChecked++;
    const label = `form #${form.index}${form.submitText ? ` ("${form.submitText}")` : ''} on ${pageUrl}`;

    if (form.paymentShaped) {
      stats.skippedPayment.push({ label, pageUrl });
      return;
    }
    if (form.hasPassword) {
      stats.skippedAuth.push({ label, pageUrl });
      return;
    }
    if (form.captchaPresent) {
      stats.skippedCaptcha.push({ label, pageUrl });
      return;
    }
    if (DESTRUCTIVE_SUBMIT_PATTERNS.some((re) => re.test(form.submitText))) {
      stats.skippedDestructive.push({ label, pageUrl });
      return;
    }
    if (!form.hasSubmit) {
      return; // nothing to submit — not a finding either way
    }

    const beforeUrl = page.url();
    const beforeHtmlLen = await page.evaluate(() => document.body.innerHTML.length).catch(() => 0);

    const consoleErrors = [];
    const onPageError = (err) => consoleErrors.push(err.message || String(err));
    page.on('pageerror', onPageError);

    let nonGetRequestFired = false;
    const onRequest = (req) => { if (req.method() !== 'GET') nonGetRequestFired = true; };
    page.on('request', onRequest);

    try {
      await this._fillForm(page, form);
      await this._submitForm(page, form);
      await page.waitForTimeout(waitMs);
    } catch (err) {
      stats.submitErrors.push({ label, pageUrl, message: err.message || String(err) });
      return;
    } finally {
      page.removeListener('pageerror', onPageError);
      page.removeListener('request', onRequest);
    }

    if (consoleErrors.length > 0) {
      stats.submitErrors.push({ label, pageUrl, message: consoleErrors[0] });
    } else {
      const afterUrl = page.url();
      const afterHtmlLen = await page.evaluate(() => document.body.innerHTML.length).catch(() => 0);
      const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');

      const urlChanged = beforeUrl !== afterUrl;
      const domChanged = Math.abs(afterHtmlLen - beforeHtmlLen) > 30;
      const hasSuccessText = SUCCESS_TEXT_RE.test(bodyText);
      const hasErrorText = ERROR_TEXT_RE.test(bodyText);

      if (urlChanged || hasSuccessText || (domChanged && !hasErrorText)) {
        stats.successes.push({ label, pageUrl });
      } else if (hasErrorText) {
        stats.possibleErrors.push({ label, pageUrl });
      } else if (!nonGetRequestFired) {
        stats.silentFailures.push({ label, pageUrl });
      } else {
        // A network request fired but no visible confirmation appeared
        // within our wait window — likely an async success state that
        // renders later. Not confident enough to call this a bug.
        stats.successes.push({ label, pageUrl, note: 'network request observed, no explicit confirmation text found' });
      }
    }

    if (page.url() !== pageUrl) {
      try {
        await page.goto(pageUrl, { timeout, waitUntil: 'networkidle' });
      } catch {
        await page.goto(pageUrl, { timeout, waitUntil: 'load' }).catch(() => {});
      }
    }
  }

  // `form.index` is the 0-based position among ALL <form> elements in
  // document order (how _discoverForms enumerated them via
  // querySelectorAll). `page.locator('form').nth(index)` reproduces that
  // exact ordering; CSS `form:nth-of-type(n)` would NOT — nth-of-type is
  // scoped per-parent, so a page with forms under different containers
  // (header + main + footer, a common layout) would match the wrong
  // form, or several. Every locator below is scoped inside this one
  // form so a same-named field in a DIFFERENT form on the same page
  // (e.g. two forms both having an "email" input) is never touched.
  _formRoot(page, form) {
    return page.locator('form').nth(form.index);
  }

  async _fillForm(page, form) {
    const root = this._formRoot(page, form);
    for (const field of form.fields) {
      const selector = field.id ? `#${escapeCssIdent(field.id)}` : field.name ? `[name="${escapeAttrValue(field.name)}"]` : null;
      if (!selector) continue;
      const locator = root.locator(selector).first();

      try {
        if (field.type === 'checkbox') {
          const blob = `${field.name} ${field.id} ${field.label}`;
          if (CONSENT_CHECKBOX_RE.test(blob) && !MARKETING_CHECKBOX_RE.test(blob)) {
            await locator.check({ timeout: 2000 }).catch(() => {});
          }
        } else if (field.type === 'radio') {
          await locator.check({ timeout: 2000 }).catch(() => {});
        } else if (field.type === 'select') {
          await locator.selectOption({ index: 1 }).catch(() => {});
        } else {
          await locator.fill(String(inferFieldValue(field)), { timeout: 2000 }).catch(() => {});
        }
      } catch {
        /* best-effort fill — a field we can't reach isn't fatal to the test */
      }
    }
  }

  async _submitForm(page, form) {
    const root = this._formRoot(page, form);
    const locator = root.locator('button[type="submit"], input[type="submit"], button').first();
    await locator.click({ timeout: 5000 }).catch(() => {});
  }

  _report(result, stats, baseUrl) {
    if (stats.silentFailures.length > 0) {
      result.addCheck('form-testing:silent-failures', false, {
        severity: 'error',
        message: `${stats.silentFailures.length} form(s) accepted input but nothing happened on submit`,
        details: stats.silentFailures.slice(0, 30),
        suggestion: 'Verify the submit handler is wired up — check for a missing onClick/onSubmit, a form with no action, or a client-side handler that silently swallows the request',
      });
    }

    if (stats.submitErrors.length > 0) {
      result.addCheck('form-testing:submit-errors', false, {
        severity: 'error',
        message: `${stats.submitErrors.length} form(s) threw an error on submit`,
        details: stats.submitErrors.slice(0, 30),
      });
    }

    if (stats.possibleErrors.length > 0) {
      result.addCheck('form-testing:possible-errors', false, {
        severity: 'warning',
        message: `${stats.possibleErrors.length} form(s) showed error/validation text after submit`,
        details: stats.possibleErrors.slice(0, 30),
        suggestion: 'This may be a real validation bug, or GateTest\'s inferred test data not matching a strict format the form expects (known limitation — see form-testing.js header)',
      });
    }

    if (stats.skippedPayment.length + stats.skippedAuth.length + stats.skippedCaptcha.length + stats.skippedDestructive.length > 0) {
      result.addCheck('form-testing:skipped', true, {
        severity: 'info',
        message: `${stats.skippedPayment.length} payment-shaped, ${stats.skippedAuth.length} auth-shaped, ${stats.skippedCaptcha.length} CAPTCHA-protected, ${stats.skippedDestructive.length} destructive-looking form(s) were NOT submitted — safety skip`,
        details: [...stats.skippedPayment, ...stats.skippedAuth, ...stats.skippedCaptcha, ...stats.skippedDestructive].slice(0, 30),
      });
    }

    result.addCheck('form-testing:summary', true, {
      severity: 'info',
      message: `${stats.formsChecked} form(s) found at ${baseUrl}: ${stats.successes.length} submitted OK, ${stats.silentFailures.length} silent failure(s), ${stats.submitErrors.length} error(s), ${stats.possibleErrors.length} possible error(s), ${stats.skippedPayment.length + stats.skippedAuth.length + stats.skippedCaptcha.length + stats.skippedDestructive.length} skipped`,
    });
  }
}

module.exports = FormTestingModule;
