import type { LegalSection, LegalBlock } from "../../components/legal/LegalDocument";
import { F, HOST, SITE, mailto } from "./terms-facts";

const NAME = F.LEGAL_ENTITY;
const OPT_OUT_SUBJECT = "Arbitration Opt-Out";

/** Contact block: the postal address line appears only when one is on file. */
const CONTACT: LegalBlock[] = [
  { p: `The Service is provided by **${NAME}**. For questions about these Terms, notices, billing, privacy requests, or anything else, e-mail ${mailto()}.` },
  ...(F.POSTAL_ADDRESS ? [{ p: `Postal address: ${F.POSTAL_ADDRESS}.` }] : []),
  { p: `The current version of these Terms is always at [${HOST}/legal/terms](${SITE}/legal/terms).` },
];

export const SECTIONS_3: LegalSection[] = [
  {
    id: "governing-law-and-venue",
    heading: "Governing Law and Venue",
    body: [
      { p: `These Terms, and any dispute or claim arising out of or relating to them or the Service, are governed by the laws of ${F.GOVERNING_LAW}, without regard to conflict-of-laws rules. The United Nations Convention on Contracts for the International Sale of Goods does not apply.` },
      { p: `Subject to [Dispute Resolution and Arbitration](#dispute-resolution-and-arbitration), any dispute that is not arbitrated will be brought exclusively in the courts of ${F.VENUE}, and each party submits to the jurisdiction of those courts. Either party may seek interim or injunctive relief in any court of competent jurisdiction to protect its intellectual property or Confidential Information.` },
      { p: "If you are a consumer, this section does not deprive you of the protection of mandatory consumer law in the country where you live, or of the right to bring proceedings in your local courts where that law gives you one." },
    ],
  },
  {
    id: "dispute-resolution-and-arbitration",
    heading: "Dispute Resolution and Arbitration",
    body: [
      { p: `**Talk to us first.** Before starting any formal proceeding, e-mail ${mailto("Dispute notice")} with your Account e-mail, a description of the dispute, and the outcome you want. We will do the same if we have a claim against you, using the e-mail on your Account. Both parties will try in good faith to resolve the dispute for at least 30 days from that notice before doing anything else.` },
      { p: `**Agreement to arbitrate.** If we cannot resolve it informally, you and ${NAME} agree that any dispute, claim, or controversy arising out of or relating to these Terms or the Service, including its formation, interpretation, or enforceability, will be resolved by **binding individual arbitration** and not in court, except as this section provides. This covers claims in contract, tort, statute, or any other theory.` },
      { p: `**Rules and seat.** If you reside in the United States, the arbitration will be administered by the American Arbitration Association under its Consumer Arbitration Rules (or, for business customers, its Commercial Arbitration Rules). Otherwise it will be administered by the New Zealand International Arbitration Centre under its Arbitration Rules. The seat of arbitration is ${F.ARBITRATION_SEAT}; hearings may be held by video, or in a location the parties agree, and the arbitration may proceed on documents alone if both parties agree. The arbitrator may award any relief a court could award to an individual party.` },
      { p: "**Individual basis only.** TO THE EXTENT THE LAW ALLOWS, EACH PARTY MAY BRING CLAIMS AGAINST THE OTHER ONLY IN ITS INDIVIDUAL CAPACITY, AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY CLASS, COLLECTIVE, CONSOLIDATED, OR REPRESENTATIVE PROCEEDING, AND EACH PARTY WAIVES ANY RIGHT TO A JURY TRIAL. The arbitrator may not consolidate claims of more than one person or preside over any form of representative proceeding. If a court finds this paragraph unenforceable for a particular claim, that claim alone will be heard in the courts named in [Governing Law and Venue](#governing-law-and-venue) and the rest will remain in arbitration." },
      { p: "**Exceptions.** Either party may bring an individual claim in a small-claims court or tribunal that has jurisdiction over it, and either party may seek interim or injunctive relief in court to protect intellectual property, Confidential Information, or the integrity of the Service. Nothing in this section prevents you from raising a complaint with a consumer-protection or data-protection authority." },
      { p: `**Opt-out.** You may opt out of this arbitration agreement by e-mailing ${mailto(OPT_OUT_SUBJECT)} with the subject line "${OPT_OUT_SUBJECT}", your name, and the e-mail on your Account, within 30 days of first accepting these Terms. Opting out does not affect any other part of these Terms, and disputes will then be resolved in the courts named in [Governing Law and Venue](#governing-law-and-venue).` },
      { p: "**Delegation, fees, and confidentiality.** The arbitrator, not a court, decides any question about the scope, applicability, or enforceability of this section, except that a court decides whether the individual-basis paragraph is enforceable. Fees and costs are allocated under the applicable rules; where the rules allow, the arbitrator may award costs and reasonable legal fees to the prevailing party. The arbitration and its outcome are confidential except as needed to enforce an award or as the law requires." },
      { p: "**Changes.** If we change this section after you accept these Terms, the change does not apply to a dispute you notified us of before the change took effect, and you may reject the change by opting out within 30 days of notice." },
    ],
  },
  {
    id: "export-controls-and-sanctions",
    heading: "Export Controls and Sanctions",
    body: [
      { p: `The Service and its Output may be subject to the export-control and sanctions laws of New Zealand, the United States, the European Union, the United Kingdom, and other jurisdictions. You will comply with them. You represent that you are not located in, organised under the laws of, or ordinarily resident in a country or territory subject to comprehensive sanctions by any of those jurisdictions, and that you are not listed on, or owned or controlled by anyone listed on, any government restricted-party list.` },
      { p: "You will not export, re-export, or transfer the Service or Output to any such country, territory, or person, or use it for any purpose those laws prohibit. We may decline to provide, or may suspend, the Service where we reasonably believe doing otherwise would breach those laws." },
    ],
  },
  {
    id: "government-users",
    heading: "Government Users",
    body: [
      { p: "If you are a government body, you will use the Service only as permitted by the laws that apply to you, and you represent that you have the authority to accept these Terms, including its dispute-resolution and indemnity provisions, or have told us in writing which provisions you cannot accept before using the Service." },
      { p: "If you are a United States federal government end user, the Service and its documentation are commercial computer software and commercial computer software documentation, and your rights in them are those granted to all other users under these Terms, consistent with FAR 12.212 and DFARS 227.7202." },
    ],
  },
  {
    id: "changes-to-these-terms",
    heading: "Changes to These Terms",
    body: [
      { p: "We may update these Terms as the Service, the law, or our business changes. For material changes we will give at least 30 days' notice before they take effect, by e-mail to your Account address, by a notice on the website, or both, and we will update the effective date at the top of this page. Changes that do not materially reduce your rights or increase your obligations, such as corrections and clarifications, may take effect when posted." },
      { p: "If you continue to use the Service after a change takes effect, you accept the changed Terms. If you do not agree, stop using the Service and cancel any subscription before the change takes effect; prepaid Fees for the period after you cancel will be refunded where the change materially reduced what you paid for." },
    ],
  },
  {
    id: "assignment",
    heading: "Assignment",
    body: [
      { p: `You may not assign or transfer these Terms, or any right or obligation under them, without our prior written consent, except to a successor in a merger, acquisition, or sale of substantially all of your assets on notice to us. We may assign these Terms to an affiliate or to a successor in a merger, acquisition, reorganisation, or sale of assets, on notice to you. Any other attempted assignment is void.` },
    ],
  },
  {
    id: "force-majeure",
    heading: "Force Majeure",
    body: [
      { p: "Neither party is liable for delay or failure to perform, other than a failure to pay Fees, caused by events beyond its reasonable control, including natural disaster, epidemic, war, terrorism, civil unrest, government action, labour dispute, power or telecommunications failure, denial-of-service or other attack, or the failure of a Git Host, payment provider, AI provider, or hosting provider. The affected party will use reasonable efforts to resume performance. If a scan cannot be completed because of such an event, it is treated as not delivered under the [Refund Policy](/legal/refunds)." },
    ],
  },
  {
    id: "general",
    heading: "General",
    body: [
      { list: [
        "**Entire agreement.** These Terms, with the policies they incorporate and any order or enterprise agreement we sign with you, are the entire agreement between you and us about the Service and replace all earlier discussions and agreements. If a signed enterprise agreement conflicts with these Terms, the signed agreement prevails for that customer.",
        "**Severability.** If any provision is held unenforceable, it will be enforced to the maximum extent permitted and the rest of these Terms remain in effect.",
        "**Waiver.** A failure or delay in enforcing a provision is not a waiver of it. A waiver is effective only in writing.",
        "**No third-party beneficiaries.** These Terms create no rights for anyone other than you and us, except that the disclaimers, limitations, and indemnities in our favour also protect the people and entities they name.",
        "**Relationship.** The parties are independent contractors. Nothing here creates a partnership, joint venture, agency, or employment relationship.",
        "**Interpretation.** Headings are for convenience only. \"Including\" means \"including without limitation\". Section links refer to sections of these Terms. The English-language version controls over any translation.",
        "**Open source.** The Service includes open-source components licensed under their own terms, which apply to those components instead of these Terms to the extent they conflict.",
      ] },
    ],
  },
  {
    id: "notices",
    heading: "Notices",
    body: [
      { p: `Notices to you are sent to the e-mail address on your Account, or posted on the website at ${HOST}, and are effective when sent or posted. You agree to receive notices, receipts, and other communications about the Service electronically, and that electronic notices satisfy any requirement that a communication be in writing.` },
      { p: `Notices to us must be sent by e-mail to ${mailto()} and are effective when we acknowledge receipt. Legal process may be served by the same route.` },
    ],
  },
  {
    id: "contact",
    heading: "Contact",
    body: CONTACT,
  },
];
