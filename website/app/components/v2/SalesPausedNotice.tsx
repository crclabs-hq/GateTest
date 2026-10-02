"use client";

import { useSalesStatus } from "../useSalesStatus";

/**
 * Shown above the price table while sales are paused (lib/sales-pause.js), so
 * a price list never reads as an offer we are not taking. Renders nothing
 * while open, loading, or if the status could not be read — checkout itself
 * refuses on the server either way.
 */
export function SalesPausedNotice() {
  const sales = useSalesStatus();
  if (!sales || !sales.paused) return null;
  return (
    <p role="status" className="mb-4 rounded-lg border border-[var(--v2-border,var(--border))] px-4 py-3 text-sm">
      {sales.message}
    </p>
  );
}
