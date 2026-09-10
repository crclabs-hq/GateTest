import type { ReactNode } from "react";

/** A content band with the site's one spacing rhythm and heading style. */
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
    <section id={id} className={`${alt ? "section-alt" : ""} scroll-mt-20`}>
      <div className={`mx-auto px-6 py-16 sm:py-24 ${narrow ? "max-w-3xl" : "max-w-7xl"}`}>
        {(eyebrow || title || lede) && (
          <div className="max-w-2xl mb-10 sm:mb-14">
            {eyebrow && <p className="text-xs font-semibold uppercase tracking-wider text-accent mb-3">{eyebrow}</p>}
            {title && <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-foreground [text-wrap:balance]">{title}</h2>}
            {lede && <p className="mt-4 text-base sm:text-lg text-foreground-secondary leading-relaxed">{lede}</p>}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
