import { redirect } from "next/navigation";

/**
 * /docs has no index of its own — the developer hub lives at /developers,
 * with /docs/configuration and /docs/api underneath this path. Until a real
 * index exists, a bare /docs must not 404 (live-site audit 2026-09-10).
 */
export default function DocsIndex() {
  redirect("/developers");
}
