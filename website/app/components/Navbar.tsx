"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_GROUPS, NAV_LINKS, NAV_ACTIONS, type NavItem } from "./site-nav";

/**
 * The site header. Rendered ONCE from the root layout via SiteChrome — pages
 * must never import it themselves (tests/site-shell.test.js enforces this).
 *
 * Sticky and in-flow (not fixed), so no page needs top padding to clear it.
 * Grouped disclosure menus on desktop; a drawer with 44px targets on phones.
 * Every colour is a token, so the header renders in either theme.
 */

const LINK = "text-sm text-muted hover:text-foreground transition-colors";

function ItemLink({ item, onClick, className = "" }: { item: NavItem; onClick?: () => void; className?: string }) {
  const inner = (
    <>
      <span className="block font-medium text-foreground">{item.label}{item.external ? " ↗" : ""}</span>
      {item.desc && <span className="block text-xs text-muted mt-0.5">{item.desc}</span>}
    </>
  );
  const cls = `block rounded-lg px-3 py-2.5 hover:bg-[var(--background-alt)] transition-colors ${className}`;
  return item.external ? (
    <a href={item.href} className={cls} onClick={onClick} rel="noopener noreferrer">{inner}</a>
  ) : (
    <Link href={item.href} className={cls} onClick={onClick}>{inner}</Link>
  );
}

export default function Navbar() {
  const [open, setOpen] = useState<string | null>(null); // desktop group label
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
  const rootRef = useRef<HTMLElement>(null);

  // Route change closes everything.
  useEffect(() => { setOpen(null); setDrawer(false); }, [pathname]);

  // Escape + click-outside close the desktop menus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, [open]);

  return (
    <header
      ref={rootRef}
      className="sticky top-0 z-50 border-b border-border bg-[color-mix(in_srgb,var(--background)_88%,transparent)] backdrop-blur-xl"
    >
      <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2.5 shrink-0" aria-label="GateTest home">
          <span className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-white font-bold text-sm font-mono">G</span>
          <span className="text-lg font-bold tracking-tight text-foreground">Gate<span className="text-accent-light">Test</span></span>
        </Link>

        {/* Desktop */}
        <nav aria-label="Primary" className="hidden lg:flex items-center gap-1">
          {NAV_GROUPS.map((g) => {
            const id = `menu-${g.label.toLowerCase()}`;
            const isOpen = open === g.label;
            return (
              <div key={g.label} className="relative" onMouseEnter={() => setOpen(g.label)} onMouseLeave={() => setOpen((o) => (o === g.label ? null : o))}>
                <button
                  type="button"
                  className={`${LINK} px-3 py-2 rounded-md inline-flex items-center gap-1 ${isOpen ? "text-foreground" : ""}`}
                  aria-expanded={isOpen}
                  aria-controls={id}
                  onClick={() => setOpen(isOpen ? null : g.label)}
                >
                  {g.label}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                <div
                  id={id}
                  hidden={!isOpen}
                  className="absolute left-0 top-full pt-2"
                >
                  <div className="w-[34rem] grid grid-cols-2 gap-1 p-2 rounded-xl border border-border bg-[var(--surface-solid)] shadow-[var(--shadow-lg)]">
                    {g.items.map((item) => <ItemLink key={item.href} item={item} />)}
                  </div>
                </div>
              </div>
            );
          })}
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={`${LINK} px-3 py-2 rounded-md ${pathname === l.href ? "text-foreground" : ""}`}>{l.label}</Link>
          ))}
        </nav>

        <div className="hidden lg:flex items-center gap-2">
          <Link href={NAV_ACTIONS.signIn.href} className={`${LINK} px-3 py-2`}>{NAV_ACTIONS.signIn.label}</Link>
          <Link href={NAV_ACTIONS.install.href} className="px-3.5 py-2 text-sm font-medium rounded-lg border border-border text-foreground hover:border-accent/50 transition-colors whitespace-nowrap">
            {NAV_ACTIONS.install.label}
          </Link>
          <Link href={NAV_ACTIONS.primary.href} className="btn-cta px-4 py-2 text-sm font-semibold rounded-lg whitespace-nowrap">
            {NAV_ACTIONS.primary.label} →
          </Link>
        </div>

        {/* Phone / tablet */}
        <button
          type="button"
          className="lg:hidden inline-flex items-center justify-center w-11 h-11 -mr-2 rounded-lg text-foreground hover:bg-[var(--background-alt)]"
          aria-label={drawer ? "Close menu" : "Open menu"}
          aria-expanded={drawer}
          aria-controls="site-menu"
          onClick={() => setDrawer(!drawer)}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            {drawer ? <path d="M18 6L6 18M6 6l12 12" /> : <path d="M3 12h18M3 6h18M3 18h18" />}
          </svg>
        </button>
      </div>

      <div id="site-menu" hidden={!drawer} className="lg:hidden border-t border-border bg-[var(--surface-solid)] max-h-[calc(100vh-4rem)] overflow-y-auto">
        <nav aria-label="Primary (mobile)" className="mx-auto max-w-7xl px-4 py-3">
          {NAV_GROUPS.map((g) => (
            <div key={g.label} className="py-2">
              <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted">{g.label}</p>
              {g.items.map((item) => <ItemLink key={item.href} item={item} onClick={() => setDrawer(false)} className="py-3" />)}
            </div>
          ))}
          <div className="py-2 border-t border-border">
            {NAV_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="block px-3 py-3 font-medium text-foreground" onClick={() => setDrawer(false)}>{l.label}</Link>
            ))}
            <Link href={NAV_ACTIONS.signIn.href} className="block px-3 py-3 font-medium text-foreground" onClick={() => setDrawer(false)}>{NAV_ACTIONS.signIn.label}</Link>
          </div>
          <div className="grid gap-2 p-3">
            <Link href={NAV_ACTIONS.install.href} className="block text-center px-4 py-3 rounded-lg border border-border font-medium text-foreground" onClick={() => setDrawer(false)}>{NAV_ACTIONS.install.label}</Link>
            <Link href={NAV_ACTIONS.primary.href} className="btn-cta block text-center px-4 py-3 rounded-lg font-semibold" onClick={() => setDrawer(false)}>{NAV_ACTIONS.primary.label} →</Link>
          </div>
        </nav>
      </div>
    </header>
  );
}
