import type { LegalBlock, LegalDoc } from "../../components/legal/LegalDocument";
import * as F from "../_facts";

type Scope = (typeof F.SUB_PROCESSORS)[number]["scope"];

/** Label the terms link honestly: "DPA" only when the URL is a data-processing document. */
const termsLabel = (url: string) => (/dpa|data-protection|data-processing/i.test(url) ? "DPA" : "Terms");

function table(scope: Scope): LegalBlock {
  return {
    table: {
      headers: ["Provider", "Entity", "Purpose", "Data shared", "Location", "Terms"],
      rows: F.SUB_PROCESSORS.filter((s) => s.scope === scope).map((s) => [
        `**${s.name}**`, s.entity, s.purpose, s.data, s.location, `[${termsLabel(s.terms)}](${s.terms})`,
      ]),
    },
  };
}

export const DOC: LegalDoc = {
  title: "Sub-processors",
  intro: `Every third party that processes customer data on GateTest's behalf, what each receives, where it is, and the terms that bind it. Providers that only run when you switch a feature on are listed separately.`,
  effective: F.EFFECTIVE_DATE,
  sections: [
    {
      id: "intro",
      heading: "About This List",
      body: [
        { p: "A **sub-processor** is a company we engage to process personal data on our behalf in order to deliver the service — a database host, a payment processor, an AI provider. Each one is bound by a written data-processing agreement, receives only the data its function needs, and is listed here." },
        { p: "This page is the authoritative list for the purposes of our [Data Processing Addendum](/legal/dpa) and [Privacy Policy](/legal/privacy), and it is the mechanism by which we give notice of changes. It is generated from the same record the application uses, so it cannot describe a provider we have quietly stopped using or omit one we have added." },
        { p: "Your git host, when it acts as your git host, is not our sub-processor: it processes your repositories on your instructions under your agreement with it. It appears below because we also read from and write to it on your behalf." },
      ],
    },
    {
      id: "core-sub-processors",
      heading: "Core Sub-processors",
      body: [
        { p: "Used for every customer as part of running the service." },
        table("core"),
      ],
    },
    {
      id: "important-sub-processors",
      heading: "Important Sub-processors",
      body: [
        { p: "Used when the feature is in your plan or connected — for example, when you connect a repository on an alternative git host, when we send you e-mail, or when you run a live-URL scan." },
        table("important"),
      ],
    },
    {
      id: "optional-sub-processors",
      heading: "Optional Sub-processors",
      body: [
        { p: "Only when you turn the feature on. Nothing is sent to these providers by default." },
        table("optional"),
      ],
    },
    {
      id: "changes-and-objections",
      heading: "Changes and Objections",
      body: [
        { list: [
          "**Before, not after.** We update this page before a new sub-processor receives any customer data, and we update the effective date at the top when we do.",
          `**Notification.** E-mail [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL}) with the subject "Sub-processor notifications" and we will e-mail you whenever this list changes.`,
          "**Objection.** If you have a reasonable data-protection ground to object to a new sub-processor, tell us within 30 days of the notice; the [DPA](/legal/dpa) sets out what happens next, including your right to terminate the affected service if we cannot resolve the objection.",
          "**Replacement.** A sub-processor that is replaced or removed is deleted from this page; we do not keep former providers listed.",
        ] },
      ],
    },
    {
      id: "contact",
      heading: "Contact",
      body: [
        { p: `Questions about any provider on this list, or a request for a copy of the transfer terms we rely on: **${F.LEGAL_ENTITY}**, [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL}).` },
      ],
    },
  ],
};
