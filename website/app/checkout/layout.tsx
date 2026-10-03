import type { Metadata } from "next";
import { siteUrl } from "@/app/lib/site-url";

// The page is a client component, which cannot export `metadata`; this
// server layout carries the title, description and canonical instead so the
// route stops falling back to the generic site title.
export const metadata: Metadata = {
  title: "Checkout — GateTest",
  description:
    "Review your GateTest scan and continue to secure Stripe checkout. One-time payment per scan, charged up front.",
  alternates: { canonical: siteUrl("/checkout") },
};

export default function CheckoutLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
