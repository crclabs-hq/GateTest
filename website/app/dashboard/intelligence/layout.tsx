import type { Metadata } from "next";
import { siteUrl } from "@/app/lib/site-url";

// The page is a client component, which cannot export `metadata`; this
// server layout carries the title, description and canonical instead so the
// route stops falling back to the generic site title.
export const metadata: Metadata = {
  title: "Scan Intelligence — GateTest Dashboard",
  description:
    "Trends, noise and fix outcomes across your GateTest scans.",
  alternates: { canonical: siteUrl("/dashboard/intelligence") },
};

export default function DashboardIntelligenceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
