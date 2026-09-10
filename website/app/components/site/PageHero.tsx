import type { ReactNode } from "react";

/**
 * The one hero every page opens with. Eyebrow, display headline, lede, then
 * actions. Same measure, same rhythm, same type scale on every route, so a
 * visitor moving between pages never feels the site change under them.
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
    <section className="section-alt border-b border-border">
      <div className={`mx-auto max-w-7xl px-6 py-16 sm:py-24 ${children ? "grid gap-12 lg:grid-cols-2 lg:items-center" : ""}`}>
        <div className={centered ? "text-center mx-auto max-w-3xl" : "max-w-2xl"}>
          {eyebrow && (
            <p className="inline-flex items-center gap-2 rounded-full border border-border bg-[var(--surface-solid)] px-3 py-1 text-xs font-medium text-muted mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-light" aria-hidden="true" />
              {eyebrow}
            </p>
          )}
          <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-foreground [text-wrap:balance]">
            {title}
          </h1>
          {lede && <p className="mt-6 text-lg sm:text-xl text-foreground-secondary leading-relaxed [text-wrap:pretty]">{lede}</p>}
          {actions && <div className={`mt-8 flex flex-wrap gap-3 ${centered ? "justify-center" : ""}`}>{actions}</div>}
        </div>
        {children && <div className="min-w-0">{children}</div>}
      </div>
    </section>
  );
}
