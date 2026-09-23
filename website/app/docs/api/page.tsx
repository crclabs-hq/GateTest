import type { Metadata } from "next";
import { SITE_URL } from "@/app/lib/site-url";
import { appInstallUrl } from "@/app/lib/github-app-permissions";
import { FULL_SUITE_MODULES } from "@/app/mcp/tools-data";
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";

export const metadata: Metadata = {
  title: "API Reference — GateTest",
  description:
    "GateTest public API v1 — scan any repo or upload files directly. Bearer auth, JSON response, idempotency support.",
};

const curlQuick = `curl -X POST ${SITE_URL}/api/v1/scan \\
  -H "Authorization: Bearer gt_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "repo_url": "https://github.com/owner/repo",
    "tier": "quick"
  }'`;

const curlDirect = `curl -X POST ${SITE_URL}/api/v1/scan \\
  -H "Authorization: Bearer gt_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "files": [
      { "path": "src/index.ts", "content": "import express..." },
      { "path": "src/auth.ts", "content": "const secret = ..." }
    ],
    "tier": "full",
    "project": "zoobicon"
  }'`;

const curlFullIdem = `curl -X POST ${SITE_URL}/api/v1/scan \\
  -H "Authorization: Bearer gt_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: scan-20260415-build-847" \\
  -d '{
    "repo_url": "https://github.com/owner/repo",
    "tier": "full"
  }'`;

const responseExample = `{
  "status": "complete",
  "repo_url": "https://github.com/owner/repo",
  "tier": "quick",
  "modules": [
    {
      "name": "syntax",
      "status": "passed",
      "checks": 18,
      "issues": 0,
      "duration": 42
    },
    {
      "name": "secrets",
      "status": "failed",
      "checks": 24,
      "issues": 1,
      "duration": 31,
      "details": ["src/config.js: AWS access key"]
    },
    {
      "name": "aiReview",
      "status": "skipped",
      "checks": 0,
      "issues": 0,
      "duration": 2,
      "skipped": "ANTHROPIC_API_KEY not set — AI review skipped"
    }
  ],
  "totalModules": 22,
  "completedModules": 22,
  "totalIssues": 1,
  "duration": 8421,
  "authSource": "app",
  "key": { "name": "Platform A prod", "prefix": "gt_live_abcd" }
}`;

const nodeExample = `import fetch from "node-fetch";

const res = await fetch("${SITE_URL}/api/v1/scan", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.GATETEST_API_KEY}\`,
    "Content-Type": "application/json",
    "Idempotency-Key": \`ci-\${process.env.GITHUB_SHA}\`,
  },
  body: JSON.stringify({
    repo_url: "https://github.com/owner/repo",
    tier: "full",
  }),
});
const result = await res.json();
if (result.totalIssues > 0) process.exit(1);`;

// Code samples are what the terminal shows, so they stay dark panels.
const CODE = "term text-xs overflow-x-auto p-4";
const H2 = "v2-h2 !text-2xl mb-3";
const H3 = "text-lg font-semibold text-[var(--v2-fg)] mb-2";

