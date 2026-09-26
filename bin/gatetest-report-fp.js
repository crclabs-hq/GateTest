#!/usr/bin/env node

/**
 * gatetest report-fp — the false-positive SLA's first entrance (the Fifty,
 * move 20; complaint C1: "every scanner is too noisy, nobody publishes how
 * fast they fix a false positive").
 *
 * This command sends NOTHING itself. It prints a prefilled GitHub issue URL
 * for `.github/ISSUE_TEMPLATE/false-positive.yml` — the second entrance —
 * so the operator reviews and submits it themselves. The finding id is the
 * same `module:rule` identity `.gatetestignore` already uses (one
 * definition, `src/core/ignore-file.js` / `src/core/rule-identity.js`;
 * `--accept-risk` will read the same id once it ships).
 *
 * A file snippet is included ONLY when the operator explicitly passes
 * --file (and optionally --line); nothing is read from disk otherwise.
 */

'use strict';

const fs = require('fs');

const REPO = 'crclabs-hq/GateTest';
const ISSUE_TEMPLATE = 'false-positive.yml';
const SNIPPET_CONTEXT_LINES = 3;

const HELP = `
  gatetest report-fp <module:rule> --reason "<text>" [options]

  Print a prefilled GitHub issue URL reporting a false positive. Nothing is
  sent — the URL opens the issue form for you to review and submit.

  USAGE
    gatetest report-fp secrets:apiKey --reason "matches a rejected placeholder"
    gatetest report-fp crossFileTaint:sqlInjection --reason "escaped by escapeForLike()" \\
      --file src/db/query.js --line 42 --expected "should not fire"

  OPTIONS
    --reason <text>    Why the finding is wrong (required)
    --file <path>      Source file to pull a short snippet from (optional —
                        nothing is read from disk unless you pass this)
    --line <n>         Line number inside --file to centre the snippet on
    --expected <text>  What the correct verdict should have been
    --json             Print the fields + URL as JSON instead of text
    --help             Show this help
`;

function getFlag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

function findingIdProblem(id) {
  if (!id) return 'a finding id is required — the module:rule id .gatetestignore uses (e.g. secrets:apiKey)';
  if (id.startsWith('-')) return `expected a finding id, got a flag: ${id}`;
  return null;
}

/**
 * A few lines of context around --line, or the whole file when it is short
 * enough. Read errors are reported, never thrown — a typo'd --file must not
 * crash the report.
 */
function readSnippet(file, line) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { error: `could not read ${file}: ${err.message}` };
  }
  const lines = text.split(/\r?\n/);
  if (!line || !Number.isInteger(line) || line < 1) {
    return { snippet: lines.slice(0, 20).join('\n'), truncated: lines.length > 20 };
  }
  const start = Math.max(0, line - 1 - SNIPPET_CONTEXT_LINES);
  const end = Math.min(lines.length, line + SNIPPET_CONTEXT_LINES);
  return { snippet: lines.slice(start, end).join('\n'), truncated: false };
}

function buildIssueUrl(fields) {
  const params = new URLSearchParams();
  params.set('template', ISSUE_TEMPLATE);
  params.set('title', `False positive: ${fields.ruleId}`);
  params.set('labels', 'false-positive');
  params.set('rule-id', fields.ruleId);
  params.set('finding-message', fields.reason);
  if (fields.snippet) params.set('snippet', fields.snippet);
  params.set('engine-version', fields.engineVersion);
  if (fields.expectedVerdict) params.set('expected-verdict', fields.expectedVerdict);
  return `https://github.com/${REPO}/issues/new?${params.toString()}`;
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }

  // First token that is not a flag and not a flag's value.
  const VALUE_FLAGS = new Set(['--reason', '--file', '--line', '--expected']);
  let positional;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) i++; continue; }
    positional = a;
    break;
  }

  const problem = findingIdProblem(positional);
  if (problem) {
    console.error(`report-fp: ${problem}`);
    console.error(HELP);
    return 2;
  }

  const reason = getFlag(argv, '--reason');
  if (!reason) {
    console.error('report-fp: --reason "<text>" is required — why is this a false positive?');
    return 2;
  }

  const file = getFlag(argv, '--file');
  const lineArg = getFlag(argv, '--line');
  const line = lineArg ? parseInt(lineArg, 10) : undefined;
  let snippet;
  if (file) {
    const result = readSnippet(file, line);
    if (result.error) {
      console.error(`report-fp: ${result.error}`);
      return 2;
    }
    snippet = result.snippet;
  }

  const expectedVerdict = getFlag(argv, '--expected');
  const engineVersion = require('../package.json').version;

  const fields = { ruleId: positional, reason, snippet, expectedVerdict, engineVersion };
  const url = buildIssueUrl(fields);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...fields, url }, null, 2));
    return 0;
  }

  console.log(`Finding:  ${positional}`);
  console.log(`Reason:   ${reason}`);
  if (snippet) console.log(`Snippet:  ${file}${line ? `:${line}` : ''} (${snippet.split('\n').length} lines)`);
  if (expectedVerdict) console.log(`Expected: ${expectedVerdict}`);
  console.log(`Engine:   v${engineVersion}`);
  console.log('');
  console.log('Nothing has been sent. Review and submit this issue yourself:');
  console.log(url);
  return 0;
}

module.exports = { main, buildIssueUrl, readSnippet };
