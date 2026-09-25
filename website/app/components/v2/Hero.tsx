import type { ReactNode } from "react";

/**
 * A page hero that sizes to its content — no forced min-h-screen, no hero
 * background image. Every non-home public page restyled under issue #686
 * should open with this instead of a bespoke hero, so the kicker/h1/lede/
 * actions rhythm matches the homepage exactly.
 */
export function Hero({
  kicker,
  title,
  lede,
  actions,
  align = "left",
  children,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  /** "center" is for a hero built around one focal action (a search box, a
   *  single CTA) — most pages should leave this at the default "left". */
  align?: "left" | "center";
  children?: ReactNode;
}) {
  const centered = align === "center";
  return (
    <div className={`v2-hero ${centered ? "text-center" : ""}`}>
      {kicker && <div className={`v2-kicker mb-6 ${centered ? "flex justify-center" : ""}`}>{kicker}</div>}
      <h1 className={`v2-h1 max-w-4xl ${centered ? "mx-auto" : ""}`}>{title}</h1>
      {lede && (
        <p className={`mt-6 text-[17px] leading-relaxed text-[var(--v2-muted)] ${centered ? "max-w-2xl mx-auto" : "max-w-2xl"}`}>
          {lede}
        </p>
      )}
      {actions && <div className={`mt-8 flex flex-wrap gap-3 ${centered ? "justify-center" : ""}`}>{actions}</div>}
      {children}
    </div>
  );
}
