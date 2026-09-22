// quality:file-length-ok — pattern table + diff parser + AI engine must coexist in one module for atomic updates
/**
 * Fake Fix Detector — The "chicken scratching" killer.
 *
 * When an AI coding assistant is told "fix this bug" and it doesn't understand
 * the root cause, it often patches the symptom instead: deletes the failing
 * assertion, wraps the error in a swallowing try/catch, stubs a function to
 * `return true`, adds `.skip` to the test, or comments out the offending code.
 *
 * This module analyses a git diff and flags those anti-patterns. Two engines:
 *
 *   1. Pattern engine — deterministic regex rules, no API key required.
 *      Catches 80% of chicken scratching with zero false positives on the
 *      high-confidence rules.
 *
 *   2. AI engine — if ANTHROPIC_API_KEY is set, sends the diff to Claude and
 *      asks whether each hunk is a real fix or a symptom patch, with the
 *      explicit prompt "is this disabling the check that exposed the bug?".
 *
 * Both engines run by default. Either can be disabled via module config.
 */

const BaseModule = require('./base-module');
const { resolveDiffBase } = require('../core/diff-base');
const https = require('https');
const { endpoint: anthropicEndpoint, apiPath: anthropicApiPath, apiVersion: anthropicVersion } = require('../core/anthropic-config');

const MODEL_SONNET = 'claude-sonnet-5';
// The cheap model the cost ledger downgrades to at 80% of the ceiling. This
// MUST stay a genuinely different (and cheaper) model from MODEL_SONNET: a
// prior model upgrade set both to the same id, which silently (a) collapsed
// MODEL_PRICING to one entry so Sonnet was billed at Haiku's rate — a 3.75x
// under-count of real spend against the ceiling — and (b) turned the 80%
// downgrade into a no-op. Never point these two at the same model.
const MODEL_HAIKU = 'claude-haiku-4-5';
const MAX_DIFF_SIZE = 120000; // 120KB — cap the payload sent to AI
const AI_TIMEOUT_MS = 60000;

// --------------------------------------------------------------------
// Cost cap ledger — prevents Claude API spend from destroying tier margin
// --------------------------------------------------------------------
//
// Every paid scan has a hard ceiling on AI spend. We estimate cost per call
// from token counts (Anthropic pricing: see MODEL_PRICING below). When
// cumulative spend hits 80% of the ceiling we fall back to Haiku. At 95%
// we stop calling Claude entirely — remaining hunks are marked "unverified
// (cost cap reached)" so the customer still gets a useful report.
//
// Ledger is keyed by scanId so parallel scans don't interfere. Memory-only:
// this is a per-invocation tracker, not persistent state.

const COST_CEILING_USD = {
  quick: 1.0,        // $29 tier  → $1 max AI spend  (97% margin)
  full: 3.0,         // $99 tier  → $3 max AI spend  (97% margin)
  'scan+fix': 15.0,  // $199 tier → $15 max AI spend (92% margin)
  nuclear: 30.0,     // $399 tier → $30 max AI spend (93% margin)
};
const DEFAULT_CEILING_USD = 3.0;

