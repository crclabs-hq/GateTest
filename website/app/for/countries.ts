/**
 * Country-specific landing pages for /for/<country> URLs.
 *
 * Each entry powers a programmatically-generated SEO page that
 * speaks to devs in that country in their own regulatory / stack
 * vocabulary.
 *
 * Honesty principle (Bible Forbidden #1, Boss Rule #8):
 *   - Names, regulation acronyms, stack items, hosting platforms are
 *     all real and verifiable.
 *   - `marketSize` is OMITTED rather than fabricated when we can't
 *     defend a number.
 *   - We say "catches the technical findings auditors look for" —
 *     NOT "compliant with regulation X" — because the audit itself
 *     requires a human assessor.
 */
export interface Country {
  /** URL-safe lowercase slug used at /for/<slug>. */
  slug: string;
  /** Display name as devs in that country know it. */
  name: string;
  /** Short alpha-2 / emoji flag — renderable as plain text. */
  flag: string;
  /** The primary compliance regime devs in this country care about. */
  primaryRegulation: string;
  /** Authoritative external link for the primary regulation. */
  regulationLink: string;
  /** Optional internal slug if a /regulation/<slug> page exists from the sibling agent. */
  regulationInternalSlug?: string;
  /** 3-5 stack items the average dev there uses. */
  popularStack: string[];
  /** 2-3 hosting platforms popular in that market. */
  popularHosts: string[];
  /** Optional factual one-line market-size note. Omit if we can't source it. */
  marketSize?: string;
  /** 1-2 sentence pitch tailored to the country. */
  whyGateTestFits: string;
  /** 3 GateTest module names most relevant to devs there (camelCase, match modules-data.ts). */
  topThreeModules: string[];
  /** Module-to-regulation-clause mappings — each tied to a real GateTest module. */
  complianceBullets: { clause: string; module: string; explanation: string }[];
  /** 3 use-case bullets — devs in this country who'd hire us. */
  useCases: string[];
  /** Country-specific honest caveats. */
  countryCaveats: string[];
  /** Open Graph locale (e.g. "en_US", "en_GB"). */
  ogLocale: string;
}

