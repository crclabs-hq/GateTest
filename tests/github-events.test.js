// ============================================================================
// GITHUB-EVENTS TEST — Coverage for website/app/lib/github-events.js
// ============================================================================
// Verifies the pure helpers behind /api/webhook. GateTest is dual-host:
// events arrive from either Gluecron (HMAC'd via GLUECRON_EMITTER_SECRET)
// or GitHub App webhooks (HMAC'd via GITHUB_WEBHOOK_SECRET). Both paths
// land in the same scan_queue — this file covers the GitHub ingress.
//
// Covered paths:
//   - verifyGitHubSignature: match, mismatch, missing header, missing secret
//   - extractGitHubEvent: push (happy path, delete-push, bad sha), PR
//     (opened/synchronize/reopened/closed), ping, unknown event
//   - processGitHubEvent: 503 (no secret), 401 (bad sig), 400 (malformed),
//     200 (ping / duplicate), 202 (new), 204 (ignore), 429 (queue full)
//   - X-GitHub-Delivery used as idempotency key end-to-end
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const {
  verifyGitHubSignature,
  extractGitHubEvent,
  processGitHubEvent,
  QUEUE_FULL_THRESHOLD,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'github-events.js'));

const SECRET = 'test-gh-webhook-secret-0123456789abcdef';
const DELIVERY = '11111111-2222-3333-4444-555555555555';

