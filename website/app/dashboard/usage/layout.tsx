import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Usage — GateTest",
  description:
    "Your GateTest usage meter: scans, fixes, findings, AI tokens and estimated cost across every surface, with BYOK and metered runs listed separately.",
  robots: { index: false, follow: false },
};

export default function UsageLayout({ children }: { children: React.ReactNode }) {
  return children;
}
