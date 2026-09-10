import type { LegalBlock, LegalSection } from "../../components/legal/LegalDocument";
import * as F from "../_facts";

const ADDRESS: string | null = F.POSTAL_ADDRESS;
const MAIL = `[${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL})`;
const CONTACT_BLOCK: LegalBlock = ADDRESS
  ? { list: [`**${F.LEGAL_ENTITY}**`, ADDRESS, MAIL] }
  : { p: `**${F.LEGAL_ENTITY}** — ${MAIL}. Contact is by e-mail.` };

export const SECTIONS_3: LegalSection[] = [
  {
    id: "your-rights",
    heading: "Your Rights",
    body: [
      { p: "Wherever you are, you can ask us to:" },
      { list: [
        "**Access** — confirm whether we hold personal data about you and receive a copy.",
        "**Correct** — fix data that is inaccurate or incomplete.",
        "**Erase** — delete your account and the data we hold, subject to records the law requires us to keep.",
        "**Restrict** — pause processing while a dispute is resolved.",
        "**Port** — receive the data you gave us in a structured, machine-readable format.",
        "**Object** — to any processing based on legitimate interests.",
        "**Withdraw consent** — for any optional integration or telemetry, at any time.",
        "**Complain** — to the New Zealand Office of the Privacy Commissioner ([privacy.org.nz](https://privacy.org.nz)), to your EU data-protection authority, or to the UK Information Commissioner's Office. We would rather hear from you first.",
      ] },
      { p: `**How.** E-mail [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL}) from the address on your account, saying which right you are exercising. Requests are handled by e-mail; there is no self-serve export or deletion tool yet. We may ask for enough information to confirm you are the account holder.` },
      { p: "**When.** Within 20 working days under the New Zealand Privacy Act 2020, and within one month under the GDPR and UK GDPR (extendable by two further months for complex requests, in which case we will tell you why). Requests are free unless they are manifestly unfounded or excessive." },
    ],
  },
  {
    id: "california-privacy-rights",
    heading: "California Privacy Rights",
    body: [
      { p: "This section is the notice at collection for California residents under the CCPA as amended by the CPRA. In the preceding 12 months we have collected these categories of personal information:" },
      { table: {
        headers: ["Category", "Examples", "Purpose"],
        rows: [
          ["Identifiers", "Name, e-mail address, git-host login, IP address", "Account, delivery, security"],
          ["Commercial information", "Tier purchased, payment identifiers, repository URL on the receipt", "Payment, records"],
          ["Internet or network activity", "Request logs, error reports, sampled session replays", "Security, error monitoring"],
          ["Professional information", "Git-host organisation and repository names", "Delivering scans to the right place"],
        ],
      } },
      { p: "Sources are you, your git host and your browser. We disclose these categories only to the service providers on the [sub-processor list](/legal/sub-processors) for the purposes above. **We do not sell or share personal information**, have not done so in the preceding 12 months, and do not use sensitive personal information for any purpose that would trigger a right to limit." },
      { list: [
        "**Right to know** what we have collected about you and **to delete** or **correct** it.",
        "**Right to non-discrimination** — exercising a right does not change the price or quality of the service.",
        `**How to exercise** — e-mail [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL}). We respond within 45 days and may extend once by a further 45 days with notice. An **authorised agent** may submit a request with your signed permission; we will still verify with you directly.`,
        "**Global Privacy Control** — we honour GPC signals as an opt-out of sale or sharing. Because we do not sell or share personal information, the signal changes nothing about advertising: there is none.",
      ] },
    ],
  },
  {
    id: "children",
    heading: "Children",
    body: [
      { p: "GateTest is a developer tool for adults and organisations. It is not directed at anyone under 16, and we do not knowingly collect personal data from anyone under 16. If you believe a child has created an account, e-mail us and we will delete it." },
    ],
  },
  {
    id: "automated-decision-making",
    heading: "Automated Decision-making",
    body: [
      { p: "Scan verdicts are produced automatically by rules and, where you choose it, by AI. They describe code, not people, and have no legal or similarly significant effect on you. Whether a verdict blocks a merge is a setting you control in your own CI. If you want a person to look at a result, e-mail us and one will." },
    ],
  },
  {
    id: "data-breaches",
    heading: "Data Breaches",
    body: [
      { p: "If a security incident affects your personal data we will notify you without undue delay, and where the GDPR applies within 72 hours of becoming aware, with what happened, what data was involved, what we have done and what you should do. Where the New Zealand Privacy Act 2020 requires it, we will also notify the Office of the Privacy Commissioner. Where we are your processor, we will give you what you need to meet your own notification obligations under the [DPA](/legal/dpa)." },
    ],
  },
  {
    id: "changes-to-this-policy",
    heading: "Changes to This Policy",
    body: [
      { p: "When we change what we collect, who we share it with or how long we keep it, we update this page and its effective date and e-mail account holders before the change takes effect. Clarifications and corrections may be published without notice. The current version is always the one at this address." },
    ],
  },
  {
    id: "contact",
    heading: "Contact",
    body: [
      CONTACT_BLOCK,
      { p: "Include the e-mail address on your account so we can find your records." },
    ],
  },
];
