import type { Metadata } from "next";

export const metadata: Metadata = {
  title:
    "Pipeline Trace — find where in your deploy chain the update is stuck · GateTest",
  description:
    "GateTest's pipeline-trace workflow checks source HEAD, last CI run, last deployment, and the live URL — then localises divergence. For the 'I pushed it 4 hours ago and it's still not live' case.",
  keywords: [
    "deploy pipeline trace",
    "CI deploy live skew",
    "stuck deployment",
    "GitHub Actions trace",
    "Vercel deploy lag",
    "edge cache stale",
    "deploy divergence",
    "GateTest pipeline trace",
  ],
  alternates: {
    canonical: "https://gatetest.ai/pipeline-trace",
  },
  openGraph: {
    title:
      "Pipeline Trace — find where in your deploy chain the update is stuck",
    description:
      "Source HEAD, CI, deploy, live — four probes, one verdict. A 10-rule cascade points at the exact stage holding your update. From $29.",
    url: "https://gatetest.ai/pipeline-trace",
    siteName: "GateTest",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "GateTest Pipeline Trace — find where deploys get stuck",
    description:
      "Source HEAD, CI, deploy, live — four probes, one verdict. A 10-rule cascade.",
  },
};

export default function PipelineTraceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
