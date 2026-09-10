import type { LegalSection } from "../../components/legal/LegalDocument";
import * as F from "../_facts";
import { ANTHROPIC, GITHUB, GLUECRON, OPENAI, RESEND, SENTRY, STRIPE } from "./privacy-vendors";

export const SECTIONS_2: LegalSection[] = [
  {
    id: "legal-bases",
    heading: "Legal Bases (GDPR and UK GDPR)",
    body: [
      { p: "Where the EU or UK GDPR applies, we rely on the following bases under Article 6(1):" },
      { list: [
        "**Contract (Art. 6(1)(b))** — account, payment, repository and scan data needed to provide what you bought and to support you.",
        "**Legitimate interests (Art. 6(1)(f))** — securing the service and preventing abuse; rate limiting; monitoring and fixing errors; keeping an audit log of security-relevant actions; improving rule accuracy from anonymous telemetry; establishing, exercising or defending legal claims; and sending service messages. We have weighed each of these against your interests and you may object at any time (see [Your Rights](#your-rights)).",
        `**Consent (Art. 6(1)(a))** — optional integrations you switch on yourself (for example a ${GLUECRON.name} repository, a notification webhook, or a second-opinion AI provider). Telemetry can be switched off at any time with \`${F.TELEMETRY_OPT_OUT_ENV}=1\`. Withdrawing consent does not affect processing that already happened.`,
        "**Legal obligation (Art. 6(1)(c))** — tax and accounting records, and responding to lawful requests from authorities.",
      ] },
    ],
  },
  {
    id: "ai-processing",
    heading: "AI Processing",
    body: [
      { p: "The deterministic scan — the modules that produce the verdict — uses no AI and sends nothing to any model provider." },
      { p: `**AI review and auto-fix** (Scan + Fix, Forensic, the \`fix_issue\` and \`explain_finding\` MCP tools, and \`gatetest fix\` in the CLI) send the **complete contents** of each file being reviewed or fixed, its path and the finding text to ${ANTHROPIC.name} (${ANTHROPIC.entity}). We send whole files rather than snippets because a fix that cannot see the surrounding code is usually a wrong fix.` },
      { p: `${ANTHROPIC.name} holds API inputs and outputs under its **standard ${F.AI_PROVIDER_RETENTION_DAYS}-day retention**. We are not on a zero-data-retention arrangement, and we say so plainly so that you can decide which repositories to point the AI features at. Under ${ANTHROPIC.name}'s commercial terms your content is not used to train its models.` },
      { p: "**Bring your own key.** If you supply your own API key (the CLI and MCP server always use yours; the hosted fix route accepts one per request) it is used for that request only and is never stored, logged or echoed back." },
      { p: `**Second opinion.** On a Forensic scan you may opt in to a consensus pass that also sends the files being fixed to ${OPENAI.name} (${OPENAI.entity}). Nothing goes there unless you turn it on.` },
      { p: "AI output is a suggestion. Every fix is delivered as a branch or pull request for a human to review; we never merge to your default branch." },
    ],
  },
  {
    id: "sharing-and-sub-processors",
    heading: "Sharing and Sub-processors",
    body: [
      { p: "**We never sell personal data** and we never share it for advertising. We disclose it only to:" },
      { list: [
        "**Sub-processors** — the providers below, each bound by a data-processing agreement and receiving only what its function needs.",
        `**Your git host** — ${GITHUB.name} or ${GLUECRON.name}, which receives the statuses, comments and branches you asked us to write back.`,
        "**Recipients you configure** — for example a notification webhook you supply.",
        "**Authorities** — where the law requires it, and only after we have checked that the request is valid. We will tell you unless we are legally prevented from doing so.",
        "**A successor** — if GateTest is acquired or merges, under the same commitments as this policy.",
      ] },
      { table: {
        headers: ["Provider", "Purpose", "Location"],
        rows: F.SUB_PROCESSORS.map((s) => [`**${s.name}**`, s.purpose, s.location]),
      } },
      { p: "The [full list](/legal/sub-processors) records the legal entity, exactly what data each provider receives, and a link to its data-processing terms. It is updated before any new provider is added." },
    ],
  },
  {
    id: "international-transfers",
    heading: "International Transfers",
    body: [
      { p: `We are in New Zealand and most of our providers are in the United States, so personal data leaves the country in which it was collected. We rely on:` },
      { list: [
        "**EU** — the European Commission's Standard Contractual Clauses (Implementing Decision (EU) 2021/914), incorporated in each provider's data-processing agreement.",
        "**UK** — the International Data Transfer Agreement or the UK Addendum to the EU clauses, likewise through the provider's agreement.",
        "**New Zealand** — Information Privacy Principle 12 of the Privacy Act 2020: we disclose personal information overseas only to recipients bound to comparable safeguards, which is what those agreements provide.",
      ] },
      { p: "You can ask us for a copy of the transfer terms that apply to your data." },
    ],
  },
  {
    id: "data-retention",
    heading: "Data Retention",
    body: [
      { p: "Each window below is either enforced by code or requires an action by you. We do not delete customer data without your instruction; we do not currently run an automatic purge of scan findings." },
      { table: {
        headers: ["Data", "Retention"],
        rows: [
          ["Session cookie", `${F.SESSION_DAYS} days from sign-in`],
          ["Sign-in state cookie", `${F.OAUTH_STATE_MINUTES} minutes`],
          ["In-memory repository snapshot", `${F.REPO_SNAPSHOT_SECONDS} seconds`],
          ["Scan workspace on our server", "The duration of the scan, then deleted"],
          ["Account records, scan findings, scan-queue records", "Until you ask us to delete them"],
          ["Payment records", `Held by ${STRIPE.name} and in our database for as long as tax and accounting law requires`],
          ["Audit log", `${F.AUDIT_LOG_YEARS} years`],
          ["Error reports and session replays", `Per ${SENTRY.name}'s retention; contain no code, bodies or secrets`],
          ["Transactional e-mail", `Delivery records held by ${RESEND.name}; we keep the address and the message we sent`],
          ["Telemetry", "Indefinitely — it is anonymous and cannot be linked back to you"],
          ["AI provider inputs and outputs", `${F.AI_PROVIDER_RETENTION_DAYS} days at ${ANTHROPIC.name}`],
        ],
      } },
    ],
  },
  {
    id: "security",
    heading: "Security",
    body: [
      { p: "All traffic is encrypted in transit. Your session cookie is encrypted and signed, HttpOnly and Secure. Secrets live in environment configuration, never in code. Git-host access uses short-lived installation tokens with the narrowest permissions the feature needs. Scan workspaces are deleted when the scan ends, and the hosted engine does not execute your code. Error reports are scrubbed of bodies, code, prompts, keys and cookies before they leave our process." },
      { p: "What we do and do not have — including which certifications we hold — is set out on [Trust & Security](/trust). No transmission or storage is perfectly secure; if you believe your data has been compromised, e-mail us immediately." },
    ],
  },
];
