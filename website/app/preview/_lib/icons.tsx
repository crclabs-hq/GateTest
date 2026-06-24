/**
 * Inline, stroke-based icon set for the /preview homepage. No icon dependency.
 * Pure components — safe to import from both server and client components.
 */

export type IconProps = { className?: string };

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const I = {
  shield: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M12 3l7 3v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  gauge: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M4 18a8 8 0 1116 0" />
      <path d="M12 18l4-5" />
      <circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  branch: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="9" r="2.2" />
      <path d="M6 8.2v7.6M8.2 6h4a3.8 3.8 0 013.8 3" />
    </svg>
  ),
  bug: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <rect x="8" y="8" width="8" height="11" rx="4" />
      <path d="M9 5l1.5 2M15 5l-1.5 2M4 11h4M16 11h4M4 16h4M16 16h4M12 8v11" />
    </svg>
  ),
  type: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M4 7V5h16v2M9 19h6M12 5v14" />
    </svg>
  ),
  cube: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  ),
  key: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <circle cx="8" cy="8" r="3.5" />
      <path d="M10.5 10.5L20 20M16 16l2-2M14 14l2-2" />
    </svg>
  ),
  server: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <rect x="4" y="5" width="16" height="6" rx="1.5" />
      <rect x="4" y="13" width="16" height="6" rx="1.5" />
      <path d="M7.5 8h.01M7.5 16h.01" />
    </svg>
  ),
  eye: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  ),
  sparkle: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
    </svg>
  ),
  flask: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M9 3h6M10 3v6l-4.5 8a2 2 0 001.8 3h9.4a2 2 0 001.8-3L14 9V3" />
      <path d="M7.5 15h9" />
    </svg>
  ),
  check: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M5 12l4.5 4.5L19 7" />
    </svg>
  ),
  arrow: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  chevron: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  github: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} fill="currentColor">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.7c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.36 1.12 2.94.86.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.34 9.34 0 015 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.79-4.58 5.05.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.02 10.02 0 0022 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  ),
  lock: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 018 0v3" />
    </svg>
  ),
};
