/**
 * Retry-Hygiene Module — tight retry loops, no backoff, unbounded.
 *
 * Retries are the second-most common silent performance killer
 * after N+1. Every backend has them. Nobody writes them well:
 *
 *   a) "Retry on failure" with a constant 100ms sleep → thundering
 *      herd on the next downstream blip. One 5xx spike becomes
 *      sustained overload.
 *   b) `while (!success)` with no max attempts → a permanent outage
 *      turns into infinite retries, filling logs, pinning CPU.
 *   c) `setTimeout(fn, 1000)` repeat without jitter → every client
 *      retries in lockstep, synchronised stampede.
 *   d) Retry after a 4xx → 400/401/403 are permanent failures.
 *      Retrying them wastes time and sometimes locks accounts.
 *
 * Competitors: nothing. Runtime profilers notice the symptom after
 * it's already knocked down an upstream. We catch it statically,
 * pre-commit, across every HTTP client.
 *
 * Approach (line-heuristic, no AST):
 *
 *   1. Walk JS/TS files.
 *   2. Find retry-shaped blocks:
 *        - `while (!ok)` / `while (!success)` / `while (retries < N)`
 *          / `while (true)` / `for (;;)` — loops where the exit
 *          condition depends on a success variable
 *        - `async-retry`, `p-retry`, `retry(...)` library calls
 *        - explicit `catch { setTimeout(fn, N); ... }` retry patterns
 *   3. Within each retry block, flag:
 *        - `sleep(N)` / `setTimeout(fn, N)` / `delay(N)` with a
 *          LITERAL number (no `Math.random`, no `* attempt`)
 *          → missing jitter + backoff
 *        - no max-attempts counter → unbounded retry
 *        - retry after `res.status === 4xx` without a status guard
 *          → retrying permanent failures
 *
 * Rules:
 *
 *   error:   `while (true)` / `for (;;)` containing an `await` to an
 *            HTTP client, with no visible break on max-attempts.
 *            (rule: `retry-hygiene:unbounded-loop:<rel>:<line>`)
 *
 *   warning: Retry block with a literal sleep/delay that has no
 *            multiplier by attempt count and no `Math.random()` term.
 *            (rule: `retry-hygiene:no-backoff:<rel>:<line>`)
 *
 *   warning: Retry block with a constant sleep and no `Math.random`
 *            anywhere in the window — no jitter means thundering
 *            herd across multiple clients.
 *            (rule: `retry-hygiene:no-jitter:<rel>:<line>`)
 *
 *   warning: Explicit retry inside a `catch` that matches a 4xx
 *            status error, without a status-guard that filters it
 *            out. Retrying 400/401/403 is wasteful.
 *            (rule: `retry-hygiene:retry-on-4xx:<rel>:<line>`)
 *
 *   info:    Retry block using `async-retry` / `p-retry` / `retry`
 *            library — these libraries handle backoff + jitter for
 *            you. Recorded for dashboard confidence.
 *            (rule: `retry-hygiene:library-ok:<rel>:<line>`)
 *
 * TODO(gluecron): host-neutral; no change needed when we add
 * Gluecron.
 */

const fs = require('fs');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');

// Directory excludes beyond what `BaseModule._collectFiles` already skips
// (node_modules, .git, dist, build, coverage, .next, out, …). The old
// private walk (removed under KI #104) also skipped these.
const EXTRA_EXCLUDES = ['.terraform'];

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

