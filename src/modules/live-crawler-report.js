'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/**
 * One definition of where a crawl's feedback report lives on disk — imported
 * by the writer below AND by every CLI reader in bin/gatetest.js. Concurrent
 * `--crawl` runs against different sites from the SAME project root used to
 * share one fixed filename (`crawl-feedback.md`/`.json`), so whichever run
 * finished last silently overwrote the other's report and a reader could
 * print a different target's findings under its own URL header (reproduced
 * 2026-09-21: a tallrig.com run printed gluecron.com's report). The run-scoped
 * path is keyed by process id + target origin, so two concurrent processes —
 * even against the same origin twice — never collide; the "latest" path
 * remains for `gatetest --crawl-feedback`, which has no run/url context to
 * key off and is a last-crawl viewer by design.
 */
function crawlReportPaths(projectRoot, baseUrl) {
  const reportDir = path.resolve(projectRoot, '.gatetest/reports');
  const runKey = `${process.pid}-${originSlug(baseUrl)}`;
  return {
    reportDir,
    mdPath: path.join(reportDir, `crawl-feedback.${runKey}.md`),
    jsonPath: path.join(reportDir, `crawl-feedback.${runKey}.json`),
    latestMdPath: path.join(reportDir, 'crawl-feedback.md'),
    latestJsonPath: path.join(reportDir, 'crawl-feedback.json'),
  };
}

function originSlug(baseUrl) {
  try {
    return new URL(baseUrl).hostname.replace(/[^a-z0-9.-]/gi, '_') || 'unknown-origin';
  } catch {
    return 'unknown-origin';
  }
}

function generateFeedbackReport(config, data) {
  const { reportDir, mdPath, jsonPath, latestMdPath, latestJsonPath } =
    crawlReportPaths(config.projectRoot, data.baseUrl);
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const timedOutPages = data.timedOutPages || [];
  const pagesAttempted = data.pagesScanned + timedOutPages.length;
  const budgetExhausted = !!data.budgetExhausted;
  const elapsedS = ((data.crawlElapsedMs || 0) / 1000).toFixed(1);

  const lines = [];
  lines.push('# GateTest Live Crawl Report');
  lines.push(`# URL: ${data.baseUrl}`);
  let pagesLine = `# Pages scanned: ${data.pagesScanned}`;
  if (timedOutPages.length > 0) pagesLine += ` (${timedOutPages.length} of ${pagesAttempted} timed out)`;
  // Doctrine #1 (three-state): a crawl cut short by its own wall-clock
  // budget carries what it fetched, labelled, instead of the runner's
  // outer race discarding it and printing "no data was collected" (#640).
  if (budgetExhausted) pagesLine += ` — crawl budget exhausted: ${data.pagesScanned} of ${data.maxPages} pages fetched in ${elapsedS}s`;
  lines.push(pagesLine);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push('');

  if (data.errors.length === 0 && data.brokenLinks.length === 0
      && data.brokenImages.length === 0 && timedOutPages.length === 0
      && !budgetExhausted) {
    lines.push('## RESULT: ALL CLEAR');
    lines.push('No errors, broken links, or broken images found.');
  } else {
    lines.push('## RESULT: ISSUES FOUND — FIX REQUIRED');
    lines.push('');

    if (budgetExhausted) {
      lines.push('### Crawl Budget Exhausted (not checked)');
      lines.push(`${data.pagesScanned} of ${data.maxPages} pages fetched in ${elapsedS}s before the wall-clock budget ran out; the remaining pages were NOT checked.`);
      lines.push('Raise the module timeout (.gatetest config modules.liveCrawler under moduleTimeouts, or GATETEST_MODULE_TIMEOUT_MS) or lower --crawl-max / --crawl-page-timeout for this host.');
      lines.push('');
    }

    if (timedOutPages.length > 0) {
      lines.push(`### Page Timeouts (${timedOutPages.length} of ${pagesAttempted} pages)`);
      for (const t of timedOutPages) {
        lines.push(`- ${t.url} — ${t.message || `timed out after ${t.elapsedMs}ms`}`);
      }
      lines.push('');
    }

    if (data.errors.length > 0) {
      lines.push(`### Page Errors (${data.errors.length})`);
      for (const err of data.errors) {
        lines.push(`- **${err.type}** at ${err.url}`);
        lines.push(`  ${err.message}`);
      }
      lines.push('');
    }

    if (data.brokenLinks.length > 0) {
      lines.push(`### Broken Links (${data.brokenLinks.length})`);
      for (const link of data.brokenLinks) {
        lines.push(`- [${link.status}] ${link.link} (found on ${link.page})`);
      }
      lines.push('');
    }

    if (data.brokenImages.length > 0) {
      lines.push(`### Broken Images (${data.brokenImages.length})`);
      for (const img of data.brokenImages) {
        lines.push(`- [${img.status}] ${img.image} (found on ${img.page})`);
      }
      lines.push('');
    }

    lines.push('## ACTION REQUIRED');
    lines.push('Fix all issues listed above and run `gatetest --module liveCrawler` again.');
    lines.push('Do not deploy until this report shows ALL CLEAR.');
  }

  const report = lines.join('\n');
  const json = JSON.stringify(data, null, 2);

  // Run-scoped copy: what THIS run's own caller reads back (bin/gatetest.js),
  // immune to a concurrent run against a different origin/process.
  fs.writeFileSync(mdPath, report);
  fs.writeFileSync(jsonPath, json);
  // "Latest" convenience copy, for the standalone `--crawl-feedback` command
  // only — inherently last-writer-wins, since it has no run to key off.
  fs.writeFileSync(latestMdPath, report);
  fs.writeFileSync(latestJsonPath, json);

  return { mdPath, jsonPath };
}

module.exports = { generateFeedbackReport, crawlReportPaths };
