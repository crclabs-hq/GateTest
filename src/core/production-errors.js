/**
 * Production Errors — cross-vendor aggregator for the "ears" of GateTest.
 *
 * Pulls top production errors from every configured observability vendor
 * (Sentry, Datadog; Rollbar reserved) and normalises them into ONE shape
 * the static-runtime correlator and the MCP get_production_errors tool
 * both consume:
 *
 *   { source, message, file, line, count, lastSeen, sourceLocation, raw }
 *
 * Per-source failure isolation: one vendor's 500 never sinks the others —
 * failures are captured in the `sources` map and stay visible
 * (Forbidden #15/#16: wrapped and reported, never silent, never fatal).
 */

'use strict';

const sentryClient = require('./sentry-client');
const datadogClient = require('./datadog-client');

/**
 * Resolve vendor configs from environment variables.
 *
 *   Sentry:  SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT
 *   Datadog: DATADOG_API_KEY + DATADOG_APP_KEY (+ DD_SITE, DD_SERVICE)
 *   Rollbar: ROLLBAR_READ_TOKEN (reserved — client ships separately)
 *
 * @param {object} [env=process.env]
 * @returns {{sentry?: object, datadog?: object, rollbar?: object}}
 */
function resolveSourcesFromEnv(env = process.env) {
  const sources = {};
  if (env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT) {
    sources.sentry = {
      accessToken: env.SENTRY_AUTH_TOKEN,
      orgId: env.SENTRY_ORG,
      projectSlug: env.SENTRY_PROJECT,
    };
  }
  if (env.DATADOG_API_KEY && env.DATADOG_APP_KEY) {
    sources.datadog = {
      apiKey: env.DATADOG_API_KEY,
      appKey: env.DATADOG_APP_KEY,
      site: env.DD_SITE || undefined,
      service: env.DD_SERVICE || undefined,
    };
  }
  if (env.ROLLBAR_READ_TOKEN) {
    sources.rollbar = { accessToken: env.ROLLBAR_READ_TOKEN };
  }
  return sources;
}

/** Normalise one Sentry issue (sentry-client fetchTopErrors shape). */
function normaliseSentryItem(issue) {
  const frame = Array.isArray(issue.frames) && issue.frames.length > 0 ? issue.frames[0] : null;
  const file = frame ? frame.file : null;
  const line = frame && frame.lineno != null ? frame.lineno : null;
  return {
    source: 'sentry',
    message: issue.title || issue.culprit || '',
    file,
    line,
    count: Number(issue.count || 0),
    lastSeen: issue.lastSeen || null,
    sourceLocation: file ? { file, line } : null,
    raw: issue,
  };
}

/** Normalise one Datadog log event (datadog-client fetchTopErrors shape). */
function normaliseDatadogItem(event) {
  const loc = event.sourceLocation || null;
  return {
    source: 'datadog',
    message: (event.message || '').split('\n')[0].slice(0, 300),
    file: loc ? loc.file : null,
    line: loc ? loc.line : null,
    // Datadog log-search events are individual occurrences, not grouped —
    // count 1 each; grouping happens implicitly through correlator matching.
    count: 1,
    lastSeen: event.timestamp || null,
    sourceLocation: loc,
    raw: event,
  };
}

/**
 * Fetch + merge production errors across configured vendors.
 *
 * @param {object}   opts
 * @param {object}   [opts.sentry]     { orgId, projectSlug, accessToken }
 * @param {object}   [opts.datadog]    { apiKey, appKey, service?, site?, hoursBack? }
 * @param {object}   [opts.rollbar]    reserved — wired when rollbar-client ships
 * @param {number}   [opts.limit=20]   max merged items returned
 * @param {Function} [opts.fetchImpl]  injected fetch (vendors with DI support)
 * @returns {Promise<{items: Array, sources: Record<string, string>}>}
 *          sources values: 'ok' | 'skipped' | 'error: <message>'
 */
async function fetchProductionErrors(opts = {}) {
  const { sentry, datadog, rollbar, limit = 20, fetchImpl } = opts;
  const sources = {
    sentry: sentry ? 'pending' : 'skipped',
    datadog: datadog ? 'pending' : 'skipped',
    rollbar: rollbar ? 'pending' : 'skipped',
  };
  const items = [];

  if (sentry) {
    try {
      const issues = await sentryClient.fetchTopErrors({
        orgId: sentry.orgId,
        projectSlug: sentry.projectSlug,
        accessToken: sentry.accessToken,
        limit,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      for (const issue of issues) {
        if (issue) items.push(normaliseSentryItem(issue));
      }
      sources.sentry = 'ok';
    } catch (err) {
      sources.sentry = `error: ${err && err.message ? err.message : String(err)}`;
    }
  }

  if (datadog) {
    try {
      const events = await datadogClient.fetchTopErrors({
        apiKey: datadog.apiKey,
        appKey: datadog.appKey,
        service: datadog.service,
        site: datadog.site,
        hoursBack: datadog.hoursBack,
      });
      for (const event of events) {
        if (event) items.push(normaliseDatadogItem(event));
      }
      sources.datadog = 'ok';
    } catch (err) {
      sources.datadog = `error: ${err && err.message ? err.message : String(err)}`;
    }
  }

  if (rollbar) {
    // Reserved: rollbar-client ships as its own unit (Boss-Rule-authorized).
    // Until it lands, an explicitly-passed rollbar config is reported
    // honestly rather than silently ignored.
    try {
      // eslint-disable-next-line global-require
      const rollbarClient = require('./rollbar-client');
      const rbItems = await rollbarClient.fetchTopErrors({
        accessToken: rollbar.accessToken,
        environment: rollbar.environment,
        limit,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      for (const item of rbItems) {
        if (!item) continue;
        items.push({
          source: 'rollbar',
          message: item.message || '',
          file: item.file || null,
          line: item.line != null ? item.line : null,
          count: Number(item.count || 0),
          lastSeen: item.lastSeen || null,
          sourceLocation: item.sourceLocation || (item.file ? { file: item.file, line: item.line } : null),
          raw: item,
        });
      }
      sources.rollbar = 'ok';
    } catch (err) {
      sources.rollbar =
        err && err.code === 'MODULE_NOT_FOUND'
          ? 'error: rollbar client not installed in this build'
          : `error: ${err && err.message ? err.message : String(err)}`;
    }
  }

  // Highest-frequency first — these are what production is screaming about.
  items.sort((a, b) => (b.count || 0) - (a.count || 0));

  return { items: items.slice(0, limit), sources };
}

module.exports = {
  fetchProductionErrors,
  resolveSourcesFromEnv,
  normaliseSentryItem,
  normaliseDatadogItem,
};
