/**
 * /trust — the Security page as data, sections 1–7.
 *
 * Every claim here is one the code makes true today. Facts come from
 * `app/legal/_facts.js`; the GitHub App scope table is generated from the
 * engine's own permission declaration. The remaining sections are in
 * `trust-content-2.ts`.
 */
import type { LegalDoc, LegalSection } from "../components/legal/LegalDocument";
import * as F from "../legal/_facts";
import {
  githubAppPermissionTable, githubAppEndpointTable, githubAppIdentitySentence,
  webhookEventsSentence, oauthScopesSentence, hostedUnsafeModuleList,
} from "../lib/legal-access-table";
import { SECTIONS_2 } from "./trust-content-2";

const vendor = (name: string) => F.SUB_PROCESSORS.find((s) => s.name === name);
const HOST = vendor("Vultr");
const DB = vendor("Neon");
const DNS = vendor("Cloudflare");

const SECTIONS_1: LegalSection[] = [
  {
    id: "overview",
    heading: "Overview",
    body: [
      { p: "You are about to point a tool at every file in your repository. This page is the complete account of what happens to those files — where they go, how long they exist, who can see them and which controls stand between them and anyone else. It is written by the people who run the system and every statement on it is checked against the code." },
      { h3: "What we do with your code" },
      { list: [
        "Fetch it from your git host with the access you granted, analyse it on a server we operate, and delete the working copy when the scan finishes.",
        "Keep the results: each finding's message, file path and line number, the verdict, the score and the summary.",
        "On the tiers that include AI review or auto-fix, send the files under review to our AI provider, which retains them for a fixed window and does not train on them.",
        "Post the verdict back to your git host as a status, comment, branch or pull request.",
      ] },
      { h3: "What we never do" },
      { list: [
        "Store your source code after a scan, in the database, in logs or in error reports.",
        "Execute your code on our servers — the modules that would need to are refused here and run only in your own CI or on your machine.",
        "Sell, share or use your code or findings for anything other than scanning it for you, or use them to train models.",
        "Handle your card details — payment is on pages Stripe hosts.",
        "Claim a certification we do not hold. There is no SOC 2, ISO 27001 or penetration-test report today; see [Compliance and attestations](#compliance-and-attestations).",
      ] },
    ],
  },
  {
    id: "infrastructure-and-hosting",
    heading: "Infrastructure and hosting",
    body: [
      { table: {
        headers: ["Layer", "Provider", "Location", "Notes"],
        rows: [
          ["Application servers", HOST ? HOST.name : "Production hosting provider", HOST ? HOST.location : "United States", "Dedicated virtual servers we administer. Scans run here; the temporary workspace for each scan lives on this disk for the duration of the scan only."],
          ["Database", DB ? `${DB.name} (managed PostgreSQL)` : "Managed PostgreSQL", DB ? DB.location : "United States", "Accounts, scan findings, payment identifiers, API keys and the audit log. Encrypted at rest by the provider."],
          ["Registrar and DNS", DNS ? DNS.name : "DNS provider", DNS ? DNS.location : "United States", "Domain registration and DNS only. Traffic is **not** proxied through the DNS provider; requests terminate at our own edge."],
          ["TLS", "Let's Encrypt", "—", "Certificates are issued by Let's Encrypt and terminated at our edge, renewed automatically."],
        ],
      } },
      { p: "GateTest does not run on Vercel or any other serverless platform. The full list of third parties that touch customer data, with what each receives, is the [Sub-processors](/legal/sub-processors) page." },
    ],
  },
  {
    id: "the-life-of-a-scan",
    heading: "The life of a scan",
    body: [
      { p: "Every hosted scan follows the same path. Nothing is skipped and nothing is added for particular customers." },
      { list: [
        "**Fetch.** The engine downloads an archive of the commit to be scanned from your git host, using the installation token (GitHub) or the token you issued (Gluecron).",
        `**Memoise.** The archive is held in memory for at most ${F.REPO_SNAPSHOT_SECONDS} seconds so that a burst of events for the same commit does not fetch it repeatedly.`,
        "**Unpack.** The archive is extracted into a temporary workspace on the scanning server, private to that scan.",
        "**Scan.** The deterministic modules read the workspace. On AI tiers, the files under review are sent to the AI provider (see [AI provider security](#ai-provider-security)).",
        "**Delete.** The workspace is removed when the scan finishes, whether it passed, failed or errored.",
        "**Report.** The verdict is written to the database and posted back to the git host.",
      ] },
      { h3: "What persists" },
      { list: [
        "Findings: message, file path, line number, rule and severity.",
        "The verdict, the score and the summary for the scan.",
        "The scan's metadata: repository URL, commit, tier, timing.",
      ] },
      { p: "**Source code does not persist.** Not in the database, not in logs, not in error reports, and not in the AI provider beyond its fixed retention window. If you ask us for a copy of your code after a scan, we cannot provide one, because we do not have it." },
    ],
  },
  {
    id: "code-we-never-run-on-our-servers",
    heading: "Code we never run on our servers",
    body: [
      { p: "The hosted engine is a static analyser. It reads your files; it does not execute them. The following modules would have to execute code from the repository being scanned, so the hosted engine refuses them outright — they are unavailable on our infrastructure regardless of tier or configuration:" },
      { list: hostedUnsafeModuleList(F.HOSTED_UNSAFE_MODULES) },
      { p: "These modules run only where your code already runs: in your own CI through the GitHub Action, or on your own machine through the CLI. In both places the code executes under your account, with your credentials and your network, and nothing about the run reaches us except the findings if you choose to upload them." },
      { p: "**There is no sandbox.** We do not isolate customer code in a container or virtual machine, because we do not execute it. The control is refusal, not containment, and it is enforced in code rather than by policy. This is also why a hosted scan cannot be tricked into running a build script, a post-install hook or a test that happens to be in the repository." },
    ],
  },
  {
    id: "access-and-permissions",
    heading: "Access and permissions",
    body: [
      { h3: "GitHub App" },
      { p: "The App requests exactly the scopes the shipped code needs. The table is generated from the same declaration the engine and the Marketplace listing use, and a test fails the build if the code ever calls a GitHub endpoint outside it." },
      githubAppPermissionTable(),
      { p: "For readers who want to verify rather than trust, these are the endpoints that force each scope:" },
      githubAppEndpointTable(),
      { p: webhookEventsSentence() },
      { p: githubAppIdentitySentence() },
      { h3: "Sign-in" },
      { p: oauthScopesSentence() },
      { h3: "Gluecron" },
      { p: "Gluecron repositories are connected through a push contract: Gluecron sends push events to our endpoint authenticated with a shared secret (bearer token or HMAC signature), and the engine fetches the commit with a token you issue for scanning. We hold no standing credential to your Gluecron account beyond that token." },
    ],
  },
  {
    id: "encryption-and-secrets",
    heading: "Encryption and secrets",
    body: [
      { h3: "In transit" },
      { list: [
        "TLS on every connection, with HTTP Strict Transport Security set for two years, `includeSubDomains` and `preload`.",
        "A Content-Security-Policy on every response, plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, a `strict-origin-when-cross-origin` referrer policy and a Permissions-Policy that disables camera, microphone and geolocation.",
      ] },
      { h3: "Sessions" },
      { p: `Your session cookie is encrypted with AES-256-GCM and authenticated with an HMAC, so it can be neither read nor forged without the server key. It is \`HttpOnly\`, \`SameSite=Lax\` and \`Secure\`, and expires after ${F.SESSION_DAYS} days. The full cookie inventory is in the [Cookie Policy](/legal/cookies).` },
      { h3: "At rest" },
      { list: [
        "Git-host integration tokens you connect are encrypted with AES-256-GCM before they are written to the database, using a key that exists only in the server environment.",
        "The database is encrypted at rest by the managed database provider; every table inherits it.",
        "Hosted MCP API keys are delivered by e-mail after checkout and stored in the database, where they rely on the provider's encryption at rest; they are not additionally hashed. Treat them as you would any bearer credential.",
      ] },
    ],
  },
  {
    id: "webhooks-and-integrity",
    heading: "Webhooks and integrity",
    body: [
      { list: [
        "**Fail-closed verification.** Every inbound webhook — Stripe, GitHub and Gluecron — is verified before anything else happens. A missing, malformed or invalid signature or bearer token is rejected, and the comparison is constant-time so timing cannot leak the secret.",
        "**Placeholder detection.** Configuration is checked for placeholder secrets. An integration whose secret is still a placeholder is treated as unconfigured, not as trusted.",
        "**Cron secret.** Scheduled endpoints require a dedicated secret; nothing on a timer can be triggered anonymously.",
        "**Parameterised SQL.** All database access uses parameterised queries.",
        "**SSRF guard.** URL scans refuse private, loopback and link-local address ranges, so the scanner cannot be aimed at internal infrastructure.",
        `**Hash-chained audit log.** Security-relevant actions are written to an append-only log where each entry commits to the hash of the previous one, so alteration is detectable. It is retained for ${F.AUDIT_LOG_YEARS} years.`,
      ] },
    ],
  },
];

export const DOC: LegalDoc = {
  title: "Trust & Security",
  intro: "What GateTest does with your code, what it never does, and the controls that make each statement true — written against the code, not the roadmap.",
  effective: F.EFFECTIVE_DATE,
  sections: [...SECTIONS_1, ...SECTIONS_2],
};
