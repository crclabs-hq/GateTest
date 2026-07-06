#!/usr/bin/env node

/**
 * gatetest trace — CLI entry for stack-trace source-map resolution.
 * Calls the exact same core engine (src/core/source-map-resolver.js) as
 * the MCP `resolve_stack_trace` tool — one implementation, two entry points.
 */

const fs = require('fs');
const { resolveStackTrace } = require('../src/core/source-map-resolver');

const TRACE_HELP = `
  gatetest trace <file|-> [options]

  Resolve a minified/bundled JS stack trace back to its original source
  file:line:column via source maps (inline data: URI or sibling .map file).

  USAGE
    gatetest trace stack.txt          Read stack trace text from a file
    cat error.log | gatetest trace -  Read stack trace text from stdin

  OPTIONS
    --json    Emit machine-readable JSON instead of the text report
    --help    Show this help
`;

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function readInput(source) {
  if (!source || source === '-') return readStdin();
  return fs.readFileSync(source, 'utf8');
}

function renderText(resolved) {
  if (resolved.length === 0) {
    return 'No stack frames recognised in the input (expected "at file:line:col" or "fn@file:line:col" lines).';
  }
  const lines = [];
  resolved.forEach((f, i) => {
    lines.push(`Frame ${i + 1}${f.functionName ? ` — ${f.functionName}` : ''}`);
    lines.push(`  Generated: ${f.file}:${f.line}:${f.column}`);
    if (f.resolution.ok) {
      const o = f.resolution.original;
      lines.push(`  Original:  ${o.source}:${o.line}:${o.column}${o.name ? ` (${o.name})` : ''}`);
      if (o.snippet) lines.push(`             ${o.snippet.trim()}`);
    } else {
      lines.push(`  Unresolved: ${f.resolution.reason}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(TRACE_HELP);
    return 0;
  }

  const asJson = argv.includes('--json');
  const positional = argv.find((a) => a === '-' || !a.startsWith('-'));

  if (!positional) {
    console.error('Error: pass a file path or "-" for stdin. See "gatetest trace --help".');
    return 1;
  }

  let text;
  try {
    text = await readInput(positional);
  } catch (err) {
    console.error(`Error reading input: ${err.message}`);
    return 1;
  }

  const resolved = resolveStackTrace(text);
  console.log(asJson ? JSON.stringify(resolved, null, 2) : renderText(resolved));
  return 0;
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0));
}
