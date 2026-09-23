"use client";

import { useEffect, useState } from "react";

/**
 * Three-state theme control (issue #690, owner 23 Sep): system, light, dark.
 * "system" removes any stored choice and lets globals.css's
 * `@media (prefers-color-scheme: dark)` block decide. An explicit choice
 * stamps `data-theme` on <html> and is persisted so it survives a reload —
 * the actual first-paint value comes from the inline script in
 * app/layout.tsx (THEME_INIT_SCRIPT), not from this component, which only
 * runs after hydration. localStorage is wrapped in try/catch everywhere:
 * a private-browsing tab or a blocked storage API must not break the page,
 * it just falls back to "system" for that visit.
 */

export const THEME_STORAGE_KEY = "gatetest-theme";
type ThemeChoice = "system" | "light" | "dark";

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function applyTheme(choice: ThemeChoice) {
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
}

const OPTIONS: { value: ThemeChoice; label: string; short: string }[] = [
  { value: "system", label: "Match system theme", short: "Auto" },
  { value: "light", label: "Light theme", short: "Light" },
  { value: "dark", label: "Dark theme", short: "Dark" },
];

export function ThemeToggle({ className = "" }: { className?: string }) {
  // Starts "system" on the server and every first client render (so
  // hydration always matches), then syncs to whatever was actually stored
  // — the pre-hydration script in layout.tsx already painted the right
  // theme before this ever runs, so there is no flash either way.
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => { setChoice(readStored()); }, []);

  function choose(next: ThemeChoice) {
    setChoice(next);
    applyTheme(next);
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked — the theme still applies for this page view via
      // applyTheme() above, it just won't survive a reload.
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={`inline-flex items-center gap-0.5 rounded-[var(--v2-radius-sm)] border border-border p-0.5 ${className}`}
    >
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={choice === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => choose(o.value)}
          className={`px-2 py-1 text-xs rounded-[4px] transition-colors ${
            choice === o.value
              ? "bg-[var(--surface-solid)] text-foreground shadow-[var(--shadow-sm)]"
              : "text-muted hover:text-foreground"
          }`}
        >
          {o.short}
        </button>
      ))}
    </div>
  );
}

/**
 * Inline, pre-hydration script — read the stored choice and stamp
 * data-theme on <html> before first paint, so there is never a flash of
 * the wrong theme. Rendered via dangerouslySetInnerHTML as the first thing
 * in <head> (app/layout.tsx). Deliberately does nothing for "system": the
 * CSS media query already handles that case with no JS required, and a
 * missing/blocked localStorage falls back to system silently.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;
