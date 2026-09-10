import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Checkout Cancelled — GateTest",
  description: "Your scan request was cancelled. No charge was made.",
};

export default function CheckoutCancel() {
  return (
    <div className="flex-1 bg-background flex items-center justify-center px-6 py-16 sm:py-24">
      <div className="max-w-xl w-full text-center">
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-4">Checkout cancelled</h1>
        <p className="text-lg text-muted mb-8">
          No worries — no charge was made. Your card was not held.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/#pricing"
            className="px-8 py-4 text-base font-semibold rounded-xl bg-accent hover:bg-accent-light text-white transition-all"
          >
            Try Again
          </Link>
          <Link
            href="/"
            className="px-8 py-4 text-base font-semibold rounded-xl border border-border hover:border-accent/50 text-foreground transition-all"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
