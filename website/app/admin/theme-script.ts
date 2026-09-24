/**
 * Admin theme — pre-hydration script + shared constants (#690 contract).
 *
 * Three states — system / light / dark. "system" stores no override and
 * follows `prefers-color-scheme` (admin.css's media-query block). An
 * explicit choice stamps `data-theme` on `<html>` and is persisted so the
 * NEXT load can apply it before first paint — this file's `ADMIN_THEME_SCRIPT`
 * is inlined as a blocking <script> at the very top of the admin body, so
 * there is no flash of the wrong theme.
 *
 * Scoped to the admin only (own localStorage key) — the customer-facing
 * toggle in the Navbar is #690's own scope, owned by a different builder,
 * and this repo has no shared token file to key off yet (#686 not merged).
 */

export const ADMIN_THEME_STORAGE_KEY = "gatetest-admin-theme";

export type AdminThemeChoice = "system" | "light" | "dark";

/**
 * Plain string of JS, inlined via `<script dangerouslySetInnerHTML>` before
 * any content renders. Wrapped in try/catch — localStorage can throw (private
 * browsing, blocked storage) and the page must still render correctly
 * (falls back to "system", i.e. no `data-theme` attribute at all).
 */
export function getAdminThemeScript(): string {
  // The empty catch inside the returned string below is TEXT — part of the
  // browser-injected pre-hydration script, not real code in this file —
  // deliberately empty for the reason in this function's own doc comment
  // above (localStorage can throw; the page must still render either way).
  return `(function(){try{var k=${JSON.stringify(ADMIN_THEME_STORAGE_KEY)};var v=localStorage.getItem(k);if(v==="light"||v==="dark"){document.documentElement.setAttribute("data-theme",v);}}catch(e){}})();`; // error-ok — string literal, not real code
}

/** Read the stored choice — never throws. */
export function readStoredAdminTheme(): AdminThemeChoice {
  try {
    const v = localStorage.getItem(ADMIN_THEME_STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // error-ok — private browsing / blocked storage; default to system
  }
  return "system";
}

/** Persist a choice and apply it immediately — never throws. */
export function applyAdminTheme(choice: AdminThemeChoice): void {
  if (choice === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", choice);
  }
  try {
    if (choice === "system") {
      localStorage.removeItem(ADMIN_THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(ADMIN_THEME_STORAGE_KEY, choice);
    }
  } catch {
    // error-ok — the attribute is already applied; persistence is best-effort
  }
}
