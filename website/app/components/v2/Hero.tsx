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
  children,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="v2-hero">
      {kicker && <div className="v2-kicker mb-6">{kicker}</div>}
      <h1 className="v2-h1 max-w-4xl">{title}</h1>
      {lede && <p className="mt-6 max-w-2xl text-[17px] leading-relaxed text-[var(--v2-muted)]">{lede}</p>}
      {actions && <div className="mt-8 flex flex-wrap gap-3">{actions}</div>}
      {children}
    </div>
  );
}
