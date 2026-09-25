import type { ReactNode } from "react";

/**
 * The one hero every page opens with. Eyebrow, display headline, lede, then
 * actions. Same measure, same rhythm, same type scale on every route, so a
 * visitor moving between pages never feels the site change under them.
 *
 * Restyled onto the v2 design-token system (issue #686 phase 2, 2026-09-23):
 * this is a shared component used by ~40 page families, so restyling it once
 * here carries the v2 look (and the .v2-wrap min-width: 0 overflow fix — see
 * globals.css) to every page that already calls <PageHero>, the same way
 * #696 restyled LegalDocument.tsx once for all six legal pages. The external
 * prop API is unchanged, so no call site needs to change.
 */
export default function PageHero({
  eyebrow,
  title,
  lede,
  actions,
  align = "left",
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  align?: "left" | "center";
  children?: ReactNode;
}) {
  const centered = align === "center";
  return (
    <section className="bg-[var(--v2-bg-alt)] border-b border-[var(--v2-line)]">
      <div className={`v2-wrap py-16 sm:py-24 ${children ? "grid gap-12 lg:grid-cols-2 lg:items-center" : ""}`}>
        <div className={centered ? "text-center mx-auto max-w-3xl" : "max-w-2xl"}>
          {eyebrow && (
            <p className={`v2-kicker mb-6 ${centered ? "flex justify-center" : ""}`}>
              {eyebrow}
            </p>
          )}
          <h1 className="v2-h1 [text-wrap:balance]">
            {title}
          </h1>
          {lede && <p className="mt-6 text-[17px] leading-relaxed text-[var(--v2-muted)] max-w-2xl [text-wrap:pretty]">{lede}</p>}
          {actions && <div className={`mt-8 flex flex-wrap gap-3 ${centered ? "justify-center" : ""}`}>{actions}</div>}
        </div>
        {children && <div className="min-w-0">{children}</div>}
      </div>
    </section>
  );
}
