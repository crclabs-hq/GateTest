import type { Metadata } from "next";
import LegalDocument from "../../components/legal/LegalDocument";
import { DOC } from "./acceptable-use-content";
import { siteUrl } from "@/app/lib/site-url";

export const metadata: Metadata = {
  alternates: { canonical: siteUrl("/legal/acceptable-use") },
  title: "Acceptable Use Policy — GateTest",
  description: "GateTest acceptable use policy — what you may and may not do with the service.",
};

export default function Page() {
  return <LegalDocument doc={DOC} current="/legal/acceptable-use" />;
}
