import type { Metadata } from "next";
import { siteUrl } from "@/app/lib/site-url";

// The page is a client component, which cannot export `metadata`; this
// server layout carries the title, description and canonical instead so the
// route stops falling back to the generic site title.
export const metadata: Metadata = {
  title: "Free Repo Scan — GateTest Playground",
  description:
    "Paste a public GitHub repository URL and run a free quick scan in your browser. Live module results, a health grade and the top findings in seconds, no sign-up.",
  alternates: { canonical: siteUrl("/playground") },
};

export default function PlaygroundLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