function hmacHeader(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function pushPayload(overrides = {}) {
  return {
    ref: 'refs/heads/main',
    after: 'a'.repeat(40),
    repository: { full_name: 'alice/webapp' },
    ...overrides,
  };
}

function prPayload(overrides = {}) {
  return {
    action: 'opened',
    number: 7,
    pull_request: {
      number: 7,
      head: { sha: 'b'.repeat(40), ref: 'feature-branch' },
    },
    repository: { full_name: 'alice/webapp' },
    ...overrides,
  };
}

function makeQueueStore({
  depth = 0,
  enqueueResult = { duplicate: false, id: 42 },
  enqueueThrows = null,
} = {}) {
  const calls = { getQueueDepth: 0, enqueueScan: [] };
  return {
    calls,
    getQueueDepth: async () => { calls.getQueueDepth++; return depth; },
    enqueueScan: async (args) => {
      calls.enqueueScan.push(args);
      if (enqueueThrows) throw enqueueThrows;
      return enqueueResult;
    },
  };
}

function makeFetchImpl() {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  impl.calls = calls;
  return impl;
}

// ── verifyGitHubSignature ────────────────────────────────────────────────────

describe('verifyGitHubSignature', () => {
  it('returns true when header matches sha256=<hmac(secret, body)>', () => {
    const body = '{"hello":"world"}';
    assert.strictEqual(verifyGitHubSignature(body, hmacHeader(body), SECRET), true);
  });

  it('returns false on wrong signature', () => {
    const body = '{"hello":"world"}';
    assert.strictEqual(
      verifyGitHubSignature(body, 'sha256=' + 'f'.repeat(64), SECRET),
      false
    );
  });

  it('returns false when header is missing or malformed', () => {
    assert.strictEqual(verifyGitHubSignature('x', null, SECRET), false);
    assert.strictEqual(verifyGitHubSignature('x', '', SECRET), false);
    assert.strictEqual(verifyGitHubSignature('x', 'garbage', SECRET), false);
  });

  it('returns false when secret is unset (fail closed)', () => {
    const body = '{}';
    assert.strictEqual(verifyGitHubSignature(body, hmacHeader(body, 'x'), ''), false);
  });
});

// ── extractGitHubEvent ───────────────────────────────────────────────────────

describe('extractGitHubEvent', () => {
  it('returns ping for ping events without inspecting payload', () => {
    const r = extractGitHubEvent('ping', DELIVERY, { zen: 'Non-blocking is better than blocking.' });
    assert.strictEqual(r.kind, 'ping');
  });

  it('enqueues a valid push event', () => {
    const r = extractGitHubEvent('push', DELIVERY, pushPayload());
    assert.strictEqual(r.kind, 'enqueue');
    assert.strictEqual(r.payload.eventId, DELIVERY);
    assert.strictEqual(r.payload.repository, 'alice/webapp');
    assert.strictEqual(r.payload.sha, 'a'.repeat(40));
    assert.strictEqual(r.payload.ref, 'refs/heads/main');
    assert.strictEqual(r.payload.pullRequestNumber, null);
  });

  it('ignores branch-delete push (all-zero sha)', () => {
    const r = extractGitHubEvent('push', DELIVERY, pushPayload({ after: '0'.repeat(40) }));
    assert.strictEqual(r.kind, 'ignore');
  });

  it('rejects push with bad sha', () => {
    const r = extractGitHubEvent('push', DELIVERY, pushPayload({ after: 'nope' }));
    assert.strictEqual(r.kind, 'error');
  });

  it('rejects missing X-GitHub-Delivery', () => {
    const r = extractGitHubEvent('push', null, pushPayload());
    assert.strictEqual(r.kind, 'error');
  });

  it('rejects missing repository.full_name', () => {
    const r = extractGitHubEvent('push', DELIVERY, { ref: 'refs/heads/main', after: 'a'.repeat(40) });
    assert.strictEqual(r.kind, 'error');
  });

  it('enqueues PR opened/synchronize/reopened/ready_for_review', () => {
    for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
      const r = extractGitHubEvent('pull_request', DELIVERY, prPayload({ action }));
      assert.strictEqual(r.kind, 'enqueue', `action=${action}`);
      assert.strictEqual(r.payload.pullRequestNumber, 7);
      assert.strictEqual(r.payload.sha, 'b'.repeat(40));
      assert.strictEqual(r.payload.ref, 'refs/heads/feature-branch');
    }
  });

  it('ignores PR closed / labeled / etc.', () => {
    for (const action of ['closed', 'labeled', 'unlabeled', 'review_requested']) {
      const r = extractGitHubEvent('pull_request', DELIVERY, prPayload({ action }));
      assert.strictEqual(r.kind, 'ignore', `action=${action}`);
    }
  });

  it('rejects PR with bad head sha', () => {
    const p = prPayload();
    p.pull_request.head.sha = 'nope';
    const r = extractGitHubEvent('pull_request', DELIVERY, p);
    assert.strictEqual(r.kind, 'error');
  });

  it('ignores unknown event types', () => {
    const r = extractGitHubEvent('repository', DELIVERY, { repository: { full_name: 'a/b' } });
    assert.strictEqual(r.kind, 'ignore');
  });
});

// ── processGitHubEvent ───────────────────────────────────────────────────────

