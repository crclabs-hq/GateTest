import type { Metadata } from "next";
import { siteUrl } from "@/app/lib/site-url";

// The score page had no metadata at all, so every repo shared the generic
// site title. The title now names the repo; the canonical is per repo.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}): Promise<Metadata> {
  const { owner, repo } = await params;
  const slug = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    title: `${owner}/${repo} quality score — GateTest`,
    description: `The public GateTest quality score and grade for ${owner}/${repo}, with the date of its last scan.`,
    alternates: { canonical: siteUrl(`/score/${slug}`) },
  };
}

export default function ScoreLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
