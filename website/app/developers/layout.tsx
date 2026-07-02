import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GateTest for developers — CLI, GitHub Action, API",
  description:
    "Install GateTest in one command. 110 modules, hard CI gate, AI auto-fix PRs. CLI reference, GitHub Action setup, and REST API for any pipeline.",
  alternates: { canonical: "https://gatetest.ai/developers" },
  openGraph: {
    title: "GateTest for developers — CLI, GitHub Action, API",
    description:
      "Install GateTest in one command. 110 modules, hard CI gate, AI auto-fix PRs.",
    url: "https://gatetest.ai/developers",
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
