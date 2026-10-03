import type { Metadata } from "next";
import { siteUrl } from "@/app/lib/site-url";

// The page is a client component, which cannot export `metadata`; this
// server layout carries the title, description and canonical instead so the
// route stops falling back to the generic site title.
export const metadata: Metadata = {
  title: "Payment Received — GateTest",
  description:
    "Your payment went through. We are starting your GateTest scan now.",
  alternates: { canonical: siteUrl("/checkout/success") },
};

export default function CheckoutSuccessLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
