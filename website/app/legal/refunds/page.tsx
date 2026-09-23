import type { Metadata } from "next";
import LegalDocument from "../../components/legal/LegalDocument";
import { DOC } from "./refunds-content";

export const metadata: Metadata = {
  title: "Refund Policy — GateTest",
  description: "GateTest refund and cancellation policy.",
};

export default function Page() {
  return <LegalDocument doc={DOC} current="/legal/refunds" />;
}
