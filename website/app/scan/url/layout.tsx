import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Free website security scan — GateTest",
  description:
    "Scan any public URL for missing security headers, TLS misconfig, exposed files, and live JavaScript errors. Free preview, full report from $29.",
  alternates: { canonical: "https://gatetest.ai/scan/url" },
  openGraph: {
    title: "Free website security scan — GateTest",
    description:
      "Scan any public URL for missing security headers, TLS misconfig, exposed files, and live JavaScript errors.",
    url: "https://gatetest.ai/scan/url",
    siteName: "GateTest",
    type: "website",
  },
};

export default function ScanUrlLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
