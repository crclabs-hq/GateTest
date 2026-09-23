import type { ReactNode } from "react";

/**
 * A v2 page section: the 96px-padded, hairline-topped band every /preview
 * section uses, now shared. `tight` is for text-heavy pages (legal,
 * glossary) that don't want marketing-scale whitespace. `wrap={false}` lets
 * a caller that needs a wider or custom container skip .v2-wrap.
 */
export function Section({
  id,
  stage,
  tight,
  wrap = true,
  className = "",
  children,
}: {
  id?: string;
  /** Sets data-stage for pages using the Rail. */
  stage?: string;
  tight?: boolean;
  wrap?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const sectionClass = `${tight ? "v2-section-tight" : "v2-section"} ${className}`.trim();
  const body = wrap ? <div className="v2-wrap">{children}</div> : children;
  return (
    <section id={id} data-stage={stage} className={sectionClass}>
      {body}
    </section>
  );
}
