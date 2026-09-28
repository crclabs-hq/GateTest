'use strict';
/**
 * Telemetry notice + status — the words a customer reads about telemetry, in
 * one place. The CLI and the MCP server both call maybeNoticeTelemetry() before
 * their first upload; `gatetest --telemetry-status` prints telemetryStatusLines().
 *
 * The field list is derived from a real record (scan-telemetry.recordFieldNames)
 * and the host from the uploader's own target resolution, so this copy cannot
 * drift from what is actually sent. Field NAMES only — never values.
 *
 * NEVER throws. Zero dependencies beyond the sibling core modules.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { resolveTelemetry, recordFieldNames, TELEMETRY_DEFAULT } = require('./scan-telemetry');
const { resolveTelemetryTarget } = require('./telemetry-uploader');
const { isOffline } = require('./offline');

const NOTICE_MARKER = path.join(os.homedir(), '.gatetest', '.telemetry-notice-shown');

const HOW_TO_OFF = [
  'Turn it off any time:',
  '  - set GATETEST_TELEMETRY=0 in your environment, or',
  '  - add "telemetry": false to .gatetest.json in your project.',
  '  Check the current setting with: gatetest --telemetry-status',
];

/** The full first-run notice, as an array of lines. */
function noticeLines(target = resolveTelemetryTarget()) {
  const f = recordFieldNames();
  return [
    'GateTest sends anonymized scan statistics to improve the engine.',
    `Host:   ${target.host}`,
    `Sent:   ${f.record.join(', ')}`,
    `        per module: ${f.module.join(', ')}`,
    `        per rule:   ${f.rule.join(', ')}`,
    '        (module and rule names plus integer counts — never your code, file paths,',
    '        finding text or repository names)',
    ...HOW_TO_OFF,
  ];
}

/**
 * Print the notice once per machine, before the first upload. Writes nothing
 * and marks nothing when an upload would be refused anyway (host guard) —
 * the notice appears when an upload first could happen.
 *
 * @param {{ write: (text: string) => void, marker?: string, target?: object }} opts
 * @returns {boolean} whether the notice was shown
 */
function maybeNoticeTelemetry({ write, marker = NOTICE_MARKER, target = resolveTelemetryTarget() } = {}) {
  try {
    if (!target.allowed || typeof write !== 'function') return false;
    if (fs.existsSync(marker)) return false;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString(), 'utf-8');
    write('\n  \x1b[2m' + noticeLines(target).join('\n  ') + '\x1b[0m\n');
    return true;
  } catch { return false; } // error-ok: a notice that fails to print must never fail a scan
}

/** Lines for `gatetest --telemetry-status`. */
function telemetryStatusLines(projectRoot, env = process.env) {
  const t = isOffline(env)
    ? { enabled: false, source: 'env', detail: 'GATETEST_OFFLINE (offline mode)' }
    : resolveTelemetry(projectRoot, env);
  const target = resolveTelemetryTarget(env);
  const lines = [
    `Telemetry: ${t.enabled ? 'on' : 'off'}`,
    `Source:    ${t.source} (${t.detail})`,
    `Default:   ${TELEMETRY_DEFAULT} when nothing is set`,
    `Host:      ${target.host || 'invalid endpoint'}${target.allowed ? '' : ' — REFUSED, uploads will not be sent (see GATETEST_TELEMETRY_ALLOW_HOST)'}`,
  ];
  if (t.enabled) lines.push('', ...HOW_TO_OFF);
  return lines;
}

module.exports = { noticeLines, maybeNoticeTelemetry, telemetryStatusLines, NOTICE_MARKER };
