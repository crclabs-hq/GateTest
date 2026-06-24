import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getRegulationBySlug } from "../catalog";

interface LayoutParams {
  params: Promise<{ slug: string }>;
  children: ReactNode;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const reg = getRegulationBySlug(slug);
  if (!reg) {
    return { title: "Regulation not found — GateTest" };
  }
  const title = `${reg.name} compliance scanner — ${reg.longName} · GateTest`;
  // Keep description in the 150-160 char band.
  const baseDesc = `${reg.name} (${reg.longName}) — ${reg.jurisdiction.split("—")[0].trim()}. GateTest catches the technical findings ${reg.topThreeModules.join(", ")} for ${reg.name}.`;
  const description = baseDesc.length > 160 ? baseDesc.slice(0, 157) + "..." : baseDesc;
  const canonical = `https://gatetest.ai/regulation/${reg.slug}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: "GateTest",
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default function RegulationLayout({ children }: LayoutParams) {
  return children;
}
