import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Checkout Cancelled — GateTest",
  description: "Your scan request was cancelled. No charge was made.",
};

export default function CheckoutCancel() {
  return (
    <div className="flex-1 bg-[var(--v2-bg)] flex items-center justify-center px-6 py-16 sm:py-24">
      <div className="v2-wrap-narrow max-w-xl w-full text-center">
        <h1 className="v2-h1 !text-3xl sm:!text-4xl mb-4">Checkout cancelled</h1>
        <p className="text-lg text-[var(--v2-muted)] mb-8">
          No worries — no charge was made. Your card was not held.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link href="/#pricing" className="v2-btn v2-btn-primary">
            Try Again
          </Link>
          <Link href="/" className="v2-btn">
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
