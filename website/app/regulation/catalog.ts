/**
 * Regulation catalogue for /regulation/[slug] pages.
 *
 * Each entry maps a real-world compliance regime to the specific
 * technical findings GateTest can defensibly catch under it.
 *
 * Honesty rules (Bible Forbidden #1):
 *   - `fineRange` must be a publicly-cited maximum. Only ship one
 *     we can defend.
 *   - `topThreeModules` must be names that exist in modules-data.ts
 *     today. We do not ship aspirational coverage.
 *   - `outOfScopeForGateTest` always populated — every regulation
 *     has parts a code scanner CANNOT address (physical security,
 *     contracts, training, governance).
 *
 * Source citations:
 *   - GDPR fines: Art. 83(5) GDPR — https://gdpr-info.eu/art-83-gdpr/
 *   - HIPAA: 45 CFR §§ 160.404 / 164 Security Rule
 *   - SOC 2: AICPA Trust Services Criteria (TSP Section 100, 2017)
 *   - CCPA/CPRA: Cal. Civ. Code § 1798.155
 *   - PCI DSS v4.0: PCI SSC, effective 2024-03-31 (mandatory 2025-03)
 *   - ISO/IEC 27001:2022 — published 2022-10-25
 */

export interface Regulation {
  /** URL slug — lowercase, kebab. */
  slug: string;
  /** Short display name. */
  name: string;
  /** Full official title. */
  longName: string;
  /** Where the regime has force of law / contract. */
  jurisdiction: string;
  /** Official authority URL — .gov / standards-body / EU institution. */
  authoritativeUrl: string;
  /** Country slugs (sibling /for/<country> pages) where this regime is primary. */
  countriesAffected: string[];
  /** One-line factual claim about max penalty. Only ship if defensible. */
  fineRange: string;
  /** Year (or month/year) the regime became effective. */
  effectiveSince: string;
  /** 1-2 sentence elevator pitch for 2026 dev relevance. */
  whyDevsCareThisYear: string;
  /** 3 GateTest module names (camelCase, must exist in modules-data.ts). */
  topThreeModules: string[];
  /** 6-10 specific technical findings GateTest can defensibly catch. */
  catchableTechnicalFindings: string[];
  /** 3-5 honest items NOT in scope for a code scanner. */
  outOfScopeForGateTest: string[];
}

