/**
 * The MCP tool catalog — single source of truth for every surface that
 * mentions the tool count (MCP page, homepage Eyes/Ears/Hands section).
 * The count is derived, never hand-written, so "18 tools" drift can't recur.
 */

export const ALL_TOOLS = [
  // Free
  { name: "check_health", paid: false, desc: "Verify GateTest engine is operational" },
  { name: "list_modules", paid: false, desc: "List all 120 modules with descriptions" },
  { name: "get_badge", paid: false, desc: "Get embeddable README badge for any repo" },
  { name: "scan_url", paid: false, desc: "Quick scan any live URL via hosted API" },
  { name: "scan_local (quick)", paid: false, desc: "4-module quick scan — syntax, lint, secrets, codeQuality" },
  // Paid
  { name: "scan_local (full/smart)", paid: true, desc: "120-module full or diff-aware smart scan" },
  { name: "run_module", paid: true, desc: "Run one specific module against a path" },
  { name: "fix_issue", paid: true, desc: "AI-driven auto-fix for a specific finding" },
  { name: "explain_finding", paid: true, desc: "Forensic-tier Claude diagnosis per finding" },
  { name: "compose_pr", paid: true, desc: "Render a PR body for a set of fixes" },
  { name: "capture_screenshot", paid: true, desc: "Screenshot any live URL or localhost — the AI sees the rendered page" },
  { name: "get_visual_diff", paid: true, desc: "Baseline vs current visual diff — catch UI regressions" },
  { name: "run_live_checks", paid: true, desc: "Runtime errors, console warnings, API health on any URL" },
  { name: "get_production_errors", paid: true, desc: "Top Sentry / Datadog / Rollbar errors with file:line attribution" },
  { name: "verify_fix", paid: true, desc: "Re-scan changed files — hard pass/fail proof the fix worked" },
  { name: "run_tests", paid: true, desc: "Auto-detect + run the project's test suite (Jest/Vitest/pytest/cargo/go)" },
  { name: "stream_logs", paid: true, desc: "Tail a running process or log file in real time (up to 60s)" },
  { name: "query_db", paid: true, desc: "Read-only SQL/NoSQL queries (Postgres/MySQL/SQLite/MongoDB/Redis)" },
  { name: "http_request", paid: true, desc: "Call any API with auth headers, follow redirects, inspect responses" },
  { name: "audit_log", paid: true, desc: "Query past local scans in the memory store" },
  { name: "compare_repos", paid: true, desc: "Cross-repo prior-art lookup via memory store" },
  { name: "get_report", paid: true, desc: "Retrieve full result of the last scan this session" },
  { name: "scan_repo", paid: true, desc: "Scan any public git repo via the hosted API" },
  { name: "resolve_stack_trace", paid: true, desc: "Minified/bundled stack trace → original file:line via source maps" },
  { name: "blame_regression", paid: true, desc: "Which git commit introduced this line — read-only, ranks candidates across a stack trace" },
];

// Distinct tool count — scan_local appears twice above (quick = free,
// full/smart = paid) but is one tool on the server.
export const TOOL_COUNT = new Set(ALL_TOOLS.map((t) => t.name.split(" ")[0])).size;