// Per-million-token pricing (USD). Safe conservative estimates — update if
// Anthropic pricing changes. Both figures cover input AND output.
const MODEL_PRICING = {
  [MODEL_SONNET]: { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  [MODEL_HAIKU]: { inputPerMTok: 1.0, outputPerMTok: 5.0 },
};

// Fail-safe: an unrecognised model id is almost always a NEWER, pricier one,
// so price it at the most expensive rate we know rather than the cheapest.
const MAX_KNOWN_PRICING = Object.values(MODEL_PRICING).reduce(
  (worst, rate) => (rate.outputPerMTok > worst.outputPerMTok ? rate : worst),
  MODEL_PRICING[MODEL_SONNET]
);

const DOWNGRADE_RATIO = 0.8;  // 80% → switch to Haiku
const HARD_STOP_RATIO = 0.95; // 95% → stop calling Claude

// Map<scanId, { ceiling, spent, calls, hitCap, downgraded, tier }>
const costLedger = new Map();

function estimateTokens(text) {
  if (!text) return 0;
  // ~4 chars per token is the commonly cited rule of thumb. This is an
  // estimate, not a billing figure — we over-estimate slightly to err on
  // the side of protecting margin.
  return Math.ceil(text.length / 4);
}

function estimateCostUsd(model, inputTokens, outputTokens) {
  const pricing = MODEL_PRICING[model] || MAX_KNOWN_PRICING;
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

function initCostLedger(scanId, tier) {
  const ceiling = COST_CEILING_USD[tier] != null
    ? COST_CEILING_USD[tier]
    : DEFAULT_CEILING_USD;
  const entry = {
    ceiling,
    spent: 0,
    calls: 0,
    hitCap: false,
    downgraded: false,
    tier: tier || 'full',
  };
  costLedger.set(scanId, entry);
  return entry;
}

/**
 * Returns a snapshot of AI spend for a given scan id.
 * Exported so the website/report layer can surface it to Craig.
 */
function getCostReport(scanId) {
  const entry = costLedger.get(scanId);
  if (!entry) {
    return { spent: 0, ceiling: 0, calls: 0, hitCap: false, tier: 'unknown' };
  }
  return {
    spent: Math.round(entry.spent * 10000) / 10000,
    ceiling: entry.ceiling,
    calls: entry.calls,
    hitCap: entry.hitCap,
    tier: entry.tier,
    downgraded: entry.downgraded,
    remaining: Math.max(0, entry.ceiling - entry.spent),
  };
}

function resetCostReport(scanId) {
  costLedger.delete(scanId);
}

/**
 * Pattern rules. Each rule inspects an ADDED or REMOVED line from the diff.
 * Severity: error = almost certainly a fake fix. warning = suspicious.
 */

/**
 * Is this source line entirely a comment? `//`, `#`, `*` continuation, or a
 * `/* … *\/` on one line. Used only by rules flagged `codeOnly`.
 */
function isWholeLineComment(sourceLine) {
  const t = String(sourceLine || '').trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('#')
    || (t.startsWith('/*') && t.endsWith('*/')) || t.startsWith('/*');
}

/**
 * #666: a `@ts-expect-error` in a test file, directly above a test that
 * asserts a type is REJECTED, is the sanctioned use of the directive — the
 * test would not compile (and would not prove the rejection) without it.
 * Matches the shape `expect(...)` (the assertion the suppressed line feeds)
 * or a TypeScript type assertion (`as SomeType` / `<SomeType>value`), which
 * is how "this shouldn't compile" tests usually read the rejected value.
 */
const TS_EXPECT_ERROR_SANCTIONED_NEXT_LINE_RE = /\bexpect\s*\(|\bas\s+[A-Za-z_$][\w$.<>[\]]*\b|^<[A-Za-z_$][\w$.<>[\]]*>/;

/**
 * Walk forward from `fromIdx` (exclusive) in `hunk.lines`/`hunk.lineNumbers`
 * to the next non-blank line that still exists in the NEW file (context or
 * added — a removed line never appears in the result, so it cannot be "the
 * next line" a reader sees). Returns `null` if the hunk ends first.
 */
function nextNonBlankNewFileLine(hunk, fromIdx) {
  for (let i = fromIdx + 1; i < hunk.lines.length; i += 1) {
    const raw = hunk.lines[i];
    if (raw.startsWith('-')) continue;
    const content = raw.slice(1);
    if (content.trim() === '') continue;
    return content;
  }
  return null;
}

/**
 * A skipped test blocks only when the commit that skipped it calls itself a
 * fix. Measured 2026-09-05 on ~14,000 commits across ten real repositories
 * (express, fastify, hono, zod, got, nest, trpc, prisma, apollo-server,
 * NodeGoat): eleven `.skip` additions, every one in a commit titled "Skip a
 * test for now", "test: migrate to vitest", "Tweaks" or a merge — deliberate,
 * visible decisions, none a fix hiding its own failure. Those stay reported
 * as warnings; the dishonest shape ("fix: negatives test" that skips the
 * failing test) blocks (the Fifty, move 30).
 */
const TEST_DISABLING_RULES = new Set(['test-skip-added', 'test-xit-added']);
/** The files that ARE the gate policy — reviewed as policy, never as code. */
const POLICY_FILE_RE = /(?:^|\/)\.gatetest(?:\.json|ignore)$/;
const FIX_SUBJECT_RE = /\b(?:fix(?:es|ed|ing)?|bug(?:fix)?|hotfix|patch(?:es|ed)?|repair(?:s|ed)?|resolv(?:e|es|ed))\b/i;

const PATTERN_RULES = [
  // --- Test disabling (high confidence) ---
  {
    id: 'test-skip-added',
    direction: 'added',
    pattern: /^\+.*\b(it|describe|test)\.skip\s*\(/,
    severity: 'error',
    title: 'Test was skipped instead of fixed',
    explanation: 'A test was changed to .skip — the failing test is now being ignored, not fixed.',
  },
  {
    id: 'test-only-added',
    direction: 'added',
    pattern: /^\+.*\b(it|describe|test)\.only\s*\(/,
    severity: 'warning',
    title: '.only added to test',
    explanation: '.only narrows the suite to one test and hides failures in the rest of the suite.',
  },
  {
    id: 'test-xit-added',
    direction: 'added',
    pattern: /^\+\s*(xit|xdescribe|xtest)\s*\(/,
    severity: 'error',
    title: 'Test was disabled with xit/xdescribe/xtest',
    explanation: 'The test has been disabled rather than fixed.',
  },
  {
    id: 'assertion-deleted',
    direction: 'removed',
    pattern: /^-.*\b(assert|expect|should)\b.*[()]/,
    severity: 'warning',
    title: 'Assertion was removed from a test',
    explanation: 'A test assertion was deleted. Verify the assertion is obsolete, not inconvenient.',
  },
  {
    id: 'test-block-deleted',
    direction: 'removed',
    pattern: /^-\s*(it|test)\s*\(\s*['"`]/,
    severity: 'warning',
    title: 'Test case was removed',
    explanation: 'An entire test case was deleted. Confirm the behaviour is still covered.',
  },

  // --- Error swallowing ---
  {
    id: 'empty-catch',
    // A test file that adds `catch {}` is a fixture of the shape under test
    // or the test's own error handling — never a symptom patch on the code
    // being fixed (self-scan of PR #488, 2026-09-14: three findings on the
    // error-swallow control pair's fixture strings). src/ still fires.
    notInTests: true,
    direction: 'added',
    // Exclude lines that carry a `// error-ok` suppressor documenting why
    // the empty catch is intentional (e.g. cleanup in finally, fallback value).
    pattern: /^\+.*\bcatch\s*(\([^)]*\))?\s*\{\s*\}(?!.*\berror-ok\b)/,
    severity: 'error',
    title: 'Empty catch block added',
    explanation: 'An empty catch swallows errors silently — the root cause is hidden, not fixed.',
  },
  {
    id: 'catch-noop',
    // A test file that adds `catch {}` is a fixture of the shape under test
    // or the test's own error handling — never a symptom patch on the code
    // being fixed (self-scan of PR #488, 2026-09-14: three findings on the
    // error-swallow control pair's fixture strings). src/ still fires.
    notInTests: true,
    direction: 'added',
    pattern: /^\+.*catch\s*\([^)]*\)\s*\{\s*\/\*.*\*\/\s*\}/,
    severity: 'error',
    title: 'Catch block comments out the error',
    explanation: 'The catch block contains only a comment — errors are being discarded.',
  },
  {
    id: 'catch-ignore-comment',
    direction: 'added',
    pattern: /^\+.*\/\/\s*(ignore|swallow|suppress|silence).*(error|exception|err)/i,
    severity: 'warning',
    title: 'Error explicitly ignored with comment',
    explanation: 'Code explicitly ignores an error. Errors should be handled, not ignored.',
  },

  // --- Stubbed returns ---
  {
    id: 'return-true-stub',
    direction: 'added',
    pattern: /^\+\s*return\s+true\s*;?\s*$/,
    severity: 'warning',
    title: 'Function reduced to `return true`',
    explanation: 'A function body was replaced with `return true`. Verify the original logic is still needed.',
  },
  {
    id: 'always-pass',
    direction: 'added',
    pattern: /^\+.*\bif\s*\(\s*(false|0|null|undefined)\s*\)/,
    severity: 'error',
    title: 'Dead-code guard added (`if (false)`)',
    explanation: 'An `if (false)` / `if (0)` guard disables code permanently. This is a symptom patch.',
  },
  {
    id: 'commented-out-code',
    direction: 'added',
    // Token, not prefix (doctrine §5): without the boundary `temp` matched
    // `// template expression`. `(?![\w-])` rather than `\b` so a hyphenated
    // word (`// disabled-by-default option`) is not the marker either. Found
    // by the determinism gate on our own diff, 2026-09-05.
    pattern: /^\+\s*\/\/\s*(TODO|FIXME|HACK|XXX|temporary|temp|disabled|commented out)(?![\w-])/i,
    severity: 'warning',
    title: 'TODO/FIXME/HACK comment added',
    explanation: 'New TODO/FIXME/HACK comments indicate unresolved work left in place of a real fix.',
  },

  // --- Weakening checks ---
  {
    id: 'strict-to-loose',
    direction: 'changed',
    pattern: /===/,
    // A loose `==` that is not the tail of `===` or `!==`. The previous
    // `/==[^=]/` matched inside `=== 'x'` — the last two `=` plus the
    // space — so any hunk that moved a strict comparison reported it as
    // relaxed (found on 2026-09-05 when a file walk was replaced and its
    // untouched `name === 'tsconfig.json'` line moved). Substring-vs-token,
    // the same shape as `.git` matching `.github`.
    replacement: /(?<![=!])==(?!=)/,
    // And a strict comparison must actually have LEFT the hunk: an added
    // `==` beside a removed `===` that also reappears is a move, not a fix.
    strictCountMustDrop: true,
    severity: 'warning',
    title: 'Strict equality relaxed to loose equality',
    explanation: '=== was changed to == — type coercion masks bugs rather than fixing them.',
  },
  {
    id: 'not-equal-removed',
    direction: 'removed',
    pattern: /^-.*(!==|!=)/,
    severity: 'info',
    title: 'Not-equal check removed',
    explanation: 'An inequality check was removed. Confirm the invariant it protected still holds.',
  },

  // --- Type escape hatches ---
  {
    // #669: the old pattern (`.*@ts-...`, matching anywhere on the line) fired
    // on a doc comment that mentions the directive in PROSE — a JSDoc line
    // like `* Use // @ts-expect-error when …` describes the directive
    // without being one, the same "text about the pattern reads as the
    // pattern" shape web-headers.js hit with CSP directive markers after
    // #668. There the fix is to skip whole-line comments outright because a
    // CSP header is never legitimately set from inside one; that does not
    // transfer directly here because the real directive IS a `//` comment.
    // Instead the directive must be the FIRST non-space token on the added
    // line: `// @ts-ignore` / `// @ts-nocheck` / `// @ts-expect-error`,
    // optionally followed by a reason. A JSDoc continuation line opens with
    // `*` (or a block comment with `/*`), not `//`, so it can never match —
    // the same "skip full-line comments and JSDoc blocks" idea, applied by
    // requiring the SPECIFIC marker a real directive uses to lead the line
    // rather than skipping every comment marker. A trailing comment after
    // code (`const x = 1; // @ts-ignore`) also fails to match — `const` is
    // the first token, not `//` — which matches TypeScript's own rule that
    // the directive must be a comment on its own line, not a trailing note.
    id: 'ts-ignore-added',
    direction: 'added',
    pattern: /^\+\s*\/\/\s*@ts-(?:ignore|nocheck|expect-error)\b/,
    severity: 'error',
    title: 'TypeScript error suppressed with @ts-ignore',
    explanation: 'Type errors are being suppressed rather than fixed. The underlying type issue remains.',
  },
  {
    id: 'eslint-disable-added',
    direction: 'added',
    pattern: /^\+.*eslint-disable(-next-line)?/,
    severity: 'warning',
    title: 'ESLint rule disabled inline',
    explanation: 'An ESLint rule was disabled instead of the underlying issue being fixed.',
  },
  {
    id: 'any-cast-added',
    direction: 'added',
    // `codeOnly` because this rule's pattern is ordinary English. It fired on
    // this repo's own PR against the comment line
    //   " * scrutiny as any other regression."
    // in scripts/real-world-precision.js — a sentence, reported as a
    // type-safety suppression. Prose describing the thing you detect looks
    // exactly like the thing you detect; base-module carries the same warning
    // for retry-hygiene matching `sleep(5)` inside a sentence about sleep(5).
    //
    // NOT applied to the whole rule set: `ts-ignore-added` and
    // `eslint-disable-added` are ABOUT comments, and skipping comment lines
    // there would disable them.
    codeOnly: true,
    pattern: /^\+.*\bas\s+any\b/,
    severity: 'warning',
    title: '`as any` cast added',
    explanation: 'An `as any` cast erases type safety instead of fixing a type mismatch.',
  },

  // --- Config / threshold softening ---
  {
    id: 'threshold-lowered',
    direction: 'added',
    codeOnly: true,
    // A `threshold: 0.7` in a TEST file is fixture data, not a gate policy
    // (tests/compliance-evidence.test.js's runner-summary fixture was
    // reported as "Threshold value changed", PR #433, 2026-09-05). The
    // rule is about config: jest coverageThreshold, sonar gates, .gatetest.json.
    notInTests: true,
    pattern: /^\+.*(coverage|threshold|minScore|maxErrors)\s*[:=]\s*\d/i,
    severity: 'info',
    title: 'Threshold value changed',
    explanation: 'A quality threshold was modified. Confirm the new value is justified, not loosened.',
  },

  // --- Gate policy (the Fifty, move 26) ---
  // The policy a team reviews IS the config: .gatetest.json and
  // .gatetestignore. A PR that widens a suppression, disables a module,
  // raises the block threshold or turns the gate advisory changes what
  // every later PR is judged by, and the review must see it as such — so
  // it is a finding on THIS PR, keyed by file, quiet on comments. Warning,
  // not error: a policy change can be right; an unreviewed one cannot.
  {
    id: 'policy-ignore-line-added',
    direction: 'added',
    file: /(?:^|\/)\.gatetestignore$/,
    pattern: /^\+\s*[^#\s]/,
    severity: 'warning',
    title: 'Gate policy changed: a suppression was added to .gatetestignore',
    explanation: 'This PR silences a rule, module or path for every future scan. Review the line as a policy decision, not as code.',
  },
  {
    id: 'policy-gate-softened',
    direction: 'added',
    file: /(?:^|\/)\.gatetest\.json$/,
    pattern: /^\+.*"(?:reportOnly|report-only)"\s*:\s*true|^\+.*"enabled"\s*:\s*false|^\+.*"confidenceThreshold"\s*:\s*(?:0\.[89]\d*|1(?:\.0+)?)\b|^\+.*"strict"\s*:\s*false/,
    severity: 'warning',
    title: 'Gate policy changed: .gatetest.json makes the gate less strict',
    explanation: 'A module is disabled, the gate is set to report-only, or the block threshold is raised. Every later PR is judged by this line.',
  },

];

class FakeFixDetectorModule extends BaseModule {
  constructor() {
    super('fakeFixDetector', 'Fake Fix Detector — Catches symptom patching and skipped tests');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const moduleConfig = config.getModuleConfig
      ? config.getModuleConfig('fakeFixDetector')
      : {};

    const runnerOptions = config._runnerOptions || {};
    const patternEnabled = moduleConfig.patternEngine !== false;
    const aiEnabled = moduleConfig.aiEngine !== false;

    // Cost-cap setup. scanId is anything stable per invocation.
    const scanId =
      moduleConfig.scanId ||
      runnerOptions.scanId ||
      `scan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const tier = moduleConfig.tier || runnerOptions.tier || 'full';
    const ledger = initCostLedger(scanId, tier);

    // Figure out what diff to analyse.
    const diff = this._getDiff(projectRoot, runnerOptions, moduleConfig);

    if (!diff || !diff.trim()) {
      result.addCheck('fake-fix:no-diff', true, {
        severity: 'info',
        message: 'No diff to analyse — skipping fake fix detection',
      });
      return;
    }

    result.addCheck('fake-fix:scanning', true, {
      severity: 'info',
      message: `Analysing ${this._countChangedFiles(diff)} changed file(s) for symptom patching`,
    });

    // 1. Pattern engine — always runs when enabled.
    let patternFindings = [];
    if (patternEnabled) {
      patternFindings = this._judgeDisabledTests(projectRoot, this._runPatternEngine(diff));
      this._recordFindings(result, patternFindings, 'pattern');
    }

    // 2. AI engine — runs if key is set and enabled. Uses the per-scan
    //    cost ledger so we can never blow past a tier's AI budget.
    if (aiEnabled && process.env.ANTHROPIC_API_KEY) {
      try {
        const aiFindings = await this._runAiEngine(
          process.env.ANTHROPIC_API_KEY,
          diff,
          moduleConfig.context || runnerOptions.fixContext || null,
          ledger
        );
        this._recordFindings(result, aiFindings, 'ai');
      } catch (err) {
        result.addCheck('fake-fix:ai-error', false, {
          severity: 'warning',
          message: `AI fake-fix analysis failed: ${err.message}`,
          suggestion: 'Check ANTHROPIC_API_KEY is valid. Pattern engine results are still valid.',
        });
      }
    } else if (aiEnabled && !process.env.ANTHROPIC_API_KEY) {
      result.addCheck('fake-fix:ai-skipped', true, {
        severity: 'info',
        message: 'AI engine skipped — set ANTHROPIC_API_KEY for deeper analysis',
      });
    }

    // Attach the cost report to the result metadata so the website/reporters
    // can display it. Green ecosystem mandate: the report is always present,
    // even when the cap was hit.
    const costReport = getCostReport(scanId);
    if (!result.metadata) result.metadata = {};
    result.metadata.fakeFixCostReport = costReport;
    result.addCheck('fake-fix:cost-report', true, {
      severity: 'info',
      message: `AI spend: $${costReport.spent.toFixed(4)} / $${costReport.ceiling.toFixed(2)} (${costReport.calls} calls, tier=${costReport.tier})`,
      costReport,
    });
    if (costReport.hitCap) {
      result.addCheck('fake-fix:cost-cap-reached', true, {
        severity: 'warning',
        message: `AI verification stopped early — cost cap of $${costReport.ceiling.toFixed(2)} reached. Remaining hunks marked unverified.`,
      });
    }

    // Summary check — passes if nothing suspicious found.
    const total = patternFindings.length;
    if (total === 0) {
      result.addCheck('fake-fix:clean', true, {
        severity: 'info',
        message: 'No fake-fix patterns detected',
      });
    }
  }

  // ------------------------------------------------------------------
  // Diff acquisition
  // ------------------------------------------------------------------

  _getDiff(projectRoot, runnerOptions, moduleConfig) {
    // Explicit diff provided (e.g. tests or CI). Empty string counts — it
    // means "no changes", not "fall through to git".
    this._diffSource = { kind: 'injected' };
    if (moduleConfig.diff != null) return moduleConfig.diff;
    if (runnerOptions.diff != null) return runnerOptions.diff;

    // Diff against a specific ref. ALWAYS scoped to the project root
    // (`-- .`): when the scanned project is a SUBDIRECTORY of a larger git
    // repo (a corpus fixture, a monorepo package, a hosted scan workspace
    // inside a checkout) an unscoped `git diff` reports the ENCLOSING repo's
    // changes — the reliability corpus flagged GateTest's own commit as 20
    // "fake fixes" in a fixture that had not changed (2026-08-18).
    const against = moduleConfig.against || runnerOptions.against;
    // A pull request is judged against ITS BASE, not its last commit. `--pr`
    // / `--since` set incrementalSince and GitHub Actions names the base in
    // GITHUB_BASE_REF; before this the module read `HEAD~1 HEAD` on a
    // multi-commit PR, so a `test.skip` added in any commit but the last was
    // never analysed (the Fifty, move 30, 2026-09-05). An unfetched ref fails
    // the command and falls through to the local shapes below.
    // ONE decision shared with prSize and the runner (src/core/diff-base.js):
    // `against`, --since / --pr, a merge-queue base, GITHUB_BASE_REF,
    // origin/main. Each command carries the commit range it covers (`null`
    // = not yet committed) so a finding can ask which commits touched its
    // file. An explicit `against` that resolves is the only command, as
    // before; one that does not resolve falls through instead of reporting
    // nothing.
    const base = resolveDiffBase({ projectRoot, explicit: against, incrementalSince: runnerOptions.incrementalSince });
    const ranged = (b) => ({ cmd: `git diff --unified=3 ${b.mergeBase}..HEAD -- .`, range: `${b.mergeBase}..HEAD` });
    const commands = base && base.source === 'explicit'
      ? [ranged(base)]
      : [
          ...(base ? [ranged(base)] : []),
          { cmd: 'git diff --unified=3 --cached -- .', range: null },     // staged
          { cmd: 'git diff --unified=3 -- .', range: null },              // working tree
          { cmd: 'git diff --unified=3 HEAD~1 HEAD -- .', range: 'HEAD~1..HEAD' }, // last commit
        ];

    for (const { cmd, range } of commands) {
      const { stdout, exitCode } = this._exec(cmd, { cwd: projectRoot });
      if (exitCode === 0 && stdout && stdout.trim()) {
        this._diffSource = range ? { kind: 'range', range } : { kind: 'uncommitted' };
        return stdout;
      }
    }
    return '';
  }

  /**
   * The subject of the first commit in `range` that touched `file` and calls
   * itself a fix, or null. Answers only what git can answer: an injected diff
   * (tests, hosted scans handing over a payload) has no commits, and the rule
   * keeps its declared severity there.
   */
  _fixCommitTouching(projectRoot, range, file) {
    const { stdout, exitCode } = this._exec(`git log --format=%s ${range} -- "${file}"`, { cwd: projectRoot });
    if (exitCode !== 0 || !stdout) return null;
    for (const subject of stdout.split(/\r?\n/)) {
      if (subject && FIX_SUBJECT_RE.test(subject)) return subject.trim();
    }
    return null;
  }

  /**
   * Decide whether each skipped/disabled test blocks: error when a fix-shaped
   * commit touched the file in the analysed range, warning (still reported)
   * otherwise, including uncommitted changes where no commit exists yet.
   */
  _judgeDisabledTests(projectRoot, findings) {
    const src = this._diffSource || { kind: 'injected' };
    if (src.kind === 'injected') return findings;
    for (const f of findings) {
      if (!TEST_DISABLING_RULES.has(f.ruleId)) continue;
      const subject = src.kind === 'range' ? this._fixCommitTouching(projectRoot, src.range, f.file) : null;
      if (subject) {
        f.explanation += ` Added by "${subject}" — a commit that calls itself a fix and skips the test instead.`;
      } else {
        f.severity = 'warning';
        f.explanation += src.kind === 'uncommitted'
          ? ' Not yet committed — reported, not blocking. A commit that calls itself a fix and skips this test will block.'
          : ' Reported, not blocking: no commit touching this file in the range calls itself a fix. If this was meant as one, fix the test instead.';
      }
    }
    return findings;
  }

  _countChangedFiles(diff) {
    const matches = diff.match(/^diff --git /gm);
    return matches ? matches.length : 0;
  }

  // ------------------------------------------------------------------
  // Pattern engine
  // ------------------------------------------------------------------

  _runPatternEngine(diff) {
    const findings = [];
    const hunks = this._parseDiff(diff);

    for (const hunk of hunks) {
      // A fix lives in source. A Markdown, YAML or lock-file hunk cannot
      // relax a comparison or skip a test, but its PROSE can name every
      // pattern below — a doc table that says "flags `@ts-ignore` and
      // `as any`" lit up five rules on 2026-09-05 when a line-ending change
      // made the whole file a hunk. Same file set the AI engine uses.
      // The two POLICY files are the exception: not source, but what the
      // gate is judged by, and only the policy rules read them (move 26).
      if (!this._isSourceFile(hunk.file) && !POLICY_FILE_RE.test(hunk.file)) continue;
      // Files that INTENTIONALLY contain bug-shape patterns and must never
      // hard-error:
      //   - website/app/for/* — marketing demo pages showing the patterns
      //     GateTest catches.
      //   - website/app/{glossary,blog,use-cases}/* — educational content
      //     that names the anti-patterns by example (a glossary entry on
      //     mutation testing literally describes replacing `return true`
      //     with `return false`; a technical-debt entry mentions
      //     `@ts-ignore` abuse). Same category as the marketing demo pages:
      //     the prose is supposed to contain these tokens.
      //   - corpus/*           — flywheel training fixtures: each "broken"
      //     instance is a known anti-pattern that the harness replays
      //     through the deterministic layers. The whole point is for those
      //     patterns to be present.
      //   - src/modules/fake-fix-detector.js — this file, which carries
      //     the literal patterns in its rule definitions.
      //   - src/modules/claude-compliance.js + its test — detector for the
      //     same `@ts-ignore` / `as any` family; regex source contains the
      //     literals, test fixtures need them verbatim.
      //   - src/modules/ai-hallucination.js + its test — same self-reference.
      const isDemo = /(?:^|\/)(?:website\/app\/(?:for|glossary|blog|use-cases)|corpus)\//.test(hunk.file)
        || /(?:^|\/)src\/modules\/(?:fake-fix-detector|claude-compliance|ai-hallucination|error-swallow)\.js$/.test(hunk.file)
        // A module that DETECTS empty catches necessarily contains empty
        // catches — as fixtures in its own doc comments and as the shapes it
        // matches. src/core/guarded-catch.js carries six, and this rule
        // reported all six as symptom patches on the commit that added it.
        // Same reason fake-fix-detector already exempts itself.
        || /(?:^|\/)src\/core\/guarded-catch\.js$/.test(hunk.file)
        || /(?:^|\/)tests\/(?:fake-fix-detector|claude-compliance|ai-hallucination|guarded-catch|error-swallow)\.test\.js$/.test(hunk.file);

      // Walk added / removed lines
      for (let idx = 0; idx < hunk.lines.length; idx += 1) {
        const line = hunk.lines[idx];
        for (const rule of PATTERN_RULES) {
          if (rule.direction === 'added' && !line.startsWith('+')) continue;
          if (rule.direction === 'removed' && !line.startsWith('-')) continue;
          if (rule.direction === 'changed') continue; // handled below
          // A rule scoped to a policy file never reads code, and a code
          // rule never reads a policy file.
          if (rule.file && !rule.file.test(hunk.file)) continue;
          if (!rule.file && POLICY_FILE_RE.test(hunk.file)) continue;

          if (isDemo && rule.severity === 'error') continue; // never hard-error on demo pages

          // A rule whose pattern is ordinary code must not match prose. The
          // `+`/`-` diff marker is stripped first so the comment test sees
          // the source line as written.
          if (rule.codeOnly && isWholeLineComment(line.slice(1))) continue;
          if (rule.notInTests && this._isTestPath(hunk.file)) continue;

          if (rule.pattern.test(line)) {
            let severity = rule.severity;
            // #666: `@ts-expect-error` in a test, directly above the
            // `expect(...)`/type-assertion it enables, is the sanctioned
            // use — downgrade from the rule's default `error` to `info`.
            if (rule.id === 'ts-ignore-added' && /@ts-expect-error/.test(line)
              && this._isTestPath(hunk.file)) {
              const nextLine = nextNonBlankNewFileLine(hunk, idx);
              if (nextLine !== null && TS_EXPECT_ERROR_SANCTIONED_NEXT_LINE_RE.test(nextLine)) {
                severity = 'info';
              }
            }
            findings.push({
              ruleId: rule.id,
              file: hunk.file,
              line: hunk.lineNumbers[idx],
              severity,
              title: rule.title,
              explanation: rule.explanation,
              snippet: line.trim().slice(0, 160),
            });
          }
        }
      }

      // Changed-line rules: look for a removed line matching `pattern` and an
      // added line matching `replacement` at a similar position.
      for (const rule of PATTERN_RULES.filter(r => r.direction === 'changed')) {
        if (isDemo && rule.severity === 'error') continue; // same fixture exemption
        const removed = hunk.lines.filter(l => l.startsWith('-') && rule.pattern.test(l));
        const addedIdx = hunk.lines.findIndex(l => l.startsWith('+') && rule.replacement.test(l));
        const added = hunk.lines.filter(l => l.startsWith('+') && rule.replacement.test(l));
        let dropped = true;
        if (rule.strictCountMustDrop) {
          const count = (prefix) => hunk.lines
            .filter(l => l.startsWith(prefix))
            .reduce((n, l) => n + (l.match(/===/g) || []).length, 0);
          dropped = count('+') < count('-');
        }
        if (removed.length > 0 && added.length > 0 && dropped) {
          findings.push({
            ruleId: rule.id,
            file: hunk.file,
            line: addedIdx >= 0 ? hunk.lineNumbers[addedIdx] : hunk.lineNumber,
            severity: rule.severity,
            title: rule.title,
            explanation: rule.explanation,
            snippet: added[0].trim().slice(0, 160),
          });
        }
      }
    }

    return findings;
  }

  /**
   * #666: a finding used to report `hunk.lineNumber` — the FIRST line of the
   * hunk — for every match anywhere inside it, so a `@ts-expect-error` ten
   * lines into a hunk was reported at the hunk's opening `return` or import
   * line. `lines` stays the raw `+`/`-`/` ` diff lines (unchanged shape, so
   * every existing consumer — `_renderHunk`, the `===` counter, the
   * changed-line filters — keeps working); `lineNumbers[i]` is the new-file
   * line number for `lines[i]`, computed by walking the hunk and advancing
   * the counter on context (` `) and added (`+`) lines, which both occupy a
   * line in the new file, and NOT on removed (`-`) lines, which don't.
   */
  _parseDiff(diff) {
    const hunks = [];
    const lines = diff.split(/\r?\n/);
    let currentFile = null;
    let currentHunk = null;
    let newLineCursor = 0;

    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        const match = line.match(/diff --git a\/(.+?) b\/(.+)$/);
        currentFile = match ? match[2] : 'unknown';
      } else if (line.startsWith('@@')) {
        if (currentHunk) hunks.push(currentHunk);
        const match = line.match(/\+(\d+)/);
        const start = match ? parseInt(match[1], 10) : 0;
        newLineCursor = start;
        currentHunk = {
          file: currentFile,
          lineNumber: start,
          lines: [],
          lineNumbers: [],
        };
      } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        currentHunk.lines.push(line);
        currentHunk.lineNumbers.push(newLineCursor);
        if (line.startsWith('+') || line.startsWith(' ')) newLineCursor += 1;
      }
    }
    if (currentHunk) hunks.push(currentHunk);
    return hunks;
  }

  // ------------------------------------------------------------------
  // AI engine
  // ------------------------------------------------------------------

  // Source file extensions the AI engine should analyse.
  // Config/data files (JSON, YAML, TOML, lock files, markdown) are excluded
  // because Claude will misidentify legitimate config resets (e.g. vercel.json
  // → {}) as "deleting config to hide error" — they're not source logic.
  _isSourceFile(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    return [
      'js', 'mjs', 'cjs', 'jsx',
      'ts', 'mts', 'cts', 'tsx',
      'py', 'go', 'rs', 'java',
      'rb', 'php', 'cs', 'kt', 'swift',
      'sh', 'bash',
    ].includes(ext);
  }

  async _runAiEngine(apiKey, diff, context, ledger) {
    // Split the diff into per-hunk chunks so the cost ledger can stop
    // mid-scan if a big diff threatens to blow the budget. Each hunk is
    // analysed with its own prompt and counts as one Claude call.
    // Only analyse source code files — config/data files generate false positives.
    const hunks = this._parseDiff(diff).filter(h => this._isSourceFile(h.file));
    const contextBlock = context
      ? `\nCONTEXT — the bug/error this diff is supposed to fix:\n${context}\n`
      : '';

    const findings = [];
    let unverifiedCount = 0;

    for (const hunk of hunks) {
      // --- Cost-cap gate: hard stop at 95% ---
      if (ledger.spent >= ledger.ceiling * HARD_STOP_RATIO) {
        ledger.hitCap = true;
        unverifiedCount++;
        findings.push({
          ruleId: 'ai:unverified',
          file: hunk.file,
          line: hunk.lineNumber,
          severity: 'info',
          title: 'AI verification skipped (cost cap reached)',
          explanation: `This diff hunk was not sent to the AI provider because the per-scan AI spend ceiling of $${ledger.ceiling.toFixed(2)} was reached. Pattern engine results still apply.`,
          suggestion: 'Rerun with a higher tier if you need AI verification on every hunk.',
        });
        continue;
      }

      // --- Cost-cap gate: downgrade to Haiku at 80% ---
      const useHaiku = ledger.spent >= ledger.ceiling * DOWNGRADE_RATIO;
      if (useHaiku && !ledger.downgraded) {
        ledger.downgraded = true;
      }
      const model = useHaiku ? MODEL_HAIKU : MODEL_SONNET;

      // Build a per-hunk diff payload Claude can reason about.
      const hunkDiff = this._renderHunk(hunk);
      const truncated = hunkDiff.length > MAX_DIFF_SIZE
        ? hunkDiff.slice(0, MAX_DIFF_SIZE) + '\n[... hunk truncated ...]'
        : hunkDiff;

      const prompt = `You are the Fake Fix Detector for GateTest. Decide whether this SINGLE diff hunk is a REAL fix or a SYMPTOM PATCH.

Symptom patches include — but are not limited to:
- Deleting, skipping, or weakening a failing test
- Wrapping failing code in empty or noop try/catch
- Replacing a function body with return true/return null/return []
- Adding @ts-ignore, eslint-disable, as any, or other suppressions
- Lowering thresholds so a quality check passes
- Adding \`if (false)\` or commenting out the offending code
- Replacing === with == to hide type mismatches

REAL fixes address WHY something was broken. They either change the faulty logic,
add missing state, or correctly handle a previously unhandled case.
${contextBlock}
FILE: ${hunk.file}
DIFF HUNK:
\`\`\`diff
${truncated}
\`\`\`

Respond with STRICT JSON only. No prose before or after. Schema:
{
  "findings": [
    {
      "file": "${hunk.file}",
      "line": ${hunk.lineNumber},
      "severity": "error" | "warning" | "info",
      "title": "Short description",
      "explanation": "Why this is a symptom patch, not a real fix",
      "suggestion": "What a real fix would look like"
    }
  ],
  "verdict": "real-fix" | "mixed" | "symptom-patch",
  "summary": "One sentence"
}

If the hunk is a genuine real fix, return { "findings": [], "verdict": "real-fix", "summary": "..." }
Be ruthless. We are building a product that kills fake fixes.`;

      // Pre-check estimated cost — if this single call would blow the
      // cap, fall back to Haiku or stop. This prevents a single oversized
      // hunk from spending over-budget in one shot.
      const estimatedInputTokens = estimateTokens(prompt);
      const estimatedOutputTokens = 512; // assume ~512 tokens of JSON
      let projectedCost = estimateCostUsd(
        model,
        estimatedInputTokens,
        estimatedOutputTokens
      );
      if (ledger.spent + projectedCost > ledger.ceiling * HARD_STOP_RATIO) {
        // Try Haiku instead — if that also exceeds the cap, skip the hunk.
        const haikuCost = estimateCostUsd(
          MODEL_HAIKU,
          estimatedInputTokens,
          estimatedOutputTokens
        );
        if (ledger.spent + haikuCost > ledger.ceiling * HARD_STOP_RATIO) {
          ledger.hitCap = true;
          unverifiedCount++;
          findings.push({
            ruleId: 'ai:unverified',
            file: hunk.file,
            line: hunk.lineNumber,
            severity: 'info',
            title: 'AI verification skipped (cost cap reached)',
            explanation: `This diff hunk was not sent to the AI provider because the per-scan AI spend ceiling of $${ledger.ceiling.toFixed(2)} would be exceeded.`,
            suggestion: 'Rerun with a higher tier if you need AI verification on every hunk.',
          });
          continue;
        }
        projectedCost = haikuCost;
      }

      let response;
      try {
        response = await this._callClaude(
          apiKey,
          prompt,
          useHaiku ? MODEL_HAIKU : model
        );
      } catch (err) {
        // One failed call shouldn't kill the whole engine. Record and continue.
        findings.push({
          ruleId: 'ai:call-error',
          file: hunk.file,
          line: hunk.lineNumber,
          severity: 'warning',
          title: 'AI provider call failed for this hunk',
          explanation: err.message,
          suggestion: 'Pattern engine results still apply.',
        });
        // Charge a minimal amount so repeated errors still tick the meter.
        ledger.spent += estimateCostUsd(model, estimatedInputTokens, 0);
        ledger.calls += 1;
        continue;
      }

      // Record actual cost. If the SDK returned usage, prefer that; else
      // fall back to our estimate.
      const usage = response && response._usage;
      const inputTokens = usage?.input_tokens || estimatedInputTokens;
      const outputTokens = usage?.output_tokens || estimatedOutputTokens;
      const actualCost = estimateCostUsd(
        useHaiku ? MODEL_HAIKU : model,
        inputTokens,
        outputTokens
      );
      ledger.spent += actualCost;
      ledger.calls += 1;

      if (response && Array.isArray(response.findings)) {
        for (const f of response.findings) {
          findings.push({
            ruleId: `ai:${f.severity || 'warning'}`,
            file: f.file || hunk.file,
            line: f.line || hunk.lineNumber,
            severity: ['error', 'warning', 'info'].includes(f.severity)
              ? f.severity
              : 'warning',
            title: f.title || 'AI detected potential symptom patch',
            explanation: f.explanation || '',
            suggestion: f.suggestion || '',
          });
        }
      }
    }

    if (unverifiedCount > 0) {
      findings.push({
        ruleId: 'ai:cap-summary',
        file: '',
        line: 0,
        severity: 'info',
        title: `${unverifiedCount} hunk(s) marked unverified — AI cost cap reached`,
        explanation: `Cost ledger: $${ledger.spent.toFixed(4)} / $${ledger.ceiling.toFixed(2)} spent across ${ledger.calls} AI provider call(s).`,
        snippet: '',
        informational: true,
      });
    }

    return findings;
  }

  /**
   * Render a parsed hunk back into a diff-style block so the AI sees the
   * same +/- context lines the pattern engine saw.
   */
  _renderHunk(hunk) {
    const header = `--- ${hunk.file}\n+++ ${hunk.file}\n@@ line ${hunk.lineNumber} @@`;
    return `${header}\n${hunk.lines.join('\n')}`;
  }

  _callClaude(apiKey, prompt, model) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: model || MODEL_SONNET,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });

      const options = {
        hostname: anthropicEndpoint().hostname,

        port: anthropicEndpoint().port,
        path: anthropicApiPath('/v1/messages'),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': anthropicVersion(),
          'x-api-key': apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            const response = JSON.parse(raw);
            if (res.statusCode !== 200) {
              reject(new Error(`API returned ${res.statusCode}: ${response.error?.message || raw}`));
              return;
            }
            const text = response.content?.[0]?.text || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            const parsed = jsonMatch
              ? JSON.parse(jsonMatch[0])
              : { findings: [], verdict: 'unknown', summary: text };
            // Attach real usage so the cost ledger can use actual tokens.
            parsed._usage = response.usage || null;
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Failed to parse AI response: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(AI_TIMEOUT_MS, () => {
        req.destroy();
        reject(new Error(`AI fake-fix analysis timed out after ${AI_TIMEOUT_MS / 1000}s`));
      });

      req.write(body);
      req.end();
    });
  }

  // ------------------------------------------------------------------
  // Result recording
  // ------------------------------------------------------------------

  _recordFindings(result, findings, engine) {
    for (const f of findings) {
      if (f.informational) {
        result.addCheck(`fake-fix:${engine}:summary`, true, {
          severity: 'info',
          message: `${f.title}${f.explanation ? ' — ' + f.explanation : ''}`,
        });
        continue;
      }
      const checkName = `fake-fix:${engine}:${f.ruleId}:${f.file}:${f.line}`;
      result.addCheck(checkName, false, {
        file: f.file,
        line: f.line,
        severity: f.severity,
        message: `[${engine === 'ai' ? 'AI' : 'PATTERN'}] ${f.title}`,
        explanation: f.explanation,
        suggestion: f.suggestion || 'Address the root cause instead of suppressing the symptom.',
        snippet: f.snippet,
      });
    }
  }
}

module.exports = FakeFixDetectorModule;
// Exported for testing and external consumers
module.exports.PATTERN_RULES = PATTERN_RULES;
module.exports.COST_CEILING_USD = COST_CEILING_USD;
// Exported for the regression test that guards against a model rename
// collapsing the two tiers into one (see MODEL_HAIKU's comment).
module.exports.MODEL_SONNET = MODEL_SONNET;
module.exports.MODEL_HAIKU = MODEL_HAIKU;
module.exports.MODEL_PRICING = MODEL_PRICING;
module.exports.estimateCostUsd = estimateCostUsd;
module.exports.getCostReport = getCostReport;
module.exports.resetCostReport = resetCostReport;
