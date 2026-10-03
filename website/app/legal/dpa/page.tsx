import type { Metadata } from "next";
import LegalDocument from "../../components/legal/LegalDocument";
import { DOC } from "./dpa-content";
import { siteUrl } from "@/app/lib/site-url";

export const metadata: Metadata = {
  alternates: { canonical: siteUrl("/legal/dpa") },
  title: "Data Processing Addendum — GateTest",
  description: "The terms on which GateTest processes personal data as your processor when it scans your code, with the security measures we run set out in Annex II.",
};

export default function Page() {
  return <LegalDocument doc={DOC} current="/legal/dpa" />;
}
