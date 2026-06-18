import type { Metadata } from "next";

export const metadata: Metadata = {
  title:
    "Triage — find where the bug actually lives between source, server, and browser · GateTest",
  description:
    "GateTest's triage workflow runs three scans in parallel and tells you which layer the bug lives in. Heuristic 9-rule cascade. Source-server-browser localisation. Admin-only today, public scan soon.",
  keywords: [
    "code triage",
    "bug localisation",
    "source server browser",
    "static analysis",
    "live runtime check",
    "headless browser scan",
    "deploy skew",
    "GateTest triage",
  ],
  alternates: {
    canonical: "https://gatetest.ai/triage",
  },
  openGraph: {
    title:
      "Triage — find where the bug actually lives between source, server, and browser",
    description:
      "Three scans in parallel, one verdict. A heuristic 9-rule cascade localises the bug to SOURCE, SERVER, BROWSER, BUILD, or MIXED. From $29.",
    url: "https://gatetest.ai/triage",
    siteName: "GateTest",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "GateTest Triage — find where the bug actually lives",
    description:
      "A heuristic 9-rule cascade tells you whether the bug is in source, server, or browser.",
  },
};

export default function TriageLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
