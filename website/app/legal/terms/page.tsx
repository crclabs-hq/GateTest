import type { Metadata } from "next";
import LegalDocument from "../../components/legal/LegalDocument";
import { DOC } from "./terms-content";

export const metadata: Metadata = {
  title: "Terms of Service — GateTest",
  description:
    "The agreement that governs your use of the GateTest scanning service, CLI, GitHub App, Gluecron integration, and MCP server.",
};

export default function Page() {
  return <LegalDocument doc={DOC} current="/legal/terms" />;
}
