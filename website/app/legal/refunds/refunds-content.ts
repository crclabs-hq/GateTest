import type { LegalDoc } from "../../components/legal/LegalDocument";
import * as F from "../_facts";

/**
 * Data for /legal/refunds, restyled onto the shared LegalDocument renderer
 * (issue #686 phase 2) the same way #696 did for the other five legal
 * pages. Every fact, list item and clause below is unchanged from the
 * page's pre-#686 prose — only the markup changed. The effective date
 * (May 18, 2026 — the day the hold-then-capture flow was replaced with the
 * upfront charge) is this document's own, per the "Refunds keeps its own
 * earlier date" note in _facts.js — it is NOT F.EFFECTIVE_DATE.
 */
export const DOC: LegalDoc = {
  title: "Refund & Cancellation Policy",
  effective: "2026-05-18",
  sections: [
    {
      id: "payment-model",
      heading: "Payment Model — Per-Scan Upfront Charge",
      body: [
        { p: "GateTest uses a **per-scan upfront charge** payment model for per-scan purchases. Here is exactly how it works:" },
        { list: [
          "**Step 1 — Charge.** When you purchase a scan, the full scan amount is charged to your payment method at checkout via Stripe. This is a one-time payment per scan.",
          "**Step 2 — Run.** GateTest runs the scan you purchased and delivers the report via the web UI, email, PR comment, or API response.",
          `**Step 3 — Service rendered.** Once the scan delivers a report, the Service is considered **rendered and fulfilled**. The payment is non-refundable. See "Scan Delivered = Service Rendered = No Refund" below for what "delivery" means.`,
        ] },
        { p: "There is no subscription, no auto-renew, no recurring charge from per-scan purchases. Each scan is a discrete one-time transaction. Continuous-plan subscriptions are covered separately below." },
      ],
    },
    {
      id: "scan-did-not-complete",
      heading: "Scan Did Not Complete — Contact Support",
      body: [
        { p: `If a scan you paid for fails to start, crashes before any report is delivered, or produces no output for reasons attributable to us (see list below), contact [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL}) within **seven (7) days** of the scan attempt with your scan ID or Stripe receipt. We will, at our sole discretion, either:` },
        { list: [
          "Re-run the scan at no additional cost; or",
          "Issue a credit toward a future scan equal to the amount charged; or",
          "In exceptional cases at our discretion, issue a cash refund.",
        ] },
        { p: "Circumstances under which we will treat a scan as non-delivered:" },
        { list: [
          "The scan cannot access your repository (permissions error, private repo without access, authentication failure, GitHub App uninstalled mid-flight)",
          "The scan fails due to a GateTest infrastructure or technical error",
          "GitHub, or another upstream provider we depend on, is experiencing an outage that prevents repository access or scan completion",
          "The scan does not complete within the expected timeframe and is timed out",
          "A force-majeure event (see Terms of Service) prevents completion",
          "Any other failure on our side that prevents delivery of a scan report",
        ] },
        { p: "We do not offer automatic refunds. The previous hold-then-capture flow was deprecated on 2026-05-18 because it created a structural opportunity for chargeback abuse. The discretionary support model above protects the long-term viability of the service for all customers." },
      ],
    },
    {
      id: "scan-delivered-no-refund",
      heading: "Scan Delivered = Service Rendered = No Refund",
      body: [
        { p: "Once a scan has completed successfully and a report has been delivered, the payment is the price of a digital service generated on demand and delivered instantly. **Delivered scans are non-refundable except as required by non-waivable consumer-protection law in your jurisdiction.**" },
        { p: `**What counts as "delivered".** The Service is delivered when a scan run completes and a scan report is made available to you through any of the following channels: the web UI at ${F.siteHost()}, the dashboard or scan-status page, an email containing the report or a link to it, a pull-request comment or commit-status check on your repository, or an API response. The scan report, analysis results, and any auto-fix pull requests constitute the delivered service.` },
        { p: `**What delivery does not mean.** Delivery means that the modules you purchased ran and produced output. Delivery does **NOT** mean: (a) that any minimum or maximum number of findings was produced; (b) that any finding is correct, actionable, or severe; (c) that your code is free of defects, secure, or compliant; (d) that the report matches your subjective expectations; or (e) that auto-fix pull requests, if any, are ready to merge without review. A "clean" scan report (zero findings) is a valid delivered service, as is a report with findings you disagree with.` },
        { p: "**Consent.** By purchasing a scan, you expressly request that the Service begin immediately and acknowledge that, where permitted by applicable law, you will lose any statutory right of withdrawal or cancellation once performance has begun with your consent. Where your jurisdiction grants a non-waivable cooling-off period that applies notwithstanding this consent, that period applies and prevails." },
      ],
    },
    {
      id: "billing-errors",
      heading: "Billing Errors — Always Corrected",
      body: [
        { p: "We will always correct billing errors regardless of delivery status. These include:" },
        { list: [
          "You were charged a different amount than the price displayed at the time of purchase",
          "A duplicate charge occurred due to a technical error",
          "You were charged for a scan you did not authorise",
        ] },
        { p: `Billing-error corrections are a legal requirement under standard payment-processor and consumer-protection rules and are not exceptions to the "Scan Delivered = Service Rendered = No Refund" section above. Email [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL}) with your Stripe receipt and we will refund the disputed amount within 3 business days.` },
      ],
    },
    {
      id: "not-grounds-for-refund",
      heading: "What Is NOT Grounds for a Refund",
      body: [
        { p: "We do not issue refunds in the following situations:" },
        { list: [
          "You disagree with the scan results or believe a finding is a false positive — scan results are automated analysis, not a guarantee (see Terms of Service)",
          "The scan passed but bugs were later found in your code — a passing scan does not guarantee bug-free code",
          "You did not review auto-fix changes before merging and they caused issues — review responsibility is yours (see Terms of Service)",
          "You purchased a higher tier than needed — you received the service described for that tier",
          `Your repository had no issues and the scan "didn't find anything" — a clean scan is a valid result`,
          "You no longer want the scan after the report has been delivered — buyer's remorse is not a refund condition",
        ] },
      ],
    },
    {
      id: "continuous-cancellation",
      heading: "Continuous Subscription — Cancellation Terms",
      body: [
        { p: "For the Continuous plan (currently US$49 per month per account, subject to change on notice):" },
        { list: [
          `**Cancel anytime.** You may cancel at any time, through your account settings or by emailing ${F.SUPPORT_EMAIL}. We intend to offer a cancellation flow at least as easy as the sign-up flow.`,
          "**Effective at end of billing period.** Cancellation takes effect at the end of the current billing period. Your subscription will not renew for the next period.",
          "**Access until end of paid period.** You retain access to the Continuous scanning features until the end of the billing period you have paid for, unless your account is suspended or terminated under the Terms of Service.",
          "**No prorated refunds.** No refunds are issued for partial months or for unused portions of a billing period. No refunds are issued for prior billing periods.",
          "**Failed payments.** If a recurring charge fails, we will attempt to charge your payment method up to three (3) times over seven (7) days (see Terms of Service). If all attempts fail, the subscription is paused. No data is deleted during the pause period.",
          "**Non-waivable consumer rights.** Nothing in this section limits any non-waivable statutory right to a refund or to cancellation that applies in your jurisdiction (including under the NZ Consumer Guarantees Act 1993, the Australian Consumer Law, or EU / UK consumer-rights law).",
        ] },
      ],
    },
    {
      id: "free-cli-tool",
      heading: "Free CLI Tool",
      body: [
        { p: `The GateTest CLI tool is free and open source under the MIT License. No payments are involved and no refund policy applies. The CLI is provided "as is" without warranty.` },
      ],
    },
    {
      id: "chargebacks",
      heading: "Chargebacks and Payment Disputes",
      body: [
        { p: `**Contact us first.** If you believe a charge is incorrect, please contact [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL}) before filing a chargeback with your bank or card issuer. We resolve most billing issues within one (1) business day and we can typically issue a credit faster than the chargeback process.` },
        { p: `**Waiver of chargeback for scans rendered.** To the maximum extent permitted by applicable law and your card-network rules, and without limiting any non-waivable statutory right, you agree **not to file a chargeback or payment dispute for any scan for which a report was delivered to you**, unless you have first contacted us with a good-faith refund request under "Scan Did Not Complete" or "Billing Errors" above and we have declined or failed to respond within ten (10) business days. This waiver does not apply to unauthorised transactions, clear billing errors (duplicate charges, wrong amount), or any dispute reserved to you by law.` },
        { p: "**Defence of disputes.** Where a chargeback is filed, we will provide all relevant transaction evidence to your bank or the card network, including proof of account authentication, scan initiation, scan completion, report delivery, applicable terms accepted at purchase, and any correspondence with you." },
        { p: `**Consequences.** Filing a chargeback in breach of the waiver above may result in (a) immediate suspension of your account pending resolution; (b) termination of your account if the chargeback is determined to be illegitimate; (c) recovery of reasonable costs incurred by us in responding to the chargeback, including bank fees, card-network fees, and reasonable administrative costs; and (d) our refusal to accept future payments from the payment method used.` },
      ],
    },
    {
      id: "how-refunds-are-processed",
      heading: "How Refunds Are Processed",
      body: [
        { p: "When we issue a discretionary refund or correct a billing error under this policy, the refund is processed via Stripe to the original payment method. Refunds typically appear on your statement within 5-10 business days, depending on your bank. We will send email confirmation when a refund is initiated." },
      ],
    },
    {
      id: "contact",
      heading: "Contact",
      body: [
        { p: `For billing questions, support requests, or payment disputes: [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL})` },
      ],
    },
  ],
};
