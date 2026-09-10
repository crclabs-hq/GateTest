import type { LegalDoc, LegalSection } from "../../components/legal/LegalDocument";
import * as F from "../_facts";
import { ANTHROPIC, SENTRY, STRIPE } from "./privacy-vendors";
import { SECTIONS_2 } from "./privacy-content-2";
import { SECTIONS_3 } from "./privacy-content-3";

const HOSTED_SKIPPED = F.HOSTED_UNSAFE_MODULES.map((m) => `\`${m}\``).join(", ");

const SECTIONS_1: LegalSection[] = [
  {
    id: "who-we-are",
    heading: "Who We Are",
    body: [
      { p: `**${F.LEGAL_ENTITY}** ("we", "us", "our") operates ${F.siteHost()}, the GateTest command-line tool, the GateTest MCP server and the GateTest apps for GitHub and Gluecron. We are based in New Zealand.` },
      { p: `This Privacy Policy explains what personal data we collect, why, how long we keep it, who we share it with, and the rights you have over it. It is written to meet the disclosure requirements of the New Zealand Privacy Act 2020, the EU and UK General Data Protection Regulation (GDPR), and the California Consumer Privacy Act as amended by the CPRA.` },
      { p: `**Our role.** For the data you give us to run your account, take payment and deliver scans, we are the **controller** (the "agency" under New Zealand law). For personal data that happens to be inside the repositories you ask us to scan, **you** are the controller and we are your **processor**: that processing is governed by our [Data Processing Addendum](/legal/dpa), which forms part of the [Terms of Service](/legal/terms).` },
      { p: `**Contact.** For any question, request or complaint about your personal data, e-mail [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL}). We do not currently have a separate privacy or security mailbox; that address reaches the people who run the service.` },
    ],
  },
  {
    id: "scope",
    heading: "Scope",
    body: [
      { p: `This policy applies to everyone who visits ${F.siteHost()}, signs in, buys a scan or subscription, installs one of our git-host apps, runs the CLI or MCP server, or writes to us. It covers the hosted service and the telemetry the CLI can send; it does not cover what the CLI does entirely on your own machine with your own keys, which never leaves your computer.` },
      { p: `It does not cover the practices of the git hosts, payment provider or other services we integrate with when they act on their own account. Their policies apply to the accounts you hold with them.` },
    ],
  },
  {
    id: "information-we-collect",
    heading: "Information We Collect",
    body: [
      { h3: "Account" },
      { p: `When you sign in with GitHub, GitLab or Google we receive your login name, display name and e-mail address from that provider, plus an OAuth access token. We request only the \`read:user\` and \`user:email\` scopes. The token is kept inside your encrypted session cookie (see the [Cookie Policy](/legal/cookies)) and is not stored in our database.` },
      { h3: "Payment" },
      { p: `Checkout is hosted by ${STRIPE.name}. Your card number is entered on ${STRIPE.name}'s pages and never reaches our servers. We keep your e-mail address, ${STRIPE.name} customer and payment identifiers, the tier you bought and the repository URL the scan is for. So that a receipt describes what was delivered, the module names that ran and the number of issues found are attached to the payment record.` },
      { h3: "Repository and scan data" },
      { p: `To scan a repository we fetch an archive of it from your git host into memory (memoised for ${F.REPO_SNAPSHOT_SECONDS} seconds so a burst of pushes is not fetched repeatedly) and, for the hosted engine, into a temporary workspace on our server. The workspace is deleted when the scan finishes. **We do not retain your source code** after a scan.` },
      { p: `We do retain the **results**: each finding (rule, message, file path, line number and a short excerpt, all capped in length), the pass/fail verdict, the score and the summary. We also keep scan-queue records: repository, commit SHA, ref and, for pull-request scans, the PR number.` },
      { p: `**We do not execute your code.** Modules that would run customer-controlled programs (${HOSTED_SKIPPED}) are skipped by the hosted engine and only run when you invoke them yourself in your own CI.` },
      { h3: "Telemetry" },
      { p: `The CLI and hosted engine send a small usage signal after each scan: module names, rule identifiers, integer counts, verdict, duration and the source (CLI, CI or hosted). It never includes code, file paths, repository names, finding text or any customer identifier, and it is stored with none attached. It exists so that noisy rules can be found and quietened. Switch it off with \`${F.TELEMETRY_OPT_OUT_ENV}=1\` in your environment or \`${F.TELEMETRY_OPT_OUT_CONFIG}\` in \`.gatetest.json\`.` },
      { h3: "Technical" },
      { p: `Our servers see your IP address and ordinary request metadata (URL, method, user agent, timestamps). We use it in memory for rate limiting and, through ${SENTRY.name}, for error monitoring. ${SENTRY.name} also records sampled browser session replays: 10% of sessions, and 100% of sessions in which an error occurs. Request bodies, source code, prompts, keys and cookies are scrubbed before anything is sent.` },
      { h3: "Cookies and browser storage" },
      { p: `We set the minimum needed to keep you signed in and nothing for advertising. Every cookie and storage key is listed in the [Cookie Policy](/legal/cookies).` },
      { h3: "Support" },
      { p: `If you e-mail us we keep the correspondence, including anything you choose to attach, so we can help you and refer back to it. Please do not send secrets or full source files unless we ask.` },
    ],
  },
  {
    id: "how-we-use-information",
    heading: "How We Use Information",
    body: [
      { list: [
        "**To deliver the service** — run the scans you request, post commit statuses and pull-request comments, open auto-fix branches, send receipts and scan digests.",
        "**To take payment** — create checkout sessions, reconcile webhooks, run the billing portal and handle refunds under the [Refund Policy](/legal/refunds).",
        `**To generate AI review and fixes** — send the files being reviewed to ${ANTHROPIC.name} (and, if you opt in on a Forensic scan, a second provider) as described in [AI processing](#ai-processing).`,
        "**To keep the service secure and available** — rate limiting, abuse prevention, error monitoring, and the audit log of security-relevant actions.",
        "**To improve detection quality** — anonymous telemetry that tells us which rules fire too often, with no link back to you.",
        "**To communicate with you** — service messages about your scans, account and changes to these policies. We do not send marketing e-mail.",
        "**To meet legal obligations** — tax and accounting records, and responding to lawful requests.",
      ] },
      { p: "We do not sell personal data, use it for advertising, build profiles for third parties, or use your source code to train any model." },
    ],
  },
];

export const DOC: LegalDoc = {
  title: "Privacy Policy",
  intro: `GateTest reads code so that it can tell you what is wrong with it. This policy says exactly what we keep, what we send to which provider, and what we throw away — in the same detail we would want from a tool we pointed at our own repositories.`,
  effective: F.EFFECTIVE_DATE,
  sections: [...SECTIONS_1, ...SECTIONS_2, ...SECTIONS_3],
};