export const REGULATIONS: Regulation[] = [
  {
    slug: "gdpr",
    name: "GDPR",
    longName: "General Data Protection Regulation",
    jurisdiction: "European Union (plus UK GDPR mirror in the United Kingdom)",
    authoritativeUrl: "https://gdpr-info.eu/",
    countriesAffected: ["eu", "uk"],
    fineRange: "Up to €20 million or 4% of total worldwide annual turnover, whichever is higher (Art. 83(5) GDPR).",
    effectiveSince: "May 2018",
    whyDevsCareThisYear:
      "Regulators in 2025-26 have moved past warning letters — Meta, TikTok, and Amazon have each been fined nine figures. The fastest way to fail a GDPR review is logging request bodies that contain personal data, or hardcoding credentials in a public repo. Both are code-level findings, not policy ones.",
    topThreeModules: ["secrets", "logPii", "dataIntegrity"],
    catchableTechnicalFindings: [
      "Personal data (req.body, req.user, headers, cookies) logged in plaintext via console.log / logger.info — violates Art. 5(1)(f) integrity-and-confidentiality.",
      "Hardcoded database credentials or API keys in committed source — Art. 32 security-of-processing failure.",
      "Database migrations that drop columns containing personal data with no documented retention basis — Art. 5(1)(e) storage limitation.",
      "Missing TLS validation (rejectUnauthorized: false, verify=False) on calls that move personal data between services — Art. 32(1)(a).",
      "Cookies set without httpOnly / Secure / SameSite on endpoints handling identifiers — Art. 32 + ePrivacy Directive interaction.",
      "Stale credentials in repository older than 90 days (likely leaked via prior contributors) — Art. 32 risk-based-controls failure.",
      "PII included in error messages or stack traces returned to the client — Art. 5(1)(f).",
      "Wildcard CORS (Access-Control-Allow-Origin: *) with credentials: true on endpoints exposing user data — Art. 32.",
    ],
    outOfScopeForGateTest: [
      "Appointing a Data Protection Officer (Art. 37) — that is an organisational requirement.",
      "Drafting your Record of Processing Activities (Art. 30) — needs human review of business processes.",
      "Data Protection Impact Assessments (Art. 35) — requires risk reasoning a scanner cannot perform.",
      "Vendor / sub-processor contracts and Standard Contractual Clauses — legal documents, not code.",
      "Responding to Subject Access Requests within 30 days — operational, not code-level.",
    ],
  },
  {
    slug: "hipaa",
    name: "HIPAA",
    longName: "Health Insurance Portability and Accountability Act",
    jurisdiction: "United States — covered entities and business associates handling Protected Health Information (PHI)",
    authoritativeUrl: "https://www.hhs.gov/hipaa/index.html",
    countriesAffected: ["usa"],
    fineRange: "Civil penalties up to $2,067,813 per violation category per calendar year (45 CFR § 102.3, 2024 inflation adjustment).",
    effectiveSince: "Privacy Rule 2003, Security Rule 2005, HITECH amendments 2009",
    whyDevsCareThisYear:
      "OCR enforcement has shifted to telehealth and AI-powered clinical SaaS — the 2024-25 wave of breach reports points back to swallowed errors that hid PHI exposures and to plaintext TLS in service-to-service calls. Both are static-analysis findings.",
    topThreeModules: ["secrets", "tlsSecurity", "errorSwallow"],
    catchableTechnicalFindings: [
      "TLS validation disabled in production (rejectUnauthorized: false, NODE_TLS_REJECT_UNAUTHORIZED=0, Python verify=False) — 45 CFR § 164.312(e)(1) transmission security.",
      "Empty catch blocks on database / API paths that handle PHI — masks integrity-failure events required to be logged under 45 CFR § 164.312(b).",
      "Hardcoded credentials granting access to PHI stores — § 164.312(a)(1) access control.",
      "PHI / patient identifiers logged via console.log, logger.info, or JSON.stringify(user) — § 164.312(b) audit-controls misuse.",
      "Cookies on PHI-handling endpoints missing httpOnly / Secure — XSS becomes session takeover, § 164.312(a)(2)(i).",
      "Stale long-lived credentials in repo — § 164.308(a)(5)(ii)(D) password management.",
      "Outdated dependencies with known CVEs in PHI-touching services — § 164.308(a)(8) periodic technical evaluation.",
      "Missing CSP / X-Frame-Options on patient-facing endpoints — § 164.312(c)(1) integrity controls.",
    ],
    outOfScopeForGateTest: [
      "Business Associate Agreements (BAAs) — contractual.",
      "Risk Analysis under § 164.308(a)(1)(ii)(A) — methodological / human.",
      "Workforce training, sanction policies, and access authorisation procedures.",
      "Physical safeguards (facility access, workstation security, device disposal).",
      "Breach notification within 60 days — procedural, not code-level.",
    ],
  },
  {
    slug: "soc2",
    name: "SOC 2",
    longName: "SOC 2 Trust Services Criteria (Type I and Type II)",
    jurisdiction: "Global — voluntary attestation framework, but contractually required by most enterprise SaaS buyers.",
    authoritativeUrl: "https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2",
    countriesAffected: ["usa"],
    fineRange: "Not a statutory regime — no government fines. The cost of failure is loss of enterprise deals: a failed Type II almost always means a customer pulling the contract.",
    effectiveSince: "2010 (Trust Services Criteria revised 2017, refreshed 2022)",
    whyDevsCareThisYear:
      "By 2026 every Series B SaaS sale in North America requires a Type II report. The Type II window is 6-12 months of evidence, so the technical controls auditors sample (secret rotation, CI-pipeline hardening, supply-chain hygiene) need to be passing in your pipeline NOW.",
    topThreeModules: ["secretRotation", "ciSecurity", "dependencies"],
    catchableTechnicalFindings: [
      "Long-lived credentials never rotated in the last 90+ days — CC6.1 logical-access controls.",
      "CI workflow steps with continue-on-error: true on the security gate — CC7.1 change-management control bypass.",
      "Unpinned third-party GitHub Actions (actions/checkout@v4 instead of SHA) — CC6.6 supply-chain controls.",
      "Wildcard dependency pins (\"package\": \"*\" or \"latest\") in package.json / requirements.txt — CC6.6.",
      "Hardcoded secrets in committed source — CC6.1.",
      "Vulnerable dependency versions with public CVEs — CC7.1 vulnerability management.",
      "Missing .env.example documentation for runtime configuration — CC8.1 change-management evidence.",
      "Logging that captures credentials or tokens in plaintext — CC6.1 + CC7.2.",
      "Drift between declared .env.example and code's process.env reads — CC8.1 baseline-configuration evidence.",
    ],
    outOfScopeForGateTest: [
      "Defining and documenting your Trust Services Criteria scope.",
      "Vendor risk-management program (CC9.2) — that is a procurement workflow.",
      "Background checks on engineers (CC1.4) — HR control.",
      "Incident response runbooks and tabletop exercises (CC7.3, CC7.4).",
      "Auditor selection and the actual Type II engagement.",
    ],
  },
  {
    slug: "ccpa",
    name: "CCPA",
    longName: "California Consumer Privacy Act (amended by the CPRA)",
    jurisdiction: "California, USA — applies to qualifying businesses anywhere that handle California-resident data.",
    authoritativeUrl: "https://oag.ca.gov/privacy/ccpa",
    countriesAffected: ["usa"],
    fineRange: "Civil penalties up to $2,500 per unintentional violation and $7,500 per intentional violation or violation involving minors (Cal. Civ. Code § 1798.155).",
    effectiveSince: "January 2020 (CCPA); January 2023 (CPRA amendments + CPPA enforcement)",
    whyDevsCareThisYear:
      "The California Privacy Protection Agency reached full enforcement throughput in 2024-25. Their public sweeps focus on \"sale or sharing\" disclosures and on apps that log identifiers (email, IP, device-ID) into systems that haven't been documented to consumers. Both are visible in code.",
    topThreeModules: ["logPii", "secrets", "dataIntegrity"],
    catchableTechnicalFindings: [
      "Email / phone / device-ID logged in plaintext via console / logger / structlog — § 1798.100(c) reasonable security.",
      "Hardcoded credentials granting access to consumer data stores — § 1798.150 private right of action breach trigger.",
      "Database migrations that drop / rename PII columns without a documented deletion-request path — § 1798.105 right-to-delete.",
      "PII included in third-party analytics calls (Segment / Mixpanel / GA4) without a documented basis — \"selling/sharing\" disclosure trigger.",
      "Missing TLS validation on calls that move consumer data — § 1798.150 unencrypted-data carve-out.",
      "Wildcard CORS with credentials on consumer endpoints — § 1798.100(c).",
      "Cookies on consumer-facing endpoints set without httpOnly / Secure — XSS-to-session-takeover risk.",
      "Stale credentials older than 90 days in repos with consumer-data access — § 1798.100(c) reasonable security.",
    ],
    outOfScopeForGateTest: [
      "Publishing a CCPA-compliant privacy policy and the \"Do Not Sell or Share My Personal Information\" link.",
      "Implementing the verifiable consumer-request workflow.",
      "Service-provider contracts and the contractually-required CCPA clauses.",
      "Employee training on CCPA-rights handling.",
      "Annual cybersecurity audit and risk assessment requirements under CPRA regulations.",
    ],
  },
  {
    slug: "pci-dss",
    name: "PCI DSS",
    longName: "Payment Card Industry Data Security Standard (v4.0)",
    jurisdiction: "Global — any entity that stores, processes, or transmits cardholder data, enforced contractually by the card networks.",
    authoritativeUrl: "https://www.pcisecuritystandards.org/standards/pci-dss/",
    countriesAffected: ["usa", "uk", "eu", "australia", "new-zealand", "singapore", "canada"],
    fineRange: "Card networks (Visa, Mastercard) can levy fines of $5,000 to $100,000 per month on the merchant's acquirer for non-compliance, passed through contractually. Forensic investigation costs typically dwarf the fines.",
    effectiveSince: "v4.0 published March 2022, mandatory from 31 March 2024 (with newer requirements effective 31 March 2025)",
    whyDevsCareThisYear:
      "PCI DSS v4.0 became fully mandatory in March 2025. v4.0 specifically calls out client-side script integrity (Requirement 6.4.3), TLS configuration (Requirement 4.2), and credential storage (Requirement 8.3) — every one of those is a static finding before a QSA ever sees it.",
    topThreeModules: ["secrets", "tlsSecurity", "moneyFloat"],
    catchableTechnicalFindings: [
      "Hardcoded API keys or DB credentials in source touching cardholder data — Req. 8.3 + 3.4 storage of authentication data.",
      "TLS validation disabled (rejectUnauthorized: false, verify=False) on any path moving card data — Req. 4.2 strong cryptography in transit.",
      "Currency arithmetic in IEEE-754 floats on amount / total / charge variables — Req. 6.3.1 secure coding (integrity of payment values).",
      "PAN-shaped or CVV-shaped values logged via console / logger — Req. 3.3 prohibits storing CVV after authorisation; logs count.",
      "Outdated dependencies with known CVEs in card-handling services — Req. 6.3.3 patch management within 30 days for critical vulnerabilities.",
      "Cookies on payment endpoints set without httpOnly / Secure — Req. 6.4 + 8.3 session management.",
      "Missing CSP on payment pages — Req. 6.4.3 client-side script integrity (new in v4.0).",
      "Wildcard CORS with credentials on payment endpoints — Req. 6.2 secure system development.",
    ],
    outOfScopeForGateTest: [
      "Quarterly external ASV scans against your perimeter (Req. 11.3.2) — requires a PCI-approved scanning vendor.",
      "Network segmentation evidence (Req. 1) — needs network-level testing.",
      "Penetration testing (Req. 11.4) — human red-team work.",
      "Physical security of card-handling locations (Req. 9).",
      "Personnel security policies, security-awareness training, and incident-response plans (Req. 12).",
    ],
  },
  {
    slug: "iso27001",
    name: "ISO 27001",
    longName: "ISO/IEC 27001:2022 — Information security management systems",
    jurisdiction: "Global — voluntary certification, but contractually required by many international enterprise buyers and procurement frameworks.",
    authoritativeUrl: "https://www.iso.org/standard/27001",
    countriesAffected: [],
    fineRange: "Not a statutory regime — no fines. Cost of failure is loss of contracts that require certification (especially in EU public-sector and UK government procurement).",
    effectiveSince: "ISO/IEC 27001:2022 published 25 October 2022; transition from 2013 version closes 31 October 2025.",
    whyDevsCareThisYear:
      "By the end of 2025, every company on the 2013 standard has to be re-certified against 2022's Annex A — the new control set explicitly names threat intelligence (A.5.7), secure development (A.8.25-28), and configuration management (A.8.9). Code-level evidence is what auditors sample.",
    topThreeModules: ["secretRotation", "dependencies", "webHeaders"],
    catchableTechnicalFindings: [
      "Credentials in source older than 90 days — A.5.16 identity management / A.5.17 authentication information.",
      "Dependencies with known CVEs in production code — A.8.8 management of technical vulnerabilities.",
      "Missing CSP / HSTS / X-Frame-Options on user-facing services — A.8.23 web filtering / A.8.26 application security requirements.",
      "Wildcard CORS with credentials — A.8.26.",
      "Hardcoded secrets in committed source — A.5.17 authentication information.",
      "CI workflows with continue-on-error on the security gate — A.8.32 change management.",
      "Unpinned third-party GitHub Actions — A.5.21 information security in the supply chain.",
      ".env.example missing keys actually read by code — A.8.9 configuration management evidence.",
      "TLS validation disabled — A.8.24 cryptography.",
    ],
    outOfScopeForGateTest: [
      "Defining your Statement of Applicability (SoA) — methodological.",
      "Information Security Management System (ISMS) scope and governance documents.",
      "Internal audit programme and management review meetings (Cl. 9).",
      "Risk assessment / treatment methodology (Cl. 6.1) — needs human risk reasoning.",
      "Physical and environmental controls (A.7).",
    ],
  },
];

/** All slugs in catalog order. */
export function getAllRegulationSlugs(): string[] {
  return REGULATIONS.map((r) => r.slug);
}

/** Lookup by slug, null if unknown. */
export function getRegulationBySlug(slug: string): Regulation | null {
  return REGULATIONS.find((r) => r.slug === slug) || null;
}

/**
 * Module-name → URL slug (matches /modules/<slug> route). Mirrors the
 * algorithm in components/howitworks/module-slugs.ts so that links from
 * regulation pages resolve to the right module page.
 */
export function moduleNameToSlug(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
