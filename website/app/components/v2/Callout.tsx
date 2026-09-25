import type { ReactNode } from "react";

/**
 * An inline note — "not checked", a caveat, a scope boundary — styled as a
 * left-accented box rather than a paragraph aside. `tone` picks the accent
 * colour; default is the site accent, not a status colour, so most callouts
 * ("here is what this page does not claim") don't read as an error.
 */
export function Callout({
  tone = "accent",
  children,
}: {
  tone?: "accent" | "warn" | "bad" | "ok";
  children: ReactNode;
}) {
  return (
    <div className="v2-callout" data-tone={tone === "accent" ? undefined : tone}>
      {children}
    </div>
  );
}
