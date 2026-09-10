import type { Metadata } from "next";
import LegalDocument from "../../components/legal/LegalDocument";
import { DOC } from "./sub-processors-content";

export const metadata: Metadata = {
  title: "Sub-processors — GateTest",
  description: "Every third party that processes customer data on GateTest's behalf, what each receives, where it is, and how to be notified of changes.",
};

export default function Page() {
  return <LegalDocument doc={DOC} current="/legal/sub-processors" />;
}
