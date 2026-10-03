import type { Metadata } from "next";
import LegalDocument from "../../components/legal/LegalDocument";
import { DOC } from "./refunds-content";
import { siteUrl } from "@/app/lib/site-url";

export const metadata: Metadata = {
  alternates: { canonical: siteUrl("/legal/refunds") },
  title: "Refund Policy — GateTest",
  description: "GateTest refund and cancellation policy.",
};

export default function Page() {
  return <LegalDocument doc={DOC} current="/legal/refunds" />;
}