export default function ApiDocs() {
  return (
    <main>
      <PageHero
        eyebrow="API Reference · v1"
        title="GateTest Public API"
        lede={<>
          Scan any GitHub repo programmatically. Every module advertised runs real
          analysis or returns an honest <code className="font-mono text-base">skipped</code>{" "}
          reason — we never fake-pass.
        </>}
      />

      <Section narrow>
        <section className="mb-12">
          <h2 className={H2}>Authentication</h2>
          <p className="text-muted mb-4">
            Every request requires a GateTest API key. Pass it via{" "}
            <code className="font-mono text-sm">Authorization: Bearer &lt;key&gt;</code>{" "}
            or the <code className="font-mono text-sm">X-API-Key</code> header. Keys start
            with <code className="font-mono text-sm">gt_live_</code> and are issued from
            the admin console. Only the hash is stored — keep the plaintext safe.
          </p>
          <div className="v2-callout text-xs">
            Request a key: email <a className="text-accent hover:underline" href="mailto:support@gatetest.io">support@gatetest.io</a>
            {" "}with your platform name and expected scan volume.
          </div>
        </section>

        <section className="mb-12">
          <h2 className={H2}>POST /api/v1/scan</h2>
          <p className="text-muted mb-4">
            Two input modes: provide a <code className="font-mono text-sm">repo_url</code>{" "}
            (GitHub) or upload <code className="font-mono text-sm">files[]</code> directly
            (any platform — no GitHub required). Same in-memory scan engine, same response format.
            Typical latency: 5–15 s for <code className="font-mono text-sm">quick</code>,
            20–60 s for <code className="font-mono text-sm">full</code>.
          </p>

          <h3 className={H3}>Request body</h3>
          <div className="overflow-x-auto mb-6">
            <table className="v2-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="v2-mono text-xs">repo_url</td>
                  <td className="text-xs">string</td>
                  <td className="text-xs">mode A</td>
                  <td className="text-xs text-[var(--v2-muted)]">github.com URL — GateTest reads the repo via API</td>
                </tr>
                <tr>
                  <td className="v2-mono text-xs">files</td>
                  <td className="text-xs">{`{path, content}[]`}</td>
                  <td className="text-xs">mode B</td>
                  <td className="text-xs text-[var(--v2-muted)]">Direct upload — send file contents inline (max 100 files, 500 KB each)</td>
                </tr>
                <tr>
                  <td className="v2-mono text-xs">project</td>
                  <td className="text-xs">string</td>
                  <td className="text-xs">no</td>
                  <td className="text-xs text-[var(--v2-muted)]">Label for direct uploads (e.g. &quot;zoobicon&quot;)</td>
                </tr>
                <tr>
                  <td className="v2-mono text-xs">tier</td>
                  <td className="text-xs">string</td>
                  <td className="text-xs">no</td>
                  <td className="text-xs text-[var(--v2-muted)]">
                    <code className="font-mono">quick</code> (default, 4 modules) or{" "}
                    <code className="font-mono">full</code> (the in-memory engine&apos;s full tier, ~23 modules — the deep {FULL_SUITE_MODULES}-module CLI-engine suite runs on paid website scans and the CLI/Action). Key must be
                    entitled.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 className={H3}>Mode A — GitHub repo</h3>
          <pre className={`${CODE} mb-6`}>{curlQuick}</pre>

          <h3 className={H3}>Mode B — Direct file upload</h3>
          <p className="text-muted text-sm mb-3">
            No GitHub required. Send file paths and contents inline — works for any
            platform, any language, any framework.
          </p>
          <pre className={`${CODE} mb-6`}>{curlDirect}</pre>

          <h3 className={H3}>Full scan with idempotency</h3>
          <p className="text-muted text-sm mb-3">
            Pass an <code className="font-mono">Idempotency-Key</code> header to deduplicate
            retries within 24 hours. Useful from CI where a build may retry.
          </p>
          <pre className={`${CODE} mb-6`}>{curlFullIdem}</pre>

          <h3 className={H3}>Example response</h3>
          <pre className={CODE}>{responseExample}</pre>
        </section>

        <section className="mb-12">
          <h2 className={H2}>Module statuses</h2>
          <div className="overflow-x-auto">
            <table className="v2-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="v2-mono text-xs text-[var(--v2-ok)]">passed</td>
                  <td className="text-xs text-[var(--v2-muted)]">
                    Module ran, performed at least 1 check, found 0 issues.
                  </td>
                </tr>
                <tr>
                  <td className="v2-mono text-xs text-[var(--v2-bad)]">failed</td>
                  <td className="text-xs text-[var(--v2-muted)]">
                    Module found ≥ 1 issue (see <code>details</code>) or threw during
                    execution.
                  </td>
                </tr>
                <tr>
                  <td className="v2-mono text-xs text-[var(--v2-muted)]">skipped</td>
                  <td className="text-xs text-[var(--v2-muted)]">
                    Module could not run honestly (e.g. missing config, nothing to
                    inspect). <code>skipped</code> field explains why. Never treated as a
                    pass.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-12">
          <h2 className={H2}>Errors</h2>
          <div className="overflow-x-auto">
            <table className="v2-table">
              <thead>
                <tr>
                  <th>HTTP</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="v2-mono text-xs">400</td>
                  <td className="text-xs text-[var(--v2-muted)]">Missing or malformed body / repo_url / tier.</td>
                </tr>
                <tr>
                  <td className="v2-mono text-xs">401</td>
                  <td className="text-xs text-[var(--v2-muted)]">Missing or invalid API key.</td>
                </tr>
                <tr>
                  <td className="v2-mono text-xs">403</td>
                  <td className="text-xs text-[var(--v2-muted)]">Key revoked, or tier not entitled on this key.</td>
                </tr>
                <tr>
                  <td className="v2-mono text-xs">429</td>
                  <td className="text-xs text-[var(--v2-muted)]">
                    Rate limit exceeded. Response body includes{" "}
                    <code className="font-mono">rate_limit_per_hour</code>. Respect{" "}
                    <code className="font-mono">Retry-After</code>.
                  </td>
                </tr>
                <tr>
                  <td className="v2-mono text-xs">500</td>
                  <td className="text-xs text-[var(--v2-muted)]">Scan crashed — retry with the same idempotency key is safe.</td>
                </tr>
                <tr>
                  <td className="v2-mono text-xs">502</td>
                  <td className="text-xs text-[var(--v2-muted)]">
                    Could not access the GitHub repo. Usually means private repo without
                    a GateTest GitHub App install.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-12">
          <h2 className={H2}>Node.js example (CI gate)</h2>
          <pre className={CODE}>{nodeExample}</pre>
        </section>

        <section className="mb-12">
          <h2 className={H2}>Private repos</h2>
          <p className="text-muted leading-relaxed">
            Install the{" "}
            <a
              href={appInstallUrl()}
              className="text-accent hover:underline"
            >
              GateTest GitHub App
            </a>{" "}
            on your repo or organisation. GateTest will mint a short-lived installation
            token at scan time — your API key stays untouched by GitHub.
          </p>
        </section>

        <div className="text-xs text-muted border-t border-border pt-6">
          Support: <a className="text-accent hover:underline" href="mailto:support@gatetest.io">support@gatetest.io</a> ·{" "}
          <a className="text-accent hover:underline" href="/legal/terms">Terms</a> ·{" "}
          <a className="text-accent hover:underline" href="/legal/privacy">Privacy</a>
        </div>
      </Section>
    </main>
  );
}
