import type { Metadata } from "next";
import LegalDocument from "../../components/legal/LegalDocument";
import { DOC } from "./privacy-content";

export const metadata: Metadata = {
  title: "Privacy Policy — GateTest",
  description: "What GateTest collects when it scans your code, which providers see it, how long it is kept, and the rights you have over it.",
};

export default function Page() {
  return <LegalDocument doc={DOC} current="/legal/privacy" />;
}
