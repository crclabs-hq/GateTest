"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";
import { BuildStatusBar } from "./BuildStatusBar";

interface NavItem {
  href: string;
  label: string;
}

// Every admin section, one place (issue #691 — "sidebar naming every
// section"). Order matches the issue's own list.
const NAV_ITEMS: NavItem[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/health", label: "Health" },
  { href: "/admin/triage", label: "Triage" },
  { href: "/admin/compliance", label: "Compliance" },
  { href: "/admin/feedback", label: "Feedback" },
  { href: "/admin/learning", label: "Learning" },
  { href: "/admin/pipeline-trace", label: "Pipeline trace" },
  { href: "/admin/integrations/tallrig", label: "Integrations" },
  { href: "/admin/hn-launch", label: "Launch" },
];

function isCurrent(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

async function signOut() {
  try {
    await fetch("/api/admin/auth", { method: "DELETE", credentials: "same-origin" });
  } finally {
    window.location.href = "/admin";
  }
}

export function AdminShell({ adminLogin, children }: { adminLogin: string; children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="gt-admin-root">
      <aside className="gt-admin-sidebar" aria-label="Admin sections">
        <div className="gt-admin-brand">
          <span className="gt-admin-brand-mark">G</span>
          <span>GateTest Admin</span>
        </div>
        <nav className="gt-admin-nav">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="gt-admin-nav-link"
              aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="gt-admin-sidebar-footer">
          <span className="gt-admin-note" style={{ color: "var(--gt-admin-sidebar-fg)" }}>
            Signed in as <strong>{adminLogin}</strong>
          </span>
          <button type="button" className="gt-admin-signout" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="gt-admin-main">
        <header className="gt-admin-topbar">
          <BuildStatusBar />
          <ThemeToggle />
        </header>
        <main className="gt-admin-content">
          <div className="gt-admin-page">{children}</div>
        </main>
      </div>
    </div>
  );
}
