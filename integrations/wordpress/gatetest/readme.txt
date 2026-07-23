=== GateTest — AI Code Quality Scanner ===
Contributors: gatetest
Tags: code-quality, security, accessibility, ai, code-review, static-analysis, ci-cd
Requires at least: 5.8
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.txt

Scan your WordPress theme, plugin, or custom code with 67 AI-powered quality modules. Security, accessibility, and more — auto-fixed automatically.

== Description ==

**GateTest is the only code quality tool that finds your bugs AND fixes them.**

Teams duct-tape 10+ tools together — ESLint for style, SonarQube for quality, Snyk for security, Lighthouse for performance, axe for accessibility. Each has its own config, its own dashboard, its own billing. GateTest replaces all of them with a single scan.

**120 modules. One gate. One decision.**

= What GateTest scans =

**Security**
* SSRF and URL injection vulnerabilities
* Hardcoded secrets, API keys, and tokens (AKIA, GitHub PATs, Stripe keys)
* SQL injection patterns
* ReDoS catastrophic regex patterns
* Cookie security misconfigurations (httpOnly, secure flags)
* TLS certificate validation bypasses

**Code Quality**
* N+1 database query detection (Prisma, Sequelize, Mongoose, TypeORM)
* Error swallowing (empty catch blocks, `.catch(() => {})`)
* Race conditions (TOCTOU, lost-update patterns)
* Resource leaks (unclosed streams, intervals, WebSockets)
* Import cycles (circular dependencies)
* Async iteration footguns (`.forEach(async)`, `.filter(async)`)

**AI Safety** *(unique to GateTest)*
* Prompt injection surfaces in LLM-facing code
* Client-bundled API keys (`NEXT_PUBLIC_ANTHROPIC_API_KEY`)
* Unbounded `max_tokens` (cost DoS vulnerability)
* Deprecated model usage

**TypeScript**
* Strict mode enforcement
* `@ts-ignore` and `@ts-nocheck` abuse
* `any`-type leaks in exported signatures
* tsconfig regression detection

**Infrastructure**
* Dockerfile security (root user, :latest tags, secrets baked in)
* CI workflow security (unpinned actions, shell injection)
* Kubernetes manifest security
* Terraform/IaC misconfigurations

**Developer Hygiene**
* PII in logs (passwords, tokens, user data)
* Feature flag staleness
* OpenAPI drift (undocumented routes)
* Datetime/timezone bugs
* Float money anti-patterns

= How it works =

1. **Install** this plugin and enter your GateTest API key (get one free at gatetest.ai/admin)
2. **Enter** your GitHub repository URL (your theme or plugin's source code)
3. **Run** a scan — results appear in your dashboard within 60 seconds
4. **Review** the detailed findings per module
5. **Optional:** Enable weekly auto-scan to catch regressions automatically

= Auto-fix =

On the Full scan tier, GateTest uses Claude AI to read your code and automatically create a pull request fixing the issues found. You review the diff and merge — no manual debugging required.

= Pricing =

GateTest charges per scan — you only pay when the scan completes and delivers value.

* **Quick** — $29/scan — the fastest first signal (syntax, lint, secrets, code quality)
* **Full** — $99/scan — the full engine suite (88 modules; mutation + chaos run via the GitHub Action, which has a CI runner)
* **Scan + Fix** — $199/scan — everything in Full, plus an AI auto-fix PR opened in your repo

Per-scan pricing has no per-seat fees and no lock-in. Continuous scanning ($49/mo, org-wide) is also available at gatetest.ai.

= Privacy =

GateTest accesses only the GitHub repository you specify. No WordPress data, user data, or site content is ever transmitted. Only the repository URL and your API key are sent to the GateTest API. See [gatetest.ai/legal/privacy](https://gatetest.ai/legal/privacy) for the full privacy policy.

== Installation ==

1. Upload the `gatetest` folder to `/wp-content/plugins/`
2. Activate the plugin from the **Plugins** menu in WordPress
3. Go to **Settings → GateTest** and enter your API key
4. Enter the GitHub repository URL you want to scan
5. Go to **GateTest → Run Scan** and click **Run Scan**

To get a free API key:
1. Visit [gatetest.ai/admin](https://gatetest.ai/admin)
2. Go to the **API Keys** tab
3. Create a new key with your name

== Frequently Asked Questions ==

= What repositories can I scan? =

Any public or private GitHub repository. For private repositories, the GateTest GitHub App needs to be installed (free from [gatetest.ai/github/setup](https://gatetest.ai/github/setup)).

= Does GateTest only work with WordPress code? =

No — GateTest scans any JavaScript, TypeScript, Python, PHP, Go, Rust, Ruby, Java, Kotlin, Swift, or C# repository. Use it on your theme, plugin, custom API, or any codebase hosted on GitHub.

= How long does a scan take? =

Quick scans complete in under 30 seconds. Full scans (88 modules) complete in a few minutes on typical repositories. Results are shown directly in your WordPress dashboard.

= Is my code sent to GateTest's servers? =

GateTest reads your repository via the GitHub API — your code is fetched from GitHub, not uploaded from your WordPress server. Only the repository URL is sent from WordPress to the GateTest API.

= What is the auto-fix feature? =

On Full scans, GateTest uses Claude AI to read the files with issues and generate precise fixes. These fixes are submitted as a pull request to your GitHub repository. You review the changes, approve if they look correct, and merge. The AI does not push directly to your main branch.

= Can I run scans automatically? =

Yes — enable **Weekly Auto-Scan** in Settings → GateTest. GateTest will scan your repository every week and update the dashboard widget with the latest results.

= Does GateTest work with Gluecron or other git hosts? =

GateTest supports GitHub and Gluecron.com. Additional git host support is in development. Contact hello@gatetest.ai for enterprise integrations.

== Screenshots ==

1. The GateTest scan page showing module-by-module results with pass/fail status
2. The WordPress dashboard widget showing your latest quality score at a glance
3. Settings page with API key, repository URL, and tier configuration

== Changelog ==

= 1.0.0 =
* Initial release
* Full-suite scan via GateTest API
* Dashboard widget with quality score
* Weekly auto-scan via WP-Cron
* AJAX scan runner with real-time status
* Per-module results with expandable details

== Upgrade Notice ==

= 1.0.0 =
Initial release.
