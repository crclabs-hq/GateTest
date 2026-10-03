import type { Metadata } from "next";
import { siteUrl } from "@/app/lib/site-url";

// The page is a client component, which cannot export `metadata`; this
// server layout carries the title, description and canonical instead so the
// route stops falling back to the generic site title.
export const metadata: Metadata = {
  title: "Free Scan Preview — GateTest",
  description:
    "Preview what GateTest finds in a public repository before you buy a scan. Real findings from a real run, with the full report one click away.",
  alternates: { canonical: siteUrl("/scan/preview") },
};

export default function ScanPreviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