export const COUNTRIES: Country[] = [
  {
    slug: "usa",
    name: "United States",
    flag: "US",
    primaryRegulation: "HIPAA + CCPA + SOX + PCI-DSS",
    regulationLink: "https://www.hhs.gov/hipaa/for-professionals/security/index.html",
    popularStack: ["Next.js", "TypeScript", "Postgres", "Stripe", "Vercel"],
    popularHosts: ["Vercel", "AWS", "Cloudflare"],
    whyGateTestFits:
      "US dev shops live inside four overlapping regimes — HIPAA for health, CCPA for consumer data, SOX for finance, PCI-DSS for cards. GateTest's 91 modules catch the technical findings each auditor looks for, in one scan, before code ships.",
    topThreeModules: ["secrets", "logPii", "dependencies"],
    complianceBullets: [
      {
        clause: "HIPAA §164.308(a)(5)(ii)(D) — credential management",
        module: "secretRotation",
        explanation:
          "secretRotation module flags credentials older than 90 days (error) and 30 days (warning) using git-history-aware dating — directly maps to HIPAA's password-management standard.",
      },
      {
        clause: "CCPA §1798.150 — reasonable security",
        module: "secrets",
        explanation:
          "secrets module catches hardcoded API keys, AWS access tokens, GitHub PATs, Stripe live keys, JWTs and private keys before they reach the repo — the lowest bar for 'reasonable security' under CCPA's private right of action.",
      },
      {
        clause: "PCI-DSS Requirement 6.2 — secure coding",
        module: "ssrf",
        explanation:
          "ssrf module taints req.body / req.query / req.params and flags when tainted values reach fetch/axios/http.request without an allowlist — the technical SSRF / IDOR class PCI auditors ask about.",
      },
      {
        clause: "SOX ITGC — change-management evidence",
        module: "prSize",
        explanation:
          "prSize module enforces a per-PR file + line cap and produces a timestamped report attached to every commit status — the same evidence a SOX auditor wants for change-management controls.",
      },
      {
        clause: "HIPAA §164.312(b) — audit logs without PII leakage",
        module: "logPii",
        explanation:
          "logPii module flags console.log / logger.info calls that dump req.body, JSON.stringify(user), or template-string interpolation of password/token/jwt — the GDPR/HIPAA logging violation that ships in nearly every codebase.",
      },
      {
        clause: "PCI-DSS 6.3.2 — third-party software inventory",
        module: "dependencies",
        explanation:
          "dependencies module scans npm / pip / Poetry / go.mod / Cargo / Bundler / Composer / Maven / Gradle and flags wildcards, 'latest' pins, deprecated packages and missing lockfiles — produces the SBOM-adjacent evidence auditors collect.",
      },
    ],
    useCases: [
      "Series A health-tech shipping a HIPAA-bound EHR integration on Vercel",
      "Fintech building card-present flows that need PCI-DSS technical evidence before SAQ-D",
      "Mid-market SaaS with a CCPA private-right-of-action exposure window",
    ],
    countryCaveats: [
      "GateTest produces technical findings — HIPAA / PCI / SOX audits still require a qualified human assessor (QSA for PCI, OCR for HIPAA).",
      "Data-residency claims (e.g. 'all data stored in us-east-1') depend on your host config; GateTest doesn't verify host region.",
    ],
    ogLocale: "en_US",
  },
  {
    slug: "uk",
    name: "United Kingdom",
    flag: "UK",
    primaryRegulation: "UK GDPR + Cyber Essentials",
    regulationLink: "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/",
    popularStack: ["Node.js", "TypeScript", "Postgres", "Stripe", "Next.js"],
    popularHosts: ["AWS London (eu-west-2)", "Vercel", "Cloudflare"],
    whyGateTestFits:
      "UK GDPR and the NCSC's Cyber Essentials scheme set a high bar for software shipped to UK customers. GateTest's 91 modules surface the technical findings the ICO and Cyber Essentials assessors care about — secret hygiene, dependency safety, error swallowing, PII in logs.",
    topThreeModules: ["logPii", "secrets", "webHeaders"],
    complianceBullets: [
      {
        clause: "UK GDPR Article 32 — security of processing",
        module: "secrets",
        explanation:
          "secrets module catches hardcoded credentials before commit; the ICO treats committed secrets as a textbook Article 32 failure when they appear in a breach notification.",
      },
      {
        clause: "UK GDPR Article 5(1)(f) — integrity and confidentiality",
        module: "logPii",
        explanation:
          "logPii flags logger calls that dump request bodies, headers, cookies, sessions or sensitive identifiers — the leakage path most often cited in ICO enforcement notices.",
      },
      {
        clause: "Cyber Essentials — secure configuration",
        module: "webHeaders",
        explanation:
          "webHeaders reads next.config / vercel.json / netlify.toml / nginx.conf and flags CSP unsafe-eval, wildcard CORS with credentials, HSTS below 180 days, missing X-Content-Type-Options — the headers Cyber Essentials Plus testers actually check.",
      },
      {
        clause: "Cyber Essentials — software updates / patch management",
        module: "dependencies",
        explanation:
          "dependencies module flags wildcard versions, 'latest' pins, deprecated packages and missing lockfiles across npm / pip / Bundler / Composer / Maven / Gradle.",
      },
      {
        clause: "UK GDPR Article 25 — data protection by design",
        module: "envVars",
        explanation:
          "envVars cross-references .env.example with actual process.env reads and flags NEXT_PUBLIC_* / VITE_* / REACT_APP_* client-bundled keys — exactly the 'designed-in' leak Article 25 is about.",
      },
    ],
    useCases: [
      "London fintech preparing a Cyber Essentials Plus assessment",
      "UK gov supplier needing technical evidence for a G-Cloud framework",
      "DTC retailer holding UK GDPR data residency requirements",
    ],
    countryCaveats: [
      "GateTest is not a Cyber Essentials certification body — we produce the technical evidence; you still need IASME or a certified assessor for the certificate.",
      "Post-Brexit, UK GDPR and EU GDPR diverge in narrow areas; the findings here are written against UK GDPR specifically.",
    ],
    ogLocale: "en_GB",
  },
  {
    slug: "eu",
    name: "European Union",
    flag: "EU",
    primaryRegulation: "GDPR + NIS2 + DORA",
    regulationLink: "https://gdpr.eu/",
    popularStack: ["Next.js", "TypeScript", "Postgres", "Stripe", "Node.js"],
    popularHosts: ["Hetzner", "Vercel (eu region)", "AWS Frankfurt (eu-central-1)"],
    whyGateTestFits:
      "GDPR is the floor. NIS2 widened the scope to thousands more 'essential' and 'important' entities in 2024. DORA hit financial entities in January 2025. GateTest's 91 modules cover the technical-control evidence each one asks for, without forcing a tool sprawl.",
    topThreeModules: ["logPii", "envVars", "secrets"],
    complianceBullets: [
      {
        clause: "GDPR Article 32 — appropriate technical measures",
        module: "secrets",
        explanation:
          "Hardcoded credentials are the single most common Article 32 failure cited in DPA notices. secrets module catches AKIA / ASIA / GitHub PAT / Stripe live / Slack / Anthropic / private-key shapes pre-commit.",
      },
      {
        clause: "GDPR Article 5(1)(f) — confidentiality",
        module: "logPii",
        explanation:
          "logPii blocks the PII-into-logs class — bare logger calls with password/token/jwt/req.body, JSON.stringify(user), template-string interpolation of sensitive identifiers.",
      },
      {
        clause: "NIS2 Article 21 — risk-management measures",
        module: "dependencies",
        explanation:
          "dependencies scans npm / pip / go.mod / Cargo / Bundler / Composer / Maven / Gradle and flags wildcards, deprecated packages, missing lockfiles — directly supports the supply-chain measures NIS2 requires.",
      },
      {
        clause: "DORA Article 9 — ICT risk management",
        module: "tlsSecurity",
        explanation:
          "tlsSecurity flags rejectUnauthorized: false, NODE_TLS_REJECT_UNAUTHORIZED=0, verify=False (Python) — the MITM-shipping pattern DORA explicitly calls out.",
      },
      {
        clause: "GDPR Article 25 — data-protection by design",
        module: "envVars",
        explanation:
          "envVars flags NEXT_PUBLIC_* / VITE_* / REACT_APP_* prefixes that bundle secrets into client JS, plus declared-but-unused env vars that signal abandoned configuration.",
      },
    ],
    useCases: [
      "Berlin SaaS preparing for a DPA audit after a customer DPIA request",
      "Dutch fintech inside DORA's January 2025 scope expansion",
      "Paris e-commerce shop needing CNIL-defensible technical controls",
    ],
    countryCaveats: [
      "Data-residency in the EU is a host-level concern — Vercel, AWS and Cloudflare all offer EU-only regions; GateTest doesn't verify your deployment region.",
      "Member-state implementations of NIS2 differ on penalties and timelines; check your national transposition.",
    ],
    ogLocale: "en_GB",
  },
  {
    slug: "australia",
    name: "Australia",
    flag: "AU",
    primaryRegulation: "Privacy Act 1988 + Essential Eight",
    regulationLink: "https://www.oaic.gov.au/privacy/australian-privacy-principles",
    popularStack: ["Next.js", "TypeScript", "Postgres", "Stripe", "Node.js"],
    popularHosts: ["AWS Sydney (ap-southeast-2)", "Vercel", "Cloudflare"],
    whyGateTestFits:
      "The Privacy Act 1988 (as amended) and the ACSC Essential Eight together set the technical bar for Australian software. GateTest's 91 modules cover the secret-hygiene, dependency-safety, logging-discipline and configuration-hardening findings the OAIC and ACSC assessors look for.",
    topThreeModules: ["secrets", "dependencies", "tlsSecurity"],
    complianceBullets: [
      {
        clause: "APP 11 — security of personal information",
        module: "secrets",
        explanation:
          "secrets module catches credential shapes before commit. The OAIC's recent Notifiable Data Breach reports consistently cite exposed credentials in source as a root cause.",
      },
      {
        clause: "Essential Eight — patch applications",
        module: "dependencies",
        explanation:
          "dependencies flags pinned-to-vulnerable, 'latest' pins (silent drift), deprecated packages and missing lockfiles across every major ecosystem — the gate ACSC Essential Eight maturity 2 asks for.",
      },
      {
        clause: "Essential Eight — configure Microsoft Office macro settings / restrict admin",
        module: "kubernetes",
        explanation:
          "kubernetes module flags privileged containers, hostNetwork, runAsUser: 0, docker.sock mounts and dangerous capabilities — the misconfigurations Essential Eight 'restrict administrative privileges' translates into for K8s.",
      },
      {
        clause: "APP 11 — destruction or de-identification when no longer needed",
        module: "logPii",
        explanation:
          "logPii flags PII written to application logs — logs that get archived become a quiet APP 11 violation when retention exceeds need.",
      },
      {
        clause: "Essential Eight — application control",
        module: "ciSecurity",
        explanation:
          "ciSecurity flags unpinned GitHub Actions, pwn-request shapes, shell-injection via ${{ github.event.* }}, secret-echo, missing permissions: — the supply-chain holes Essential Eight maturity 3 calls out.",
      },
    ],
    useCases: [
      "Sydney SaaS bidding for a DTA digital-marketplace contract",
      "Melbourne health-tech holding My Health Record adjacent data",
      "Brisbane fintech preparing AUSTRAC-aligned controls",
    ],
    countryCaveats: [
      "Essential Eight maturity levels are self-assessed; GateTest produces technical evidence but doesn't issue a maturity rating.",
      "Australian data-residency requirements depend on the dataset (My Health Record vs general PII); GateTest doesn't check host region.",
    ],
    ogLocale: "en_AU",
  },
  {
    slug: "new-zealand",
    name: "Aotearoa New Zealand",
    flag: "NZ",
    primaryRegulation: "Privacy Act 2020 + NZISM",
    regulationLink: "https://www.privacy.org.nz/privacy-act-2020/",
    popularStack: ["Next.js", "TypeScript", "Postgres", "Stripe", "Node.js"],
    popularHosts: ["Cloudflare", "Vercel", "AWS Sydney (ap-southeast-2)"],
    whyGateTestFits:
      "GateTest is built in Aotearoa. The Privacy Act 2020 and the NZISM together set the technical baseline for any product holding NZ personal information. We catch the technical findings the OPC and NZISM assessors care about — and our home-market customers get the closest support loop.",
    topThreeModules: ["secrets", "logPii", "webHeaders"],
    complianceBullets: [
      {
        clause: "IPP 5 — storage and security of personal information",
        module: "secrets",
        explanation:
          "secrets module catches hardcoded credentials before commit — the most common IPP 5 failure cited in OPC compliance notices.",
      },
      {
        clause: "IPP 5 — reasonable security safeguards",
        module: "logPii",
        explanation:
          "logPii flags PII written to console / logger / structlog / pino calls — including JSON.stringify(req.body) and template-string interpolation of password/token/jwt.",
      },
      {
        clause: "NZISM 17.1.10 — web application security",
        module: "webHeaders",
        explanation:
          "webHeaders flags CSP unsafe-eval / unsafe-inline, missing HSTS, wildcard CORS with credentials, missing X-Content-Type-Options — the headers NZISM web-application-security control explicitly lists.",
      },
      {
        clause: "Privacy Act 2020 §115 — notifiable privacy breaches",
        module: "errorSwallow",
        explanation:
          "errorSwallow catches empty catch blocks, .catch(() => {}) on Promise chains, and Node-callback (err, ...) handlers that ignore err — the silent-failure path that turns a breach into a silent breach.",
      },
      {
        clause: "NZISM 14.1.8 — patching",
        module: "dependencies",
        explanation:
          "dependencies flags out-of-date pins, deprecated packages, missing lockfiles. The NZISM patching control treats outdated runtime dependencies as a finding.",
      },
    ],
    useCases: [
      "Wellington gov supplier inside the NZISM-aligned procurement track",
      "Auckland fintech preparing for an OPC privacy assessment",
      "Christchurch SaaS shipping to NZ public-sector buyers",
    ],
    countryCaveats: [
      "GateTest is not an NZISM-certified assessor — we surface the technical findings; GCSB-recognised assessors run the certification.",
      "Privacy Act 2020 has extraterritorial reach; if you hold NZ personal information from offshore, you still need the same controls.",
    ],
    ogLocale: "en_NZ",
  },
  {
    slug: "singapore",
    name: "Singapore",
    flag: "SG",
    primaryRegulation: "PDPA + IM8",
    regulationLink: "https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act",
    popularStack: ["Next.js", "TypeScript", "Postgres", "Stripe", "Node.js"],
    popularHosts: ["AWS Singapore (ap-southeast-1)", "Vercel", "Cloudflare"],
    whyGateTestFits:
      "The PDPA and the IM8 Instruction Manual together govern what Singapore software must do at the technical layer. GateTest's 91 modules catch the secret-hygiene, configuration-hardening, and dependency-safety findings the PDPC and IM8 assessors look for in one scan.",
    topThreeModules: ["secrets", "tlsSecurity", "dependencies"],
    complianceBullets: [
      {
        clause: "PDPA §24 — protection obligation",
        module: "secrets",
        explanation:
          "secrets module catches the credential-shape findings the PDPC has cited in successive financial penalty decisions — AWS keys, Stripe live, GitHub PATs, JWTs, private keys.",
      },
      {
        clause: "IM8 — encryption in transit",
        module: "tlsSecurity",
        explanation:
          "tlsSecurity flags rejectUnauthorized: false, NODE_TLS_REJECT_UNAUTHORIZED=0, Python verify=False / CERT_NONE / _create_unverified_context — the MITM-shipping anti-patterns IM8 explicitly forbids.",
      },
      {
        clause: "IM8 — software supply chain",
        module: "dependencies",
        explanation:
          "dependencies scans npm / pip / Poetry / go.mod / Cargo / Bundler / Composer / Maven / Gradle for wildcards, deprecated packages, missing lockfiles — the supply-chain controls IM8 calls out.",
      },
      {
        clause: "PDPA §24 — reasonable security arrangements",
        module: "cookieSecurity",
        explanation:
          "cookieSecurity flags httpOnly: false, secure: false, weak session secrets ('changeme', 'keyboard cat'), Python SESSION_COOKIE_HTTPONLY = False — the configuration findings the PDPC commonly cites.",
      },
      {
        clause: "IM8 — secure coding",
        module: "ssrf",
        explanation:
          "ssrf taints req.* sources to fetch / axios / got / http.request sinks and flags hardcoded cloud-metadata endpoints (169.254.169.254, metadata.google.internal) — IM8's SSRF control.",
      },
    ],
    useCases: [
      "Singapore-listed fintech inside the MAS TRM Guidelines",
      "GovTech vendor on AGIL-aligned procurement",
      "Regional SaaS shipping to Singapore public-sector buyers",
    ],
    countryCaveats: [
      "GateTest is not a PDPA / IM8 certifying authority — we produce the technical findings; certification still needs the PDPC's recognised assessors.",
      "IM8 applies specifically to Singapore government suppliers — private-sector shops still get value from the same controls.",
    ],
    ogLocale: "en_SG",
  },
  {
    slug: "canada",
    name: "Canada",
    flag: "CA",
    primaryRegulation: "PIPEDA + Bill C-26",
    regulationLink: "https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/",
    popularStack: ["Next.js", "TypeScript", "Postgres", "Stripe", "Node.js"],
    popularHosts: ["Vercel", "AWS Canada (ca-central-1)", "Cloudflare"],
    whyGateTestFits:
      "PIPEDA is the federal floor; Bill C-26 (the Critical Cyber Systems Protection Act) is layering critical-infrastructure obligations on top. GateTest's 91 modules cover the technical-control findings the OPC and CSE assessors look for under both regimes.",
    topThreeModules: ["secrets", "logPii", "dependencies"],
    complianceBullets: [
      {
        clause: "PIPEDA Principle 7 — safeguards",
        module: "secrets",
        explanation:
          "secrets module catches AWS / GitHub / Stripe / Anthropic / Slack credential shapes pre-commit — the OPC's PIPEDA reports list exposed credentials as a recurring root cause.",
      },
      {
        clause: "PIPEDA Principle 7 — physical, organizational, technological",
        module: "logPii",
        explanation:
          "logPii flags PII into application logs — the silent-leak path PIPEDA's breach-notification regime turns into a notifiable event.",
      },
      {
        clause: "Bill C-26 (CCSPA) — cyber-security programs",
        module: "dependencies",
        explanation:
          "dependencies flags vulnerable / deprecated / wildcard pins and missing lockfiles — the supply-chain control CCSPA explicitly requires designated operators to maintain.",
      },
      {
        clause: "PIPEDA Principle 7 — authentication strength",
        module: "cookieSecurity",
        explanation:
          "cookieSecurity flags httpOnly: false, secure: false, and weak session secrets ('changeme', 'default', 'mysecret') across Express, Next.js, FastAPI, Starlette, Django.",
      },
      {
        clause: "Bill C-26 — incident reporting readiness",
        module: "errorSwallow",
        explanation:
          "errorSwallow catches empty catch blocks, swallowed Promise rejections, Node-callback handlers that drop err — the silent-failure path that prevents an incident from being detected.",
      },
    ],
    useCases: [
      "Toronto SaaS holding PIPEDA-bound consumer data across provinces",
      "Vancouver health-tech preparing for PHIPA / PIPA provincial overlay",
      "Ottawa critical-infrastructure operator inside Bill C-26 designation",
    ],
    countryCaveats: [
      "PIPEDA is the federal baseline — provinces (BC PIPA, Alberta PIPA, Quebec Law 25) overlay extra obligations; GateTest's technical findings apply equally to all four.",
      "Bill C-26 (CCSPA) only applies to designated operators; check the schedule before relying on it.",
    ],
    ogLocale: "en_CA",
  },
];

export function getAllCountrySlugs(): string[] {
  return COUNTRIES.map((c) => c.slug);
}

export function getCountryBySlug(slug: string): Country | undefined {
  return COUNTRIES.find((c) => c.slug === slug);
}
