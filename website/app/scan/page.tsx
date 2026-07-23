// /scan — linked as a primary CTA from the regulation, /for, pipeline-trace,
// and triage pages, but no page existed here (only /scan/preview, /scan/status,
// /scan/url), so every one of those CTAs 404'd. The free playground is the
// right landing spot: run a real scan first, upsell from there.

import { redirect } from "next/navigation";

export default function ScanIndex() {
  redirect("/playground");
}
