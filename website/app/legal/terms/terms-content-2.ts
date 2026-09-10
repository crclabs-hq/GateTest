import type { LegalSection } from "../../components/legal/LegalDocument";
import { F, T, AI, AI_SECOND, mailto } from "./terms-facts";

const NAME = F.LEGAL_ENTITY;
const CAP = `the greater of US$${F.LIABILITY_FLOOR_USD} and the total Fees you paid to ${NAME} in the ${F.LIABILITY_LOOKBACK_MONTHS} months before the event giving rise to the claim`;

export const SECTIONS_2: LegalSection[] = [
  {
    id: "ai-features",
    heading: "AI Features",
    body: [
      { p: "The deterministic scan engine uses no AI: its modules are rule-based and produce the same Findings for the same input. AI Features run only on Plans and paths that include them, or when you invoke them yourself through the CLI or MCP server." },
      { p: `**What AI Features send.** When an AI Feature runs, the complete contents of the files being reviewed or fixed, their paths, and the related Finding text are sent to ${AI.entity}, our AI provider, together with our prompts. ${AI.name} retains API inputs and outputs for a standard ${F.AI_PROVIDER_RETENTION_DAYS} days and does not use them to train its models under its commercial terms. If you opt in to a second-opinion review on a ${T.forensic.name} scan, the same material is also sent to ${AI_SECOND.entity}. Details are in the [Privacy Policy](/legal/privacy) and on the [Sub-processors](/legal/sub-processors) page.` },
      { p: "**AI output can be wrong.** Large language models are probabilistic. AI review, explanations, and generated fixes may be inaccurate, incomplete, out of date, insecure, or unsuitable for your codebase; they may flag non-issues, miss real ones, invent references, or introduce new bugs. **You must review and test every AI-generated change before you merge it.** We never merge changes for you, and you are solely responsible for the code you ship." },
      { p: "**Bring your own key.** Where the Service lets you supply your own AI provider API key, that key is used only for the request you attach it to and is never stored, logged, or echoed back. You are responsible for the key, for the spend it incurs, and for complying with your provider's terms. The CLI and local MCP server always use your own key and never ours. Where you choose a model, the request is billed to whichever key funded it." },
      { p: "AI Features and their Output are information, not advice. They are not a substitute for a qualified engineer, a security professional, or legal counsel, and we are not liable for actions you take or decline to take on the basis of them." },
    ],
  },
  {
    id: "no-guarantee-of-detection",
    heading: "No Guarantee of Detection",
    body: [
      { p: "**A passing scan is not a warranty.** GateTest is an automated analysis tool. A pass, a score, a badge, or an empty Findings list means the modules that ran did not report an issue; it does not mean, and we do not represent, that your code is free of defects, vulnerabilities, licence problems, accessibility failures, or any other issue, or that it complies with any law, standard, or certification." },
      { p: "No automated tool finds every issue. Coverage depends on which modules ran, what your Plan includes, what the hosted engine can safely run, the languages and frameworks in your repository, and the state of the rules and models on the day of the scan. Findings may be false positives, may be mis-classified in severity, and may not apply to your context." },
      { p: "The Service supplements, and does not replace, code review, testing, professional security assessment, penetration testing, and compliance audit. Nothing the Service produces is legal, security, engineering, financial, or other professional advice. You are responsible for verifying Findings, for deciding what to do about them, and for the security and quality of what you deploy." },
      { p: "Without limiting the rest of these Terms, we are not liable for any defect, vulnerability, breach, outage, or loss in code that the Service scanned, whether the scan passed or failed, or for any consequence of merging a proposed fix." },
    ],
  },
  {
    id: "beta-features",
    heading: "Beta Features",
    body: [
      { p: "We may offer Beta Features. They are provided for evaluation, may be incomplete, may change or be withdrawn at any time without notice, and may not be subject to the same support, availability, or security commitments as the rest of the Service." },
      { p: "Beta Features are provided **as is** and are excluded from any warranty, indemnity, or service commitment in these Terms to the fullest extent the law allows. Use them at your own risk, and do not rely on them for production decisions unless you have verified the Output yourself." },
    ],
  },
  {
    id: "confidentiality",
    heading: "Confidentiality",
    body: [
      { p: "**Confidential Information** is non-public information one party discloses to the other that is marked confidential or that a reasonable person would understand to be confidential. Your Customer Content, Findings, and Reports are your Confidential Information. Our non-public features, roadmap, pricing offers, and API keys are ours." },
      { p: "Each party will use the other's Confidential Information only to perform under these Terms, will protect it with at least reasonable care, and will disclose it only to employees, contractors, and providers who need it and are bound by obligations at least as protective. We disclose your Confidential Information only to the providers on our [Sub-processors](/legal/sub-processors) page, to the extent needed to provide the Service." },
      { p: "These obligations do not cover information that is or becomes public without breach, was already known to the recipient, is independently developed, or is received from a third party without restriction. A party may disclose Confidential Information where the law or a court requires, after giving the other party notice where lawful and reasonable help to contest or limit the disclosure." },
      { p: "Confidentiality obligations last for three years after they are disclosed, and for as long as the information remains a trade secret." },
    ],
  },
  {
    id: "privacy-and-data-protection",
    heading: "Privacy and Data Protection",
    body: [
      { p: "Our [Privacy Policy](/legal/privacy) explains what personal information we collect, why, how long we keep it, and the rights you have. Our [Cookie Policy](/legal/cookies) lists every cookie and browser-storage key the Service sets." },
      { p: "Where you are subject to the GDPR, the UK GDPR, or similar law and we process personal data in Customer Content on your behalf, our [Data Processing Addendum](/legal/dpa) applies and forms part of these Terms. The providers we use to process your data, and what each receives, are listed on our [Sub-processors](/legal/sub-processors) page." },
      { p: `Requests to access, correct, export, or delete your personal information or Findings are handled by e-mail to ${mailto("Privacy request")}. We will verify the request and respond within the time the applicable law allows.` },
      { p: "You are responsible for having a lawful basis to submit any personal data contained in your Customer Content, and for telling the people it concerns where the law requires it." },
    ],
  },
  {
    id: "feedback",
    heading: "Feedback",
    body: [
      { p: "If you send us ideas, suggestions, bug reports, or other feedback about the Service, you grant us a perpetual, irrevocable, worldwide, royalty-free licence to use it for any purpose without obligation to you. Feedback is not Confidential Information, and we do not claim any right in your Customer Content by receiving it." },
    ],
  },
  {
    id: "suspension-and-termination",
    heading: "Suspension and Termination",
    body: [
      { p: `**By you.** You may stop using the Service at any time. Cancel subscriptions through the [billing portal](/billing), uninstall the GitHub App or disconnect your Gluecron repositories to end our access, and e-mail ${mailto("Close account")} to close your Account.` },
      { p: "**By us.** We may suspend or terminate your access to all or part of the Service, with notice where practicable, if: you materially breach these Terms or the [Acceptable Use Policy](/legal/acceptable-use); a Fee is overdue; your use creates a security, legal, or operational risk to the Service, our providers, or other customers; we are required to by law or by a Git Host or payment provider; or you dispute a charge for a delivered scan with your card issuer rather than with us." },
      { p: "Where a breach can be cured, we will normally give you notice and a reasonable period to cure before terminating. Where immediate action is needed to protect the Service or others, or where the law requires it, we may act without prior notice and will notify you afterwards." },
      { p: "We may also stop providing the Service, or any Plan, on at least 30 days' notice; see [The Service](#the-service) for what happens to prepaid Fees." },
    ],
  },
  {
    id: "effect-of-termination",
    heading: "Effect of Termination",
    body: [
      { p: "When these Terms end: your right to use the Service ends; subscriptions are cancelled and no further renewal is charged; Fees already due remain payable; and any API keys are revoked. Fees paid for scans that were delivered are not refunded, except as the [Refund Policy](/legal/refunds) or a law that cannot be excluded provides." },
      { p: `We keep your Account record and Findings after termination so that you can return and see your history, and we delete them when you ask by e-mail to ${mailto("Deletion request")}. Records we are required to keep for tax, accounting, fraud-prevention, or legal purposes, including payment records and the audit log, are kept for the period the law requires, up to ${F.AUDIT_LOG_YEARS} years, and then deleted.` },
      { p: "Termination does not affect your rights in the CLI under the MIT License, which continues to apply to any copy you already have." },
      { p: "The sections that by their nature should survive do so, including [Your Content and Repositories](#your-content-and-repositories) as to Findings, [Our Intellectual Property](#our-intellectual-property), [No Guarantee of Detection](#no-guarantee-of-detection), [Confidentiality](#confidentiality), [Disclaimer of Warranties](#disclaimer-of-warranties), [Limitation of Liability](#limitation-of-liability), [Indemnification](#indemnification), [Governing Law and Venue](#governing-law-and-venue), and [Dispute Resolution and Arbitration](#dispute-resolution-and-arbitration)." },
    ],
  },
  {
    id: "disclaimer-of-warranties",
    heading: "Disclaimer of Warranties",
    body: [
      { p: "**TO THE FULLEST EXTENT PERMITTED BY LAW, THE SERVICE AND ALL OUTPUT ARE PROVIDED \"AS IS\" AND \"AS AVAILABLE\", WITHOUT WARRANTY OF ANY KIND, EXPRESS, IMPLIED, OR STATUTORY, INCLUDING ANY WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, OR THAT THE SERVICE WILL BE UNINTERRUPTED, TIMELY, SECURE, OR ERROR-FREE.** We do not warrant that the Service will detect any particular issue, that Findings or AI Output are correct, or that any defect will be fixed." },
      { p: "We target high availability but do not guarantee it and do not offer service credits. We may take the Service down for maintenance, and will announce planned maintenance in advance where practicable." },
      { p: "**Consumer rights.** Some laws imply guarantees that cannot be excluded. Nothing in these Terms excludes, restricts, or modifies any right or remedy you have under the New Zealand Consumer Guarantees Act 1993 or Fair Trading Act 1986, or under any other law that cannot be excluded by agreement. If you acquire the Service for the purposes of a business, you agree that the Consumer Guarantees Act 1993 does not apply, as that Act permits, and that these Terms are fair and reasonable given the nature of the Service and its price." },
      { p: "The CLI is licensed under the MIT License, which contains its own disclaimer of warranty." },
    ],
  },
  {
    id: "limitation-of-liability",
    heading: "Limitation of Liability",
    body: [
      { p: `**Exclusions.** TO THE FULLEST EXTENT PERMITTED BY LAW, ${NAME.toUpperCase()} AND ITS OWNERS, DIRECTORS, EMPLOYEES, CONTRACTORS, LICENSORS, AND PROVIDERS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, BUSINESS, GOODWILL, DATA, OR COST OF SUBSTITUTE SERVICES, ARISING OUT OF OR RELATED TO THESE TERMS OR THE SERVICE, UNDER ANY THEORY OF LIABILITY, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.` },
      { p: `**The cap.** TO THE FULLEST EXTENT PERMITTED BY LAW, OUR TOTAL LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATED TO THESE TERMS OR THE SERVICE, IN AGGREGATE, WILL NOT EXCEED ${CAP.toUpperCase()}. This cap applies across all claims and causes of action together and is not increased by bringing more than one.` },
      { p: "Without limiting the above, we are not liable for: defects, vulnerabilities, breaches, or losses in code the Service scanned, whether the scan passed or failed; the consequences of merging a proposed fix; actions taken on the basis of Findings or AI Output; the acts or omissions of Git Hosts, payment providers, AI providers, or other third parties; or loss arising from your use of the CLI, which is provided under the MIT License without warranty." },
      { p: "**What is not limited.** Nothing in these Terms excludes or limits liability for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, for your obligation to pay Fees, for your indemnification obligations, or for any liability that the law does not allow to be excluded or limited, including under the Consumer Guarantees Act 1993 and Fair Trading Act 1986 where they apply. Where liability under such a law can be limited, it is limited to the greatest extent the law permits, including, at our option, resupplying the Service or paying the cost of resupply." },
      { p: "These limitations are an essential part of the bargain between you and us and reflect the Service's price. They apply even if a remedy fails of its essential purpose." },
    ],
  },
  {
    id: "indemnification",
    heading: "Indemnification",
    body: [
      { p: `**By you.** You will defend, indemnify, and hold harmless ${NAME} and its owners, directors, employees, and contractors from and against any third-party claim, and the resulting losses, damages, liabilities, costs, and reasonable legal fees, arising out of or related to: your Customer Content; your breach of these Terms or the [Acceptable Use Policy](/legal/acceptable-use); your scanning of, or writing to, any repository, site, or system you were not authorised to scan or modify; your violation of any law or third-party right; or your use of Output, including merging a proposed fix.` },
      { p: `**By us.** We will defend you against any third-party claim alleging that the hosted Service, as provided by us and used in accordance with these Terms, infringes that third party's patent, copyright, or trade mark, and will pay the damages and costs finally awarded or agreed in settlement. This does not apply to claims arising from Customer Content, Output, third-party services, open-source components including the CLI, your modifications, combination of the Service with anything we did not supply, or use after we told you to stop. If such a claim arises or seems likely, we may procure the right for you to keep using the Service, modify or replace it so that it does not infringe, or terminate the affected part and refund prepaid Fees for the period after termination. This section states your exclusive remedy for infringement claims.` },
      { p: "**Conditions.** The indemnified party must notify the indemnifying party promptly of the claim, give it sole control of the defence and settlement, and provide reasonable help at the indemnifying party's expense. The indemnifying party may not settle a claim in a way that admits fault by, or imposes an obligation on, the indemnified party without its written consent, which will not be unreasonably withheld." },
    ],
  },
];
