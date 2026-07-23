/**
 * Use-case catalogue for /use-cases and /use-cases/[slug].
 *
 * Each entry targets a distinct high-intent query — the job a developer is
 * trying to get done ("block a PR when a scan finds a vulnerability"), not a
 * feature. Every page has real prose, a real config/code snippet, and
 * page-specific FAQs so it earns its index slot.
 *
 * Source of truth for the /use-cases URL set.
 */

export interface UseCaseEntry {
  slug: string;
  title: string;
  /** The query intent, shown as the hero subtitle. */
  intent: string;
  /** One-sentence answer for snippet extraction. */
  shortDef: string;
  /** The problem this solves, in prose. */
  problem: string[];
  /** How to do it with GateTest, in prose. */
  solution: string[];
  /** Optional code / config snippet. */
  code?: { lang: string; label: string; content: string };
  /** Step list rendered as an ordered list. */
  steps: string[];
  related: string[];
  modules: string[];
  faqs: { q: string; a: string }[];
}

const GH_ACTION_SNIPPET = `# .github/workflows/gatetest.yml
name: GateTest
on:
  pull_request:
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: crclabs-hq/gatetest-action@v1
        with:
          suite: full
          # error-severity findings fail the job and block the merge
          fail-on: error`;

export const USE_CASES: UseCaseEntry[] = [
  {
    slug: "block-pull-requests-on-security-findings",
    title: "Block pull requests on security findings",
    intent: "Stop a PR from merging when a scan finds a vulnerability",
    shortDef:
      "Run GateTest as a required status check on every pull request so any error-severity finding — a leaked secret, an injection, a vulnerable dependency — fails the check and blocks the merge until it's fixed.",
    problem: [
      "Code review catches design problems, but humans are unreliable at spotting a hardcoded key or a tainted SQL string buried in a 400-line diff at the end of the day. Without an automated gate, whether a vulnerability merges depends on whether a reviewer happened to notice.",
      "The fix is to make 'no new criticals' a precondition of merging, applied identically to every pull request, with the same rigor at 9am on Monday and 6pm on Friday.",
    ],
    solution: [
      "Add GateTest as a GitHub Action that runs on `pull_request`. It scans the changed code, and any error-severity finding fails the job.",
      "Mark the GateTest check as a required status check in branch protection. Now GitHub itself refuses to merge until the check is green — there's no override short of an admin.",
    ],
    code: { lang: "yaml", label: ".github/workflows/gatetest.yml", content: GH_ACTION_SNIPPET },
    steps: [
      "Add the GateTest workflow to .github/workflows/.",
      "Open Settings → Branches → branch protection for your default branch.",
      "Enable 'Require status checks to pass before merging' and select the GateTest check.",
      "On the Scan + Fix tier, let GateTest open an auto-fix PR so the gate can go green without manual work.",
    ],
    related: ["ci-cd-quality-gate", "auto-fix-vulnerabilities", "pre-push-gate"],
    modules: ["security", "secrets", "dependencies"],
    faqs: [
      {
        q: "How do I make GateTest a required check?",
        a: "Add GateTest as a GitHub Action on pull_request, then enable branch protection on your default branch and select the GateTest check under 'Require status checks to pass before merging'. GitHub then blocks the merge until the check passes.",
      },
      {
        q: "What severity blocks the merge?",
        a: "Only error-severity findings fail the job by default. Warnings and info surface in the output without blocking, so the gate stops real problems without becoming noise developers route around.",
      },
    ],
  },
  {
    slug: "ci-cd-quality-gate",
    title: "Add a quality gate to CI/CD",
    intent: "Enforce code-quality and security standards automatically in CI",
    shortDef:
      "A CI/CD quality gate runs your standards — security, supply chain, tests, complexity — as an automated pass/fail step on every build, so quality is enforced consistently instead of depending on who's reviewing.",
    problem: [
      "Standards that live in a wiki are aspirational. The only standards that hold are the ones a machine enforces on every change, because human discipline erodes under deadline pressure exactly when it matters most.",
      "A quality gate makes the standard executable: it runs in the pipeline, evaluates the change against thresholds, and returns a single verdict that the pipeline obeys.",
    ],
    solution: [
      "Run GateTest's full 120-module suite as a CI step. Error-severity findings fail the build; warnings surface without blocking.",
      "Because GateTest emits SARIF, the same run also feeds GitHub code scanning, so findings appear inline on the diff as well as in the build log.",
    ],
    code: { lang: "yaml", label: ".github/workflows/gatetest.yml", content: GH_ACTION_SNIPPET },
    steps: [
      "Drop the GateTest Action into your pipeline (GitHub Actions, or the CLI in any other CI).",
      "Choose a suite: quick (fast feedback) or full (the complete gate).",
      "Set fail-on: error so only high-confidence problems block.",
      "Optionally upload the SARIF output to GitHub code scanning for inline annotations.",
    ],
    related: ["block-pull-requests-on-security-findings", "sarif-github-code-scanning", "monorepo-scanning"],
    modules: [],
    faqs: [
      {
        q: "Does GateTest work outside GitHub Actions?",
        a: "Yes. GateTest is a Node CLI, so it runs in any CI system — GitLab CI, CircleCI, Jenkins, Buildkite — and exits non-zero on error-severity findings to fail the build. The GitHub Action is just a packaged wrapper.",
      },
      {
        q: "Will a quality gate slow my pipeline down?",
        a: "The quick suite is designed for fast PR feedback; the full suite runs the complete 120-module gate. You choose per-workflow, so you can gate PRs quickly and run the deep suite on merges to main.",
      },
    ],
  },
  {
    slug: "auto-fix-vulnerabilities",
    title: "Auto-fix vulnerabilities with an AI pull request",
    intent: "Not just find vulnerabilities — fix them automatically",
    shortDef:
      "On the Scan + Fix tier, GateTest doesn't stop at finding issues — Claude writes the fix, validates it through a syntax and re-scan gate, generates a regression test, and opens a pull request you review and merge.",
    problem: [
      "Finding a vulnerability is half the job. The finding still has to be triaged, understood, fixed, tested, and shipped — and that backlog is where most scanner output goes to die. A list of 200 findings nobody has time to action protects nothing.",
      "Closing the loop means turning the finding into a reviewable fix automatically, so the human cost is a code review rather than an investigation.",
    ],
    solution: [
      "GateTest's iterative fix loop sends each finding to Claude with full project context, applies the fix, then re-scans that specific finding in isolation. If it didn't resolve, it retries with the failure context, up to a configurable limit.",
      "Every fix passes a syntax gate and a cross-file scanner re-validation so a fix can't introduce a new problem, and a regression test is generated demonstrating the original bug. The result is a single pull request with the fixes, the tests, and a before/after scan comparison.",
    ],
    steps: [
      "Run a scan on the Scan + Fix ($199) or Forensic ($399) tier.",
      "GateTest clusters findings by file and fixes the highest-impact root causes first.",
      "Each fix is validated and gets a regression test.",
      "Review the resulting pull request and merge — the fix is as fast as the finding.",
    ],
    related: ["block-pull-requests-on-security-findings", "ci-cd-quality-gate", "dependency-supply-chain-gate"],
    modules: ["security", "dependencies", "cveFeed"],
    faqs: [
      {
        q: "Does the AI fix get merged automatically?",
        a: "No. GateTest opens a pull request that a human reviews and merges. The fix is validated through a syntax and re-scan gate and ships with a regression test, but a person stays in the loop — your code is never changed without review.",
      },
      {
        q: "How does GateTest avoid the fix breaking something else?",
        a: "Each fix passes a syntax-validation gate and a cross-file scanner re-validation that builds a synthetic post-fix workspace and re-runs the scan. If a fix introduces a new finding, it's rolled back rather than shipped.",
      },
    ],
  },
  {
    slug: "monorepo-scanning",
    title: "Scan a monorepo",
    intent: "Run one quality gate across many packages in a single repository",
    shortDef:
      "GateTest scans a whole monorepo in one pass — every package, multiple languages, shared and per-package config — without standing up a separate pipeline per project, and reports findings with their real file paths.",
    problem: [
      "Monorepos concentrate many projects, often in several languages, behind one CI pipeline. A scanner that only understands a single language or a single package at the root either misses most of the tree or forces you to wire up N separate jobs.",
      "What you want is one gate that walks the whole repository, understands each package's stack, and reports findings against their actual paths.",
    ],
    solution: [
      "A single run covers a mixed monorepo: deep JavaScript/TypeScript analysis, pattern-level checks for Python, Go, Java, Ruby, and PHP, plus infrastructure-as-code (Dockerfile, Terraform, Kubernetes) and polyglot dependency manifests.",
      "The monorepo-constraints module additionally checks for cross-package boundary violations and dependency drift between workspaces, which are the bugs unique to the monorepo shape.",
    ],
    code: { lang: "yaml", label: ".github/workflows/gatetest.yml", content: GH_ACTION_SNIPPET },
    steps: [
      "Run GateTest from the repository root — it discovers packages and languages automatically.",
      "Findings are reported with their full path, so you can route them to the owning team.",
      "Use the prSize module to keep cross-package changes reviewable.",
    ],
    related: ["ci-cd-quality-gate", "block-pull-requests-on-security-findings"],
    modules: ["monorepoConstraints", "dependencies", "importCycle"],
    faqs: [
      {
        q: "Does GateTest need per-package configuration?",
        a: "No. It discovers packages and languages from the repository structure and manifests, so a single run from the root covers the whole monorepo. Per-package overrides are supported but not required.",
      },
      {
        q: "Can it catch cross-package problems?",
        a: "Yes. Beyond scanning each package, the monorepo-constraints and import-cycle modules detect boundary violations and circular dependencies between workspaces — the failure modes specific to monorepos.",
      },
    ],
  },
  {
    slug: "pre-push-gate",
    title: "Catch issues before they're pushed",
    intent: "Run the gate locally as a pre-push hook for instant feedback",
    shortDef:
      "Install GateTest as a git pre-push hook so secrets, syntax errors, and obvious vulnerabilities are caught on your machine — before they ever reach the shared history where a leaked credential is already compromised.",
    problem: [
      "Some problems are far cheaper to catch before the push than after. A secret that lands in shared git history is compromised permanently, even if you delete it in the next commit — the value still sits in history, on every clone and fork.",
      "A local pre-push hook moves that catch left to the last safe moment: your machine, before anything leaves it.",
    ],
    solution: [
      "GateTest ships a pre-push hook that runs a fast suite before `git push` completes. Catch a secret or a syntax error and the push is stopped with the finding shown inline.",
      "Local hooks can be advisory (surface findings without blocking developer flow) while the CI gate stays authoritative — the hook is for speed, CI is for enforcement.",
    ],
    code: {
      lang: "bash",
      label: "install the pre-push hook",
      content: `# from your repo root
npx @gatetest/cli install-hook pre-push

# now every 'git push' runs a fast scan first;
# a leaked secret or syntax error stops the push.`,
    },
    steps: [
      "Install the GateTest pre-push hook in your repo.",
      "Push as normal — the hook runs a fast suite first.",
      "Findings appear inline; fix and re-push.",
      "Keep the CI gate as the authoritative enforcement layer.",
    ],
    related: ["block-pull-requests-on-security-findings", "ci-cd-quality-gate"],
    modules: ["secrets", "syntax", "secretRotation"],
    faqs: [
      {
        q: "Should the pre-push hook block the push?",
        a: "It can, but many teams run it advisory — surfacing findings without blocking flow — and rely on the CI gate as the hard enforcement layer. The hook is about fast local feedback; CI is the gate of record.",
      },
      {
        q: "Why catch secrets before the push specifically?",
        a: "Because once a secret is in shared git history it's compromised even if you delete it later — it persists in earlier commits and every clone. Catching it pre-push is the difference between 'don't commit that' and rotating a live credential.",
      },
    ],
  },
  {
    slug: "sarif-github-code-scanning",
    title: "Show findings in GitHub code scanning",
    intent: "Get scanner findings as inline annotations on the PR diff",
    shortDef:
      "GateTest emits SARIF, the standard format GitHub code scanning ingests, so every finding appears as an inline annotation on the pull-request diff — tracked across commits and dismissible — instead of buried in CI logs.",
    problem: [
      "Findings in a CI log are easy to ignore. A wall of text at the bottom of a build that nobody scrolls to isn't a review surface; it's noise. Developers act on what shows up next to the code they're reviewing.",
      "GitHub code scanning solves this by rendering findings inline on the diff — but it needs results in SARIF, the standard interchange format.",
    ],
    solution: [
      "GateTest produces SARIF as one of its reporter formats. Upload it with the standard `github/codeql-action/upload-sarif` step and GitHub renders each finding inline.",
      "GitHub then tracks findings across commits, de-duplicates them, and lets reviewers dismiss with a reason — turning scanner output into a managed review surface.",
    ],
    code: {
      lang: "yaml",
      label: "upload SARIF to code scanning",
      content: `- uses: crclabs-hq/gatetest-action@v1
  with:
    suite: full
    sarif-file: gatetest.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: gatetest.sarif`,
    },
    steps: [
      "Run GateTest with SARIF output enabled.",
      "Upload the SARIF file via github/codeql-action/upload-sarif.",
      "Findings appear under the Security tab and inline on the diff.",
      "Reviewers dismiss false positives with a tracked reason.",
    ],
    related: ["ci-cd-quality-gate", "block-pull-requests-on-security-findings"],
    modules: [],
    faqs: [
      {
        q: "Do I need GitHub Advanced Security for this?",
        a: "Code scanning via SARIF upload is available on public repositories for free and on private repositories with GitHub Advanced Security. GateTest produces the SARIF; GitHub's availability rules apply to where it's displayed.",
      },
      {
        q: "What format does GateTest export?",
        a: "GateTest emits five reporter formats — Console, JSON, HTML, SARIF, and JUnit. SARIF is the one GitHub code scanning ingests for inline annotations.",
      },
    ],
  },
  {
    slug: "dependency-supply-chain-gate",
    title: "Gate on vulnerable and risky dependencies",
    intent: "Block builds that pull in vulnerable or unpinned packages",
    shortDef:
      "GateTest inventories your dependencies across ten ecosystems and fails the gate on known-vulnerable packages, wildcard or unpinned versions, missing lockfiles, and abandoned dependencies — the supply-chain layer your own code never touches.",
    problem: [
      "Most of your attack surface is third-party code you didn't write and rarely read. A transitively-pulled package with a fresh CVE, a wildcard pin that lets a malicious update slip in, a dependency abandoned two years ago — none of these show up in a review of your own diff.",
      "Gating the supply chain means evaluating the dependency graph itself, on every change to a lockfile and on a schedule, because a clean dependency today can have a CVE disclosed tomorrow.",
    ],
    solution: [
      "GateTest's dependencies module resolves manifests across npm, pip, Pipenv, Poetry, go.mod, Cargo, Bundler, Composer, Maven, and Gradle, and flags wildcards, `latest` pins, missing lockfiles, deprecated packages, and git-without-rev specifiers.",
      "The CVE-feed module maps vulnerable packages to concrete version-bump fixes, so the auto-fix PR can raise the pin to a safe release rather than just reporting the problem.",
    ],
    code: { lang: "yaml", label: ".github/workflows/gatetest.yml", content: GH_ACTION_SNIPPET },
    steps: [
      "Run GateTest with the dependencies and CVE-feed modules (included in the full suite).",
      "Fail the gate on error-severity dependency findings.",
      "On Scan + Fix, accept the version-bump PR GateTest opens.",
      "Schedule a periodic re-scan to catch newly-disclosed CVEs.",
    ],
    related: ["auto-fix-vulnerabilities", "ci-cd-quality-gate", "block-pull-requests-on-security-findings"],
    modules: ["dependencies", "cveFeed", "secretRotation"],
    faqs: [
      {
        q: "Which ecosystems does GateTest cover?",
        a: "The dependencies module is polyglot: npm, pip, Pipenv, Poetry, go.mod, Cargo, Bundler, Composer, Maven, and Gradle. It runs with zero network calls against your manifests and lockfiles.",
      },
      {
        q: "Can it fix a vulnerable dependency automatically?",
        a: "On the Scan + Fix tier, yes. The CVE-feed module maps a vulnerable package to a safe version, and the auto-fix PR raises the pin in package.json / requirements.txt / Cargo.toml accordingly.",
      },
    ],
  },
];

export function getAllUseCaseSlugs(): string[] {
  return USE_CASES.map((u) => u.slug);
}

export function getUseCaseBySlug(slug: string): UseCaseEntry | undefined {
  return USE_CASES.find((u) => u.slug === slug);
}

export function getRelatedUseCases(slug: string, limit = 3): UseCaseEntry[] {
  const entry = getUseCaseBySlug(slug);
  if (!entry) return [];
  const out: UseCaseEntry[] = [];
  for (const rel of entry.related) {
    const e = getUseCaseBySlug(rel);
    if (e) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
