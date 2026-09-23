"use client";

import { useEffect, useState } from "react";
import { applyAdminTheme, readStoredAdminTheme, type AdminThemeChoice } from "./theme-script";

const OPTIONS: Array<{ id: AdminThemeChoice; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** Three-state theme toggle (system / light / dark) for the admin top bar. */
export function ThemeToggle() {
  // Starts "system" on the server and every first client render so hydration
  // never mismatches; the real stored choice (if any) is applied a tick
  // later — admin-theme-script.tsx already set `data-theme` before paint,
  // so there is no visible flash even though this label briefly lags.
  const [choice, setChoice] = useState<AdminThemeChoice>("system");

  useEffect(() => {
    setChoice(readStoredAdminTheme());
  }, []);

  function choose(next: AdminThemeChoice) {
    setChoice(next);
    applyAdminTheme(next);
  }

  return (
    <div className="gt-theme-toggle" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="radio"
          aria-checked={choice === opt.id}
          aria-pressed={choice === opt.id}
          onClick={() => choose(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
