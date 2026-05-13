# Product Hunt — GateTest

**Name:** GateTest

**Tagline (max 60 chars):**

> 67-module code QA gate. Native MCP. Kills SonarQube.

**Alt taglines:**

- "Code QA built for agents. One MCP install. 67 modules."
- "The one quality gate that Claude Code can call as a tool."

**Description (260 chars):**

> Code quality has never been unified. Snyk for security, ESLint for style, hadolint for Dockerfiles, kube-score for k8s, gitleaks for secrets, tfsec for Terraform — different configs, different bills. GateTest is 67 modules behind one zero-dep CLI. With native MCP support.

**Gallery copy (write 4-6 short captions for screenshots):**

1. **One install. 67 modules.** Screenshot: `gatetest --list` showing the catalog.
2. **AI-native: agents call it directly.** Screenshot: Claude Code calling
   `gatetest_explain_check` and getting back a structured fix recipe.
3. **Catches what others miss.** Screenshot: a money-as-float finding in JS
   alongside the safe-harbour decimal.js fix.
4. **Pay on completion.** Screenshot: the gatetest.ai checkout flow showing
   "Customer only charged after scan delivers."
5. **Zero dependencies, runs anywhere.** Screenshot: `npm install -g gatetest`
   on a clean box, no peer-dep noise.

**Topics:** Developer Tools, DevOps, Security, Code Quality, Open Source,
Artificial Intelligence

**First comment (hunter to post):**

> Hi PH! Maker here. GateTest replaces my whole personal QA stack (SonarQube, Snyk, gitleaks, hadolint, actionlint, kube-score, tfsec, ts-prune...) with one CLI. Zero npm deps. Native MCP support so Claude Code / Cursor / Cline can invoke it as a tool — when the agent finds an issue, it can ask GateTest "what does this mean and how do I fix it?" and get a structured fix recipe back.
>
> Free CLI. Optional paid web scans (pay-on-completion via Stripe — you only get charged after the scan delivers).
>
> Two questions I'd love the PH community to weigh in on:
> 1. What's the next module you'd want? We have 67 today but the backlog is open.
> 2. Which AI agent should we add native MCP examples for next? (We have Claude Code, Cursor, Cline, Windsurf, Continue today.)
>
> AMA below.
