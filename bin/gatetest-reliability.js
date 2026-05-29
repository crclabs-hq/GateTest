#!/usr/bin/env node
/**
 * gatetest-reliability — CLI entry for the continuous reliability sweep.
 *
 * Loads the corpus under `--corpus <path>` (default
 * `reliability-corpus/`), runs every case through the scanner adapter,
 * prints the report.
 *
 * Painkiller (Bible Forbidden #25): NEVER exits non-zero on case
 * failures. The nightly workflow opens a PR with the drift report
 * when regressions land; the CLI exit code is reserved for argument
 * errors or outright crashes.
 *
 * Examples:
 *   gatetest-reliability
 *   gatetest-reliability --corpus reliability-corpus --url-only
 *   gatetest-reliability --json > report.json
 */

"use strict";

const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { runReliabilityCli } = require(path.join(ROOT, "website/app/lib/reliability/cli-runner.js"));

const USAGE = `
Usage: gatetest-reliability [flags]

Flags:
  --corpus <path>         Corpus root (default: reliability-corpus/)
  --gatetest-bin <path>   Path to gatetest CLI (default: bin/gatetest.js)
  --category <name>       Only run this category (repeatable)
  --url-only              Only run url-* cases
  --code-only             Only run code-target cases
  --determinism           Run each scan twice and verify identical output
  --json                  Emit JSON instead of markdown
  --help, -h              Show this usage

Painkiller: this CLI never exits non-zero on case failures. The
reliability run is informational. Hard non-zero exit only on argument
errors or outright crashes.
`.trim();

function parseArgs(argv) {
  const out = {
    corpusRoot: path.join(ROOT, "reliability-corpus"),
    gatetestBin: path.join(ROOT, "bin/gatetest.js"),
    includeCategories: [],
    urlOnly: false,
    codeOnly: false,
    repeatForDeterminism: false,
    json: false,
    help: false,
    errors: [],
  };
  const args = argv.slice();
  while (args.length > 0) {
    const a = args.shift();
    switch (a) {
      case "--corpus": out.corpusRoot = args.shift() || out.corpusRoot; break;
      case "--gatetest-bin": out.gatetestBin = args.shift() || out.gatetestBin; break;
      case "--category": {
        const v = args.shift();
        if (v) out.includeCategories.push(v);
        break;
      }
      case "--url-only": out.urlOnly = true; break;
      case "--code-only": out.codeOnly = true; break;
      case "--determinism": out.repeatForDeterminism = true; break;
      case "--json": out.json = true; break;
      case "--help":
      case "-h": out.help = true; break;
      default:
        if (a && a.startsWith("--")) out.errors.push(`unknown flag: ${a}`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (args.errors.length > 0) {
    process.stderr.write(`[gatetest-reliability] argument errors:\n`);
    for (const e of args.errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write(`\n${USAGE}\n`);
    return 2;
  }
  let result;
  try {
    result = await runReliabilityCli({
      corpusRoot: args.corpusRoot,
      gatetestBin: args.gatetestBin,
      includeCategories: args.includeCategories,
      repeatForDeterminism: args.repeatForDeterminism,
      urlOnly: args.urlOnly,
      codeOnly: args.codeOnly,
      json: args.json,
    });
  } catch (err) {
    process.stderr.write(`[gatetest-reliability] fatal: ${err && err.stack ? err.stack : String(err)}\n`);
    return 2;
  }
  process.stdout.write(result.output + "\n");
  return result.exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[gatetest-reliability] crash: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(2);
  });
