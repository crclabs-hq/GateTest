/**
 * The response a visitor gets when they reach an OAuth initiate route whose
 * credentials are not configured.
 *
 * ── Why this is not `NextResponse.json(...)` ────────────────────────────────
 * All three routes used to answer with a raw JSON error body. Two of them also
 * included `missing: status.missing` — the NAMES of our unset environment
 * variables, handed to an unauthenticated visitor who did nothing but click a
 * button. That is needless information disclosure about our infrastructure.
 *
 * These routes are reached by a human clicking "Continue with X" in a browser,
 * never by an API client. So the response is a readable page with a way back,
 * and it says the same thing to everyone: this option is unavailable. Why it is
 * unavailable is an operator concern, visible on /api/status.
 *
 * The status stays 503 — the option genuinely is temporarily unavailable, and
 * lying with a 200 would hide it from uptime checks.
 *
 * AuthModal hides unconfigured providers via /api/auth/providers, so in normal
 * use nobody reaches this. It is the backstop for a direct hit, a stale tab, or
 * a bookmark.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function authUnavailable(providerLabel: string): Response {
  const safe = escapeHtml(providerLabel);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign-in unavailable — GateTest</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0d1117; color:#e6edf3; font:15px/1.6 ui-sans-serif,system-ui,sans-serif; padding:1.5rem }
  .card { max-width:26rem; text-align:center; border:1px solid #ffffff14; border-radius:1rem;
          background:#161b22; padding:2.5rem 2rem }
  h1 { font-size:1.125rem; margin:0 0 .75rem }
  p { color:#8b949e; margin:0 0 1.5rem }
  a.btn { display:inline-block; padding:.7rem 1.4rem; border-radius:.6rem; background:#0d9488;
          color:#fff; text-decoration:none; font-weight:600; font-size:.875rem }
  a.mail { color:#8b949e }
</style></head>
<body><div class="card">
  <h1>${safe} sign-in is temporarily unavailable</h1>
  <p>Nothing is wrong with your account — this option is switched off right now.
     Try another sign-in method, or email us and we&#39;ll sort it out.</p>
  <a class="btn" href="/">Back to GateTest</a>
  <p style="margin:1.25rem 0 0;font-size:.8125rem">
    <a class="mail" href="mailto:support@gatetest.io">support@gatetest.io</a>
  </p>
</div></body></html>`;

  return new Response(html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
