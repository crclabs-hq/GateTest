import type { Metadata } from "next";
import LegalDocument from "../../components/legal/LegalDocument";
import { DOC } from "./cookies-content";
import { siteUrl } from "@/app/lib/site-url";

export const metadata: Metadata = {
  alternates: { canonical: siteUrl("/legal/cookies") },
  title: "Cookie Policy — GateTest",
  description: "Every cookie and browser-storage key GateTest sets, what each is for, how long it lasts, and how to control it.",
};

export default function Page() {
  return <LegalDocument doc={DOC} current="/legal/cookies" />;
}
