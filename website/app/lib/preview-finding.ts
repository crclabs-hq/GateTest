/**
 * Shaping helpers for the free preview scan (`POST /api/scan/preview`).
 *
 * These live here rather than inside the route because a Next.js `route.ts`
 * may only export HTTP handlers and route config — so anything defined there
 * is, by construction, untestable. That is precisely how the bug below
 * survived: the route carried a private, unexercised copy of a shared parser.
 *
 * THE BUG (found 2026-08-29 against live production):
 *   Every finding in the live `/api/scan/preview` response came back with
 *   `"file": null, "line": null`, with the path still glued to the front of
 *   the message:
 *
 *     { "file": null, "line": null,
 *       "message": "examples/error/index.js: contains console.log/debug/info call" }
 *
 *   Root cause: the route's private `parseDetail` required a `:<line>`
 *   segment (`path:42: msg`) before it would attribute a file. Measured
 *   across `website/app/lib/scan-modules/*.ts`: of 86 detail templates only
 *   15 emit a line number, while 57 emit `path: message` with none. So the
 *   regex structurally could not attribute the overwhelming majority of real
 *   findings, and the structured fields the API contract advertises were
 *   dead weight for every consumer (the MCP upsell pitch, any client trying
 *   to deep-link a finding).
 *
 *   Meanwhile `@/app/lib/issue-extractor` — the canonical extractor used by
 *   the scan-status page and the admin Command Center — had already solved
 *   exactly this, including extensionless names (`Dockerfile`) and the
 *   `package.json scripts.postinstall:` sub-key shape. It was fixed in one
 *   call site and not the other.
 *
 * This is the KI #77 `TEST_PATH_RE` pattern again: a shared concern
 * re-implemented per call site, then corrected in only one copy. File
 * attribution now has exactly ONE definition in the codebase.
 */

import { parseDetail as extractFile } from "./issue-extractor";

export interface PreviewFinding {
  module: string;
  severity: "error" | "warning" | "info";
  file: string | null;
  line: number | null;
  message: string;
}

/**
 * The subset of the engine's ranked finding (`src/core/finding-registry.js`,
 * surfaced as `RankedFinding` by scan-engine-dispatch) the preview needs.
 */
export interface RankedFindingLike {
  module: string;
  severity: "error" | "warning" | "info";
  confidence?: number;
  blocking?: boolean;
  file?: string | null;
  line?: number | null;
  message: string;
  duplicateOf?: string | null;
}

/**
 * Shape one ranked engine finding for the preview.
 *
 * Since 2026-09-13 the preview runs the real CLI engine, whose findings carry
 * severity AND confidence. The gate blocks only on error-severity findings at
 * or above the confidence threshold; a low-confidence error is shown but does
 * not block. The preview keeps that distinction: a soft error is presented as
 * a warning, so the first five findings a prospect sees are the ones that
 * would actually block their commit — the same verdict the CLI prints.
 */
export function fromRankedFinding(f: RankedFindingLike): PreviewFinding {
  const severity: PreviewFinding["severity"] =
    f.severity === "error" ? (f.blocking ? "error" : "warning") : f.severity;
  return {
    module: f.module,
    severity,
    file: f.file || null,
    line: typeof f.line === "number" && f.line > 0 ? f.line : null,
    message: String(f.message || "").trim(),
  };
}

/**
 * Modules whose every finding is an error by construction. Verified against
 * the module sources, not assumed:
 *
 *   - `secrets` (scan-modules/security-data.ts) emits exactly two shapes, and
 *     both are leaked credentials: `path: <SECRET_PATTERNS name>` (Stripe live
 *     key, GitHub PAT, AWS keys, private key block, hardcoded password, DB
 *     connection string with inline credentials, …) and
 *     `path: committed sensitive file (…)`.
 *   - `syntax` (scan-modules/static-quality.ts) emits only genuine parse
 *     breakage — brace/paren/bracket imbalance measured AFTER strings and
 *     comments are stripped, unterminated template literals, invalid JSON.
 *
 * If either module grows a lower-severity check, take it out of this set.
 */
const ALWAYS_ERROR_MODULES = new Set(["secrets", "syntax"]);