describe('processGitHubEvent', () => {
  const baseArgs = () => ({
    rawBody: '',
    eventType: 'push',
    delivery: DELIVERY,
    signatureHeader: null,
    env: { GITHUB_WEBHOOK_SECRET: SECRET, NEXT_PUBLIC_BASE_URL: 'https://gatetest.ai' },
    sql: async () => [],
    queueStore: makeQueueStore(),
    fetchImpl: makeFetchImpl(),
    baseUrl: 'https://gatetest.ai',
  });

  it('returns 503 when GITHUB_WEBHOOK_SECRET is not set', async () => {
    const args = baseArgs();
    args.env = {};
    const r = await processGitHubEvent(args);
    assert.strictEqual(r.status, 503);
  });

  it('returns 401 on invalid signature', async () => {
    const args = baseArgs();
    args.rawBody = JSON.stringify(pushPayload());
    args.signatureHeader = 'sha256=' + 'f'.repeat(64);
    const r = await processGitHubEvent(args);
    assert.strictEqual(r.status, 401);
  });

  it('returns 400 on malformed JSON', async () => {
    const args = baseArgs();
    args.rawBody = '{not json';
    args.signatureHeader = hmacHeader(args.rawBody);
    const r = await processGitHubEvent(args);
    assert.strictEqual(r.status, 400);
  });

  it('returns 200 pong on ping event', async () => {
    const args = baseArgs();
    args.eventType = 'ping';
    args.rawBody = JSON.stringify({ zen: 'Speak like a human.' });
    args.signatureHeader = hmacHeader(args.rawBody);
    const r = await processGitHubEvent(args);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.pong, true);
    assert.strictEqual(args.queueStore.calls.enqueueScan.length, 0);
  });

  it('returns 202 and enqueues on a valid push, using delivery as eventId', async () => {
    const args = baseArgs();
    args.rawBody = JSON.stringify(pushPayload());
    args.signatureHeader = hmacHeader(args.rawBody);
    const r = await processGitHubEvent(args);
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.body.queued, true);
    assert.strictEqual(r.body.eventId, DELIVERY);
    assert.strictEqual(args.queueStore.calls.enqueueScan.length, 1);
    const enq = args.queueStore.calls.enqueueScan[0];
    assert.strictEqual(enq.eventId, DELIVERY);
    assert.strictEqual(enq.repository, 'alice/webapp');
    assert.strictEqual(enq.sha, 'a'.repeat(40));
    assert.strictEqual(enq.ref, 'refs/heads/main');
    assert.strictEqual(args.fetchImpl.calls.length, 1);
    assert.match(args.fetchImpl.calls[0].url, /\/api\/scan\/worker\/tick$/);
  });

  it('returns 200 duplicate and skips worker kick on ON CONFLICT', async () => {
    const args = baseArgs();
    args.queueStore = makeQueueStore({ enqueueResult: { duplicate: true, id: null } });
    args.rawBody = JSON.stringify(pushPayload());
    args.signatureHeader = hmacHeader(args.rawBody);
    args.fetchImpl = makeFetchImpl();
    const r = await processGitHubEvent(args);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.duplicate, true);
    assert.strictEqual(args.fetchImpl.calls.length, 0);
  });

  it('returns 204 on non-actionable pull_request action', async () => {
    const args = baseArgs();
    args.eventType = 'pull_request';
    args.rawBody = JSON.stringify(prPayload({ action: 'closed' }));
    args.signatureHeader = hmacHeader(args.rawBody);
    const r = await processGitHubEvent(args);
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.body, null);
    assert.strictEqual(args.queueStore.calls.enqueueScan.length, 0);
  });

  it('returns 429 with Retry-After: 30 when queue depth >= threshold', async () => {
    const args = baseArgs();
    args.queueStore = makeQueueStore({ depth: QUEUE_FULL_THRESHOLD });
    args.rawBody = JSON.stringify(pushPayload());
    args.signatureHeader = hmacHeader(args.rawBody);
    const r = await processGitHubEvent(args);
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.headers['Retry-After'], '30');
  });

  it('returns 400 when payload shape is wrong', async () => {
    const args = baseArgs();
    args.rawBody = JSON.stringify({ ref: 'refs/heads/main' }); // no repository
    args.signatureHeader = hmacHeader(args.rawBody);
    const r = await processGitHubEvent(args);
    assert.strictEqual(r.status, 400);
  });
});

// ── workflow_run event tests ──────────────────────────────────────────────────

function workflowRunPayload(overrides = {}) {
  return {
    action: 'completed',
    workflow_run: {
      id: 99887766,
      name: 'Build & Release',
      head_sha: 'c'.repeat(40),
      head_branch: 'main',
      conclusion: 'failure',
    },
    repository: { full_name: 'alice/webapp' },
    ...overrides,
  };
}

