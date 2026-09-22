import type { Metadata } from "next";
import { TOTAL_MODULES } from "@/app/lib/module-count";

export const metadata: Metadata = {
  title: "How GateTest works — Architecture, modules, flywheel, tiers",
  description:
    `${TOTAL_MODULES} modules — deterministic first. A model is called only to generate a fix. The full technical architecture behind GateTest — the static engine, the fix flywheel, the 4-tier deliverable, and the documented limits.`,
  keywords: [
    "GateTest architecture",
    "how GateTest works",
    "static code analysis",
    "AI code review",
    "code fix flywheel",
    "deterministic scanning",
    "auto-fix pull requests",
    "Next.js serverless architecture",
    "GitHub App integration",
    "Gluecron integration",
  ],
  alternates: {
    canonical: "/how-it-works",
  },
  openGraph: {
    title: "How GateTest works — Architecture, modules, flywheel, tiers",
    description:
      `${TOTAL_MODULES} modules — deterministic first. One AI pass when it's worth it. The full technical architecture behind GateTest.`,
    url: "/how-it-works",
    siteName: "GateTest",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "How GateTest works",
    description:
      "The full technical architecture: static engine first, a model only for the fix.",
  },
};

export default function HowItWorksLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
