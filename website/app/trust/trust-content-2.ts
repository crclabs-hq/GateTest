/**
 * /trust — sections 8–13: AI provider, payments, monitoring, compliance,
 * responsible disclosure and known limitations. The `responsible-disclosure`
 * id is linked from `/.well-known/security.txt`; keep it stable.
 */
import type { LegalSection } from "../components/legal/LegalDocument";
import * as F from "../legal/_facts";

const vendor = (name: string) => F.SUB_PROCESSORS.find((s) => s.name === name);
const AI = vendor("Anthropic");
const AI_ALT = vendor("OpenAI");
const PAY = vendor("Stripe");
const MON = vendor("Sentry");
const SECURITY_TXT = F.siteUrl("/.well-known/security.txt");

export const SECTIONS_2: LegalSection[] = [
  {
    id: "ai-provider-security",
    heading: "AI provider security",
    body: [
      { p: `**The deterministic scan uses no AI.** Every module in the standard suite is rule-based and runs entirely on our server; nothing leaves it. AI is used only on the paths that say so — AI review, auto-fix and the Forensic diagnosis — and only when your tier or request includes them.` },
      { list: [
        `**Provider.** ${AI ? `${AI.name} (${AI.entity})` : "Our AI provider"}, via its API under commercial terms${AI ? ` — [terms](${AI.terms})` : ""}.`,
        "**What is sent.** The complete contents of the files under review or being fixed, their paths and the finding text. Not the whole repository; not files outside the finding.",
        `**Retention.** The provider retains API inputs and outputs for ${F.AI_PROVIDER_RETENTION_DAYS} days under its standard terms. This is standard retention, **not** a zero-data-retention arrangement; we say so because customers with strict requirements need to know the difference.`,
        "**No training.** Inputs are not used to train the provider's models.",
        "**Bring your own key.** If you supply your own provider API key, it is used for that request only and is never stored, logged or echoed back. Requests made with your key are billed to you by the provider directly.",
        "**Prompt-injection guard.** Repository content is screened for instructions aimed at the model before it is placed in a prompt; a suspicious file is flagged rather than trusted.",
        "**Output screening.** Model output is screened for leaked secrets and credentials before it is used in a fix or shown to a user.",
        `**Optional second opinion.** On Forensic scans you may opt in to a consensus review by ${AI_ALT ? AI_ALT.name : "a second provider"}, which then receives the same files for those fixes. It is off unless you turn it on.`,
      ] },
    ],
  },
  {
    id: "payments",
    heading: "Payments",
    body: [
      { p: `Payments, subscriptions and the billing portal are handled by ${PAY ? `${PAY.name} (${PAY.entity})` : "our payment provider"}. Card details are entered on pages Stripe hosts and never pass through, or are stored on, our servers; what we receive is the outcome of the payment and the identifiers needed to link it to your account and scan. PCI DSS obligations for card data are met by Stripe as a certified Level 1 service provider. We make no PCI attestation of our own and do not need one, because card data never touches us.` },
    ],
  },
  {
    id: "monitoring-and-logging",
    heading: "Monitoring and logging",
    body: [
      { list: [
        `**Error monitoring.** Application errors are reported to ${MON ? `${MON.name} (${MON.entity})` : "our error-monitoring provider"}. Reports include the request URL, request headers and client IP address. Request bodies, source code, prompts, API keys and cookies are scrubbed before sending.`,
        "**Session replay.** The site records browser session replays for 10% of sessions and 100% of sessions in which an error occurs, so that we can reproduce faults. Replays are scrubbed by the same rules before they leave your browser.",
        "**IP addresses.** Your IP address is used in memory on each server for rate limiting and appears in error reports as above. It is not written to a long-term store of its own.",
        `**Audit log.** Security-relevant actions are hash-chained and retained for ${F.AUDIT_LOG_YEARS} years, as described under [Webhooks and integrity](#webhooks-and-integrity).`,
        `**Engine telemetry.** The CLI and engine send anonymous usage signals — module names and finding counts, never code, paths or finding text. Opt out with the environment variable \`${F.TELEMETRY_OPT_OUT_ENV}=1\` or with \`${F.TELEMETRY_OPT_OUT_CONFIG}\` in \`.gatetest.json\`.`,
      ] },
    ],
  },
  {
    id: "compliance-and-attestations",
    heading: "Compliance and attestations",
    body: [
      { p: "**We hold no third-party certification today.** There is no SOC 2 report, no ISO 27001 certificate and no independent penetration-test report for GateTest. If a vendor questionnaire asks for one, the honest answer is that it does not exist yet. SOC 2 readiness work exists internally; we will publish the report on this page when there is one, and not before." },
      { p: "What we can offer now:" },
      { list: [
        "Support for your obligations under the GDPR, the UK GDPR, the New Zealand Privacy Act 2020 and the CCPA/CPRA, as a processor of the data in your repositories.",
        "A [Data Processing Addendum](/legal/dpa) that applies automatically to every customer, incorporates the EU Standard Contractual Clauses and the UK Addendum for transfers, and sets out our technical and organisational measures in its Annex II. A countersigned copy is available on request.",
        "A published [Sub-processors](/legal/sub-processors) list, with each provider's entity, location, purpose, the data it receives and its own data-protection terms.",
        "Written answers to reasonable security questionnaires, and the audit right described in the DPA.",
        "The [Privacy Policy](/legal/privacy) and [Cookie Policy](/legal/cookies), which describe the account, billing and telemetry data we hold as a controller.",
      ] },
    ],
  },
  {
    id: "responsible-disclosure",
    heading: "Found a security issue?",
    body: [
      { p: `Please tell us. E-mail ${F.SUPPORT_EMAIL} with steps to reproduce, the impact as you understand it, and the affected URL, endpoint or package version. We aim to acknowledge every report within 5 business days, keep you informed as we investigate and fix, and credit you if you would like us to.` },
      { h3: "Safe harbour" },
      { p: "We will not pursue legal action against, or report to law enforcement, security research conducted in good faith that: avoids privacy violations, data destruction and any degradation of the service (including denial-of-service testing); does not access, modify or retain data belonging to other customers; stops and reports immediately on encountering such data; and gives us reasonable time to fix an issue before it is disclosed publicly. If you are unsure whether something is in scope, ask first." },
      { h3: "Out of scope" },
      { list: [
        "Findings that require a compromised customer device or credentials.",
        "Volumetric denial-of-service, rate-limit exhaustion and automated scanning that degrades the service.",
        "Reports against third-party services we do not operate — our git-host, payment, database and AI providers each run their own programmes.",
      ] },
      { p: `A machine-readable version of this policy is published at [${SECURITY_TXT}](${SECURITY_TXT}) in the RFC 9116 format.` },
    ],
  },
  {
    id: "known-limitations",
    heading: "Known limitations",
    body: [
      { p: "A security page that lists only strengths is marketing. These are the gaps we know about and have not yet closed:" },
      { list: [
        "**No execution isolation.** Customer code is never executed on our servers, but where a future feature required it there is no container or virtual-machine sandbox in place today. The refusal list above is the control.",
        "**Rate limits are per server instance.** Limits are held in memory on each instance rather than in a shared store, so they apply per instance and reset on deploy.",
        "**No self-serve deletion or export.** Deleting your account and findings, or exporting them, is done by e-mailing us; there is no button yet. We complete requests within 30 days.",
        "**Findings are retained until you ask.** Scan findings are kept until a deletion request; there is no automatic expiry. Source code is never retained regardless.",
        "**No third-party certification.** No SOC 2, ISO 27001 or independent penetration test, as stated above.",
      ] },
      { p: "When one of these changes, this page changes in the same release. If a limitation you care about is not listed, e-mail us and we will either add it or explain why it is not one." },
    ],
  },
];
