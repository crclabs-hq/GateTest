/**
 * Data Processing Addendum — clauses 10–15, including Annex II (the technical
 * and organisational measures). Every measure listed in Annex II is one the
 * code actually implements as of the facts module's verification date; the
 * GitHub App scope table is generated, never typed.
 */
import type { LegalSection } from "../../components/legal/LegalDocument";
import * as F from "../_facts";
import {
  githubAppPermissionTable, webhookEventsSentence, oauthScopesSentence, hostedUnsafeModuleList,
} from "../../lib/legal-access-table";

const vendor = (name: string) => F.SUB_PROCESSORS.find((s) => s.name === name);
const AI = vendor("Anthropic");
const AI_ALT = vendor("OpenAI");
const AI_VENDORS = `${AI ? AI.name : "our AI provider"}${AI_ALT ? `, and ${AI_ALT.name} only where the Customer opts in to consensus review on a Forensic scan` : ""}`;

export const SECTIONS_2: LegalSection[] = [
  {
    id: "return-and-deletion",
    heading: "Return and deletion of Customer Data",
    body: [
      { p: `**Source code is not retained after a scan in any case.** The Service fetches a repository, analyses it in a temporary workspace, and deletes that workspace when the scan completes; an in-memory copy of the fetched archive expires within ${F.REPO_SNAPSHOT_SECONDS} seconds. What persists is the scan record: findings (message, file path and line number), the verdict, the score and the summary, plus the account and billing records described in the Privacy Policy.` },
      { p: `On termination or expiry of the Agreement, or at any time on request, e-mail ${F.SUPPORT_EMAIL} from your account address and GateTest will delete your account records and scan findings, or return the findings to you in a machine-readable export first if you ask. Deletion is completed within 30 days of the request. Copies held in Sub-processor backups age out on those providers' own schedules (see the [Sub-processors](/legal/sub-processors) page) and are not restored to production. GateTest may retain records that a law requires it to keep — for example tax and billing records, and the audit log described in Annex II for ${F.AUDIT_LOG_YEARS} years — and will keep them confidential and Process them only for that purpose.` },
    ],
  },
  {
    id: "liability",
    heading: "Liability",
    body: [
      { p: `Each party's liability arising out of or related to this DPA, including the SCCs, is subject to the exclusions and limitations of liability in the Agreement, and GateTest's total aggregate liability to you under this DPA and the Agreement together will not exceed the greater of US$${F.LIABILITY_FLOOR_USD} and the fees you paid to GateTest in the ${F.LIABILITY_LOOKBACK_MONTHS} months before the event giving rise to the claim. Nothing in this clause limits either party's liability to Data Subjects under the SCCs, or any liability that cannot be limited by law.` },
    ],
  },
  {
    id: "term-and-precedence",
    heading: "Term and precedence",
    body: [
      { p: `This DPA takes effect when the Agreement does and continues for as long as GateTest Processes Customer Data on your behalf, including after the Agreement ends until deletion under clause 10 is complete.` },
      { p: `In the event of a conflict between this DPA and the Agreement, this DPA prevails on matters of data protection. In the event of a conflict between this DPA and the SCCs or the UK Addendum, the SCCs or UK Addendum prevail. Nothing in this DPA limits any right a Data Subject has under the SCCs.` },
      { p: `GateTest may update this DPA to reflect changes in Data Protection Laws, in the Service or in the measures in Annex II. A change that materially reduces your protection will be notified by e-mail at least 30 days before it takes effect; other changes take effect when published.` },
    ],
  },
  {
    id: "governing-law",
    heading: "Governing law",
    body: [
      { p: `This DPA is governed by the laws of ${F.GOVERNING_LAW}, and the parties submit to the courts of ${F.VENUE}, in the same way as the Agreement — except that the SCCs and the UK Addendum are governed by the law, and subject to the courts, that they themselves specify (clause 7), and nothing in this clause overrides a choice of law or forum that Data Protection Laws mandate.` },
    ],
  },
  {
    id: "annex-ii-technical-and-organisational-measures",
    heading: "Annex II — Technical and organisational measures",
    body: [
      { p: `The measures below are the controls GateTest operates to protect Customer Data. They serve as Annex II to the SCCs where the SCCs apply. They describe what is in place, not what is planned: GateTest holds no third-party certification or audit report at this time, and the [Security page](/trust) says so plainly.` },
      { h3: "Transport and perimeter" },
      { list: [
        "All traffic to the Service is served over TLS. HTTP Strict Transport Security is set for two years with `includeSubDomains` and `preload`.",
        "Every response carries a Content-Security-Policy, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, a `strict-origin-when-cross-origin` referrer policy and a restrictive Permissions-Policy.",
        "URL scans pass through a server-side request-forgery guard that refuses private, loopback and link-local address ranges, so the scanner cannot be pointed at internal infrastructure.",
      ] },
      { h3: "Authentication and sessions" },
      { list: [
        `Customers sign in through their git host's OAuth flow with a one-time anti-forgery state token. ${oauthScopesSentence()}`,
        `The session cookie is encrypted with AES-256-GCM and authenticated with an HMAC, is \`HttpOnly\`, \`SameSite=Lax\` and \`Secure\`, and expires after ${F.SESSION_DAYS} days.`,
        "Operator (staff) console access uses a separate, shorter-lived credential and is limited to GateTest personnel.",
      ] },
      { h3: "Access and least privilege" },
      { p: "The GitHub App requests exactly the scopes the shipped code needs, and a test in the engine fails if the code ever calls an endpoint outside them:" },
      githubAppPermissionTable(),
      { p: webhookEventsSentence() },
      { p: "Gluecron repositories are connected through a push contract authenticated by a shared secret (bearer token or HMAC signature); no standing credential to the customer's Gluecron account is held beyond the token the customer issues for scanning." },
      { h3: "Data handling during a scan" },
      { list: [
        `The repository archive is fetched from the git host, memoised in memory for at most ${F.REPO_SNAPSHOT_SECONDS} seconds, unpacked into a temporary workspace on the scanning server, analysed, and the workspace is deleted when the scan ends.`,
        "Source code is not written to the database, to logs or to error reports. Findings are stored with a message, file path and line number; the surrounding code is not stored.",
        "Findings are retained until the Customer requests deletion (clause 10).",
      ] },
      { h3: "Customer code is never executed on GateTest infrastructure" },
      { p: "The hosted engine analyses code statically. Modules that would have to run the Customer's code are refused on GateTest servers and run only inside the Customer's own CI (via the GitHub Action) or on the Customer's machine (via the CLI). There is no sandbox; the control is that the code is not executed. The refused modules are:" },
      { list: hostedUnsafeModuleList(F.HOSTED_UNSAFE_MODULES) },
      { h3: "Integrity of inbound events" },
      { list: [
        "Webhooks from Stripe, GitHub and Gluecron are verified fail-closed: a missing or invalid signature or bearer token is rejected before any processing, using a constant-time comparison.",
        "Configuration is checked for placeholder secrets; an integration whose secret is still a placeholder is treated as unconfigured rather than trusted.",
        "Scheduled (cron) endpoints require a dedicated secret and cannot be triggered anonymously.",
        "All database access uses parameterised queries.",
      ] },
      { h3: "Encryption" },
      { list: [
        "In transit: TLS for every connection to the Service and from the Service to each Sub-processor.",
        "Session cookie: AES-256-GCM with HMAC authentication, as above.",
        "Integration tokens (git-host access tokens the Customer connects): encrypted at rest with AES-256-GCM using a key held only in the server environment.",
        "Database: encryption at rest is provided by the managed database Sub-processor and inherited by every table.",
      ] },
      { h3: "Logging and monitoring" },
      { list: [
        `Security-relevant actions are written to an append-only, hash-chained audit log — each entry commits to the hash of the previous one, so alteration is detectable — retained for ${F.AUDIT_LOG_YEARS} years.`,
        "Application errors are reported to an error-monitoring Sub-processor with request bodies, source code, prompts, API keys and cookies scrubbed before sending.",
      ] },
      { h3: "AI provider handling" },
      { list: [
        `The deterministic scan uses no AI. Only the AI review and auto-fix paths send data to an AI provider (${AI_VENDORS}), and those paths send the complete contents of the files under review together with the finding text.`,
        `The provider retains API inputs for ${F.AI_PROVIDER_RETENTION_DAYS} days under its standard commercial terms and does not use them to train models. This is standard retention, not a zero-data-retention arrangement.`,
        "Customers who supply their own provider API key (bring-your-own-key) have it used for that request only; it is never stored, logged or echoed back.",
        "Repository content is screened for prompt-injection patterns before it is included in a prompt, and model output is screened for leaked secrets before it is used in a fix or shown to a user.",
      ] },
      { h3: "Rate limiting" },
      { list: ["Request rate limits are enforced per server instance, keyed on client IP address held in memory only."] },
      { h3: "Vendor management" },
      { list: ["Every Sub-processor is listed at [Sub-processors](/legal/sub-processors) with its data-protection terms; each is engaged under a written DPA or equivalent terms and reviewed before engagement (clause 7)."] },
      { h3: "Personnel" },
      { list: ["Access to production systems and Customer Data is limited to the operators who need it to run the Service, each bound by confidentiality."] },
    ],
  },
  {
    id: "contact",
    heading: "Contact",
    body: [
      { p: `Questions about this DPA, requests for a countersigned copy, Sub-processor objections, deletion requests and Security Incident correspondence all go to ${F.LEGAL_ENTITY} at ${F.SUPPORT_EMAIL}${F.POSTAL_ADDRESS ? `, or by post to ${F.POSTAL_ADDRESS}` : ""}. Please send data-protection requests from the e-mail address on your account so we can verify them.` },
    ],
  },
];
