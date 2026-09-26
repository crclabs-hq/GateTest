import { headers } from "next/headers";

/**
 * A `<script>` element that stamps the per-request CSP nonce (set by
 * `website/proxy.ts`, read back via the `x-nonce` request header) onto
 * itself. GT-10 (outside reviewer, 2026-09-26): once `script-src` drops
 * `'unsafe-inline'`, every hand-written inline script — JSON-LD structured
 * data on ~30 pages, the theme pre-hydration bootstrap — needs the same
 * nonce Next.js already attaches to its own inline scripts automatically.
 *
 * One definition (Doctrine #4): pages swap a raw `<script ... />` for
 * `<NonceScript ... />` with the exact same props (untouched
 * `dangerouslySetInnerHTML` content) — the nonce lookup lives here once
 * instead of being re-implemented per page.
 *
 * Calling `headers()` opts the rendering tree into dynamic rendering; that
 * is an accepted, unavoidable consequence of per-request nonces in the App
 * Router (see the Next.js CSP guide: "all pages must be dynamically
 * rendered"), not a defect of this component.
 */
export async function NonceScript(props: React.ComponentProps<"script">) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <script {...props} nonce={nonce} />;
}
