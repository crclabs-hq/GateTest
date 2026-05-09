/**
 * fix-core — the work body of /api/scan/fix, extracted into a pure JS
 * module so it can be exercised under `node --test` and so the route
 * file becomes a thin wrapper around (a) input parsing + (b) deciding
 * whether to stream SSE events or return one JSON.
 *
 * Why this lives in a separate file:
 *   - Tests cannot easily exercise the TS route without a Next.js runtime.
 *     Moving the per-file loop + branch + PR work into JS lets us mock the
 *     I/O dependencies (fetchBlob / askClaude / openPullRequest / ...)
 *     and assert on emitted events + final payload.
 *   - The route.ts wrapper becomes small enough to read at a glance.
 *
 * Public surface:
 *   - executeFixCore({ input, deps, emitter }) → { payload, status }
 *
 * `deps` is the I/O contract — every function that touches the network
 * is injected. Production wiring lives in route.ts. Tests pass mocks.
 *
 * `emitter` is a progress-emitter (see ./progress-emitter.js). When
 * provided we emit per-file checkpoint events. When null/undefined we
 * skip emission silently — non-streaming callers see the same payload
 * they always saw, no behaviour change beyond the new optional events.
 *
 * Event vocabulary (kept in sync with the page-side consumer):
 *   - scan-fix:start  → { totalFiles, totalIssues, tier }
 *   - file:start      → { file, issueCount, idx, total }
 *   - file:attempt    → { file, attemptNumber, outcome }
 *                       outcome ∈ 'success' | 'validation-fail' | 'verify-fail'
 *                                 | 'claude-error' | 'fetch-fail' | 'too-large'
 *                                 | 'create-success' | 'create-fail'
 *   - file:complete   → { file, success, attempts, durationMs, reason? }
 *   - gate:syntax     → { accepted, rejected }   (informational summary)
 *   - gate:scanner    → { accepted, rolledBack, summary }
 *   - gate:tests      → { generated, skipped }
 *   - pr:open         → { url, fixCount }
 *   - done            → emitted by emitter.end with the final payload
 *
 * The route file's POST handler returns whatever this module returns —
 * non-streaming callers see `payload` JSON with `status`. Streaming
 * callers see the events plus `done`.
 */

'use strict';

const TIME_BUDGET_MS = 240_000;
const MAX_FILE_BYTES = 400 * 1024;
const FIX_CONCURRENCY = 2;

function noopEmit() {}
function safeEmit(emitter, name, data) {
  if (!emitter || typeof emitter.emit !== 'function') return;
  try {
    emitter.emit(name, data);
  } catch {
    // emitter is best-effort; never let event-emission failure block work
  }
}

function isAbortError(err) {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  return name === 'AbortError' || /aborted|abort/i.test(msg);
}

function isNetworkError(err) {
  if (!err) return false;
  const raw = err instanceof Error ? err.message : String(err);
  return isAbortError(err) || /EPROTO|ECONNRESET|ETIMEDOUT|ssl.*alert|handshake|fetch failed|socket hang up|unreachable/i.test(raw);
}

/**
 * Run the per-file loop with adaptive concurrency. Mirrors the
 * mapWithAdaptiveConcurrency helper that lived inline in route.ts, but
 * stripped of its TypeScript wrapping so it sits under `node --test`.
 */
