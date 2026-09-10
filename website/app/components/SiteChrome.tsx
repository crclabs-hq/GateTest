"use client";

import { usePathname } from "next/navigation";
import Navbar from "./Navbar";
import Footer from "./Footer";

/**
 * The site shell, rendered once from app/layout.tsx. Every public page gets
 * the same header and footer; the operator console under /admin has its own
 * chrome and opts out. Pages never import Navbar or Footer directly —
 * tests/site-shell.test.js fails if one does.
 */
const NO_CHROME_PREFIXES = ["/admin"];

function bare(pathname: string | null): boolean {
  return !!pathname && NO_CHROME_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function SiteHeader() {
  const pathname = usePathname();
  if (bare(pathname)) return null;
  return <Navbar />;
}

export function SiteFooter() {
  const pathname = usePathname();
  if (bare(pathname)) return null;
  return <Footer />;
}
