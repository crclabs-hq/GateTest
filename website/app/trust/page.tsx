/**
 * /trust — the Security page. Rendered from data (`trust-content.ts`) by the
 * shared legal renderer so every claim reads from `app/legal/_facts.js` and
 * the GitHub App scope table is generated, never typed. The
 * `responsible-disclosure` section is the target of
 * `/.well-known/security.txt`'s Policy line.
 */
import type { Metadata } from "next";
import LegalDocument from "../components/legal/LegalDocument";
import { DOC } from "./trust-content";

export const metadata: Metadata = {
  title: "Trust & Security — GateTest",
  description: "What GateTest does with your code, what it never does, and the controls that make each statement true — infrastructure, encryption, AI provider handling, permissions, disclosure and known limitations.",
};

export default function TrustPage() {
  return <LegalDocument doc={DOC} current="/trust" />;
}
