import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CUSTOMER_COOKIE_NAME, verifyCustomerSession } from "./app/lib/customer-session";

// GT-10 (outside reviewer, 2026-09-26): every gatetest.io response carried
// `script-src 'self' 'unsafe-inline' 'unsafe-eval' ...` — a product whose own
// modules (webHeaders, cookieSecurity) grade other sites on exactly this
// weakness. The CSP itself is generated in `./app/lib/csp.js` — ONE
// definition (Doctrine #4) — so `tests/website-csp-nonce.test.js` can assert
// on the same builder this file uses, without spinning up a server.
//
// This is `proxy.ts`, not `middleware.ts`: Next 16 renamed the file
// convention (website/node_modules/next/AGENTS.md warns this Next version
// has breaking changes vs. training data; confirmed against
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
// {proxy,middleware}.md — `middleware.js` is deprecated and non-functional
// under the file-convention docs, `proxy.js` is its replacement, same
// runtime behavior).
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildCsp } = require("./app/lib/csp.js") as {
  buildCsp: (opts: { nonce: string; isDev: boolean }) => string;
};

// The sign-in gate — ONE definition in `./app/lib/session-gate.js`, tested by
// tests/signin-gate.test.js. An anonymous request for a protected page gets a
// 307 to /login?next=… from here, before any page renders (#810).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { requireSession } = require("./app/lib/session-gate.js") as {
  requireSession: (opts: {
    pathname: string;
    search: string;
    cookie: string | undefined;
    secret: string;
    verify: typeof verifyCustomerSession;
  }) => { ok: true } | { ok: false; location: string };
};

export function proxy(request: NextRequest) {
  const gate = requireSession({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    cookie: request.cookies.get(CUSTOMER_COOKIE_NAME)?.value,
    secret: process.env.SESSION_SECRET || "",
    verify: verifyCustomerSession,
  });
  if (!gate.ok) {
    // Relative Location on purpose: behind the box's proxy `request.url`
    // carries the internal host, and a relative target is always right.
    return new NextResponse(null, {
      status: 307,
      headers: { Location: gate.location, "Cache-Control": "private, no-store" },
    });
  }

  // Matches the Next.js CSP guide's own proxy.ts example
  // (content-security-policy.md, "Adding a nonce with Proxy").
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV !== "production";
  const csp = buildCsp({ nonce, isDev });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  matcher: [
    // Every document/API response needs the CSP + nonce; static assets
    // under _next/static and _next/image and the favicon don't execute
    // scripts and don't need either, so they're excluded (Next.js CSP
    // guide's own recommended matcher shape).
    {
      source: "/((?!_next/static|_next/image|favicon\\.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
