'use strict';
/**
 * Onboarding mode — `--report-only-until <date>` (LAUNCH_BOARD row 15 / the
 * Fifty, move 15).
 *
 * `--report-only` (existing, see runner.js `reportOnly`) makes a scan
 * permanently advisory: it never fails the gate, on any run, forever, until
 * a human remembers to remove the flag. That is fine for local dev but a
 * bad default for a CI onboarding path — teams either never come back to
 * flip it to enforcing (a gate that can never turn red is not a gate,
 * Doctrine #1) or skip the advisory phase altogether and eat the whole
 * pre-existing backlog on day one.
 *
 * `--report-only-until <YYYY-MM-DD>` is TIME-BOXED report-only: advisory up
 * to (not including) the date, then automatically ignored from that day on
 * — the gate enforces with no second flag to remember to flip and no PR to
 * revert. `--strict` still wins over it, exactly as it wins over
 * `--report-only` (bin/gatetest.js resolves that precedence; this module
 * only resolves the date).
 *
 * Dates are UTC, ISO-8601 calendar dates only (`YYYY-MM-DD`) — no
 * time-of-day, no local-timezone ambiguity about whether "the 15th" has
 * started yet on a CI runner in a different timezone than the customer.
 *
 * One definition, imported (Doctrine #4): both the CLI flag (parsed as a
 * plain string by `cli-args.js`) and the `.gatetest.json` `reportOnlyUntil`
 * key resolve through `resolveReportOnlyUntil` here. `GateTestRunner`'s
 * constructor reads the CLI value first, falling back to the config key —
 * the same explicit-flag-beats-config precedent as `gate.modelVerdictsBlock`.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Is `str` a real calendar date in strict `YYYY-MM-DD` form? */
function isValidIsoDate(str) {
  if (typeof str !== 'string' || !ISO_DATE_RE.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects calendar overflow (2026-02-30 parses to March 2 without this).
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve report-only-until mode for one run.
 *
 * @param {string|null|undefined} raw  `--report-only-until` value, or the
 *   `.gatetest.json` `reportOnlyUntil` key, or absent/null/'' when neither
 *   requested onboarding mode.
 * @param {Date} [now]  injectable for tests; compared in UTC calendar days.
 * @returns {null | {valid:false, raw:string} | {valid:true, date:string,
 *   active:boolean, expired:boolean, daysLeft:number}}
 *   - `null` — onboarding mode not requested at all.
 *   - `valid:false` — malformed value (not a real ISO date); the caller
 *     decides how loud to be (a bad CLI flag is a usage error, a bad config
 *     value is a warning — see bin/gatetest.js and config.js).
 *   - `valid:true, active:true` — strictly before the date: report only.
 *   - `valid:true, expired:true` — on or after the date: gate enforces.
 *     `daysLeft` is 0 on the date itself and negative further past it.
 */
function resolveReportOnlyUntil(raw, now = new Date()) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!isValidIsoDate(raw)) return { valid: false, raw: String(raw) };
  const [y, m, d] = raw.split('-').map(Number);
  const untilMs = Date.UTC(y, m - 1, d);
  const nowMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysLeft = Math.round((untilMs - nowMs) / MS_PER_DAY);
  const active = nowMs < untilMs;
  return { valid: true, date: raw, active, expired: !active, daysLeft };
}

module.exports = { ISO_DATE_RE, isValidIsoDate, resolveReportOnlyUntil };