describe('extractGitHubEvent — workflow_run', () => {
  it('returns ci_fix for a completed failure run', () => {
    const r = extractGitHubEvent('workflow_run', DELIVERY, workflowRunPayload());
    assert.strictEqual(r.kind, 'ci_fix');
    assert.strictEqual(r.payload.repository, 'alice/webapp');
    assert.strictEqual(r.payload.runId, 99887766);
    assert.strictEqual(r.payload.headSha, 'c'.repeat(40));
    assert.strictEqual(r.payload.headBranch, 'main');
    assert.strictEqual(r.payload.workflowName, 'Build & Release');
    assert.strictEqual(r.payload.eventId, DELIVERY);
  });

  it('ignores non-completed actions', () => {
    const r = extractGitHubEvent('workflow_run', DELIVERY, workflowRunPayload({ action: 'requested' }));
    assert.strictEqual(r.kind, 'ignore');
  });

  it('ignores non-failure conclusions', () => {
    const p = workflowRunPayload();
    p.workflow_run.conclusion = 'success';
    const r = extractGitHubEvent('workflow_run', DELIVERY, p);
    assert.strictEqual(r.kind, 'ignore');
  });

  it('ignores cancelled conclusion', () => {
    const p = workflowRunPayload();
    p.workflow_run.conclusion = 'cancelled';
    const r = extractGitHubEvent('workflow_run', DELIVERY, p);
    assert.strictEqual(r.kind, 'ignore');
  });

  it('errors on missing workflow_run object', () => {
    const p = { action: 'completed', repository: { full_name: 'alice/webapp' } };
    const r = extractGitHubEvent('workflow_run', DELIVERY, p);
    assert.strictEqual(r.kind, 'error');
  });

  it('errors on bad head_sha', () => {
    const p = workflowRunPayload();
    p.workflow_run.head_sha = 'not-a-sha';
    const r = extractGitHubEvent('workflow_run', DELIVERY, p);
    assert.strictEqual(r.kind, 'error');
  });
});

describe('processGitHubEvent — workflow_run ci_fix', () => {
  function baseArgs() {
    const payload = workflowRunPayload();
    const rawBody = JSON.stringify(payload);
    const kicks = [];
    return {
      rawBody,
      eventType: 'workflow_run',
      delivery: DELIVERY,
      signatureHeader: hmacHeader(rawBody),
      env: { GITHUB_WEBHOOK_SECRET: SECRET, CRON_SECRET: 'cron-secret-abc' },
      sql: null,
      queueStore: makeQueueStore(),
      fetchImpl: (url, opts) => { kicks.push({ url, opts }); return Promise.resolve({ ok: true }); },
      baseUrl: 'https://gatetest.ai',
      _kicks: kicks,
    };
  }

  it('returns 202 with kind ci_fix', async () => {
    const args = baseArgs();
    const r = await processGitHubEvent(args);
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.body.kind, 'ci_fix');
  });

  it('fires a kick to /api/scan/ci-fix', async () => {
    const args = baseArgs();
    await processGitHubEvent(args);
    assert.ok(args._kicks.some(k => k.url.endsWith('/api/scan/ci-fix')));
  });

  it('kick uses Authorization Bearer CRON_SECRET', async () => {
    const args = baseArgs();
    await processGitHubEvent(args);
    const kick = args._kicks.find(k => k.url.endsWith('/api/scan/ci-fix'));
    assert.ok(kick);
    assert.strictEqual(kick.opts.headers['Authorization'], 'Bearer cron-secret-abc');
  });

  it('kick body contains repository and runId', async () => {
    const args = baseArgs();
    await processGitHubEvent(args);
    const kick = args._kicks.find(k => k.url.endsWith('/api/scan/ci-fix'));
    const body = JSON.parse(kick.opts.body);
    assert.strictEqual(body.repository, 'alice/webapp');
    assert.strictEqual(body.runId, 99887766);
    assert.strictEqual(body.headSha, 'c'.repeat(40));
  });

  it('does NOT enqueue a regular scan', async () => {
    const args = baseArgs();
    await processGitHubEvent(args);
    assert.strictEqual(args.queueStore.calls.enqueueScan.length, 0);
  });
});
