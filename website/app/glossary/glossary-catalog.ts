/**
 * Glossary catalogue for /glossary and /glossary/[slug].
 *
 * Definitional pages targeting "what is X" queries in the software quality &
 * application-security space — the exact phrasing developers type into Google
 * AND into AI answer engines. Each entry is original prose (not copied from a
 * standards body), grounded in how the concept actually shows up in GateTest's
 * 110-module scan so the page earns its place instead of being a thin stub.
 *
 * Source of truth for the /glossary URL set. `getAllGlossarySlugs()` feeds the
 * sitemap; the drift test asserts the sitemap and all-urls.js stay in lockstep.
 */

export interface GlossaryEntry {
  /** URL slug (kebab-case). */
  slug: string;
  /** The term as a human reads it. */
  term: string;
  /** Optional abbreviation / acronym expansion shown under the title. */
  abbreviation?: string;
  /** One-sentence answer — the snippet AI engines and Google will lift. */
  shortDef: string;
  /** 2-4 paragraphs of real explanation. */
  body: string[];
  /** How this concept maps to GateTest specifically. */
  gatetest: string;
  /** Related glossary slugs for internal linking. */
  related: string[];
  /** GateTest modules most relevant to this term (may be empty). */
  modules: string[];
  /** Page-specific FAQs (rendered + FAQPage schema). */
  faqs: { q: string; a: string }[];
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    slug: "sast",
    term: "Static Application Security Testing (SAST)",
    abbreviation: "SAST",
    shortDef:
      "SAST analyses source code, bytecode, or binaries for security flaws without running the program — catching vulnerabilities like injection, hardcoded secrets, and unsafe deserialization before code is executed or deployed.",
    body: [
      "Static Application Security Testing inspects code at rest. Instead of sending traffic at a running app, a SAST tool parses the source into an abstract syntax tree (or an intermediate representation), then walks that structure looking for known-dangerous patterns: tainted data flowing into a SQL query, a secret committed in plaintext, user input reaching a shell command, a regex that backtracks catastrophically.",
      "Because it works on the code itself, SAST runs early — in the editor, on every commit, in CI — and points at an exact file and line. That makes it the cheapest place to catch a class of bug: the finding lands while the author still has the context in their head, long before the code reaches a security review or production.",
      "The trade-off is precision. A static analyzer reasons about all possible paths, so it can flag code that is technically reachable but practically safe (a false positive), and it can't see issues that only appear at runtime — misconfigured infrastructure, an exposed admin route, a broken auth check under real load. Mature programs pair SAST with DAST and software-composition analysis rather than treating any one of them as complete.",
    ],
    gatetest:
      "Most of GateTest's 110 modules are SAST checks: secret scanning, SSRF and injection detection, the TLS/cookie/CORS hardening scanners, the cross-file taint tracker, and language analyzers for JavaScript, TypeScript, Python, Go, Java, Ruby, and PHP. Every finding carries a file and line, and on the Scan + Fix tier Claude opens a pull request with the fix.",
    related: ["dast", "sca", "quality-gate", "false-positive-rate", "shift-left"],
    modules: ["security", "secrets", "ssrf", "crossFileTaint", "tlsSecurity"],
    faqs: [
      {
        q: "What is the difference between SAST and DAST?",
        a: "SAST reads source code without running it and finds flaws like injection and hardcoded secrets early, with a file and line. DAST exercises a running application from the outside and finds issues that only appear at runtime, such as broken auth or misconfigured headers. They catch different bug classes and are complementary, not interchangeable.",
      },
      {
        q: "Does SAST produce false positives?",
        a: "Yes. Because static analysis reasons over all possible code paths, it can flag code that is reachable in theory but safe in practice. The useful metric is the false-positive rate; GateTest tunes detectors with suppression markers and path-aware downgrades to keep that rate low.",
      },
    ],
  },
  {
    slug: "dast",
    term: "Dynamic Application Security Testing (DAST)",
    abbreviation: "DAST",
    shortDef:
      "DAST tests a running application from the outside — sending real requests to find vulnerabilities that only appear at runtime, like broken authentication, missing security headers, and server misconfiguration.",
    body: [
      "Dynamic Application Security Testing treats the app as a black box. It drives a deployed instance with crafted HTTP requests, a headless browser, or a fuzzing harness, and watches how the system responds: does an unauthenticated request reach an admin route, does the login form leak which usernames exist, are security headers present, does a malformed payload trigger a 500 with a stack trace.",
      "DAST's strength is that it sees the system as an attacker does — the real deployment, with its real configuration, middleware, and infrastructure. It finds whole categories of issue that source analysis structurally cannot: a reverse proxy that forwards an internal header, a cookie missing the Secure flag in production, a content-security-policy that was never applied.",
      "The cost is that DAST needs something running and reachable, it lands later in the lifecycle, and a finding tells you the symptom (an exposed endpoint) without always pointing at the line of code responsible. Good pipelines run DAST against staging on every deploy and feed the results back to the team that owns the code.",
    ],
    gatetest:
      "GateTest's live-scan modules are DAST: the headless-browser runtime-error capture, the live auth-bypass / IDOR / XSS / path-traversal probes, and the web-headers and TLS checks against a deployed URL. They run where a browser and a target URL are available (the GitHub Action, a worker, or the URL-scan flow) and complement the static modules.",
    related: ["sast", "quality-gate", "shift-left", "secret-scanning"],
    modules: ["runtimeErrors", "liveAuthBypass", "liveXss", "webHeaders"],
    faqs: [
      {
        q: "When should I run DAST instead of SAST?",
        a: "Run both. Use SAST on every commit to catch code-level flaws early, and run DAST against a deployed staging environment to catch runtime and configuration issues that source analysis can't see. Neither replaces the other.",
      },
      {
        q: "Does DAST need access to source code?",
        a: "No. DAST tests a running application from the outside, so it works without source. That also means its findings describe symptoms rather than the exact responsible line, which is why teams correlate DAST results back to the owning code.",
      },
    ],
  },
  {
    slug: "sca",
    term: "Software Composition Analysis (SCA)",
    abbreviation: "SCA",
    shortDef:
      "SCA inventories the third-party and open-source dependencies in a project and flags known vulnerabilities, license risks, and unmaintained packages — the supply-chain layer that your own code never touches directly.",
    body: [
      "Modern applications are mostly other people's code. Software Composition Analysis reads your manifests and lockfiles — package.json, requirements.txt, go.mod, Cargo.toml, pom.xml — resolves the full transitive dependency tree, and checks each package against vulnerability databases (CVE / GHSA) and license metadata.",
      "SCA answers questions your own source can't: is a transitively-pulled library subject to a published CVE, is a dependency pinned to a wildcard that could pull a malicious update, is a package abandoned, does a copyleft license create an obligation your legal team needs to know about. The 2021 Log4Shell incident is the canonical example — the vulnerable code was a dependency three levels deep, invisible to any tool that only read first-party code.",
      "Because the dependency graph changes whenever you update a lockfile, SCA belongs in CI and in a scheduled re-scan: a package that was clean at merge time can have a CVE disclosed against it next week.",
    ],
    gatetest:
      "GateTest's dependencies module is polyglot SCA — npm, pip, Pipenv, Poetry, go.mod, Cargo, Bundler, Composer, Maven, and Gradle. It flags wildcard and `latest` pins, missing lockfiles, deprecated packages, and git-without-rev specifiers, and the CVE-feed module maps findings to version-bump fixes the auto-fix PR can apply.",
    related: ["sbom", "supply-chain-security", "sast", "quality-gate"],
    modules: ["dependencies", "cveFeed", "secretRotation"],
    faqs: [
      {
        q: "What is the difference between SCA and SAST?",
        a: "SAST analyses the code your team writes; SCA analyses the third-party dependencies your team pulls in. Most real-world breaches involve one or the other, so a complete program runs both.",
      },
      {
        q: "How often should SCA run?",
        a: "On every change to a lockfile and on a schedule. A dependency that is clean today can have a CVE disclosed against it tomorrow, so a periodic re-scan catches vulnerabilities that did not exist at merge time.",
      },
    ],
  },
  {
    slug: "sarif",
    term: "Static Analysis Results Interchange Format (SARIF)",
    abbreviation: "SARIF",
    shortDef:
      "SARIF is an OASIS-standard JSON format for static-analysis results. It lets any scanner report findings — with file, line, rule id, and severity — in a structure that IDEs, CI systems, and GitHub code scanning all understand.",
    body: [
      "Before SARIF, every analyzer emitted its own report shape, so wiring a new tool into GitHub, an IDE, or a dashboard meant writing a custom parser. SARIF (Static Analysis Results Interchange Format) standardised that: a single JSON schema for runs, rules, results, locations, and severities.",
      "The practical payoff is GitHub code scanning. Upload a SARIF file from any scanner and GitHub renders each finding inline on the pull request diff, tracks it across commits, and de-duplicates it — turning a wall of CLI output into reviewable, dismissible annotations that live next to the code.",
      "Because the format is tool-agnostic, SARIF is also how you avoid lock-in: results from different scanners land in the same structure, so you can swap or combine tools without rebuilding your reporting layer.",
    ],
    gatetest:
      "GateTest emits SARIF as one of its five reporter formats, so findings drop straight into GitHub code scanning and show up as inline pull-request annotations. The same run also produces Console, JSON, HTML, and JUnit output for other CI systems.",
    related: ["sast", "quality-gate", "shift-left"],
    modules: [],
    faqs: [
      {
        q: "What is SARIF used for?",
        a: "SARIF is a standard JSON format for static-analysis findings. Its most common use is uploading scanner results to GitHub code scanning, which renders each finding as an inline annotation on the pull-request diff and tracks it across commits.",
      },
      {
        q: "Can GitHub display GateTest results?",
        a: "Yes. GateTest produces SARIF output, which GitHub code scanning ingests directly, so findings appear inline on the diff with their file, line, rule id, and severity.",
      },
    ],
  },
  {
    slug: "quality-gate",
    term: "Quality Gate",
    shortDef:
      "A quality gate is an automated pass/fail checkpoint in a pipeline that blocks code from merging or deploying unless it meets defined thresholds — zero new criticals, no leaked secrets, tests passing — making quality a precondition rather than a hope.",
    body: [
      "A quality gate turns a set of standards into an enforced decision. It runs in CI (or a pre-push hook), evaluates the change against rules — no new error-severity findings, no hardcoded secrets, coverage not regressing, no failing tests — and returns a single verdict: pass and the merge proceeds, fail and it is blocked.",
      "The value is that it removes judgement from the hot path. Without a gate, 'we should fix that before shipping' depends on whoever is reviewing noticing and caring at 5pm on a Friday. With a gate, the standard is applied identically to every change, so quality stops eroding one rushed merge at a time.",
      "A good gate is strict about what blocks (real, high-confidence, error-severity problems) and informative about the rest (warnings that surface without failing the build), so it protects the codebase without becoming the thing developers learn to bypass.",
    ],
    gatetest:
      "GateTest is a quality gate. Error-severity findings block; warnings and info surface without failing the build. It runs as a GitHub Action, a pre-push hook, or a paid per-scan run, and on the Scan + Fix tier it doesn't just block — it opens a pull request that fixes the findings so the gate can go green.",
    related: ["sast", "shift-left", "false-positive-rate", "technical-debt"],
    modules: [],
    faqs: [
      {
        q: "What does a quality gate block on?",
        a: "A well-designed gate blocks only on high-confidence, error-severity problems — new critical vulnerabilities, leaked secrets, failing tests — and lets lower-severity findings surface as warnings without failing the build. GateTest follows exactly this split.",
      },
      {
        q: "Where does a quality gate run?",
        a: "Usually in CI on every pull request, so nothing merges until it passes. It can also run as a local pre-push hook for faster feedback. GateTest supports both, plus an on-demand per-scan run.",
      },
    ],
  },
  {
    slug: "mutation-testing",
    term: "Mutation Testing",
    shortDef:
      "Mutation testing measures how good your tests actually are by introducing small bugs (mutants) into the code and checking whether the test suite catches them. A test suite that passes despite the injected bug has a real gap.",
    body: [
      "Code coverage tells you which lines ran during the tests — not whether the tests would notice if those lines were wrong. Mutation testing closes that gap. It systematically alters the code: flips a `>` to `>=`, changes a `+` to a `-`, replaces `return true` with `return false`, deletes a statement. Each altered version is a mutant.",
      "Then it reruns the test suite against each mutant. If a test fails, the mutant is 'killed' — your tests caught the injected bug, which is what you want. If every test still passes, the mutant 'survived' — meaning a real bug of that exact shape could ship and your suite would stay green. The mutation score is the percentage of mutants killed.",
      "Surviving mutants are the most actionable signal in testing: each one points at a specific line where your assertions don't actually constrain behaviour. It is more expensive than coverage (you rerun the suite many times), so it is usually reserved for critical code paths.",
    ],
    gatetest:
      "GateTest's mutation module applies 19 canonical operators — equality flips, boundary swaps, math-operator swaps, return-value flips — and reports any mutant that slips through your suite as a coverage hole. Because it has to run your tests, it executes via the GitHub Action where a CI runner is available rather than in the serverless web scan.",
    related: ["quality-gate", "technical-debt", "false-positive-rate"],
    modules: ["mutation"],
    faqs: [
      {
        q: "How is mutation testing different from code coverage?",
        a: "Coverage measures which lines executed during the tests. Mutation testing measures whether the tests would fail if those lines were wrong. A file can have 100% coverage and a poor mutation score, which reveals assertions that don't actually check anything.",
      },
      {
        q: "Why does mutation testing need a CI runner?",
        a: "Because it works by rerunning your test suite against each injected bug. That requires executing your tests, which GateTest does in the GitHub Action rather than in the serverless web scan.",
      },
    ],
  },
  {
    slug: "false-positive-rate",
    term: "False Positive Rate",
    shortDef:
      "The false positive rate is the share of a scanner's findings that aren't real problems. It's the single biggest factor in whether a security tool gets used or ignored — high noise trains developers to dismiss everything, including the true positives.",
    body: [
      "A false positive is a finding the tool reports that is not actually a bug — code flagged as a SQL injection that is parameterised, a 'hardcoded secret' that is a test fixture, a path that is reachable in theory but guarded in practice. The false positive rate is how often that happens relative to total findings.",
      "It matters more than almost any other metric because it governs trust. The first time a developer chases a flagged 'critical' and finds nothing wrong, the tool loses a little credibility. After enough of those, the team learns to bulk-dismiss findings — and that habit buries the true positives along with the noise. A noisy scanner is worse than no scanner, because it manufactures false confidence.",
      "Lowering the rate without hiding real bugs is the hard part of detector engineering: path-aware severity (downgrade in tests), library-aware suppression (recognise safe wrappers), explicit suppression markers, and confidence scoring so the gate blocks only on high-confidence findings.",
    ],
    gatetest:
      "GateTest treats false-positive control as a first-class design constraint. Detectors downgrade severity on test paths, safe-harbour known-good patterns (parameterised ORMs, decimal money libraries, retry libraries), honour inline suppression markers, and feed a confidence-calibrator that recommends severity downgrades for rules customers repeatedly dismiss.",
    related: ["sast", "quality-gate", "mutation-testing", "technical-debt"],
    modules: [],
    faqs: [
      {
        q: "Why does a high false positive rate matter so much?",
        a: "Because it destroys trust. Once developers learn that most findings are noise, they bulk-dismiss them — and real vulnerabilities get dismissed alongside the false ones. A noisy scanner can leave a team less safe than no scanner.",
      },
      {
        q: "How do scanners reduce false positives?",
        a: "With path-aware severity (lower severity in test code), library-aware suppression (recognising safe wrappers), explicit suppression markers, and confidence scoring so only high-confidence findings block the build. GateTest uses all four.",
      },
    ],
  },
  {
    slug: "supply-chain-security",
    term: "Software Supply Chain Security",
    shortDef:
      "Supply-chain security protects everything your software depends on but doesn't write — open-source packages, build tools, CI pipelines, and base images — from compromise, because an attacker who poisons a dependency or a build step compromises every downstream user at once.",
    body: [
      "Your application's attack surface is far larger than your own repository. It includes every dependency you pull, every GitHub Action in your workflows, every base image in your Dockerfiles, and the CI system that assembles them. Software supply-chain security is the practice of defending that whole chain.",
      "The threat is leverage. Compromising one popular package, one unpinned Action, or one build server can reach thousands of downstream projects automatically — as the SolarWinds, Codecov, and event-stream incidents all showed. The attacker doesn't need to breach you; they breach something you trust.",
      "Defences are concrete: pin dependencies and Actions to immutable versions (a commit SHA, not a moving tag), generate and verify an SBOM, scan for known-vulnerable packages, lock down CI permissions so a poisoned step can't exfiltrate secrets, and watch for typosquatted or newly-malicious packages.",
    ],
    gatetest:
      "Several GateTest modules target the supply chain directly: dependencies (vulnerable / wildcard / unpinned packages), ci-security (unpinned Actions, pwn-request, secret-echo, missing permissions blocks), dockerfile (untrusted base images, curl-pipe-sh), and secret-rotation. Together they harden the chain, not just first-party code.",
    related: ["sca", "sbom", "sast"],
    modules: ["dependencies", "ciSecurity", "dockerfile", "secretRotation"],
    faqs: [
      {
        q: "What is a software supply-chain attack?",
        a: "An attack that compromises something you depend on rather than your own code — a dependency, a build tool, a CI Action, or a base image — so that every project trusting that component is compromised at once. SolarWinds and Codecov are well-known examples.",
      },
      {
        q: "How do I reduce supply-chain risk?",
        a: "Pin dependencies and CI Actions to immutable SHAs, generate an SBOM, scan for known-vulnerable packages, restrict CI permissions, and watch for typosquatted packages. GateTest's dependencies, ci-security, and dockerfile modules check these automatically.",
      },
    ],
  },
  {
    slug: "sbom",
    term: "Software Bill of Materials (SBOM)",
    abbreviation: "SBOM",
    shortDef:
      "An SBOM is a machine-readable inventory of every component in a piece of software — each dependency, its version, and its license. It's what lets you answer 'are we affected?' in minutes when the next critical CVE drops.",
    body: [
      "A Software Bill of Materials is to software what an ingredients list is to food: a complete, structured manifest of every component that went into the build, including transitive dependencies, with versions and licenses. The common formats are CycloneDX and SPDX.",
      "The reason SBOMs went from nice-to-have to mandated (US Executive Order 14028, and increasingly enterprise procurement) is incident response. When Log4Shell broke, the teams that could answer 'do we ship a vulnerable Log4j, and where' in minutes had an SBOM; everyone else spent days grepping build logs. An SBOM turns that question into a lookup.",
      "An SBOM is only useful if it's current and verifiable, so it's generated as part of the build and stored alongside the artifact — not written by hand after the fact.",
    ],
    gatetest:
      "GateTest exposes an SBOM endpoint and inventories dependencies as part of a scan, so the components it's reasoning about are enumerated rather than implicit. Paired with the dependencies and CVE-feed modules, the same inventory drives 'are we affected' answers and version-bump fixes.",
    related: ["sca", "supply-chain-security", "sast"],
    modules: ["dependencies", "cveFeed"],
    faqs: [
      {
        q: "Why do I need an SBOM?",
        a: "So you can answer 'are we affected?' immediately when a new critical CVE is disclosed. An SBOM is a complete, machine-readable inventory of your components and versions, which turns incident response from a multi-day grep into a lookup. It is also increasingly required by regulation and enterprise procurement.",
      },
      {
        q: "What formats are SBOMs in?",
        a: "The two widely-used standards are CycloneDX and SPDX. Both are machine-readable and list every component, its version, and its license, including transitive dependencies.",
      },
    ],
  },
  {
    slug: "secret-scanning",
    term: "Secret Scanning",
    shortDef:
      "Secret scanning detects credentials — API keys, tokens, private keys, passwords — accidentally committed to source code, so they can be revoked before an attacker finds them. Once a secret hits git history, it's compromised until rotated.",
    body: [
      "Developers leak secrets constantly: an AWS key pasted into a config to test something, a Stripe token hardcoded 'temporarily', a private key checked in by an over-eager `git add .`. Secret scanning finds those credentials by matching known patterns (AKIA-prefixed AWS keys, GitHub PATs, JWT shapes, PEM blocks) and high-entropy strings.",
      "The critical thing to understand is that git history is permanent. The moment a secret is pushed, it must be treated as compromised — deleting it in a later commit does nothing, because the value still sits in the history and on every clone and fork. The only real remediation is to rotate the credential, then purge history if needed.",
      "That's why secret scanning belongs at the gate, before the push lands: catching the key in a pre-push hook or a pull-request check is the difference between 'don't commit that' and an incident-response exercise.",
    ],
    gatetest:
      "GateTest's secrets module detects AWS keys, GitHub PAT/OAuth/fine-grained tokens, Stripe live/restricted keys, Slack, Google, and Anthropic keys, private keys, and JWTs. The secret-rotation module goes further — it dates credential-shaped strings via git history and flags ones that are stale or overdue for rotation, plus .env vs .env.example drift.",
    related: ["sast", "supply-chain-security", "shift-left"],
    modules: ["secrets", "secretRotation"],
    faqs: [
      {
        q: "I deleted the secret in a later commit — am I safe?",
        a: "No. Git history is permanent: the secret still exists in earlier commits and on every clone and fork. The only safe remediation is to rotate (revoke and reissue) the credential, then optionally rewrite history. Treat any committed secret as compromised.",
      },
      {
        q: "Where should secret scanning run?",
        a: "As early as possible — ideally a pre-push hook or a pull-request check — so the secret is caught before it ever lands in the shared history. GateTest runs secret detection at the gate for exactly this reason.",
      },
    ],
  },
  {
    slug: "shift-left",
    term: "Shift Left",
    shortDef:
      "Shift left means moving testing and security earlier in the development lifecycle — into the editor, the commit, and the pull request — instead of waiting for a pre-release audit, because a bug caught at authoring time costs a fraction of one caught in production.",
    body: [
      "Picture the development lifecycle as a left-to-right timeline: write code, review, merge, deploy, run in production. 'Shifting left' means catching problems as far toward the writing end as possible.",
      "The economic argument is overwhelming and well-measured: a defect found while the author is still looking at the code costs almost nothing to fix; the same defect found in a security audit costs more; found in production it costs dramatically more, plus incident response and reputational damage. Pushing detection left compresses that cost curve.",
      "In practice, shifting left means a SAST check in CI on every pull request, a secret scan in a pre-push hook, dependency checks at install time, and fast feedback that lands while the change is fresh. The failure mode to avoid is shifting left so aggressively (or noisily) that developers route around the checks — speed and signal-to-noise matter as much as placement.",
    ],
    gatetest:
      "GateTest is built to shift left: it runs as a GitHub Action on every pull request, as a local pre-push hook for instant feedback, and as an on-demand scan — surfacing findings while the author still has the context, with auto-fix PRs on the Scan + Fix tier so the fix is as fast as the finding.",
    related: ["sast", "quality-gate", "secret-scanning", "false-positive-rate"],
    modules: [],
    faqs: [
      {
        q: "Why is shifting left cheaper?",
        a: "Because the cost of fixing a defect rises sharply the later it's found. A bug caught while the author is still in the code is trivial to fix; the same bug in production carries fix cost plus incident response and downtime. Catching it early compresses that curve.",
      },
      {
        q: "Can you shift left too far?",
        a: "Yes — if the checks are slow or noisy, developers learn to bypass them. Effective shift-left pairs early placement with fast feedback and a low false-positive rate, which is why those are core GateTest design goals.",
      },
    ],
  },
  {
    slug: "technical-debt",
    term: "Technical Debt",
    shortDef:
      "Technical debt is the implied future cost of choosing a fast or easy solution now instead of a better one that would take longer. Like financial debt, it accrues interest — every shortcut makes future changes slower until it's paid down.",
    body: [
      "Ward Cunningham coined the metaphor: shipping imperfect code to learn quickly is like borrowing money. It can be a smart trade — you get to market sooner — but you owe a principal (the cleanup) and you pay interest (every future change in that area is harder, slower, and more bug-prone until you refactor).",
      "Debt comes in many forms: duplicated logic that must be changed in five places, a function that's grown to 300 lines, missing tests that make every edit risky, a dependency three major versions behind, dead code nobody dares delete, suppressed type errors. Some is deliberate and tracked; the dangerous kind is the unintentional drift nobody is measuring.",
      "The point of measuring it is not zero debt — that's neither achievable nor worthwhile — but keeping it visible and serviceable, so teams make the borrow-or-pay decision deliberately instead of waking up insolvent.",
    ],
    gatetest:
      "A large slice of GateTest's modules quantify technical debt rather than security: duplicateCode, deadCode, codeQuality (function length, complexity, TODO/FIXME), typescriptStrictness (any-leaks, @ts-ignore abuse), importCycle, and the architecture-drift checks. Each finding is a concrete, located line of debt you can choose to service.",
    related: ["quality-gate", "false-positive-rate", "mutation-testing", "sast"],
    modules: ["duplicateCode", "deadCode", "codeQuality", "typescriptStrictness"],
    faqs: [
      {
        q: "Is all technical debt bad?",
        a: "No. Deliberately shipping a simpler solution to move fast can be a smart trade, as long as the debt is tracked and serviced. The dangerous kind is the unintentional, unmeasured drift that quietly makes every change slower and riskier.",
      },
      {
        q: "How do you measure technical debt?",
        a: "Through concrete, located signals: code duplication, dead code, oversized functions, complexity, suppressed type errors, import cycles, and outdated dependencies. GateTest's quality modules surface each of these as a finding tied to a file and line.",
      },
    ],
  },
];

export function getAllGlossarySlugs(): string[] {
  return GLOSSARY.map((g) => g.slug);
}

export function getGlossaryBySlug(slug: string): GlossaryEntry | undefined {
  return GLOSSARY.find((g) => g.slug === slug);
}

export function getRelatedGlossary(slug: string, limit = 4): GlossaryEntry[] {
  const entry = getGlossaryBySlug(slug);
  if (!entry) return [];
  const out: GlossaryEntry[] = [];
  for (const rel of entry.related) {
    const e = getGlossaryBySlug(rel);
    if (e) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
