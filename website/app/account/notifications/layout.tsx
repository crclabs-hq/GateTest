import type { Metadata } from "next";
import { siteUrl } from "@/app/lib/site-url";

// The page is a client component, which cannot export `metadata`; this
// server layout carries the title, description and canonical instead so the
// route stops falling back to the generic site title.
export const metadata: Metadata = {
  title: "Notification Settings — GateTest",
  description:
    "Choose which GateTest scan and watch emails you receive.",
  alternates: { canonical: siteUrl("/account/notifications") },
};

export default function AccountNotificationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
