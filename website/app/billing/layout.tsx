import type { Metadata } from "next";
import { siteUrl } from "@/app/lib/site-url";

// The page is a client component, which cannot export `metadata`; this
// server layout carries the title, description and canonical instead so the
// route stops falling back to the generic site title.
export const metadata: Metadata = {
  title: "Billing — Manage Your GateTest Subscription",
  description:
    "Update your card, download invoices, change plan or cancel. Enter the email used at checkout and a secure billing-portal link is sent to your inbox.",
  alternates: { canonical: siteUrl("/billing") },
};

export default function BillingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
