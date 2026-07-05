#!/usr/bin/env node

/**
 * gatetest blame — CLI entry for regression-commit blame.
 * Calls the exact same core engine (src/core/regression-bisector.js) as
 * the MCP `blame_regression` tool — one implementation, two entry points.
 * Read-only: never checks out or mutates the working tree.
 */

const fs = require('fs');
const {
  blameLine,
  blameRange,
  showCommit,
  findLikelyRegressionCommit,
} = require('../src/core/regression-bisector');

const BLAME_HELP = `
  gatetest blame <file> --line <n> [options]

  Find which git commit introduced the code at a specific file:line —
  read-only, never checks out or mutates the working tree.

  USAGE
    gatetest blame src/app.js --line 42
    gatetest blame src/app.js --line 40 --end-line 60
    gatetest blame --commit <hash>
    gatetest blame --hits hits.json     (JSON array of {file, line})

  OPTIONS
    --line <n>       Line number (1-based)
    --end-line <n>   End of a range (use with --line as the range start)
    --commit <hash>  Fetch a known commit's message + diff directly
    --hits <file>    Path to a JSON file: [{ "file": "...", "line": n }, ...]
    --project <path> Repository root (default: cwd)
    --json           Emit machine-readable JSON instead of the text report
    --help           Show this help
`;

const VALUE_FLAGS = new Set(['--line', '--end-line', '--commit', '--hits', '--project']);

function getFlag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

function getPositional(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

function renderText(mode, result) {
  if (mode === 'commit') {
    return [
      `Commit ${result.shortHash}`,
      `Author: ${result.author} <${result.authorEmail}>`,
      `Date:   ${result.date}`,
      `Message: ${result.message}`,
      '',
      result.stat || '',
      '',
      result.diff,
      result.truncated ? '\n(diff truncated)' : '',
    ].join('\n');
  }
  if (mode === 'hits') {
    const lines = ['Likely regression commit(s) — ranked by hit count', ''];
    if (result.candidates.length === 0) {
      lines.push('None of the given hits could be blamed (files untracked or lines out of range).');
    } else {
      result.candidates.forEach((c, i) => {
        lines.push(`${i + 1}. ${c.shortHash} — ${c.hitCount} hit(s) across ${c.fileCount} file(s)`);
        lines.push(`   ${c.summary || '(no summary)'} — ${c.author} — ${c.date}`);
      });
    }
    return lines.join('\n');
  }
  if (mode === 'range') {
    const lines = [`Commits touching ${result.file}:${result.startLine}-${result.endLine}`, ''];
    result.commits.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.shortHash} — ${c.lineCount} line(s) — ${c.summary || '(no summary)'} — ${c.author} — ${c.date}`);
    });
    return lines.join('\n');
  }
  // mode === 'line'
  return [
    `${result.shortHash} introduced this line`,
    `Author: ${result.author} <${result.authorEmail}>`,
    `Date:   ${result.date}`,
    `Message: ${result.summary}`,
    `Line:    ${result.lineContent}`,
  ].join('\n');
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(BLAME_HELP);
    return 0;
  }

  const asJson = argv.includes('--json');
  const cwd = getFlag(argv, '--project') || process.cwd();
  const commit = getFlag(argv, '--commit');
  const hitsFile = getFlag(argv, '--hits');
  const lineArg = getFlag(argv, '--line');
  const endLineArg = getFlag(argv, '--end-line');
  const file = getPositional(argv);

  let result;
  let mode;

  if (commit) {
    result = showCommit({ cwd, hash: commit });
    mode = 'commit';
  } else if (hitsFile) {
    let hits;
    try {
      hits = JSON.parse(fs.readFileSync(hitsFile, 'utf8'));
    } catch (err) {
      console.error(`Error reading --hits file: ${err.message}`);
      return 1;
    }
    result = findLikelyRegressionCommit({ cwd, hits });
    mode = 'hits';
  } else if (file && lineArg) {
    const line = parseInt(lineArg, 10);
    if (endLineArg) {
      result = blameRange({ cwd, file, startLine: line, endLine: parseInt(endLineArg, 10) });
      mode = 'range';
    } else {
      result = blameLine({ cwd, file, line });
      mode = 'line';
    }
  } else {
    console.error('Error: pass <file> --line <n>, --commit <hash>, or --hits <file>. See "gatetest blame --help".');
    return 1;
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (!result.ok) {
    console.error(`Error: ${result.reason}`);
    return 1;
  }

  console.log(renderText(mode, result));
  return 0;
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0));
}
