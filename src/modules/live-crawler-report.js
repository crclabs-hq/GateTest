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

/**
 * How much of the crawl's "in scope" pages may go unchecked before the exit
 * code fails the gate (issue #677 item 2). A single stalled page out of forty
 * should not fail a CI build on an otherwise-clean site; the site being
 * mostly unreachable should. Documented here because bin/gatetest.js's
 * `--crawl` exit code and this module's own "not checked" report line both
 * read the SAME number — one definition, so the exit code can never diverge
 * from what the report prints (doctrine #4).
 */
const NOT_CHECKED_BLOCK_SHARE = 0.2; // 20%

/** How many pages this crawl never actually verified — timed out, or never attempted before the wall-clock budget ran out. */
function notCheckedCount(data) {
  const timedOut = (data.timedOutPages || []).length;
  const budgetSkipped = data.budgetExhausted
    ? Math.max(0, (data.maxPages || 0) - (data.pagesScanned || 0) - timedOut)
    : 0;
  return timedOut + budgetSkipped;
}

/** Why those pages were not checked, in the order the reasons apply. Null when nothing was skipped. */
function notCheckedReason(data) {
  const reasons = [];
  if ((data.timedOutPages || []).length > 0) reasons.push('timed out');
  if (data.budgetExhausted) reasons.push('crawl budget exhausted');
  return reasons.length ? reasons.join('; ') : null;
}

/** The one "N pages not checked (reason)" line — shared by the markdown report and the JSON document. Null when everything was checked. */
function notCheckedLine(data) {
  const count = notCheckedCount(data);
  if (count === 0) return null;
  return `${count} page${count === 1 ? '' : 's'} not checked (${notCheckedReason(data) || 'unknown'})`;
}

/** Total hard (error-severity) findings — the ones that always fail the crawl regardless of the not-checked share. */
function hardFindingCount(data) {
  return (data.errors || []).length
    + (data.brokenLinks || []).length
    + (data.brokenImages || []).length
    + (data.brokenScripts || []).length
    + (data.brokenStylesheets || []).length;
}

/**
 * The one "Warnings" block shared by both RESULT branches below (issue
 * #703) — printed regardless of ALL CLEAR/ISSUES FOUND, since a warning
 * never flips that verdict (crawlResultLabel only looks at hard findings)
 * but must never be silently uncounted either. One definition so the ALL
 * CLEAR path (which used to say nothing else at all) and the ISSUES FOUND
 * path can't render this differently.
 */
function pushWarningsSection(lines, warnings) {
  if (!warnings || warnings.length === 0) return;
  lines.push(`### Warnings (${warnings.length})`);
  for (const w of warnings) {
    const loc = w.url ? ` — ${w.url}` : '';
    lines.push(`- **${w.module}**${loc}: ${w.message}`);
  }
  lines.push('');
}

/** The one-word verdict the markdown heading and the JSON `result` field both show. */
function crawlResultLabel(data) {
  const clean = hardFindingCount(data) === 0
    && (data.timedOutPages || []).length === 0
    && !data.budgetExhausted
    && (data.pagesScanned || 0) > 0;
  return clean ? 'ALL CLEAR' : 'ISSUES FOUND';
}

/**
 * The crawl's own findings decide the exit code — never the runner's generic
 * module-crashed/timed-out status, which can diverge from what this report
 * actually shows (issue #677 item 2: a 40-page crawl printed ALL CLEAR and
 * still exited 1 because an unrelated wall-clock race marked the module
 * "failed" — via the runner's outer timeout race — after this report had
 * already been written clean to disk).
 *
 * Hard findings (broken links/images/scripts/stylesheets, page errors)
 * always fail. Otherwise the crawl fails only when the NOT-CHECKED share —
 * pages timed out or never attempted because the wall-clock budget ran
 * out — exceeds NOT_CHECKED_BLOCK_SHARE. Fewer skipped pages than that
 * still prints the not-checked line, but does not fail the gate. A crawl
 * that verified zero pages and found no errors either can never claim
 * clean off zero observations.
 */
function crawlExitCode(data) {
  if (hardFindingCount(data) > 0) return 1;

  const notChecked = notCheckedCount(data);
  const pagesScanned = data.pagesScanned || 0;
  if (pagesScanned === 0 && notChecked === 0) return 1;

  const totalInScope = data.budgetExhausted ? (data.maxPages || 0) : pagesScanned + notChecked;
  const share = totalInScope > 0 ? notChecked / totalInScope : 0;
  return share > NOT_CHECKED_BLOCK_SHARE ? 1 : 0;
}

/**
 * The uniform `findings` array for `--crawl --format json` (issue #677
 * item 1) — one shape covering every collector this module fills, built
 * from the SAME `data` object the markdown report and crawlExitCode() both
 * read, so the JSON document can never show something the human report and
 * the exit code disagree about.
 */
