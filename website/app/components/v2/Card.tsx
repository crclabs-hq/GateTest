import type { ReactNode } from "react";

/**
 * The v2 card: hairline border, border brightens to the accent on hover,
 * no lift/glow/3D tilt (Craig 2026-09-22 — "restrained engineering", not a
 * consumer-SaaS template). Use for module tiles, tier cards, use-case
 * cards — anywhere the old .card-highlight glow shape showed up.
 */
export function Card({
  as: As = "div",
  className = "",
  children,
}: {
  as?: "div" | "li" | "article";
  className?: string;
  children: ReactNode;
}) {
  return <As className={`v2-card ${className}`.trim()}>{children}</As>;
}