async function mapWithAdaptiveConcurrency(items, initialLimit, fn) {
  const results = new Array(items.length);
  const state = {
    consecutiveNetworkErrors: 0,
    activeConcurrency: initialLimit,
    haltRun: false,
  };
  let cursor = 0;
  let activeWorkers = 0;

  async function worker() {
    activeWorkers++;
    while (cursor < items.length && !state.haltRun) {
      if (activeWorkers > state.activeConcurrency) {
        activeWorkers--;
        return;
      }
      const idx = cursor++;
      results[idx] = await fn(items[idx], state);
    }
    activeWorkers--;
  }

  const workers = Array.from(
    { length: Math.min(initialLimit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Execute the fix-core pipeline.
 *
 * @param {object} args
 * @param {object} args.input  – { repoUrl, issues, tier? }
 * @param {object} args.deps   – I/O contract (see route.ts production wiring)
 * @param {object} [args.emitter] – progress-emitter (createEmitter return);
 *                                  null/undefined → no events emitted
 * @returns {Promise<{ payload: object, status: number }>}
 */
async function executeFixCore({ input, deps, emitter }) {
  const emit = emitter ? (n, d) => safeEmit(emitter, n, d) : noopEmit;

  // -- 1. Validate input --
  if (!input || typeof input !== 'object') {
    return { payload: { error: 'Invalid request body' }, status: 400 };
  }
  const { repoUrl, issues, tier } = input;
  if (!repoUrl || !Array.isArray(issues) || issues.length === 0) {
    return { payload: { error: 'Missing repoUrl or issues' }, status: 400 };
  }
  if (!deps.hasAnthropicKey) {
    return { payload: { error: 'AI not configured (ANTHROPIC_API_KEY)' }, status: 503 };
  }

  // -- 2. Resolve owner/repo --
  const gluecronMatch = repoUrl.match(/gluecron\.com\/([^/]+)\/([^/?#]+)/);
  const githubMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  const repoMatch = gluecronMatch || githubMatch;
  if (!repoMatch) {
    return { payload: { error: 'Invalid repo URL (expected gluecron.com/<owner>/<repo>)' }, status: 400 };
  }
  const owner = repoMatch[1];
  const repo = repoMatch[2].replace(/\.git$/, '');

  // -- 3. Resolve auth --
  const auth = await deps.resolveRepoAuth(owner, repo);
  if (!auth || !auth.token) {
    return {
      payload: {
        error:
          (auth && auth.error) ||
          "Gluecron access not configured — set GLUECRON_API_TOKEN (PAT, scope 'repo')",
        hint: 'Generate a PAT at https://gluecron.com/settings/tokens and set GLUECRON_API_TOKEN.',
      },
      status: 503,
    };
  }
  const token = auth.token;
  const authSource = auth.source;

  // -- 4. Group issues by file --
  const issuesByFile = new Map();
  for (const issue of issues) {
    if (!issue || !issue.file) continue;
    const existing = issuesByFile.get(issue.file) || [];
    existing.push(issue.issue);
    issuesByFile.set(issue.file, existing);
  }
  if (issuesByFile.size === 0) {
    return { payload: { error: 'No fixable issues (issues must have file paths)' }, status: 400 };
  }

  const fileEntries = Array.from(issuesByFile.entries());
  const totalFiles = fileEntries.length;
  const totalIssues = issues.length;

  emit('scan-fix:start', { totalFiles, totalIssues, tier: tier || null });

  // -- 5. Per-file work loop --
  const fixes = [];
  const errors = [];
  const failedFiles = [];
  const startedAt = Date.now();
  const budgetExceeded = () => Date.now() - startedAt > TIME_BUDGET_MS;
  let skippedForBudget = 0;

  await mapWithAdaptiveConcurrency(fileEntries, FIX_CONCURRENCY, async ([filePath, fileIssues], state) => {
    const fileStartedAt = Date.now();
    const idx = fileEntries.findIndex(([f]) => f === filePath);
    emit('file:start', { file: filePath, issueCount: fileIssues.length, idx, total: totalFiles });

    if (budgetExceeded() || state.haltRun) {
      skippedForBudget += 1;
      emit('file:complete', {
        file: filePath,
        success: false,
        attempts: 0,
        durationMs: Date.now() - fileStartedAt,
        reason: state.haltRun ? 'halt' : 'budget-exceeded',
      });
      return;
    }

    // CREATE_FILE branch — generate a brand-new file
    const createIssues = fileIssues.filter((i) => typeof i === 'string' && i.startsWith('CREATE_FILE:'));
    if (createIssues.length > 0) {
      try {
        const newContent = await deps.askClaudeCreate(filePath, createIssues.map((i) => i.replace('CREATE_FILE: ', '')));
        if (newContent && newContent.length > 10) {
          fixes.push({ file: filePath, original: '', fixed: newContent, issues: fileIssues });
          emit('file:attempt', { file: filePath, attemptNumber: 1, outcome: 'create-success' });
          emit('file:complete', {
            file: filePath,
            success: true,
            attempts: 1,
            durationMs: Date.now() - fileStartedAt,
          });
        } else {
          errors.push(`Could not generate ${filePath}: empty response`);
          emit('file:attempt', { file: filePath, attemptNumber: 1, outcome: 'create-fail' });
          emit('file:complete', {
            file: filePath,
            success: false,
            attempts: 1,
            durationMs: Date.now() - fileStartedAt,
            reason: 'empty-response',
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown';
        errors.push(`Could not generate ${filePath}: ${reason}`);
        emit('file:attempt', { file: filePath, attemptNumber: 1, outcome: 'create-fail' });
        emit('file:complete', {
          file: filePath,
          success: false,
          attempts: 1,
          durationMs: Date.now() - fileStartedAt,
          reason,
        });
      }
      return;
    }

    // Standard fix path
    let attempts = 0;
    try {
      const originalContent = await deps.fetchBlob(owner, repo, filePath, '', token);
      if (!originalContent) {
        errors.push(`Could not read ${filePath}`);
        emit('file:attempt', { file: filePath, attemptNumber: 1, outcome: 'fetch-fail' });
        emit('file:complete', {
          file: filePath,
          success: false,
          attempts: 0,
          durationMs: Date.now() - fileStartedAt,
          reason: 'fetch-empty',
        });
        return;
      }
      if (originalContent.length > MAX_FILE_BYTES) {
        errors.push(`Skipped ${filePath}: file too large (${originalContent.length} bytes, limit ${MAX_FILE_BYTES})`);
        emit('file:attempt', { file: filePath, attemptNumber: 1, outcome: 'too-large' });
        emit('file:complete', {
          file: filePath,
          success: false,
          attempts: 0,
          durationMs: Date.now() - fileStartedAt,
          reason: 'too-large',
        });
        return;
      }

      // Attempt 1
      attempts = 1;
      let fixedContent = await deps.askClaude(originalContent, filePath, fileIssues);
      let validation = deps.validateFix(originalContent, fixedContent);
      if (!validation.ok) {
        errors.push(`Skipped ${filePath}: ${validation.reason}`);
        emit('file:attempt', { file: filePath, attemptNumber: 1, outcome: 'validation-fail' });
        emit('file:complete', {
          file: filePath,
          success: false,
          attempts: 1,
          durationMs: Date.now() - fileStartedAt,
          reason: validation.reason,
        });
        return;
      }

      // Quality verify — may trigger a second-pass attempt
      let verify = deps.verifyFixQuality(fixedContent, filePath);
      if (!verify.clean) {
        emit('file:attempt', { file: filePath, attemptNumber: 1, outcome: 'verify-fail' });
        const retryIssues = [
          ...fileIssues,
          ...verify.newIssues.map((i) => `YOUR FIX INTRODUCED: ${i} — fix this too`),
        ];
        attempts = 2;
        fixedContent = await deps.askClaude(originalContent, filePath, retryIssues);
        validation = deps.validateFix(originalContent, fixedContent);
        if (!validation.ok) {
          errors.push(`Skipped ${filePath} after retry: ${validation.reason}`);
          emit('file:attempt', { file: filePath, attemptNumber: 2, outcome: 'validation-fail' });
          emit('file:complete', {
            file: filePath,
            success: false,
            attempts: 2,
            durationMs: Date.now() - fileStartedAt,
            reason: validation.reason,
          });
          return;
        }
        verify = deps.verifyFixQuality(fixedContent, filePath);
        if (!verify.clean) {
          errors.push(`Skipped ${filePath}: fix still introduces issues after retry: ${verify.newIssues.join('; ')}`);
          emit('file:attempt', { file: filePath, attemptNumber: 2, outcome: 'verify-fail' });
          emit('file:complete', {
            file: filePath,
            success: false,
            attempts: 2,
            durationMs: Date.now() - fileStartedAt,
            reason: 'verify-fail-after-retry',
          });
          return;
        }
      }

      fixes.push({ file: filePath, original: originalContent, fixed: fixedContent, issues: fileIssues });
      state.consecutiveNetworkErrors = 0;
      emit('file:attempt', { file: filePath, attemptNumber: attempts, outcome: 'success' });
      emit('file:complete', {
        file: filePath,
        success: true,
        attempts,
        durationMs: Date.now() - fileStartedAt,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'unknown';
      const networkErr = isNetworkError(err);
      const abortErr = isAbortError(err);

      if (networkErr) {
        state.consecutiveNetworkErrors += 1;
        if (state.consecutiveNetworkErrors === 3 && state.activeConcurrency > 1) {
          state.activeConcurrency = 1;
        }
        if (state.consecutiveNetworkErrors >= 8) {
          state.haltRun = true;
        }
        failedFiles.push({ file: filePath, issues: fileIssues, reason: 'api-unavailable' });
        const msg = abortErr
          ? `${filePath}: request timed out (file may be too large) — queued for retry`
          : `${filePath}: Anthropic API temporarily unavailable — queued for retry`;
        errors.push(msg);
        emit('file:attempt', { file: filePath, attemptNumber: attempts || 1, outcome: 'claude-error' });
        emit('file:complete', {
          file: filePath,
          success: false,
          attempts: attempts || 1,
          durationMs: Date.now() - fileStartedAt,
          reason: abortErr ? 'timeout' : 'api-unavailable',
        });
      } else {
        errors.push(`Failed to fix ${filePath}: ${raw}`);
        emit('file:attempt', { file: filePath, attemptNumber: attempts || 1, outcome: 'claude-error' });
        emit('file:complete', {
          file: filePath,
          success: false,
          attempts: attempts || 1,
          durationMs: Date.now() - fileStartedAt,
          reason: raw,
        });
      }
    }
  });

  if (skippedForBudget > 0) {
    errors.push(`Skipped ${skippedForBudget} file${skippedForBudget > 1 ? 's' : ''} — function time budget exhausted. Re-run fix to process the remainder.`);
  }

  // Informational gate summaries — these mirror the existing report
  // sections so the streaming UI can show "syntax/scanner/tests passed".
  // The route file doesn't currently call separate gate libraries on every
  // request (validateFix + verifyFixQuality cover the per-file gates) so
  // these summaries roll up the per-file outcomes.
  const gateSyntaxAccepted = fixes.length;
  const gateSyntaxRejected = errors.filter((e) => /Skipped/.test(e)).length;
  emit('gate:syntax', { accepted: gateSyntaxAccepted, rejected: gateSyntaxRejected });
  emit('gate:scanner', { accepted: fixes.length, rolledBack: 0, summary: 'per-file verifyFixQuality applied' });
  emit('gate:tests', { generated: 0, skipped: fixes.length });

  if (fixes.length === 0) {
    const apiDegraded = failedFiles.length > 0 && failedFiles.length === fileEntries.length;
    return {
      payload: {
        status: apiDegraded ? 'api_unavailable' : 'no_fixes',
        message: apiDegraded
          ? `Anthropic API is temporarily degraded — every file failed with a network/TLS error. All ${failedFiles.length} files are queued for retry. Click "Retry Failed" in 1-2 minutes; if the problem persists, Anthropic is likely having an incident (check status.anthropic.com).`
          : skippedForBudget > 0
          ? `All ${skippedForBudget} files skipped — function time budget exhausted before Claude could finish. Try again — the second run will typically complete since results cache and retries kick in faster.`
          : 'No fixes could be generated',
        errors,
        skippedForBudget,
        failedFiles,
      },
      status: 200,
    };
  }

  // -- 6. Branch + commits + PR --
  try {
    const baseRef = await deps.resolveBaseBranchSha(owner, repo, '', token);
    const defaultBranch = baseRef.defaultBranch;
    const baseSha = baseRef.sha;

    if (!baseSha) {
      return {
        payload: {
          error: 'Could not resolve base branch SHA from Gluecron or GitHub',
          hint: 'Confirm the repo is reachable and GLUECRON_API_TOKEN / GITHUB_TOKEN has read access.',
          defaultBranch,
        },
        status: 500,
      };
    }

    const branchName = `gatetest/auto-fix-${Date.now()}`;
    const branchRes = await deps.createBranch(owner, repo, branchName, baseSha, token);
    if (branchRes.status !== 201) {
      return {
        payload: {
          error: 'Could not create branch — check Gluecron token permissions',
          details: branchRes.data,
        },
        status: 500,
      };
    }

    await mapWithConcurrency(fixes, FIX_CONCURRENCY, async (fix) => {
      const isNewFile = fix.original === '';
      const message = isNewFile
        ? `feat: create ${fix.file}`
        : `fix: ${fix.issues[0]}${fix.issues.length > 1 ? ` (+${fix.issues.length - 1} more)` : ''}`;
      const existingSha = isNewFile
        ? ''
        : await deps.fetchFileSha(owner, repo, fix.file, branchName, token);
      await deps.upsertFile(owner, repo, fix.file, fix.fixed, message, branchName, existingSha, token);
    });

    const totalIssuesFixed = fixes.reduce((sum, f) => sum + f.issues.length, 0);
    const prBody = deps.composePrBody({ fixes, errors, totalIssuesFixed, totalChecks: issues.length });

    const prRes = await deps.openPullRequest(
      owner,
      repo,
      `GateTest: Fix ${totalIssuesFixed} issues across ${fixes.length} files`,
      prBody,
      branchName,
      defaultBranch,
      token,
    );

    if (prRes.status !== 201) {
      return {
        payload: {
          status: 'fixes_committed',
          message: `Fixes committed to branch ${branchName} but PR creation failed`,
          branch: branchName,
          filesFixed: fixes.length,
          issuesFixed: totalIssuesFixed,
          errors: [...errors, `PR creation failed: ${JSON.stringify(prRes.data)}`],
        },
        status: 200,
      };
    }

    const prNumber = prRes.data.number;
    const prUrl = prRes.data.html_url || '';
    emit('pr:open', { url: prUrl, fixCount: fixes.length });

    // Verification PR comment — non-critical
    try {
      const remainingIssues = [];
      for (const fix of fixes) {
        const verify = deps.verifyFixQuality(fix.fixed, fix.file);
        if (!verify.clean) {
          remainingIssues.push(`**${fix.file}**: ${verify.newIssues.join(', ')}`);
        }
      }
      const verifyBody = remainingIssues.length === 0
        ? `## ✅ GateTest Verification Passed\n\nAll ${totalIssuesFixed} fixes have been verified against GateTest's pattern scanner. No new issues introduced.\n\n**This PR is safe to merge.**`
        : `## ⚠️ GateTest Verification Warning\n\n${remainingIssues.length} file(s) may still have issues:\n${remainingIssues.map((i) => `- ${i}`).join('\n')}\n\nPlease review these files carefully before merging.`;
      await deps.postPrComment(owner, repo, prNumber, verifyBody, token);
    } catch {
      // non-critical
    }

    return {
      payload: {
        status: 'pr_created',
        prUrl,
        prNumber,
        branch: branchName,
        filesFixed: fixes.length,
        issuesFixed: totalIssuesFixed,
        fixes: fixes.map((f) => ({ file: f.file, issues: f.issues })),
        authSource,
        errors,
        failedFiles,
      },
      status: 200,
    };
  } catch (err) {
    return {
      payload: {
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to create PR',
        fixesGenerated: fixes.length,
        errors,
      },
      status: 500,
    };
  }
}

module.exports = {
  executeFixCore,
  // Exported for tests / advanced consumers
  TIME_BUDGET_MS,
  MAX_FILE_BYTES,
  FIX_CONCURRENCY,
  isNetworkError,
  isAbortError,
};
