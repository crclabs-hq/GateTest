/**
 * Pure tone-selection logic for the public /testing proof page
 * (website/app/testing/page.tsx). Kept out of the page component so it is
 * unit-testable without rendering React — see
 * tests/testing-page-proof-tone.test.js.
 *
 * GT-01 (outside reviewer, 2026-09-26): gatetest.io/testing rendered
 * "AUTO-FIXED 0 % (0/40)" in the same green used for a real win — a reader
 * skimming colour alone came away thinking the arena was succeeding. This
 * module decides, from the raw numbers alone, whether the page may wear its
 * success tone or must switch to a warning tone instead, and writes the one
 * honest sentence that goes with that decision.
 */

export type ProofTone = "success" | "warning";

export interface ProofToneStats {
  /** Cycles whose fix PR merged. */
  fixed: number;
  /** Total cycles considered (bug PRs matched, up to the last 40). */
  total: number;
  /** ISO timestamp of the most recently merged fix, or null if none ever landed. */
  lastFixedAt: string | null;
  /**
   * Known cause when fixed === 0, if any (e.g. "fixes are in flight but none
   * has merged yet"). Optional — the page still tells the truth without it.
   */
  reason?: string | null;
}

export interface ProofToneResult {
  tone: ProofTone;
  /** One sentence, safe to render next to the stat tiles. */
  headline: string;
}

/** A fix that landed longer ago than this no longer earns the success tone. */
export const PROOF_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function daysAgo(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/**
 * Decides the page's tone from the raw numbers. The success tone requires
 * BOTH at least one merged fix AND that fix having landed within the last
 * 7 days — a page that hasn't proven anything recently does not get to wear
 * the green regardless of the historical percentage.
 */
export function selectProofTone(
  stats: ProofToneStats,
  now: number = Date.now(),
): ProofToneResult {
  const { fixed, total, lastFixedAt, reason } = stats;
  const ageMs = lastFixedAt !== null ? now - Date.parse(lastFixedAt) : null;
  const hasRecentFix = ageMs !== null && ageMs >= 0 && ageMs <= PROOF_STALE_MS;

  if (fixed === 0 && total > 0) {
    return {
      tone: "warning",
      headline: reason
        ? `${total} cycles ran; none produced a merged fix yet — ${reason}.`
        : `${total} cycles ran; none produced a merged fix yet.`,
    };
  }

  if (!hasRecentFix) {
    return {
      tone: "warning",
      headline:
        lastFixedAt !== null
          ? `No fix has landed in the last 7 days — the most recent merged fix was ${daysAgo(ageMs as number)}.`
          : "No fix has landed yet.",
    };
  }

  return {
    tone: "success",
    headline: `${fixed} of ${total} cycles auto-fixed — most recently ${daysAgo(ageMs as number)}.`,
  };
}
