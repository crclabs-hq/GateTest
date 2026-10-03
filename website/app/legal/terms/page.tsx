import type { Metadata } from "next";
import LegalDocument from "../../components/legal/LegalDocument";
import { DOC } from "./terms-content";
import { siteUrl } from "@/app/lib/site-url";

export const metadata: Metadata = {
  alternates: { canonical: siteUrl("/legal/terms") },
  title: "Terms of Service — GateTest",
  description:
    "The agreement that governs your use of the GateTest scanning service, CLI, GitHub App, Gluecron integration, and MCP server.",
};

export default function Page() {
  return <LegalDocument doc={DOC} current="/legal/terms" />;
}
