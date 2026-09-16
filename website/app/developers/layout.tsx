import type { Metadata } from "next";
import { TOTAL_MODULES } from "@/app/lib/module-count";

export const metadata: Metadata = {
  title: "GateTest for developers — CLI, GitHub Action, API",
  description:
    `Install GateTest in one command. ${TOTAL_MODULES} modules, hard CI gate, AI auto-fix PRs. CLI reference, GitHub Action setup, and REST API for any pipeline.`,
  alternates: { canonical: "/developers" },
  openGraph: {
    title: "GateTest for developers — CLI, GitHub Action, API",
    description:
      `Install GateTest in one command. ${TOTAL_MODULES} modules, hard CI gate, AI auto-fix PRs.`,
    url: "/developers",
    siteName: "GateTest",
    type: "website",
  },
};

export default function DevelopersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
