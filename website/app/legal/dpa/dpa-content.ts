/**
 * Data Processing Addendum — content module (clauses 1–9).
 *
 * Every fact (entity, contact, retention window, law, venue, date) is read
 * from `app/legal/_facts.js`; nothing below types a domain, address or
 * number by hand. Clauses 10 onward and the Annexes live in `dpa-content-2.ts`
 * to keep every file inside the 300-line cap.
 */
import type { LegalDoc, LegalSection } from "../../components/legal/LegalDocument";
import * as F from "../_facts";
import { SECTIONS_2 } from "./dpa-content-2";

const CONTACT = F.POSTAL_ADDRESS
  ? `${F.LEGAL_ENTITY}, ${F.POSTAL_ADDRESS}, ${F.SUPPORT_EMAIL}`
  : `${F.LEGAL_ENTITY}, ${F.SUPPORT_EMAIL}`;

const SECTIONS_1: LegalSection[] = [
  {
    id: "introduction",
    heading: "Introduction",
    body: [
      { p: `This Data Processing Addendum ("**DPA**") forms part of the [Terms of Service](/legal/terms) (the "**Agreement**") between ${F.LEGAL_ENTITY} ("**GateTest**", "**we**") and the customer that accepts the Agreement ("**Customer**", "**you**"). It sets out the terms on which GateTest processes personal data on your behalf when you use the hosted service, the command-line tool in hosted mode, the GitHub App, the Gluecron integration, the MCP endpoint and every related feature (together, the "**Service**").` },
      { p: `This DPA applies automatically, without signature, to every Customer whose use of the Service involves personal data. It is incorporated into the Agreement by reference and takes effect on the later of ${F.EFFECTIVE_DATE} and the date you first use the Service. If your procurement or compliance process needs a countersigned copy, e-mail ${F.SUPPORT_EMAIL} and we will return one; a countersigned copy has the same terms as this page.` },
      { p: `Where this DPA uses a capitalised term that the Agreement defines, it has the meaning given there. Where the two conflict on a matter of data protection, this DPA prevails (clause 12).` },
    ],
  },
  {
    id: "definitions",
    heading: "Definitions",
    body: [
      { list: [
        `**Personal Data** means any information relating to an identified or identifiable natural person that GateTest processes on your behalf under the Agreement.`,
        `**Processing** means any operation performed on Personal Data, whether or not by automated means, including collection, retrieval, analysis, storage, disclosure by transmission and erasure. "Process" and "Processed" are read accordingly.`,
        `**Controller** means the party that determines the purposes and means of Processing; **Processor** means the party that Processes Personal Data on the Controller's behalf. The equivalent terms under other Data Protection Laws (for example "business" and "service provider" under the CCPA, or "agency" under the NZ Privacy Act) are read into these definitions.`,
        `**Sub-processor** means a third party engaged by GateTest to Process Personal Data in connection with the Service.`,
        `**Data Subject** means the natural person to whom Personal Data relates.`,
        `**Data Protection Laws** means all laws applying to the Processing of Personal Data under the Agreement, including, to the extent applicable: Regulation (EU) 2016/679 (the "**GDPR**"); the GDPR as retained in the law of the United Kingdom and the Data Protection Act 2018 (the "**UK GDPR**"); the New Zealand Privacy Act 2020; and the California Consumer Privacy Act as amended by the California Privacy Rights Act (the "**CCPA**").`,
        `**Security Incident** means a breach of security leading to the accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, Personal Data Processed by GateTest or a Sub-processor.`,
        `**SCCs** means the standard contractual clauses for the transfer of personal data to third countries adopted by the European Commission in Implementing Decision (EU) 2021/914.`,
        `**UK Addendum** means the International Data Transfer Addendum to the EU Commission Standard Contractual Clauses issued by the UK Information Commissioner under s.119A of the Data Protection Act 2018.`,
      ] },
    ],
  },
  {
    id: "roles",
    heading: "Roles of the parties",
    body: [
      { p: `**Repository and scan data.** For Personal Data contained in the repositories, archives, URLs, files and other inputs you submit for scanning, and in the findings, fixes and reports the Service produces from them ("**Customer Data**"), you are the Controller (or a Processor acting for another Controller) and GateTest is your Processor. You are responsible for having a lawful basis to submit that data to the Service and for the instructions you give.` },
      { p: `**Account, billing and telemetry data.** For the Personal Data GateTest collects to run its own business — your account and sign-in identity, billing records, support correspondence, product analytics and the anonymous engine telemetry described in the [Privacy Policy](/legal/privacy) — GateTest is an independent Controller. That Processing is governed by the Privacy Policy, not by this DPA.` },
      { p: `**Git hosts.** GitHub and Gluecron act on your instructions under your own agreements with them. When the Service reads a repository or writes a status, comment or branch back to a git host, it does so as your Processor using the access you granted at installation.` },
    ],
  },
  {
    id: "details-of-processing",
    heading: "Annex I — Details of Processing",
    body: [
      { p: `This Annex describes the Processing GateTest performs as your Processor and serves as Annex I to the SCCs where they apply (clause 7).` },
      { table: {
        headers: ["Item", "Description"],
        rows: [
          ["Subject matter", "Automated quality and security analysis of source repositories and web properties that the Customer submits to the Service, and the generation of proposed fixes."],
          ["Duration", "The term of the Agreement, and thereafter until the Customer Data is deleted on request under clause 10."],
          ["Nature and purpose", "Fetching source repositories from the Customer's git host; analysing them with deterministic rules and, on the tiers that include it, AI review; producing findings, verdicts and reports; generating proposed fixes; and posting results (statuses, comments, branches, pull requests) back to the git host."],
          ["Categories of Personal Data", "Identifiers and contact data of developers that appear in code, commit metadata, comments, configuration and documentation (names, e-mail addresses, usernames, avatar URLs); and any Personal Data the Customer places in a repository, file or URL submitted for scanning."],
          ["Special categories", "None expected. The Service is not designed for special-category data and the Customer must not submit it."],
          ["Categories of Data Subjects", "The Customer's employees, contractors, developers and contributors; and any individual referenced in the code, data or web property submitted for scanning."],
          ["Frequency", "Continuous for the term: once per scan the Customer requests, and once per push or pull-request event for repositories connected to Continuous scanning."],
          ["Sub-processor transfers", "As set out in clause 6 and on the [Sub-processors](/legal/sub-processors) page; the subject matter, nature and duration of each transfer match this Annex."],
        ],
      } },
    ],
  },
  {
    id: "processor-obligations",
    heading: "GateTest's obligations as Processor",
    body: [
      { p: `GateTest will:` },
      { list: [
        `**Process only on documented instructions.** The Agreement, this DPA, the settings you choose in the product (including which repositories are connected, which modules run and whether AI features are enabled) and each scan request you make constitute your complete documented instructions. GateTest will not Process Customer Data for any other purpose, except where required by law, in which case it will tell you first unless the law forbids it.`,
        `**Inform you of unlawful instructions.** If GateTest believes an instruction infringes Data Protection Laws it will tell you without undue delay and may suspend the affected Processing until the instruction is confirmed or changed.`,
        `**Keep personnel bound by confidentiality.** Access to Customer Data is limited to people who need it to operate the Service, and each is bound by a contractual or statutory duty of confidentiality.`,
        `**Maintain the security measures in Annex II** (clause 14), and not reduce their overall level of protection during the term.`,
        `**Assist you with Data Subject requests** (clause 9) and, taking into account the nature of the Processing and the information available to GateTest, with data-protection impact assessments and prior consultations with supervisory authorities.`,
        `**Delete or return Customer Data** at the end of the Service on request (clause 10), subject to any retention a law requires.`,
        `**Make available the information necessary to demonstrate compliance** with this DPA, and allow for and contribute to audits, as set out below.`,
      ] },
      { h3: "Audits" },
      { p: `GateTest will answer reasonable written information-security and data-protection questionnaires within 30 days. Where Data Protection Laws give you a right to audit and a written response is genuinely insufficient, you (or an independent auditor you appoint that is not a competitor of GateTest and is bound by confidentiality) may carry out an audit of the relevant controls no more than once in any 12-month period, on at least 30 days' written notice, during business hours, at your cost, and in a manner that does not disrupt the Service or expose other customers' data. Where a Sub-processor's controls are in question, GateTest will make available the Sub-processor's most recent audit report or certification in place of an on-site audit of that Sub-processor.` },
    ],
  },
  {
    id: "sub-processors",
    heading: "Sub-processors",
    body: [
      { p: `You give GateTest general written authorisation to engage Sub-processors. The current list — with each Sub-processor's legal entity, purpose, the data it receives, its location and its own data-protection terms — is published at [Sub-processors](/legal/sub-processors). That page is the notice mechanism for this DPA: GateTest will update it at least 30 days before a new Sub-processor begins Processing Customer Data (the "**objection window**").` },
      { p: `If you have reasonable data-protection grounds to object to a new Sub-processor, e-mail ${F.SUPPORT_EMAIL} within the objection window, stating the grounds. GateTest will work with you in good faith to resolve the objection — for example by not routing your Customer Data to that Sub-processor, or by offering a configuration that avoids it. If no resolution is reached within 30 days of your objection, you may terminate the part of the Service that cannot be provided without the Sub-processor by written notice, and GateTest will refund any prepaid fees for the terminated part covering the period after termination.` },
      { p: `GateTest imposes on each Sub-processor, by written contract, data-protection obligations that provide at least the level of protection required by this DPA, and remains responsible to you for the performance of each Sub-processor's obligations.` },
    ],
  },
  {
    id: "international-transfers",
    heading: "International transfers",
    body: [
      { p: `GateTest is operated from ${F.GOVERNING_LAW} and the Service is hosted with Sub-processors located predominantly in the United States. Customer Data will therefore be transferred to and Processed in the United States and in the locations listed on the [Sub-processors](/legal/sub-processors) page. GateTest will only make a transfer of Personal Data that Data Protection Laws restrict where a valid transfer mechanism applies.` },
      { list: [
        `**EU transfers.** Where the GDPR applies to a transfer from you to GateTest, the SCCs are incorporated into this DPA by reference and take effect on the date of this DPA, completed as follows: **Module Two** (controller to processor) applies; Clause 7 (docking) is included; in Clause 9 Option 2 (general authorisation) applies with the 30-day period in clause 6 of this DPA; the optional language in Clause 11 is not included; in Clause 13 and Annex I.C the supervisory authority is that of the EU member state in which you are established; in Clause 17 Option 1 applies with the law of Ireland; in Clause 18 the courts of Ireland. The parties' details are the details in this DPA and the Agreement; Annex I of the SCCs is clause 4 of this DPA; Annex II of the SCCs is clause 14 of this DPA; Annex III is the [Sub-processors](/legal/sub-processors) page.`,
        `**UK transfers.** Where the UK GDPR applies, the SCCs as completed above apply as amended by the UK Addendum, which is incorporated by reference; Table 4 of the UK Addendum permits either party to end the Addendum as set out in its section 19.`,
        `**New Zealand.** Where the Privacy Act 2020 applies, GateTest discloses Personal Data to overseas Sub-processors only where Information Privacy Principle 12 is satisfied — in each case because the Sub-processor is contractually bound to protect the information in a way that, overall, provides comparable safeguards to the Act.`,
        `**Transfer assessment.** Before engaging each Sub-processor GateTest reviews its data-protection terms, the data it will receive, its location and its published security measures, and records the outcome. GateTest will provide you with reasonable information to support your own transfer impact assessment on request.`,
      ] },
    ],
  },
  {
    id: "security-incidents",
    heading: "Security Incidents",
    body: [
      { p: `GateTest will notify you of a Security Incident affecting your Customer Data without undue delay after becoming aware of it and, where the GDPR or UK GDPR applies, no later than 72 hours after becoming aware. Notification goes to the e-mail address on your account.` },
      { p: `The notification will describe, to the extent then known, the nature of the incident and the categories and approximate number of Data Subjects and records concerned; the likely consequences; the measures GateTest has taken or proposes to take to address it and mitigate its effects; and a contact point. Information may be provided in phases as it becomes available. GateTest will cooperate reasonably with your investigation and with any notifications you are required to make.` },
      { p: `Notification of, or response to, a Security Incident under this clause is not an acknowledgement by GateTest of fault or liability.` },
    ],
  },
  {
    id: "data-subject-requests",
    heading: "Data Subject requests",
    body: [
      { p: `If GateTest receives a request from a Data Subject to exercise a right under Data Protection Laws in respect of Customer Data (access, rectification, erasure, restriction, portability or objection), it will not respond except to direct the Data Subject to you, unless a law requires otherwise, and will forward the request to you without undue delay.` },
      { p: `Because the Service does not retain source code after a scan, and because you control what is in your repositories, most requests are met by changing the repository and, if you wish, deleting the affected findings. Where you cannot fulfil a request through the product, e-mail ${F.SUPPORT_EMAIL} and GateTest will provide reasonable assistance, at no charge for occasional requests and otherwise at its then-current rates.` },
    ],
  },
];

export const DOC: LegalDoc = {
  title: "Data Processing Addendum",
  intro: `The terms on which GateTest processes personal data as your processor when it scans your code — incorporated into the [Terms of Service](/legal/terms) automatically, with the security measures we actually run set out in Annex II. Contact: ${CONTACT}.`,
  effective: F.EFFECTIVE_DATE,
  sections: [...SECTIONS_1, ...SECTIONS_2],
};
