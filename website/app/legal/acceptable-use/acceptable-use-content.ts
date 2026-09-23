import type { LegalDoc } from "../../components/legal/LegalDocument";
import * as F from "../_facts";

/**
 * Data for /legal/acceptable-use, restyled onto the shared LegalDocument
 * renderer (issue #686 phase 2) the same way #696 did for the other five
 * legal pages. Every fact, list item and clause below is unchanged from the
 * page's pre-#686 prose — only the markup changed: JSX becomes LegalBlock
 * data, and inline <strong> / <a> tags become the bold and link inline
 * syntax LegalDocument parses. The effective date (April 9, 2026) is this
 * document's own and is
 * NOT F.EFFECTIVE_DATE (2026-09-10, the rebuilt-document-set date the other
 * five share) — see the "Refunds keeps its own earlier date" comment in
 * _facts.js; the same reasoning applies here.
 */
export const DOC: LegalDoc = {
  title: "Acceptable Use Policy",
  effective: "2026-04-09",
  sections: [
    {
      id: "purpose",
      heading: "Purpose",
      body: [
        { p: `This Acceptable Use Policy ("AUP") governs your use of the GateTest platform, CLI tool, API, GitHub App, and all associated services (collectively, the "Service") operated by GateTest ("we," "us," "our"). This AUP is incorporated by reference into the GateTest [Terms of Service](/legal/terms). Capitalised terms not defined here have the meaning given in the Terms of Service.` },
        { p: "We built GateTest to help developers write safer, higher-quality code. This policy exists to protect our infrastructure, other customers, and third parties from misuse. It is written to be clear, not to be long." },
      ],
    },
    {
      id: "authorised-use",
      heading: "Authorised Use",
      body: [
        { p: "You may use the Service to:" },
        { list: [
          "Scan repositories that you own or that you have explicit written permission from the repository owner to scan.",
          "Run the CLI tool against codebases on machines you own or control.",
          "Integrate the GitHub App with repositories in GitHub organisations where you are an administrator or have been granted permission to install third-party apps.",
          "Use the API with valid credentials to automate scans within your authorised quota.",
          "Review scan findings, auto-fix pull requests, and reports for the legitimate purposes of code quality improvement, security hardening, and compliance.",
          "Demonstrate the Service to prospective customers using repositories you own or control.",
        ] },
      ],
    },
    {
      id: "prohibited-uses",
      heading: "Prohibited Uses",
      body: [
        { p: "You may **not** use the Service to:" },
        { h3: "Unauthorised Access and Scanning" },
        { list: [
          "Scan any repository, codebase, or system that you do not own or do not have explicit written permission to scan.",
          "Use the Service as a reconnaissance or intelligence-gathering tool against organisations, systems, or individuals you are not authorised to assess.",
          "Attempt to access or exfiltrate code, secrets, tokens, or other data from repositories you are not authorised to access.",
          "Use scan results, findings, or vulnerability reports to attack, exploit, or harm the owners of the scanned repository or any third party.",
        ] },
        { h3: "Abuse of Infrastructure" },
        { list: [
          "Submit scans, API calls, or other requests at rates or volumes that constitute a denial-of-service attack or that materially degrade the Service for other customers.",
          "Attempt to circumvent rate limits, scan quotas, payment controls, or other technical restrictions.",
          "Use the Service to generate AI outputs at scale for the purpose of reselling, redistributing, or republishing those outputs without our prior written consent.",
          "Reverse-engineer, decompile, or attempt to extract the source code, models, prompts, detection logic, or other proprietary components of the Service.",
          "Use automated means to probe, fuzz, or test the security of our infrastructure without prior written authorisation from us.",
        ] },
        { h3: "Unlawful and Harmful Activity" },
        { list: [
          "Use the Service in violation of any applicable law or regulation, including export control laws, privacy laws, computer-fraud laws, and intellectual property laws.",
          "Submit repositories containing CSAM (child sexual abuse material) or other illegal content.",
          "Use the Service to facilitate the development, deployment, or improvement of malware, ransomware, spyware, exploit kits, or other tools designed to harm computer systems or their users.",
          "Attempt to launder money, evade sanctions, or otherwise use the Service in connection with financial crimes.",
          "Use the Service to harass, threaten, or harm any individual or organisation.",
        ] },
        { h3: "Account and Credential Misuse" },
        { list: [
          "Share your API keys, account credentials, or payment methods with any third party without our prior written consent.",
          "Create multiple accounts to circumvent usage limits, payment requirements, or account suspensions.",
          "Impersonate any person or entity or misrepresent your affiliation with any person or entity.",
          "Use stolen credit cards, fraudulent payment instruments, or engage in friendly fraud (filing chargebacks for services rendered).",
        ] },
        { h3: "Competitive Intelligence and Benchmarking" },
        { list: [
          "Use the Service to benchmark, evaluate, or reverse-engineer our detection capabilities for the primary purpose of building a competing product, without our prior written consent.",
          "Systematically harvest scan results, module outputs, or AI-generated content to train or fine-tune any machine learning model without our prior written consent.",
        ] },
      ],
    },
    {
      id: "responsible-disclosure",
      heading: "Responsible Disclosure",
      body: [
        { p: "If you discover a vulnerability in the GateTest platform, CLI, or API, please disclose it to us responsibly before public disclosure:" },
        { list: [
          `Email: [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL}) with subject line "Security Disclosure"`,
          "Include a description of the vulnerability, steps to reproduce, and potential impact",
          "Give us a reasonable time to investigate and remediate before public disclosure (typically 90 days)",
          "Do not exploit the vulnerability beyond what is necessary to demonstrate the issue",
        ] },
        { p: "We will acknowledge your report within 5 business days, keep you informed of our progress, and publicly credit you (unless you prefer anonymity) once the issue is resolved. We do not currently operate a paid bug-bounty programme, but we may offer recognition or other courtesy acknowledgement at our discretion." },
      ],
    },
    {
      id: "content-you-submit",
      heading: "Content You Submit",
      body: [
        { p: "By submitting a repository URL or source files to GateTest, you represent and warrant that:" },
        { list: [
          "You have the right to submit the code for scanning (you own it or have permission from the owner).",
          "The submission does not violate the intellectual property rights, privacy rights, or other rights of any third party.",
          "The submission does not contain content that is unlawful or that we are prohibited from processing under applicable law.",
        ] },
        { p: "We do not store your source code beyond what is necessary to complete the scan. See our [Privacy Policy](/legal/privacy) for details on data retention." },
      ],
    },
    {
      id: "ai-generated-output",
      heading: "AI-Generated Output",
      body: [
        { p: "GateTest uses large language models (including Claude by Anthropic) to generate code analysis, fix suggestions, and reports. You acknowledge that:" },
        { list: [
          "AI-generated content may be inaccurate, incomplete, or inappropriate for your specific context.",
          "You are solely responsible for reviewing, testing, and validating any AI-generated fix before applying it to your codebase.",
          "You may not use AI-generated outputs as the sole basis for security certifications, compliance sign-offs, or representations to third parties without independent expert verification.",
          "We do not warrant that AI-generated outputs are free of hallucinations, biases, or errors.",
        ] },
      ],
    },
    {
      id: "api-usage",
      heading: "API Usage",
      body: [
        { p: "If you access the Service via API:" },
        { list: [
          "You must keep your API keys confidential and not share them with unauthorised parties.",
          "You are responsible for all API activity under your credentials, whether or not you authorised it.",
          "You must implement reasonable rate limiting on your client to avoid exceeding our published quotas.",
          "You must not use the API to build a product or service that directly competes with GateTest without our prior written consent, and you must not white-label the API output as your own proprietary scanning engine.",
        ] },
      ],
    },
    {
      id: "github-app",
      heading: "GitHub App",
      body: [
        { p: "If you install the GateTest GitHub App:" },
        { list: [
          "You authorise GateTest to access the repositories you select in accordance with the permissions disclosed at install time and our Privacy Policy.",
          "You are responsible for ensuring the App is installed only on repositories where you have the right to grant such access.",
          "You must notify us immediately if the App is installed on a repository without your authorisation.",
          "You may revoke App access at any time through your GitHub settings.",
        ] },
      ],
    },
    {
      id: "consequences-of-violation",
      heading: "Consequences of Violation",
      body: [
        { p: "If we determine, in our sole reasonable discretion, that you have violated this AUP, we may take any of the following actions:" },
        { list: [
          "**Warning.** Issue a warning and require immediate remediation.",
          "**Suspension.** Suspend your access to the Service, with or without prior notice, pending investigation or remediation.",
          "**Termination.** Terminate your account and revoke all access to the Service. In cases of serious or repeated violations, termination is permanent.",
          "**Legal action.** Pursue civil or criminal legal remedies where the violation constitutes unlawful conduct, including referral to law enforcement authorities.",
          "**Disclosure.** Disclose relevant information to law enforcement, regulatory authorities, or affected third parties as required by law or as necessary to prevent harm.",
        ] },
        { p: "Accounts terminated for AUP violations are not entitled to a refund of any amounts paid. Where a violation causes us loss, we reserve the right to recover damages, costs, and fees to the extent permitted by the Terms of Service and applicable law." },
      ],
    },
    {
      id: "reporting-violations",
      heading: "Reporting Violations",
      body: [
        { p: `If you become aware of any use of the Service that violates this AUP, please report it to: [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL}) with subject line "AUP Violation Report". We investigate all reports and will follow up where appropriate, subject to confidentiality constraints.` },
      ],
    },
    {
      id: "changes-to-this-policy",
      heading: "Changes to This Policy",
      body: [
        { p: `We may update this AUP from time to time. We will notify you of material changes by posting a notice on ${F.siteHost()} or by emailing you. Your continued use of the Service after the effective date of a revised AUP constitutes acceptance of the revised policy. If you disagree with a change, you may terminate your account in accordance with the Terms of Service.` },
      ],
    },
    {
      id: "contact",
      heading: "Contact",
      body: [
        { p: `For questions about this policy: [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL})` },
      ],
    },
  ],
};
