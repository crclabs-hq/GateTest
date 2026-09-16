#!/usr/bin/env node
'use strict';

/**
 * Blocking on Craig — the ONE always-current list of things only the owner
 * can do (account settings, secrets, tokens, DNS).
 *
 *   node scripts/ops/blocking-on-craig.js --check      # validate; exit 1 if invalid
 *   node scripts/ops/blocking-on-craig.js --markdown   # render the queue (default)
 *   node scripts/ops/blocking-on-craig.js --json       # items + ages + summary
 *   node scripts/ops/blocking-on-craig.js --file other.json --today 2026-09-16
 *
 * Why this exists: every audit lists the Craig-only items, and then they sit
 * for days because a bullet in a closed PR is easy to ignore. The JSON at
 * docs/ops/blocking-on-craig.json is the single source of truth; this script
 * validates it, computes how long each item has been waiting, and renders the
 * Markdown that .github/workflows/blocking-on-craig.yml commits back to
 * docs/ops/BLOCKING-ON-CRAIG.md and pins as an issue every morning. Ages are
 * computed from `since`, never typed — the number goes up on its own until
 * the item is marked `"done": true`.
 *
 * Exit codes: 0 valid, 1 invalid data, 2 the script could not run (bad flag,
 * unreadable file). Node 22 builtins only.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'docs', 'ops', 'blocking-on-craig.json');
const SOURCE_REL = 'docs/ops/blocking-on-craig.json';

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86400000;

// Every key an item may carry, with its JSON type. Anything else is an
// error — a typo'd key ("steps") would otherwise be silently ignored and
// the item would render without its instructions.
const REQUIRED_KEYS = {
  id: 'string',
  title: 'string',
  since: 'string',
  unblocks: 'string',
  step: 'string',
  where: 'string',
  priority: 'number',
  done: 'boolean',
};
const OPTIONAL_KEYS = { after: 'array' };

const PRIORITY_HEADINGS = {
  1: 'P1 — do first',
  2: 'P2 — this week',
  3: 'P3 — once the P1s are clear',
};

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` and a real calendar day (2026-02-30 is not a date). */
function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function utcDay(iso) {
  const m = DATE_RE.exec(iso);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Whole days from `since` to `today` (both ISO dates); never negative. */
function ageDays(since, today) {
  if (!isIsoDate(since) || !isIsoDate(today)) {
    throw new TypeError(`ageDays needs two ISO dates, got ${JSON.stringify(since)} and ${JSON.stringify(today)}`);
  }
  return Math.max(0, Math.round((utcDay(today) - utcDay(since)) / MS_PER_DAY));
}

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function jsonType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/**
 * Returns an array of error strings; empty means valid. Every rule here has
 * a control pair in tests/blocking-on-craig.test.js.
 */
function validate(data) {
  const errors = [];
  if (jsonType(data) !== 'object') {
    return ['top level must be an object with "updated" and "items"'];
  }
  for (const key of Object.keys(data)) {
    if (key !== 'updated' && key !== 'items') errors.push(`unknown top-level key "${key}"`);
  }
  if (!isIsoDate(data.updated)) {
    errors.push(`"updated" must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(data.updated)}`);
  }
  if (!Array.isArray(data.items)) {
    errors.push('"items" must be an array');
    return errors;
  }

  const seen = new Map();
  data.items.forEach((item, index) => {
    const label = jsonType(item) === 'object' && typeof item.id === 'string' ? `item "${item.id}"` : `item #${index}`;
    if (jsonType(item) !== 'object') {
      errors.push(`${label} must be an object`);
      return;
    }
    for (const [key, type] of Object.entries(REQUIRED_KEYS)) {
      if (!(key in item)) {
        errors.push(`${label} is missing "${key}"`);
      } else if (jsonType(item[key]) !== type) {
        errors.push(`${label}: "${key}" must be a ${type}, got ${jsonType(item[key])}`);
      } else if (type === 'string' && item[key].trim() === '') {
        errors.push(`${label}: "${key}" must not be empty`);
      }
    }
    for (const key of Object.keys(item)) {
      if (!(key in REQUIRED_KEYS) && !(key in OPTIONAL_KEYS)) errors.push(`${label} has unknown key "${key}"`);
    }
    if (typeof item.id === 'string') {
      if (!ID_RE.test(item.id)) errors.push(`${label}: id must be kebab-case (a-z, 0-9, single hyphens)`);
      if (seen.has(item.id)) errors.push(`duplicate id "${item.id}" (items #${seen.get(item.id)} and #${index})`);
      else seen.set(item.id, index);
    }
    if (typeof item.since === 'string') {
      if (!isIsoDate(item.since)) {
        errors.push(`${label}: "since" must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(item.since)}`);
      } else if (isIsoDate(data.updated) && utcDay(item.since) > utcDay(data.updated)) {
        errors.push(`${label}: "since" ${item.since} is after "updated" ${data.updated}`);
      }
    }
    if (typeof item.priority === 'number' && !(Number.isInteger(item.priority) && item.priority >= 1 && item.priority <= 3)) {
      errors.push(`${label}: "priority" must be 1, 2 or 3, got ${item.priority}`);
    }
    if ('after' in item) {
      if (!Array.isArray(item.after) || item.after.some((a) => typeof a !== 'string')) {
        errors.push(`${label}: "after" must be an array of item ids`);
      }
    }
  });

  // Dependency ids are checked once every id is known, so order in the file
  // does not matter.
  for (const item of data.items) {
    if (jsonType(item) !== 'object' || !Array.isArray(item.after)) continue;
    for (const dep of item.after) {
      if (typeof dep !== 'string') continue;
      if (dep === item.id) errors.push(`item "${item.id}": "after" must not name itself`);
      else if (!seen.has(dep)) errors.push(`item "${item.id}": "after" names unknown id "${dep}"`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Summary + rendering
// ---------------------------------------------------------------------------

function openItems(data) {
  return data.items.filter((item) => !item.done);
}

/** Open count and the oldest open item. Assumes `validate` passed. */
function summarize(data, today = todayIso()) {
  const open = openItems(data);
  let oldest = null;
  for (const item of open) {
    const age = ageDays(item.since, today);
    if (!oldest || age > oldest.ageDays) oldest = { id: item.id, since: item.since, ageDays: age };
  }
  const count = open.length;
  const summary = {
    count,
    oldestDays: oldest ? oldest.ageDays : 0,
    oldestId: oldest ? oldest.id : null,
    oldestSince: oldest ? oldest.since : null,
  };
  summary.line = summaryLine(summary);
  summary.issueTitle = issueTitle(summary);
  return summary;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "N items blocking, oldest X days" — the one-liner the workflow and issue use. */
function summaryLine(summary) {
  if (summary.count === 0) return '0 items blocking';
  return `${plural(summary.count, 'item')} blocking, oldest ${plural(summary.oldestDays, 'day')}`;
}

function issueTitle(summary) {
  return `Blocking on Craig — ${summaryLine(summary).replace(/ blocking/, '')}`;
}

/** Markdown-safe single line: collapse whitespace so a step never breaks a bullet. */
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

function render(data, today = todayIso()) {
  const summary = summarize(data, today);
  const open = openItems(data);
  const done = data.items.filter((item) => item.done);
  const out = [];

  out.push('# Blocking on Craig');
  out.push('');
  out.push(`> Generated ${today} by \`scripts/ops/blocking-on-craig.js\` from \`${SOURCE_REL}\` (updated ${data.updated}). Edit the JSON, not this file — the daily workflow re-renders it and the pinned \`craig-only\` issue.`);
  out.push('');
  if (summary.count === 0) {
    out.push(`**${summary.line}.** Nothing on this list needs the owner. Add an item the moment an audit finds one.`);
  } else {
    out.push(`**${summary.line}** — \`${summary.oldestId}\`, waiting since ${summary.oldestSince}.`);
    out.push('');
    out.push('Only the owner can do these: account settings, secrets, tokens, DNS. Each one says what turns green when it is done. Finished one? Set `"done": true` in the JSON and the number above drops on the next run.');
  }

  for (const priority of [1, 2, 3]) {
    const group = open
      .filter((item) => item.priority === priority)
      .sort((a, b) => utcDay(a.since) - utcDay(b.since) || a.id.localeCompare(b.id));
    if (group.length === 0) continue;
    out.push('');
    out.push(`## ${PRIORITY_HEADINGS[priority]} (${group.length})`);
    for (const item of group) {
      const age = ageDays(item.since, today);
      out.push('');
      out.push(`### ${oneLine(item.title)}`);
      out.push('');
      out.push(`- **Id:** \`${item.id}\` — waiting **${plural(age, 'day')}** (since ${item.since})`);
      out.push(`- **Unblocks:** ${oneLine(item.unblocks)}`);
      out.push(`- **Where:** ${oneLine(item.where)}`);
      out.push(`- **Step:** ${oneLine(item.step)}`);
      if (Array.isArray(item.after) && item.after.length) {
        out.push(`- **After:** ${item.after.map((id) => `\`${id}\``).join(', ')}`);
      }
    }
  }

  if (done.length) {
    out.push('');
    out.push(`## Done (${done.length})`);
    out.push('');
    for (const item of done) out.push(`- ~~${oneLine(item.title)}~~ (\`${item.id}\`)`);
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function load(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

function parseArgs(argv) {
  const opts = { mode: 'markdown', file: DEFAULT_FILE, today: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check' || a === '--json' || a === '--markdown') opts.mode = a.slice(2);
    else if (a === '--file' && argv[i + 1]) opts.file = path.resolve(argv[++i]);
    else if (a === '--today' && argv[i + 1]) opts.today = argv[++i];
    else if (a === '--help' || a === '-h') opts.mode = 'help';
    else throw new Error(`unknown argument "${a}" (use --check, --json, --markdown, --file <path>, --today YYYY-MM-DD)`);
  }
  if (opts.today !== null && !isIsoDate(opts.today)) throw new Error(`--today must be YYYY-MM-DD, got "${opts.today}"`);
  return opts;
}

function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`blocking-on-craig: ${err.message}\n`);
    return 2;
  }
  if (opts.mode === 'help') {
    io.stdout.write('usage: blocking-on-craig.js [--check | --json | --markdown] [--file <json>] [--today YYYY-MM-DD]\n');
    return 0;
  }
  let data;
  try {
    data = load(opts.file);
  } catch (err) {
    io.stderr.write(`blocking-on-craig: ${err.message}\n`);
    return 2;
  }
  const errors = validate(data);
  if (errors.length) {
    io.stderr.write(`blocking-on-craig: ${opts.file} is INVALID (${plural(errors.length, 'error')}):\n`);
    for (const e of errors) io.stderr.write(`  - ${e}\n`);
    return 1;
  }
  const today = opts.today || todayIso();
  const summary = summarize(data, today);
  if (opts.mode === 'check') {
    io.stderr.write(`blocking-on-craig: OK — ${data.items.length} items in ${path.relative(process.cwd(), opts.file) || opts.file}; ${summary.line}\n`);
    return 0;
  }
  if (opts.mode === 'json') {
    const items = data.items.map((item) => ({ ...item, ageDays: ageDays(item.since, today) }));
    io.stdout.write(`${JSON.stringify({ updated: data.updated, today, summary, items }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(render(data, today));
  return 0;
}

module.exports = {
  DEFAULT_FILE,
  ageDays,
  isIsoDate,
  issueTitle,
  load,
  render,
  summarize,
  summaryLine,
  todayIso,
  validate,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
