import type { Metadata } from "next";
import { siteUrl } from "@/app/lib/site-url";

// The page is a client component, which cannot export `metadata`; this
// server layout carries the title, description and canonical instead so the
// route stops falling back to the generic site title.
export const metadata: Metadata = {
  title: "Scan Status — GateTest",
  description:
    "Follow your GateTest scan live: modules running, findings as they land, and the finished report with fix options.",
  alternates: { canonical: siteUrl("/scan/status") },
};

export default function ScanStatusLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
