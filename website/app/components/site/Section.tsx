import type { ReactNode } from "react";

/**
 * A content band with the site's one spacing rhythm and heading style.
 *
 * Restyled onto the v2 design-token system (issue #686 phase 2, 2026-09-23):
 * shared by ~40 page families, so restyling it once here carries the v2
 * look — v2-kicker/v2-h2 type, v2-wrap's min-width: 0 overflow fix, the
 * v2-bg-alt banding token — to every page that already calls <Section>. The
 * external prop API is unchanged, so no call site needs to change.
 */
export default function Section({
  id,
  eyebrow,
  title,
  lede,
  alt = false,
  narrow = false,
  children,
}: {
  id?: string;
  eyebrow?: ReactNode;
  title?: ReactNode;
  lede?: ReactNode;
  alt?: boolean;
  narrow?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`${alt ? "bg-[var(--v2-bg-alt)]" : ""} v2-section-tight scroll-mt-20`}>
      <div className={narrow ? "v2-wrap-narrow" : "v2-wrap"}>
        {(eyebrow || title || lede) && (
          <div className="max-w-2xl mb-10 sm:mb-14">
            {eyebrow && <p className="v2-kicker mb-3">{eyebrow}</p>}
            {title && <h2 className="v2-h2 [text-wrap:balance]">{title}</h2>}
            {lede && <p className="mt-4 text-base sm:text-lg text-[var(--v2-muted)] leading-relaxed">{lede}</p>}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