// Every deciding regex runs on the MASKED line (BaseModule._maskedLines:
// string, regex and comment content blanked, offsets preserved). The raw line
// is read only for the loop head quoted in a message and for a retry
// library's name, which lives inside the import's quotes.
function usesRetryLib(codeText, rawText) {
  const open = /\b(?:require|import)\s*\(?\s*['"`]/g;
  let m;
  while ((m = open.exec(codeText)) !== null) {
    if (/^(?:async-retry|p-retry|retry|cockatiel|opossum)['"`]/.test(rawText.slice(m.index + m[0].length))) return true;
  }
  return false;
}

// Identify any HTTP / network call shape inside a retry block.
const HTTP_CALL_RES = [
  /\bfetch\s*\(/,
  /\baxios\.(?:get|post|put|patch|delete|head|options|request)\s*\(/,
  /\baxios\s*\(/,
  /\bgot\.(?:get|post|put|patch|delete|head)\s*\(/,
  /\brequest\s*\(\s*['"`{]/,
  /\bhttp\.(?:request|get)\s*\(/,
  /\bhttps\.(?:request|get)\s*\(/,
  /\bneedle\.(?:get|post|put|patch|delete|head)\s*\(/,
  /\bsuperagent\.(?:get|post|put|patch|delete)\s*\(/,
];

// Library-backed retry wrappers — these ship with backoff + jitter.
const RETRY_LIB_RES = [
  /\bretry\s*\(\s*async/,
  /\bpRetry\s*\(/,
  /\basyncRetry\s*\(/,
];

// Sleep / delay primitives with a literal-number first argument.
// Capture group = the numeric literal.
const LITERAL_SLEEP_RES = [
  /\bsetTimeout\s*\(\s*[^,]+,\s*(\d+)\s*[),]/,
  /\bsleep\s*\(\s*(\d+)\s*\)/,
  /\bdelay\s*\(\s*(\d+)\s*\)/,
  /\bawait\s+new\s+Promise\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*setTimeout\s*\([^,]+,\s*(\d+)\s*\)\s*\)/,
];

class RetryHygieneModule extends BaseModule {
  constructor() {
    super(
      'retryHygiene',
      'Retry hygiene — tight retry loops, no backoff, unbounded retry, retry-on-4xx across fetch, axios, got, node-http',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    // Shared walk from BaseModule — honours --diff/--pr scoping (KI #104).
    const files = this._collectFiles(projectRoot, [...SOURCE_EXTS], EXTRA_EXCLUDES);

    if (files.length === 0) {
      result.addCheck('retry-hygiene:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('retry-hygiene:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s) for retry hygiene`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('retry-hygiene:summary', true, {
      severity: 'info',
      message: `Retry hygiene scan: ${files.length} file(s), ${issues} issue(s)`,
    });
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }

    const rel = repoRelative(projectRoot, file);
    const lines = content.split(/\r?\n/);
    const masked = this._maskedLines(content);
    let issues = 0;

    // Find retry-shaped loop blocks first. A retry block is a loop
    // whose body contains an HTTP call AND either awaits a `sleep`
    // or matches a `while (!ok)` / `for (;;)` / `while (true)` head.
    const retryBlocks = this._findRetryBlocks(masked);

    for (const block of retryBlocks) {
      const rawHead = lines[block.start] || '';
      const head = masked[block.start] || '';
      const body = masked.slice(block.start, block.end + 1).join('\n');
      const rawBody = lines.slice(block.start, block.end + 1).join('\n');

      // Rule: library-backed retry → info.
      if (RETRY_LIB_RES.some((re) => re.test(head) || re.test(body)) || usesRetryLib(body, rawBody)) {
        result.addCheck(`retry-hygiene:library-ok:${rel}:${block.start + 1}`, true, {
          severity: 'info',
          file: rel,
          line: block.start + 1,
          message: `${rel}:${block.start + 1} retry uses a retry library (async-retry/p-retry/retry/cockatiel) — backoff + jitter expected`,
        });
        continue;
      }

      // Rule: unbounded loop — `while (true)` or `for (;;)` with an
      // HTTP call and no `break` in the body.
      const isInfinite = /\bwhile\s*\(\s*true\s*\)/.test(head) || /\bfor\s*\(\s*;\s*;\s*\)/.test(head);
      const hasBreak = /\bbreak\b/.test(body);
      const hasMaxAttempts = /\b(?:attempts?|tries|retries|maxAttempts|MAX_[A-Z_]*)\b/.test(body);
      if (isInfinite && !hasBreak && !hasMaxAttempts) {
        issues += this._flag(result, `retry-hygiene:unbounded-loop:${rel}:${block.start + 1}`, {
          severity: 'error',
          file: rel,
          line: block.start + 1,
          message: `${rel}:${block.start + 1} infinite retry loop (\`${rawHead.trim().slice(0, 50)}\`) with no visible \`break\` or max-attempts counter — a permanent upstream failure becomes an infinite loop that pins CPU and fills logs`,
          suggestion: 'Add `if (attempt >= MAX_ATTEMPTS) throw err;` OR use a retry library (async-retry / p-retry) that enforces a bound.',
        });
      }

      // Rule: literal sleep with no multiplier / no jitter.
      // Scan each body line for LITERAL_SLEEP_RES; if the delay
      // argument is a raw number and the surrounding code does NOT
      // multiply by `attempt`/`i`/`n` and does NOT use `Math.random`,
      // flag no-backoff + no-jitter.
      const literalSleep = this._findLiteralSleep(masked, block);
      if (literalSleep) {
        const { lineIdx, delay } = literalSleep;
        const window = masked.slice(Math.max(block.start, lineIdx - 3), Math.min(block.end + 1, lineIdx + 4)).join('\n');
        const hasMultiplier = /(?:attempt|tries|retries|i|n)\s*[*]/.test(window)
          || /Math\.pow\s*\(/.test(window)
          || /\*\*\s*(?:attempt|tries|retries|i|n)/.test(window)
          || /<<\s*(?:attempt|tries|retries|i|n)/.test(window);
        const hasJitter = /Math\.random\s*\(/.test(window)
          || /crypto\.randomInt\s*\(/.test(window);

        if (!hasMultiplier) {
          issues += this._flag(result, `retry-hygiene:no-backoff:${rel}:${lineIdx + 1}`, {
            severity: 'warning',
            file: rel,
            line: lineIdx + 1,
            loopStart: block.start + 1,
            delay,
            message: `${rel}:${lineIdx + 1} retry sleeps a constant ${delay}ms with no backoff multiplier — every retry attempt waits the same duration, thundering-herd on the next upstream blip`,
            suggestion: 'Multiply the delay by attempt count: `sleep(baseMs * 2 ** attempt)` (exponential backoff). Or use async-retry with `factor: 2`.',
          });
        }
        if (!hasJitter) {
          issues += this._flag(result, `retry-hygiene:no-jitter:${rel}:${lineIdx + 1}`, {
            severity: 'warning',
            file: rel,
            line: lineIdx + 1,
            loopStart: block.start + 1,
            message: `${rel}:${lineIdx + 1} retry delay contains no \`Math.random()\` jitter — multiple clients retrying in lockstep cause synchronised traffic spikes`,
            suggestion: 'Add jitter: `sleep(base * (0.5 + Math.random()))`. Or use async-retry with `randomize: true`.',
          });
        }
      }

      // Rule: retry on 4xx — catch block contains a retry trigger
      // AND references a 4xx status without a guard.
      const fourXxRetried = /\b(?:status|statusCode)\s*===?\s*4\d\d\b/.test(body)
        && !/\b(?:status|statusCode)\s*<\s*5\d\d\b/.test(body)
        && !/\b(?:status|statusCode)\s*>=\s*5\d\d\b/.test(body);
      if (fourXxRetried && (isInfinite || this._bodyHasRetryShape(body))) {
        // Only flag if the 4xx status is NOT inside an early-return
        // / throw guard.
        // "Guarded" = bail-out on 4xx (throw/return/break), NOT
        // just an `if (status === 4xx) continue` (which IS retrying).
        const guarded = /\b(?:throw|return|break)\b[^\n;]*(?:status|statusCode)\s*[><=]=?\s*4\d\d/.test(body)
          || /(?:status|statusCode)\s*[><=]=?\s*4\d\d[^\n;]*\b(?:throw|return|break)\b/.test(body);
        if (!guarded) {
          issues += this._flag(result, `retry-hygiene:retry-on-4xx:${rel}:${block.start + 1}`, {
            severity: 'warning',
            file: rel,
            line: block.start + 1,
            message: `${rel}:${block.start + 1} retry block references a 4xx status without an early-return guard — 400/401/403 are permanent failures; retrying them wastes quota and can lock accounts`,
            suggestion: 'Guard: `if (res.status >= 400 && res.status < 500) throw new NonRetryableError(...);` before the retry. Retry only on 5xx and network errors.',
          });
        }
      }
    }

    return issues;
  }

  // A retry block is a loop whose body awaits an HTTP call.
  // Use the same loop-range approach as n-plus-one but restrict
  // to loops that contain HTTP.
  _findRetryBlocks(masked) {
    const blocks = [];
    for (let i = 0; i < masked.length; i += 1) {
      // Match: while (...), for (...), for (;;)
      if (!/\b(?:while|for)\s*\(/.test(masked[i])) continue;

      // Find `{`
      const braceLine = this._findOpenBraceLine(masked, i);
      if (braceLine < 0) continue;
      const end = this._findMatchingBrace(masked, braceLine);
      if (end < 0) continue;

      const bodyStr = masked.slice(braceLine, end + 1).join('\n');
      const hasHttp = HTTP_CALL_RES.some((re) => re.test(bodyStr));
      const hasSleep = LITERAL_SLEEP_RES.some((re) => re.test(bodyStr));
      if (hasHttp || hasSleep) {
        blocks.push({ start: i, end });
      }
    }
    return blocks;
  }

  _bodyHasRetryShape(body) {
    return /\b(?:attempt|tries|retries|retry)\b/i.test(body)
      || LITERAL_SLEEP_RES.some((re) => re.test(body));
  }

  // Prose about sleep(5) is not a call to sleep(5): `// Time-based: send
  // sleep(5), expect response delay` was reported as a real un-backed-off
  // retry (KI #77). The masked lines carry no comment or string content.
  _findLiteralSleep(masked, block) {
    for (let i = block.start; i <= block.end; i += 1) {
      for (const re of LITERAL_SLEEP_RES) {
        const m = masked[i].match(re);
        if (m) {
          const delay = parseInt(m[1] || m[2] || '0', 10);
          if (Number.isFinite(delay) && delay > 0) {
            return { lineIdx: i, delay };
          }
        }
      }
    }
    return null;
  }

  _findOpenBraceLine(masked, startLine) {
    let depthParen = 0;
    let seenOpenParen = false;
    for (let i = startLine; i < masked.length && i < startLine + 30; i += 1) {
      const line = masked[i];
      for (let j = 0; j < line.length; j += 1) {
        const ch = line[j];
        if (ch === '(') { depthParen += 1; seenOpenParen = true; }
        else if (ch === ')') { depthParen -= 1; }
        else if (ch === '{' && (depthParen === 0 || !seenOpenParen)) {
          return i;
        }
      }
    }
    return -1;
  }

  _findMatchingBrace(masked, braceLine) {
    let depth = 0;
    let started = false;
    for (let i = braceLine; i < masked.length && i < braceLine + 200; i += 1) {
      const line = masked[i];
      for (let j = 0; j < line.length; j += 1) {
        const ch = line[j];
        if (ch === '{') { depth += 1; started = true; }
        else if (ch === '}') {
          depth -= 1;
          if (started && depth === 0) return i;
        }
      }
    }
    return -1;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = RetryHygieneModule;
