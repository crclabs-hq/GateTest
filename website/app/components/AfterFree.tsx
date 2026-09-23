import Link from "next/link";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import { TIERS } from "@/app/lib/checkout-tiers";
import { SAMPLE_REPORT_URL } from "@/app/lib/sample-report";

/**
 * <AfterFree> — "what happens after the free tier."
 *
 * Issue #678, gap 5: nothing on / or /pricing said what the paid tier adds,
 * what stays free regardless, or what happens to a free scan's report once
 * its share link expires. A buyer had to run the free scan and read the
 * inline upgrade card (playground/page.tsx) to find any of this out, and
 * that card never mentions the local CLI/MCP staying free or the 48h share
 * window. Rendered on both / and /pricing so it is visible before AND
 * without running a scan.
 *
 * Every number here is imported, not typed: TOTAL_MODULES (the catalogue
 * behind the Sync Rule tests) and TIERS.quick (the same object Stripe
 * checkout reads), so this section cannot drift from what the product
 * actually does.
 */
const FREE_MODULE_COUNT = TIERS.quick.modules.split(",").length;

export default function AfterFree() {
  return (
    <section id="after-free" className="py-20 px-6 border-t border-border bg-background-alt">
      <div className="mx-auto max-w-5xl">
        <div className="text-center mb-12">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            Before you decide
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-3 text-foreground">
            What happens after the free scan
          </h2>
          <p className="text-muted text-base max-w-2xl mx-auto">
            No card for the free scan, and nothing about it changes later. Here is exactly what
            stays free, what a paid run adds, and what happens to a free report once it ages out.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-5">
          <div className="rounded-2xl border border-border bg-surface-solid p-6">
            <h3 className="font-bold text-foreground mb-2">Free, no limit on retries</h3>
            <p className="text-sm text-muted leading-relaxed">
              The {FREE_MODULE_COUNT}-module quick scan on a URL or a public repo needs no card
              and no account, and you can run it again any time. The CLI and the local MCP server
              are free permanently — every tool runs on your own machine and your own API key, not
              ours.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-surface-solid p-6">
            <h3 className="font-bold text-foreground mb-2">What a paid run adds</h3>
            <p className="text-sm text-muted leading-relaxed">
              A Full Scan runs the rest of the {TOTAL_MODULES}-module engine instead of the free
              {" "}{FREE_MODULE_COUNT}. Scan&nbsp;+&nbsp;Fix and Forensic add an auto-fix pull
              request with a regression test, a second-model review, and (Forensic only) per-finding
              AI diagnosis and a board-ready report. Charged per run, no seats, no subscription
              required.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-surface-solid p-6">
            <h3 className="font-bold text-foreground mb-2">What happens at the limit</h3>
            <p className="text-sm text-muted leading-relaxed">
              A free scan&apos;s shareable result link works for 48 hours, then expires — nothing
              is deleted from your repository or account, because a free scan does not require one.
              Run it again and it is instant and free again; nothing is rate-limited beyond a few
              requests per minute, enough for a real visitor and not for a scraper.
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-muted mt-8">
          See a full report instead of taking our word for it:{" "}
          <Link
            href={SAMPLE_REPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            our own repository&apos;s current full-scan findings
          </Link>
          , uploaded by the same CI job on every push to main.
        </p>
      </div>
    </section>
  );
}
