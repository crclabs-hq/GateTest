import type { Metadata } from "next";
import { getCountryBySlug } from "../countries";

// Total live module count — sourced from CLAUDE.md v1.43.0 (91 modules).
const MODULE_COUNT = 91;

interface LayoutParams {
  params: Promise<{ country: string }>;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

/**
 * Per-country metadata. Next.js merges this with the page-level
 * `generateMetadata` — the page-level export wins where keys overlap,
 * but this layout supplies the canonical defaults so the layout file
 * itself is a defensible source-of-truth for the country slug.
 */
export async function generateMetadata({ params }: LayoutParams): Promise<Metadata> {
  const { country } = await params;
  const data = getCountryBySlug(country);
  if (!data) {
    return { title: "Country not found — GateTest" };
  }
  const stackHint = data.popularStack.slice(0, 2).join("/");
  const title = `GateTest for ${data.name} — ${data.primaryRegulation} compliance, ${stackHint} stack`;
  const description = truncate(
    `${MODULE_COUNT} GateTest modules built for ${data.name} dev shops — catches the technical findings ${data.primaryRegulation} auditors look for across ${data.popularStack.slice(0, 3).join(", ")}.`,
    160,
  );
  const canonical = `https://gatetest.ai/for/${data.slug}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: "GateTest",
      locale: data.ogLocale,
      type: "website",
    },
  };
}

export default function CountryLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
