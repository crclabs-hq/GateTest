import type { LegalDoc, LegalSection } from "../../components/legal/LegalDocument";
import { F, HOST, SITE, T, usd, UNSAFE, AI, AI_SECOND, PAY, GH, GL, mailto } from "./terms-facts";
import { SECTIONS_2 } from "./terms-content-2";
import { SECTIONS_3 } from "./terms-content-3";

const NAME = F.LEGAL_ENTITY;

const SECTIONS_1: LegalSection[] = [
  {
    id: "agreement-to-terms",
    heading: "Agreement to Terms",
    body: [
      { p: `These **Terms of Service** (**Terms**) are a binding agreement between you and ${NAME} (**${NAME}**, **we**, **us**, **our**). They govern your use of the website at [${HOST}](${SITE}), the hosted scanning service, the GateTest GitHub App and GitHub Action, the Gluecron integration, the hosted MCP endpoint, our APIs, and any related software and documentation (together, the **Service**).` },
      { p: `By creating an account, installing the GitHub App, connecting a Gluecron repository, starting a scan, buying a Plan, or otherwise using the Service, you agree to these Terms and to our [Privacy Policy](/legal/privacy), [Acceptable Use Policy](/legal/acceptable-use) and [Refund Policy](/legal/refunds), each of which forms part of these Terms. If you do not agree, do not use the Service.` },
      { p: `If you use the Service on behalf of a company or other organisation, you accept these Terms for that organisation and confirm you have authority to bind it. **You** and **your** then refer to that organisation and to every person it allows to use the Service through its account.` },
      { p: `**Please read [Dispute Resolution and Arbitration](#dispute-resolution-and-arbitration) carefully.** It requires most disputes to be resolved by individual arbitration rather than in court, waives class actions and jury trials where the law allows, and explains how to opt out within 30 days.` },
    ],
  },
  {
    id: "definitions",
    heading: "Definitions",
    body: [
      { p: "Capitalised terms have the meanings below, or the meaning given where they first appear in bold." },
      { list: [
        "**Account** — the record we hold for you, created when you sign in through a supported identity provider.",
        "**AI Features** — any part of the Service that sends content to a large-language-model provider: AI code review, finding explanations, auto-fix, pair-review, architecture annotation, Forensic diagnosis, and the AI tools of the MCP server.",
        "**Beta Features** — features labelled beta, preview, experimental, early access, or similar.",
        "**CLI** — the GateTest command-line tool and local MCP server distributed as open source under the MIT License.",
        "**Customer Content** — repositories, source code, configuration, live URLs, and any other material you submit to the Service or allow it to fetch, including changes it writes back to your repository at your request.",
        "**Findings** — the results a scan produces: the finding message, rule and module name, file path, line number, severity, and verdict.",
        "**Output** — Findings, reports, scores, badges, explanations, and code changes the Service generates for you.",
        "**Git Host** — a service that hosts your repositories and that the Service integrates with, currently GitHub and Gluecron.",
        "**Plan** — a one-time scan tier or a monthly subscription listed in [Plans, Fees and Billing](#plans-fees-and-billing).",
        "**Fees** — the amounts payable for a Plan, as displayed at checkout.",
        `**Report** — the Output a scan delivers through the website, e-mail, a pull-request comment, a commit status, or an API response.`,
      ] },
    ],
  },
  {
    id: "eligibility-and-accounts",
    heading: "Eligibility and Accounts",
    body: [
      { p: "You must be at least 18 years old, or the age of legal majority where you live if that is higher, and able to form a binding contract. You must not be a person or entity barred from using the Service under [Export Controls and Sanctions](#export-controls-and-sanctions)." },
      { p: `You sign in through a supported identity provider rather than a password we hold. Signed-in sessions last up to ${F.SESSION_DAYS} days. You are responsible for everything done through your Account, for keeping your session, tokens and API keys confidential, and for the people you allow to use the Service. Tell us at ${mailto()} as soon as you become aware of unauthorised use.` },
      { p: "Keep the information on your Account accurate. We may rely on the e-mail address associated with your Account for notices, receipts, API keys, and security messages." },
      { p: "Automated or scripted account creation, sharing one Account across unrelated organisations, and circumventing Plan limits are not permitted." },
    ],
  },
  {
    id: "the-service",
    heading: "The Service",
    body: [
      { h3: "Hosted scans" },
      { p: "You give us a repository URL or connect a Git Host, and we fetch the repository into memory and a temporary workspace on our servers for the duration of the scan, run the scan engine and any AI Features your Plan includes, deliver the Report, and delete the working copy." },
      { p: `**We do not execute your code.** Modules that would run customer-controlled code (${UNSAFE}) are skipped on our infrastructure. They run only where you choose to run them: in your own CI through the GitHub Action, or on your own machine through the CLI.` },
      { h3: "Open-source CLI" },
      { p: `The CLI is free and licensed under the MIT License. It runs on your machine, with your own credentials and AI keys, and nothing in these Terms narrows the rights the MIT License gives you in that software. These Terms still govern any hosted part of the Service the CLI calls, such as a hosted scan or the telemetry endpoint. The CLI sends anonymised telemetry (module names and counts, never code, file paths or Findings); opt out with the \`${F.TELEMETRY_OPT_OUT_ENV}\` environment variable or \`${F.TELEMETRY_OPT_OUT_CONFIG}\` in \`.gatetest.json\`.` },
      { h3: "GitHub App and GitHub Action" },
      { p: "The GitHub App receives push and pull-request events, reads repository contents to scan them, and writes commit statuses and pull-request comments. On Plans that include auto-fix it pushes a branch and opens a pull request; it never merges. The permissions it requests are shown by GitHub when you install it, and uninstalling it ends our access. The GitHub Action runs inside your own CI runner under your control and can run the modules the hosted engine skips." },
      { h3: "Gluecron" },
      { p: "When you connect a Gluecron repository, Gluecron sends us push events, we read the repository to scan it, and we write the verdict and Findings back to Gluecron. Disconnecting the repository on Gluecron ends our access." },
      { h3: "MCP server" },
      { p: `The local MCP server ships with the CLI, is free, and runs entirely on your machine. The **${T.mcp.name}** Plan adds a hosted MCP endpoint and hosted scan history, accessed with an API key we e-mail you after checkout. Keep that key confidential; anything done with it is done on your Account.` },
      { h3: "Changes to the Service" },
      { p: "We improve the Service continuously and may add, change, or remove features, modules, rules, models, and limits. Where a change materially removes a capability you are paying for, we will give reasonable notice by e-mail or on the website where practicable. If we discontinue a subscription Plan, we will refund any prepaid Fees for the period after discontinuation." },
    ],
  },
  {
    id: "plans-fees-and-billing",
    heading: "Plans, Fees and Billing",
    body: [
      { p: "The Plans and their prices at the effective date of these Terms are set out below. Prices are in US dollars and exclude taxes. The price shown at checkout is the price for that purchase." },
      { table: {
        headers: ["Plan", "Price", "Billing"],
        rows: [
          [`**${T.quick.name}**`, usd(T.quick.priceInCents), "One-time, charged in full at checkout"],
          [`**${T.full.name}**`, usd(T.full.priceInCents), "One-time, charged in full at checkout"],
          [`**${T.fix.name}**`, usd(T.fix.priceInCents), "One-time, charged in full at checkout"],
          [`**${T.forensic.name}**`, usd(T.forensic.priceInCents), "One-time, charged in full at checkout"],
          [`**${T.continuous.name}**`, `${usd(T.continuous.priceInCents)} per month`, "Monthly subscription covering every repository under one Git Host owner or organisation; renews until cancelled"],
          [`**${T.mcp.name}**`, `${usd(T.mcp.priceInCents)} per month`, "Monthly subscription; renews until cancelled"],
          ["**Enterprise**", "By agreement", `Negotiated per customer; contact ${mailto("Enterprise")}`],
        ],
      } },
      { h3: "Payment" },
      { p: `Payments are processed by ${PAY.entity} through a checkout page ${PAY.name} hosts. Your card details are entered on ${PAY.name}'s pages and never touch our servers; we receive a payment identifier, your e-mail address, the Plan, and the repository the purchase is for. By paying you confirm you are authorised to use the payment method. We accept the payment methods ${PAY.name} offers at checkout.` },
      { h3: "One-time Plans and delivery" },
      { p: "One-time Plans are charged in full at checkout. The Service is **delivered** when the scan completes and a Report is made available to you. Delivery means the purchased modules ran and produced Output. It does not mean the scan found any particular number of issues, found every issue, that every Finding is correct, or that your code is free of defects. The Report is the service; its contents are not a warranty." },
      { h3: "Subscriptions" },
      { p: `The ${T.continuous.name} and ${T.mcp.name} Plans are billed monthly in advance and renew automatically each month until you cancel. Cancel at any time through the [billing portal](/billing); cancellation takes effect at the end of the current billing period and you keep access until then. The ${T.continuous.name} Plan includes a monthly allowance of AI review; deterministic scans are not metered. Fix pull requests are not part of the ${T.continuous.name} Plan and are bought as one-time Plans.` },
      { h3: "Taxes" },
      { p: "Fees exclude GST, VAT, sales tax, withholding tax and similar charges. Where we are required to collect a tax, it is added at checkout. Where you are required to withhold, you pay us the amount that leaves us with the full Fee." },
      { h3: "Price changes" },
      { p: "We may change Fees. For subscriptions we will give at least 30 days' notice by e-mail before a new price applies to your next renewal; if you do not want to pay the new price, cancel before it takes effect. One-time Plans are always charged at the price displayed when you buy." },
      { h3: "Failed payments and chargebacks" },
      { p: `If a subscription payment fails we may retry it and will notify you. While it remains unpaid we may suspend the Plan, including scanning on push. We do not delete your Findings for non-payment alone. If you believe a charge is wrong, contact ${mailto("Billing")} before disputing it with your card issuer; a chargeback on a delivered scan may lead to suspension under [Suspension and Termination](#suspension-and-termination).` },
      { h3: "Refunds" },
      { p: "Refunds are governed by our [Refund Policy](/legal/refunds), which forms part of these Terms and does not limit any right you have under law that cannot be excluded." },
    ],
  },
  {
    id: "your-content-and-repositories",
    heading: "Your Content and Repositories",
    body: [
      { p: "**You own your Customer Content.** These Terms do not transfer any right in it to us. You grant us a limited, non-exclusive, worldwide, royalty-free licence to fetch, store temporarily, copy, analyse, transmit to the sub-processors listed in our [Sub-processors](/legal/sub-processors) page, and display Customer Content solely to provide, secure, support, and improve the Service for you as described in these Terms and the [Privacy Policy](/legal/privacy). The licence ends when the scan finishes, except for the Findings we keep." },
      { p: `**What we keep.** Source code is not retained after a scan: the working copy is deleted when the scan finishes. Findings (message, module, file path, line number, severity) are retained so that you can see scan history, trends and badges, until you ask us to delete them by e-mail to ${mailto("Deletion request")}. There is no automatic purge. Where an AI Feature ran, the file contents it reviewed were also sent to ${AI.entity}, subject to that provider's ${F.AI_PROVIDER_RETENTION_DAYS}-day retention; see [AI Features](#ai-features).` },
      { p: "**Authority.** You represent and warrant that for every repository, URL, or other content you submit: you own it or have permission from its owner to have it scanned and, on Plans that include auto-fix, to have branches and pull requests written to it; scanning it does not breach any law, agreement, or third-party right; and it does not contain material designed to attack, probe, or exfiltrate data from the Service, its providers, or other customers. Scanning code you are not authorised to scan is a breach of these Terms and of the [Acceptable Use Policy](/legal/acceptable-use)." },
      { p: "**What you merge is yours.** Code changes we propose become part of your repository only when you merge them. You are responsible for reviewing, testing, and approving every change before it reaches your codebase." },
      { p: "We do not review Customer Content manually except to provide support you ask for, to investigate a suspected breach of these Terms, or where the law requires. We may refuse or stop a scan that we reasonably believe breaches these Terms." },
    ],
  },
  {
    id: "our-intellectual-property",
    heading: "Our Intellectual Property",
    body: [
      { p: `The Service — including the scan engine, modules, rules, detection logic, prompts, models and model configuration, report formats, website, documentation, and the GateTest name and logos — is owned by ${NAME} and its licensors and is protected by intellectual-property law. Subject to these Terms we grant you a limited, non-exclusive, non-transferable, revocable right to use the Service for your internal business or personal purposes during the term. No other right is granted, by implication or otherwise.` },
      { p: "**Output is yours to use.** We claim no ownership of Output. To the extent we hold any right in code changes generated for your repository, we assign it to you when the Output is delivered. You may use Reports and Findings for any lawful purpose, including sharing them inside your organisation and with your advisers. You may not offer Reports to third parties as a scanning or auditing service of your own." },
      { p: "You may not copy, modify, or create derivative works of the hosted Service; reverse-engineer, decompile, or otherwise attempt to extract its rules, prompts, or source, except to the extent a law that cannot be excluded allows it; remove any proprietary notice; or use the Service to build or train a competing product. None of this restricts your rights in the CLI under the MIT License." },
      { p: "We may use aggregated, de-identified data about how the Service is used, including which modules fire and how often, to operate and improve the Service. That data never contains your code, file paths, or Findings." },
    ],
  },
  {
    id: "acceptable-use",
    heading: "Acceptable Use",
    body: [
      { p: "The full rules are in the [Acceptable Use Policy](/legal/acceptable-use), which forms part of these Terms. In summary, you must not:" },
      { list: [
        "scan repositories, sites, or systems you are not authorised to scan, or use Findings to exploit vulnerabilities in anyone's systems;",
        "submit content designed to compromise, probe, overload, or exfiltrate data from the Service, its providers, or other customers;",
        "probe, stress-test, or penetration-test the Service itself without our prior written permission;",
        "bypass authentication, rate limits, billing, or Plan limits, or share API keys outside your organisation;",
        "scrape, crawl, or bulk-download the website, API, or Output beyond documented use;",
        "resell, sublicense, or white-label the Service or its Output;",
        "use the Service to break any law, including export-control, sanctions, privacy, and intellectual-property law.",
      ] },
      { p: "We may investigate suspected breaches, suspend access while we do, remove content, and cooperate with lawful requests from authorities." },
    ],
  },
  {
    id: "third-party-services",
    heading: "Third-party Services",
    body: [
      { p: `The Service depends on services we do not control: Git Hosts (${GH.name}, ${GL.name}), our payment processor (${PAY.name}), and our AI providers (${AI.name}; ${AI_SECOND.name} only when you opt in to a second opinion on a ${T.forensic.name} scan). Your use of each is governed by that provider's own terms and privacy policy, and by the permissions you grant it. The GitHub App's permissions are set and shown by GitHub, not by us.` },
      { p: `We are not responsible for third-party services, for their availability, or for what they do with data you give them directly. If a third-party service fails or changes in a way that affects the Service, we will use reasonable efforts to work around it, but that failure is outside our control for the purposes of [Force Majeure](#force-majeure). The complete list of providers that process your data, and what each receives, is on our [Sub-processors](/legal/sub-processors) page.` },
      { p: `Links from the website at ${HOST} to other sites are provided for convenience; we do not endorse or take responsibility for them.` },
    ],
  },
];

export const DOC: LegalDoc = {
  title: "Terms of Service",
  intro: `These Terms explain what you can expect from ${NAME} and what we ask of you when you use the GateTest scanning service, CLI, GitHub App, Gluecron integration, and MCP server. Questions: ${mailto()}.`,
  effective: F.EFFECTIVE_DATE,
  sections: [...SECTIONS_1, ...SECTIONS_2, ...SECTIONS_3],
};