function buildCrawlFindings(data) {
  const findings = [];
  for (const e of data.errors || []) {
    findings.push({ type: e.type || 'error', severity: 'error', message: e.message || null, url: e.url || null });
  }
  for (const l of data.brokenLinks || []) {
    findings.push({ type: 'broken-link', severity: 'error', message: `[${l.status}] ${l.link}`, url: l.page || null });
  }
  for (const i of data.brokenImages || []) {
    findings.push({ type: 'broken-image', severity: 'error', message: `[${i.status}] ${i.image}`, url: i.page || null });
  }
  for (const s of data.brokenScripts || []) {
    findings.push({ type: 'broken-script', severity: 'error', message: `[${s.status}] ${s.script}`, url: s.page || null });
  }
  for (const s of data.brokenStylesheets || []) {
    findings.push({ type: 'broken-stylesheet', severity: 'error', message: `[${s.status}] ${s.stylesheet}`, url: s.page || null });
  }
  for (const t of data.timedOutPages || []) {
    findings.push({ type: 'timeout', severity: 'warning', message: t.message || `timed out after ${t.elapsedMs}ms`, url: t.url || null });
  }
  if (data.budgetExhausted) {
    findings.push({
      type: 'budget-exhausted',
      severity: 'info',
      message: `${data.pagesScanned || 0} of ${data.maxPages || 0} pages fetched before the crawl budget ran out`,
      url: null,
    });
  }
  // Every OTHER warning-severity check the crawl raised (issue #703) —
  // duplicate titles, missing meta description/canonical, slow pages,
  // broken anchor targets, the no-session auth wall. Read from `data.warnings`,
  // the SAME array the text report's "Warnings" section prints from, so the
  // JSON document can never disagree with the human-readable one.
  for (const w of data.warnings || []) {
    findings.push({
      type: (w.key || 'warning').replace(/^crawl:/, ''),
      severity: 'warning',
      message: w.message || null,
      url: w.url || null,
    });
  }
  return findings;
}

/**
 * Convergence-guard finding ids for a `--crawl-loop` round (complaint C23,
 * src/core/convergence-guard.js). One id per `buildCrawlFindings()` entry —
 * reusing that function rather than re-deriving from `data` means this can
 * never disagree with what the human report or `--format json` list, so two
 * rounds that raise the exact same problems always hash identically.
 */
function crawlFindingIds(data) {
  return buildCrawlFindings(data).map((f) => `${f.type}|${f.url || ''}|${f.message || ''}`);
}

function generateFeedbackReport(config, data) {
  const { reportDir, mdPath, jsonPath, latestMdPath, latestJsonPath } =
    crawlReportPaths(config.projectRoot, data.baseUrl);
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const timedOutPages = data.timedOutPages || [];
  const brokenScripts = data.brokenScripts || [];
  const brokenStylesheets = data.brokenStylesheets || [];
  const pagesAttempted = data.pagesScanned + timedOutPages.length;
  const budgetExhausted = !!data.budgetExhausted;
  const elapsedS = ((data.crawlElapsedMs || 0) / 1000).toFixed(1);
  const resultLabel = crawlResultLabel(data);
  const notChecked = notCheckedLine(data);
  // Every non-blocking finding the crawl raised beyond hard errors and page
  // timeouts (duplicate titles, missing meta/canonical, slow pages, broken
  // anchor targets, the no-session auth wall) — the SAME array `warningChecks`
  // counts, so the recap's "N warnings" always has text behind it (#703).
  const warnings = data.warnings || [];

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
  // The exact "N pages not checked (reason)" line — the same number
  // bin/gatetest.js's --crawl exit code reads via crawlExitCode() (issue
  // #677 item 2), so the report and the exit code can never disagree.
  if (notChecked) lines.push(`# Not checked: ${notChecked}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push('');

  if (resultLabel === 'ALL CLEAR') {
    lines.push('## RESULT: ALL CLEAR');
    lines.push('No errors, broken links, or broken images found.');
    lines.push('');
    pushWarningsSection(lines, warnings);
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

    if (brokenScripts.length > 0) {
      lines.push(`### Broken Scripts (${brokenScripts.length})`);
      for (const s of brokenScripts) {
        lines.push(`- [${s.status}] ${s.script} (found on ${s.page})`);
      }
      lines.push('');
    }

    if (brokenStylesheets.length > 0) {
      lines.push(`### Broken Stylesheets (${brokenStylesheets.length})`);
      for (const s of brokenStylesheets) {
        lines.push(`- [${s.status}] ${s.stylesheet} (found on ${s.page})`);
      }
      lines.push('');
    }

    pushWarningsSection(lines, warnings);

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

module.exports = {
  generateFeedbackReport,
  crawlReportPaths,
  crawlExitCode,
  crawlResultLabel,
  buildCrawlFindings,
  crawlFindingIds,
  notCheckedLine,
  notCheckedCount,
  hardFindingCount,
  NOT_CHECKED_BLOCK_SHARE,
};
