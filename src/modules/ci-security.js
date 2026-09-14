/**
 * CI Security Module — hardens CI pipeline definitions.
 *
 * Supply-chain attackers target CI before application code — pinning,
 * permissions, and untrusted-input handling are the three big wins this
 * module enforces. Discovery covers GitHub Actions (`.github/workflows/*`),
 * GitLab CI (`.gitlab-ci.yml`), CircleCI (`.circleci/*.yml`), Azure
 * Pipelines (`azure-pipelines.yml`), Bitbucket Pipelines
 * (`bitbucket-pipelines.yml`) and Buildkite (`.buildkite/*.yml`). The
 * GitHub-specific rules (pinning, pwn-request, permissions) run on GitHub
 * files only; shell injection and secrets-in-logs are generic and run on
 * every host (KI #106, 2026-09-05 — before that the module opened GitHub
 * and GitLab files only, and GitLab's `script:` lists were never read).
 *
 * Rules implemented (all line-heuristic, zero network, zero deps):
 *   - `uses: owner/action@<branch>` — pin to a SHA or at least a tag
 *   - `pull_request_target` trigger — warns, then errors if checkout
 *     pulls the PR head commit (the pwn-request sink)
 *   - shell text containing an expansion the HOST substitutes before the
 *     shell runs and an outsider controls: `${{ github.event.* }}` /
 *     `${{ github.head_ref }}`, `<< pipeline.git.branch >>`,
 *     `$(Build.SourceBranchName)`, `$BUILDKITE_BRANCH` (interpolated by
 *     `pipeline upload`) — command injection. A host env var read by the
 *     shell (`$CIRCLE_BRANCH`, `$BITBUCKET_BRANCH`, `$CI_COMMIT_REF_NAME`)
 *     is the SAFE idiom and stays quiet — until the script re-parses it as
 *     code (`eval`, `sh -c`, `python -c`, `node -e`), which fires on every
 *     host including GitHub's `$GITHUB_HEAD_REF`.
 *   - shell text echoing `${{ secrets.* }}` or a `$VAR` whose name says it
 *     is a secret (`*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*_API_KEY`…) to
 *     stdout — leaks to logs. Redirected to a file, piped (`docker login
 *     --password-stdin`) or captured (`<(echo …)`, `$(echo …)`) is not
 *     stdout and stays quiet.
 *   - `continue-on-error: true` on a step that runs `gatetest` —
 *     explicitly forbidden by the Bible (Forbidden #24: never soft-fail
 *     the gate)
 *   - Workflow missing a top-level `permissions:` block — default
 *     GITHUB_TOKEN is read/write which is rarely needed
 *   - Workflow with an `on: workflow_run:` trigger but no `actions: read`
 *     in `permissions:` — the GITHUB_TOKEN default doesn't include
 *     `actions:` scope, so any `gh run view` / `gh run download` / direct
 *     `/repos/.../actions/runs/...` API call silently 403s. The downstream
 *     workflow runs, errors out fetching upstream logs, and the operator
 *     spends hours blaming the wrong layer. Crontech's ai-deploy-supervisor
 *     hit this in production 2026-05-24 — every failed-deploy diagnosis
 *     hid behind the supervisor's own 403.
 *   - Workflow using `github/codeql-action/upload-sarif@*` but no
 *     `actions: read` in `permissions:` — the upload step calls the
 *     workflow-runs API to attach SARIF results to the right run.
 *     Without the scope it fails with `"Resource not accessible by
 *     integration"` and the GitHub Security tab never sees the SARIF.
 *     Crontech's stale-installed GateTest workflow hit this 2026-05-25;
 *     OUR OWN ci.yml had the same bug. Static catch prevents recurrence.
 *     WARNING, not error (2026-09-14): GitHub's own upload-sarif docs
 *     require `actions: read` only for PRIVATE repositories — on a
 *     public one `security-events: write` is enough and the upload
 *     succeeds. The file cannot say which kind of repo it runs in, so
 *     a blocking verdict was a guess: gin-gonic/gin (public) was
 *     gate-BLOCKED on its trivy-scan.yml, which works as written.
 *
 * TODO(gluecron): when Gluecron ships a CI model, mirror these heuristics
 * to Gluecron pipeline YAML (same attack surface, different filename).
 */

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');

