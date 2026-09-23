/**
 * The v2 icon set: small, stroke-based, currentColor, no filled emoji-style
 * glyphs (the 2026-09-22 pass removed emoji icons from developers, badge,
 * mcp, scan/url, fixes and the URL-scan flow — this is what replaces them
 * site-wide). Every icon is 16x16 by default via `size`.
 */
type IconProps = { size?: number; className?: string };

export function IconCheck({ size = 16, className = "" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function IconCross({ size = 16, className = "" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function IconArrowRight({ size = 16, className = "" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}

export function IconChevronDown({ size = 12, className = "" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={className} aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function IconDot({ size = 8, className = "" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="4" cy="4" r="4" />
    </svg>
  );
}