/**
 * Classify a finding into a display severity.
 *
 * THE BUG THIS FIXES (measured 2026-08-29, both directions):
 *
 *   The keyword heuristic used to run against the RAW string — which begins
 *   with the FILE PATH. So the path decided the severity:
 *
 *     examples/error/index.js: uses legacy 'var' declaration   → error
 *     examples/auth/index.js:  uses legacy 'var' declaration   → warning
 *
 *   Identical rule, identical finding, different severity, purely because
 *   express really does have an `examples/error/` directory. Any repo with a
 *   `error/`, `fail/`, or `secret.js` path got its ordinary lint findings
 *   escalated — and errors sort first, so they led the free preview.
 *
 *   The same heuristic under-called the findings that actually matter:
 *   10 of the 13 shapes the `secrets` module can emit — including a live
 *   Stripe key, a GitHub personal access token and a private key block —
 *   came out as `warning`, because "Stripe live key" contains none of the
 *   keywords. A leaked credential presented as a warning is the
 *   false-NEGATIVE direction, on the highest-severity module we run, in the
 *   top of the funnel.
 *
 * The order below reflects how much each signal is worth:
 *   1. An explicit `error:` / `warning:` / `info:` prefix — the module said
 *      what it meant, so believe it. Read from the RAW string, before any
 *      stripping, which is why this function takes the raw form.
 *   2. The module that produced the finding — structural, not textual.
 *   3. Keyword match on the MESSAGE ONLY. Never the path: a filename is not
 *      evidence about severity.
 */
export function classifySeverity(
  raw: string,
  moduleName?: string,
  message?: string
): PreviewFinding["severity"] {
  if (typeof raw !== "string") return "warning";

  // 1. Explicit marker wins.
  if (/^(error|err|critical|high)\b[:]/i.test(raw)) return "error";
  if (/^(warning|warn|medium)\b[:]/i.test(raw)) return "warning";
  if (/^(info|note|low|summary)\b[:]/i.test(raw)) return "info";

  // 2. The emitting module.
  if (moduleName && ALWAYS_ERROR_MODULES.has(moduleName)) return "error";

  // 3. Keywords, against the message with the path already removed. Falls
  //    back to the raw string only when no parsed message was supplied.
  const body = typeof message === "string" ? message : raw;
  if (
    /\b(?:error|fail(?:ure|ed|s)?|vulnerab\w*|exploit\w*|injection|secrets?|credentials?|api[_\- ]?keys?|hardcoded)\b/i.test(
      body
    )
  )
    return "error";

  return "warning";
}

/**
 * Split a raw module detail into `{ module, severity, file, line, message }`.
 *
 * File/line attribution is delegated to the canonical extractor. Do NOT
 * reintroduce a local filename regex here — `tests/preview-finding.test.js`
 * has a ratchet that fails the build if one reappears.
 */
export function parseDetail(raw: string, moduleName: string): PreviewFinding {
  const safeRaw = typeof raw === "string" ? raw : String(raw ?? "");

  // Strip the prefixes the canonical extractor does not: a `[tag]` prefix and
  // the `note:` / `summary:` severities. The severity words it already strips
  // are included too, so both helpers agree on where the filename starts.
  const stripped = safeRaw
    .replace(/^(?:\[[^\]]+\]\s*|(?:error|warn(?:ing)?|info|note|summary)\s*:\s*)/i, "")
    .trim();

  const parsed = extractFile(stripped, moduleName);
  let file: string | null = null;
  let line: number | null = null;
  let message = stripped;

  if (parsed?.file) {
    file = parsed.file;
    line = typeof parsed.line === "number" ? parsed.line : null;
    // The extractor tags create-a-missing-file findings with a `CREATE_FILE:`
    // marker for the auto-fixer. That is an internal instruction, not
    // something to show a customer in a free preview.
    const issue = parsed.issue.replace(/^CREATE_FILE:\s*/, "").trim();
    if (issue) message = issue;
  }

  const finalMessage = message.trim();

  return {
    module: moduleName,
    // Severity is classified from the raw string (for an explicit prefix), the
    // emitting module, and the path-stripped message — in that order.
    severity: classifySeverity(safeRaw, moduleName, finalMessage),
    file,
    line,
    message: finalMessage,
  };
}