// Pinned short SHA or full SHA — 7-40 hex chars.
const SHA_REGEX = /^[a-f0-9]{7,40}$/i;
// Semver-ish tags like v1, v1.2, v1.2.3, 2.0.0, v3-foo — prefer these
// over branch names, but still warn (SHA is the gold standard).
const TAG_LOOKS_SEMVER = /^v?\d+(\.\d+)*([.-][A-Za-z0-9_.-]+)?$/;
// Pull-request-target + untrusted checkout is the classic pwn-request.
const DANGEROUS_PR_REF = /github\.event\.pull_request\.head\.(sha|ref)|github\.head_ref/;

// Per host: where shell text lives (`keys`), the expansions the host
// substitutes into that text BEFORE the shell runs and an outsider controls
// (`template` — the injection surface; commit SHAs and numeric ids are
// omitted by construction, they cannot carry shell metacharacters), and the
// env vars that carry outsider text (`env` — safe to read as `$VAR`, unsafe
// when re-parsed as code). `<< pipeline.parameters.* >>` is NOT untrusted:
// it is declared and typed by the maintainer in the same file (nest
// .circleci/config.yml line 115 uses one in `run:`).
const HOSTS = {
  github: { label: 'GitHub event', keys: ['run'], template: null,
    env: 'GITHUB_(?:HEAD_REF|REF_NAME|REF)' },
  gitlab: { label: 'GitLab CI', keys: ['script', 'before_script', 'after_script'], template: null,
    env: 'CI_(?:COMMIT_(?:REF_NAME|REF_SLUG|BRANCH|TAG|MESSAGE|TITLE|DESCRIPTION|AUTHOR)|MERGE_REQUEST_(?:SOURCE_BRANCH_NAME|TARGET_BRANCH_NAME|TITLE|DESCRIPTION|LABELS))' },
  circleci: { label: 'CircleCI pipeline', keys: ['run', 'command'],
    template: /<<\s*pipeline\.git\.(?:branch|tag)\s*>>/,
    env: 'CIRCLE_(?:BRANCH|TAG|PR_USERNAME|PR_REPONAME|USERNAME)' },
  azure: { label: 'Azure Pipelines', keys: ['script', 'bash', 'pwsh', 'powershell', 'inlineScript'],
    template: /\$\((?:Build\.(?:SourceBranch(?:Name)?|SourceVersionMessage|RequestedFor(?:Email)?)|System\.PullRequest\.(?:SourceBranch|TargetBranch|SourceRepositoryUri))\)/i,
    env: 'BUILD_(?:SOURCEBRANCH(?:NAME)?|SOURCEVERSIONMESSAGE|REQUESTEDFOR(?:EMAIL)?)|SYSTEM_PULLREQUEST_(?:SOURCEBRANCH|TARGETBRANCH)' },
  bitbucket: { label: 'Bitbucket Pipelines', keys: ['script', 'after-script'], template: null,
    env: 'BITBUCKET_(?:BRANCH|TAG|PR_DESTINATION_BRANCH)' },
  // `buildkite-agent pipeline upload` interpolates `$VAR` into the YAML
  // before the shell sees it; `$$VAR` is the escape that defers to the shell.
  buildkite: { label: 'Buildkite build', keys: ['command', 'commands'],
    template: /(?<!\$)\$\{?BUILDKITE_(?:BRANCH|TAG|MESSAGE|LABEL|BUILD_AUTHOR(?:_EMAIL)?|BUILD_CREATOR(?:_EMAIL)?|PULL_REQUEST_(?:BASE_BRANCH|REPO))\b/,
    env: 'BUILDKITE_(?:BRANCH|TAG|MESSAGE|LABEL|BUILD_AUTHOR(?:_EMAIL)?|BUILD_CREATOR(?:_EMAIL)?|PULL_REQUEST_(?:BASE_BRANCH|REPO))' },
};
for (const h of Object.values(HOSTS)) {
  h.keyRe = new RegExp(`^\\s*(?:-\\s*)?(?:${h.keys.join('|')})\\s*:`);
  // The value is re-parsed as code: `eval "$X"`, `sh -c "… $X"`, `python -c`…
  h.reparseRe = new RegExp(`\\b(?:eval|(?:ba|z|da)?sh\\s+-c|python[23]?\\s+-c|node\\s+-e|ruby\\s+-e|perl\\s+-e)\\b.*\\$\\{?(?:${h.env})\\b`);
}
// `echo … $NPM_TOKEN` / `${DB_PASSWORD}` / `$(MY_SECRET)` — a secret named as
// one. Matched on the text after `echo`; a redirect or pipe means it did not
// reach stdout.
const SECRET_VAR_RE = /\$[{(]?[A-Za-z0-9_]*?(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Za-z0-9_]*\b/i;

class CiSecurityModule extends BaseModule {
  constructor() {
    super('ciSecurity', 'CI Security — action pinning, pwn-request, shell injection, secrets-in-logs, permissions, forbidden soft-fail');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findWorkflows(projectRoot);

    if (files.length === 0) {
      result.addCheck('ci-security:no-files', true, {
        severity: 'info',
        message: 'No CI workflow files found — skipping',
      });
      return;
    }

    result.addCheck('ci-security:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} CI workflow file(s)`,
    });

    let totalIssues = 0;
    for (const file of files) {
      totalIssues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('ci-security:summary', true, {
      severity: 'info',
      message: `CI security scan: ${files.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _findWorkflows(projectRoot) {
    const out = [];
    for (const dir of [['.github', 'workflows'], ['.circleci'], ['.buildkite']]) {
      const abs = path.join(projectRoot, ...dir);
      if (!fs.existsSync(abs)) continue;
      for (const name of fs.readdirSync(abs)) {
        if (/\.ya?ml$/i.test(name)) out.push(path.join(abs, name));
      }
    }
    for (const name of ['.gitlab-ci.yml', 'azure-pipelines.yml', 'azure-pipelines.yaml', 'bitbucket-pipelines.yml']) {
      const abs = path.join(projectRoot, name);
      if (fs.existsSync(abs)) out.push(abs);
    }
    return out;
  }

  /** Which CI host owns this file — decides the shell grammar and which rules apply. */
  static hostOf(rel) {
    if (/(?:^|\/)\.github\/workflows\/[^/]+$/.test(rel)) return 'github';
    if (/(?:^|\/)\.circleci\/[^/]+$/.test(rel)) return 'circleci';
    if (/(?:^|\/)\.buildkite\/[^/]+$/.test(rel)) return 'buildkite';
    if (/(?:^|\/)azure-pipelines\.ya?ml$/.test(rel)) return 'azure';
    if (/(?:^|\/)bitbucket-pipelines\.yml$/.test(rel)) return 'bitbucket';
    return 'gitlab';
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return 0;
    }

    const rel = repoRelative(projectRoot, file);
    const lines = content.split(/\r?\n/);
    let issues = 0;

    let hasPermissionsBlock = false;
    let hasPullRequestTarget = false;
    let hasCheckoutPrHead = false;
    const host = HOSTS[CiSecurityModule.hostOf(rel)];
    const isGitHubActions = host === HOSTS.github;
    // `workflow_run` trigger downstream of another workflow needs explicit
    // `actions: read` to fetch the upstream run's logs/artifacts via API.
    // Default GITHUB_TOKEN omits the `actions:` scope.
    let hasWorkflowRunTrigger = false;
    // `github/codeql-action/upload-sarif@*` also needs `actions: read`
    // to attach SARIF results to the workflow run via the API. Without
    // it, the SARIF upload step fails with "Resource not accessible by
    // integration" and the customer's GitHub Security tab never updates.
    let hasCodeqlSarifUpload = false;
    // Granted by an exact `actions: read` / `actions: write` line under a
    // `permissions:` block. We also accept `permissions: read-all` /
    // `write-all` (covered by the separate `hasReadAllOrWriteAll` flag) —
    // those grant every scope including `actions`.
    let hasActionsScopeGranted = false;
    let hasReadAllOrWriteAll = false;

    // Track the most recent step name so continue-on-error diagnostics
    // can reference the step.
    let lastRun = '';

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const line = raw.replace(/\s+$/, '');
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Top-level permissions detection (left-most indentation).
      if (/^permissions\s*:/.test(line)) hasPermissionsBlock = true;

      // `permissions: read-all` / `write-all` is a shorthand that grants
      // every scope including `actions:` — satisfies the workflow_run
      // requirement without an explicit `actions:` line.
      if (/^\s*permissions\s*:\s*(?:read-all|write-all)\s*(?:#.*)?$/i.test(line)) {
        hasReadAllOrWriteAll = true;
      }

      // Explicit `actions: read` / `actions: write` line under a
      // `permissions:` block. Must be the entire value on the line — not
      // a substring — so workflow names like `name: GitHub Actions Foo`
      // don't false-positive. Trailing comment allowed.
      if (/^\s*actions\s*:\s*(?:read|write)\s*(?:#.*)?$/i.test(line)) {
        hasActionsScopeGranted = true;
      }

      // Event triggers
      if (isGitHubActions && /^\s*pull_request_target\s*:/.test(line)) {
        hasPullRequestTarget = true;
      }
      // Downstream workflow trigger — silent-403 footgun if no actions: read.
      if (isGitHubActions && /^\s*workflow_run\s*:/.test(line)) {
        hasWorkflowRunTrigger = true;
      }
      // codeql-action/upload-sarif — same actions:read requirement as
      // workflow_run, different failure mode. Matches any version pin.
      if (isGitHubActions && /github\/codeql-action\/upload-sarif@/.test(line)) {
        hasCodeqlSarifUpload = true;
      }

      // `uses: ...` pinning check
      const usesMatch = trimmed.match(/^(?:-\s*)?uses\s*:\s*['"]?([^'"#\s]+)['"]?/);
      if (usesMatch) {
        const ref = usesMatch[1];
        // Skip Docker-ref `docker://...` and local paths (`./...`, `./.github/...`)
        if (!/^(docker:|\.\/|\.\.\/)/.test(ref) && ref.includes('@')) {
          const [, version] = ref.split('@');
          if (!version) {
            // "uses: owner/action" with no ref — implicit default branch
            issues += this._flag(result, `ci-security:unpinned:no-ref:${rel}:${i + 1}`, {
              severity: 'warning',
              file: rel,
              line: i + 1,
              message: `"${ref}" has no @ref — defaults to the action's default branch (non-reproducible)`,
              suggestion: 'Pin to a full commit SHA (preferred) or a release tag.',
            });
          } else if (SHA_REGEX.test(version)) {
            // Good — SHA pin.
          } else if (TAG_LOOKS_SEMVER.test(version)) {
            // Acceptable, but worth a gentle info note: semver tags can be moved.
            issues += this._flag(result, `ci-security:tag-pin:${rel}:${i + 1}`, {
              severity: 'info',
              file: rel,
              line: i + 1,
              message: `"${ref}" pinned to a semver tag — tags are mutable; SHA pinning is safer`,
              suggestion: 'Run `gh api /repos/OWNER/REPO/commits/<tag> --jq .sha` to get the SHA and pin to it.',
            });
          } else {
            // Anything else = branch name / unknown. Two shapes are mutable
            // but not a supply-chain finding worth a red build (2026-09-05,
            // axum / vapor / ktor):
            //   - a CHANNEL ref on a toolchain-selector action —
            //     `dtolnay/rust-toolchain@stable` is that action's documented
            //     use; "stable" is the toolchain, not a branch to hijack;
            //   - a reusable workflow from the repository's OWN owner
            //     (`vapor/ci/.github/workflows/x.yml@main`) — inside the
            //     trust boundary, mutable by the same people who can edit
            //     this file.
            // Both stay reported, as warnings. A third-party `@main` is the
            // real risk and stays an error.
            const actionPath = ref.split('@')[0];
            const isChannel = (/^(?:stable|beta|nightly|latest)$/i.test(version)
              && /^(?:dtolnay\/rust-toolchain|actions-rs\/toolchain|oven-sh\/setup-bun|denoland\/setup-deno)$/i.test(actionPath))
              // taiki-e/install-action's documented form is `@<tool-name>`
              // (`@cargo-hack`, `@nextest`): a per-tool pointer the action
              // maintains, the same channel shape.
              || /^taiki-e\/install-action$/i.test(actionPath);
            const ownerOfRef = actionPath.split('/')[0].toLowerCase();
            const isOwnReusable = /\/\.github\/workflows\/[^/]+\.ya?ml$/i.test(actionPath)
              && ownerOfRef !== '' && ownerOfRef === this._repoOwner(projectRoot);
            issues += this._flag(result, `ci-security:branch-pin:${rel}:${i + 1}`, {
              severity: isChannel || isOwnReusable ? 'warning' : 'error',
              file: rel,
              line: i + 1,
              message: isChannel
                ? `"${ref}" follows a toolchain channel, not a version — reproducible builds pin the toolchain version too`
                : isOwnReusable
                  ? `"${ref}" is your own reusable workflow on a branch — mutable, inside your trust boundary; pin it for reproducibility`
                  : `"${ref}" pinned to a branch/non-version ref — the action can change under you at any time (supply-chain risk)`,
              suggestion: 'Pin to a specific commit SHA or an immutable tag.',
            });
          }
        }

        // PR-target + untrusted checkout sink
        if (/actions\/checkout/i.test(ref)) {
          // Look ahead a few lines for a `ref: ${{ ... head ... }}` line
          for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
            if (DANGEROUS_PR_REF.test(lines[j])) {
              hasCheckoutPrHead = true;
              break;
            }
          }
        }
      }

      // Shell-text key for this host (`run:`, `script:`, `command:`…) —
      // track as "last run" and scan for injection / secrets
      if (host.keyRe.test(line)) {
        lastRun = trimmed;
        issues += this._scanRunInjection(line, lines, i, rel, result, host);
      }

      // continue-on-error: true on the GATE step itself (not on auxiliary
      // upload / artifact / SARIF steps that happen to live in the same job
      // as a gate step). Bible Forbidden #24 scopes specifically to the gate
      // step that EXECUTES `gatetest`. We detect this by looking back up to
      // 4 lines for an explicit `run: ... gatetest` invocation — not just
      // any line mentioning gatetest (which would also catch step `name:`
      // labels, comments, and the upload-sarif step that references the
      // gate's output path).
      if (/^\s*continue-on-error\s*:\s*true\b/i.test(line)) {
        const lookback = lines.slice(Math.max(0, i - 4), i).join('\n');
        if (/\brun\s*:.*gatetest/i.test(lookback)) {
          issues += this._flag(result, `ci-security:soft-fail-gate:${rel}:${i + 1}`, {
            severity: 'error',
            file: rel,
            line: i + 1,
            message: '`continue-on-error: true` on a GateTest step — Bible Forbidden #24: never soft-fail the gate',
            suggestion: 'Remove `continue-on-error` on the GateTest step. If the gate fails, the build MUST fail.',
          });
        }
      }
    }

    if (isGitHubActions && !hasPermissionsBlock) {
      issues += this._flag(result, `ci-security:no-permissions:${rel}`, {
        severity: 'warning',
        file: rel,
        message: `${rel} has no top-level \`permissions:\` block — GITHUB_TOKEN defaults to broad read/write scopes`,
        suggestion: 'Add `permissions: { contents: read }` at the top and opt in to only the scopes each job needs.',
      });
    }

    // workflow_run trigger without actions: read = silent 403 on every
    // upstream-log fetch. Warn (not error) — the trigger itself is fine,
    // and a workflow that doesn't actually call /actions/runs/* won't
    // hit the 403. But it's the highest-rate silent-failure footgun in
    // multi-workflow CI graphs.
    if (hasWorkflowRunTrigger && !hasActionsScopeGranted && !hasReadAllOrWriteAll) {
      issues += this._flag(result, `ci-security:workflow-run-missing-actions-read:${rel}`, {
        severity: 'warning',
        file: rel,
        message: `${rel} triggers on \`workflow_run\` but \`permissions:\` does not grant \`actions: read\` — \`gh run view\`, \`gh run download\`, and direct \`/repos/.../actions/runs/*\` API calls will silently 403`,
        suggestion: 'Add `actions: read` to the workflow\'s `permissions:` block (or job-level `permissions:`). Without it, fetching logs / artifacts / status from the upstream run will fail with no useful error — your supervisor workflow runs but its own diagnosis hides behind a 403.',
      });
    }

    // codeql-action/upload-sarif without actions:read = SARIF never
    // reaches the Security tab — on a PRIVATE repository. GitHub's
    // upload-sarif docs require `actions: read` only there; on a public
    // repository `security-events: write` is enough and the upload
    // succeeds. The workflow file cannot say which kind of repository it
    // runs in, so the verdict is a warning that names the condition: it
    // was an error until 2026-09-14, when gin-gonic/gin (public, 80k
    // stars) was gate-BLOCKED on a trivy-scan.yml that works as written.
    // Same root cause and one-line fix as the workflow_run case above.
    if (hasCodeqlSarifUpload && !hasActionsScopeGranted && !hasReadAllOrWriteAll) {
      issues += this._flag(result, `ci-security:codeql-sarif-missing-actions-read:${rel}`, {
        severity: 'warning',
        file: rel,
        message: `${rel} uses \`github/codeql-action/upload-sarif\` but \`permissions:\` does not grant \`actions: read\` — on a PRIVATE repository the upload fails with "Resource not accessible by integration" and the GitHub Security tab never sees the results; a public repository does not need the scope`,
        suggestion: 'If this repository is private, add `actions: read` to the job\'s `permissions:` block (alongside `security-events: write` and `contents: read`) — upload-sarif calls the workflow-runs API to attach results to the right run. On a public repository nothing is needed; adding the scope anyway is harmless and makes the workflow portable.',
      });
    }

    if (hasPullRequestTarget && hasCheckoutPrHead) {
      issues += this._flag(result, `ci-security:pwn-request:${rel}`, {
        severity: 'error',
        file: rel,
        message: `${rel} uses \`pull_request_target\` AND checks out the PR head — classic pwn-request RCE pattern`,
        suggestion: 'Either use `pull_request` instead, or do not check out the untrusted head in a privileged context.',
      });
    } else if (hasPullRequestTarget) {
      issues += this._flag(result, `ci-security:pr-target:${rel}`, {
        severity: 'warning',
        file: rel,
        message: `${rel} uses \`pull_request_target\` — runs with write tokens and repo secrets; audit carefully`,
        suggestion: 'Prefer `pull_request` unless you genuinely need PR-write permissions. Never check out the PR head in the same job.',
      });
    }

    // Ensure we reference lastRun somewhere so lint doesn't complain.
    void lastRun;

    return issues;
  }

  /**
   * The shell text that starts at a shell key: the inline value, a `|` / `>`
   * block scalar, or a list of commands (`script:` / `commands:`). A map
   * value (CircleCI `run:` → `name:` / `command:`) is not shell text — its
   * `command:` key is scanned on its own turn. The block ends where the
   * indentation returns to the KEY's column, so a sibling `env:` mapping
   * after `- run: |` is not read as part of the script.
   */
  /**
   * Is line `k` inside a `{ … }` group whose closing brace is redirected or
   * piped — `{ echo "KEY=$SECRET"; … } >> "$GITHUB_ENV"`? Then the echo
   * never reaches stdout: the group's output does, into the file. prisma's
   * ci.yml:440 writes four Supabase values to GITHUB_ENV this way; it had
   * scored 0.2 by accident (a phantom JavaScript comment in a YAML file) and
   * became a blocking finding the day the scorer masked YAML as YAML
   * (2026-09-05). A `${…}` expansion is not a group opener.
   */
  _groupRedirected(block, k) {
    const opens = (t) => t === '{' || (/\{\s*$/.test(t) && !/\$\{\s*$/.test(t));
    const closes = (t) => /^\}/.test(t);
    let depth = 0;
    for (let i = k - 1; i >= 0; i -= 1) {
      const t = block[i].trim();
      if (closes(t)) { depth += 1; continue; }
      if (!opens(t)) continue;
      if (depth > 0) { depth -= 1; continue; }
      let inner = 0;
      for (let j = k + 1; j < block.length; j += 1) {
        const u = block[j].trim();
        if (opens(u)) { inner += 1; continue; }
        if (!closes(u)) continue;
        if (inner > 0) { inner -= 1; continue; }
        return /^\}\s*(?:\d?>>?|\|)/.test(u);
      }
      return false;
    }
    return false;
  }

  _collectShellBlock(startLine, lines, startIdx) {
    const block = [startLine];
    const m = startLine.match(/^(\s*)(-\s*)?[\w-]+\s*:\s*(.*)$/);
    if (!m) return block;
    const baseIndent = m[1].length + (m[2] ? m[2].length : 0);
    const value = m[3];
    const isBlockScalar = /^[|>]/.test(value);
    if (value.trim() && !isBlockScalar) return block;
    const indentOf = (l) => l.match(/^(\s*)/)[1].length;
    if (!isBlockScalar) {
      const next = lines.slice(startIdx + 1).find((l) => l.trim());
      if (!next || !/^\s*-\s/.test(next) || indentOf(next) <= baseIndent) return block;
    }
    for (let j = startIdx + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (!l.trim()) { block.push(l); continue; }
      if (indentOf(l) <= baseIndent) break;
      block.push(l);
    }
    return block;
  }

  /**
   * Scan a shell-text key and its block for shell-injection and
   * secrets-echo patterns. `host` is the HOSTS entry for the file.
   */
  _scanRunInjection(startLine, lines, startIdx, rel, result, host = HOSTS.github) {
    let issues = 0;
    const block = this._collectShellBlock(startLine, lines, startIdx);

    for (let k = 0; k < block.length; k += 1) {
      const l = block[k];
      const lineNo = startIdx + 1 + k;
      const injection = this._injectionOn(l, host);
      if (injection) {
        issues += this._flag(result, `ci-security:shell-injection:${rel}:${lineNo}`, {
          severity: 'error',
          file: rel,
          line: lineNo,
          message: `Untrusted ${host.label} data ${injection.how} — command injection risk`,
          suggestion: injection.fix,
        });
      }
      // `echo` whose output is captured — `<(echo "$PGPASSWORD")` (django
      // postgis.yml:63, an initdb --pwfile), `$(echo …)`, backticks — or
      // redirected / piped never reaches stdout.
      const echoed = /\becho\b(.*)$/.exec(l);
      const captured = echoed && (/(?:[<$]\(|`)\s*$/.test(l.slice(0, echoed.index)) || this._groupRedirected(block, k));
      const secretEnv = echoed && !captured && SECRET_VAR_RE.test(echoed[1]) && !/[|>]/.test(echoed[1]);
      if (/\becho\b.*\$\{\{\s*secrets\./.test(l) || secretEnv) {
        issues += this._flag(result, `ci-security:secret-echo:${rel}:${lineNo}`, {
          severity: 'error',
          file: rel,
          line: lineNo,
          message: 'Secret piped to `echo` — shows up in logs and in any downstream action that reads stdout',
          suggestion: 'Never echo secrets. Pass them via env vars; the host may mask them but logs can still leak transformed versions.',
        });
      }
    }
    return issues;
  }

  /**
   * Why a line is injectable, or null. Three shapes: a GitHub event
   * expansion with a free-text leaf, a host template expansion of an
   * outsider-controlled value, or a host env var re-parsed as code.
   */
  _injectionOn(l, host) {
    if (host === HOSTS.github) {
      // A `github.event.*` expansion is injectable when the value is free
      // text an outsider controls (`head_ref`, `pull_request.title`,
      // `comment.body`, `release.tag_name`). A commit SHA (40 hex chars) or a
      // numeric `number`/`id` cannot carry shell metacharacters — prisma's
      // `--baseline-commit ${{ github.event.pull_request.base.sha }}` was
      // reported as injection (2026-09-05). GitHub's own guidance draws the
      // same line.
      // Every expansion on the line, not the first: `echo "${{ …base.sha }}"
      // "${{ …issue.body }}"` was judged by the safe SHA and the body rode
      // through (#418's control pair, 2026-09-02).
      const leaves = [...l.matchAll(/\$\{\{\s*github\.event\.([\w.]+)/g)].map((m) => m[1]);
      const unsafe = leaves.some((leaf) => !/(?:^|\.)(?:sha|number|id|node_id|run_number|run_id)$/.test(leaf));
      if (unsafe || /\$\{\{\s*github\.head_ref\s*\}\}/.test(l)) {
        return { how: 'interpolated into a shell script', fix: 'Assign to an env var via `env:` with ${{ github.event.* }} and reference it as $VAR in the shell. GitHub Actions expansion into a shell is unsafe.' };
      }
    } else if (host.template && host.template.test(l)) {
      return {
        how: 'expanded into a shell script before the shell runs',
        fix: host === HOSTS.buildkite
          ? 'Escape it as `$$BUILDKITE_VAR` so the shell, not `buildkite-agent pipeline upload`, expands it at run time — as data, not as script text.'
          : 'Map the value to an env var (`env:` / `environment:`) and read it as `$VAR` in the shell; the host expands template syntax into the script text itself.',
      };
    }
    if (host.reparseRe.test(l)) {
      return { how: 're-parsed as code (`eval` / `-c` / `-e`)', fix: 'Reading `$VAR` is safe; re-parsing it as script text is not. Pass the value as an argument or quote it as data.' };
    }
    return null;
  }

  /**
   * Owner of the repository being scanned, lower-cased: GITHUB_REPOSITORY
   * in Actions, else the `origin` remote, else null. Cached per root.
   */
  _repoOwner(projectRoot) {
    if (this._ownerCache && this._ownerCache.root === projectRoot) return this._ownerCache.owner;
    let owner = null;
    // The project's own remote first. GITHUB_REPOSITORY names the repo the
    // WORKFLOW runs in, which is only the project being scanned when the
    // scan targets the workspace checkout: on CI the corpus job scans
    // vapor with GITHUB_REPOSITORY=crclabs-hq/GateTest, and vapor's own
    // reusable workflows on @main came back as third-party errors (1 → 4,
    // 2026-09-05). The env var is the fallback for a checkout with no
    // remote, and only when the root IS the workspace.
    try {
      const url = require('child_process').execFileSync('git', ['config', '--get', 'remote.origin.url'], {
        cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const m = url.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/);
      if (m) owner = m[1].toLowerCase();
    } catch { owner = null; } // error-ok — no git or no remote: try the workflow's own identity below
    if (!owner) {
      const envRepo = process.env.GITHUB_REPOSITORY;
      const workspace = process.env.GITHUB_WORKSPACE;
      const isWorkspace = workspace && path.resolve(workspace) === path.resolve(projectRoot);
      if (envRepo && envRepo.includes('/') && isWorkspace) owner = envRepo.split('/')[0].toLowerCase();
    }
    // Still nothing: no remote, not the workspace — nothing is "our own",
    // every branch ref stays an error.
    this._ownerCache = { root: projectRoot, owner };
    return owner;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = CiSecurityModule;
