import type { Metadata } from "next";

// Standalone preview shell. This route is a greenfield homepage prototype —
// it paints its own deep-ink surface and does NOT inherit the marketing
// site's light theme. Deployed to /preview for review before any live swap.
export const metadata: Metadata = {
  title: "GateTest — AI writes fast. GateTest keeps it honest.",
  description:
    "The QA guardrail for the AI-assisted engineering era. 120+ checks in one unified scan — security, memory leaks, type safety, edge cases, architecture. Every issue ships back as an auto-fix pull request.",
  robots: { index: false, follow: false },
};

export default function PreviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="gt-preview-root">{children}</div>;
}
