// =============================================================================
// DEPLOY-STALLED-ISSUE TEST — scripts/ops/deploy-stalled-issue.js (issue #706 part 2)
// =============================================================================
// The "Production deploy stalled" issue: opened once when the box's own
// pull-deploy.sh (or the readiness probe's deploy/fresh check) reports the
// deploy has stopped, commented on every later failure instead of opening a
// duplicate, and closed automatically once a run reports the box caught up.
// All HTTP is mocked — same fetchImpl-mock shape as
// tests/post-tracking-issues.test.js.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  TITLE,
  LABEL,
  MARKER,
  renderIssue,
  findOpenIssue,
  resolveRepoOwnerLogin,
  upsertDeployStalledIssue,
} = require('../scripts/ops/deploy-stalled-issue');

function makeFetchMock(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init || {} });
      const r = responses[i++] || { status: 200, body: [] };
      return { status: r.status, json: async () => r.body };
    },
  };
}

describe('renderIssue', () => {
  it('renders the marker, reason, unshipped merges and box command', () => {
    const { title, body } = renderIssue({
      reason: 'pull timer did not pick up abc123 within 15 min',
      unshipped: [{ sha: 'abcdef0123456789', subject: 'Merge pull request #700' }],
      boxCommand: 'journalctl -u gatetest-pull-deploy -n 100 --no-pager',
      source: 'deploy-box.yml poll-pull-deploy',
      checkedAt: '2026-09-23T02:30:00Z',
    });
    assert.equal(title, TITLE);
    assert.match(body, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(body, /pull timer did not pick up abc123/);
    assert.match(body, /abcdef012345/);
    assert.match(body, /Merge pull request #700/);
    assert.match(body, /journalctl -u gatetest-pull-deploy/);
    assert.match(body, /deploy-box\.yml poll-pull-deploy/);
  });

  it('says so honestly when no unshipped merges could be resolved', () => {
    const { body } = renderIssue({ reason: 'box unreachable', unshipped: [], source: 'x', checkedAt: 'now' });
    assert.match(body, /none resolved/);
  });
});

describe('findOpenIssue', () => {
  it('matches only an issue whose body carries the marker, ignoring a same-title coincidence', async () => {
    const { fetchImpl } = makeFetchMock([
      {
        status: 200,
        body: [
          { number: 1, body: 'a human opened this one, no marker' },
          { number: 2, body: `${MARKER}\nthe real one` },
        ],
      },
    ]);
    const found = await findOpenIssue({ owner: 'o', repo: 'r', token: 't', fetchImpl });
    assert.equal(found.number, 2);
  });

  it('returns null when the list call fails', async () => {
    const { fetchImpl } = makeFetchMock([{ status: 500, body: {} }]);
    const found = await findOpenIssue({ owner: 'o', repo: 'r', token: 't', fetchImpl });
    assert.equal(found, null);
  });
});

describe('resolveRepoOwnerLogin', () => {
  it('returns the owner login directly when the repo owner is a User', async () => {
    const { fetchImpl } = makeFetchMock([
      { status: 200, body: { owner: { login: 'a-solo-dev', type: 'User' } } },
    ]);
    const login = await resolveRepoOwnerLogin({ owner: 'o', repo: 'r', token: 't', fetchImpl });
    assert.equal(login, 'a-solo-dev');
  });

  it('falls back to the admin collaborator when the repo owner is an Organization (issues cannot assign an org)', async () => {
    const { fetchImpl } = makeFetchMock([
      { status: 200, body: { owner: { login: 'crclabs-hq', type: 'Organization' } } },
      { status: 200, body: [{ login: 'a-member', role_name: 'write' }, { login: 'ccantynz-alt', role_name: 'admin' }] },
    ]);
    const login = await resolveRepoOwnerLogin({ owner: 'crclabs-hq', repo: 'GateTest', token: 't', fetchImpl });
    assert.equal(login, 'ccantynz-alt');
  });

  it('resolves to null (never throws) when both calls fail', async () => {
    const { fetchImpl } = makeFetchMock([{ status: 500, body: {} }, { status: 500, body: {} }]);
    const login = await resolveRepoOwnerLogin({ owner: 'o', repo: 'r', token: 't', fetchImpl });
    assert.equal(login, null);
  });
});

describe('upsertDeployStalledIssue', () => {
  it('opens a new issue (labeled ops, assigned) when stalled and none is open', async () => {
    const { fetchImpl, calls } = makeFetchMock([
      { status: 200, body: [] },                                            // list: none open
      { status: 200, body: { owner: { login: 'ccantynz-alt', type: 'User' } } }, // resolveRepoOwnerLogin
      { status: 201, body: { number: 55 } },                                 // create
    ]);
    const r = await upsertDeployStalledIssue({
      stalled: true,
      reason: 'git fetch failed: fatal: could not read Username',
      unshipped: [{ sha: 'deadbeef', subject: 'Merge #1' }],
      boxCommand: 'journalctl -u gatetest-pull-deploy -n 100 --no-pager',
      source: 'deploy-box.yml poll-pull-deploy',
      owner: 'crclabs-hq', repo: 'GateTest', token: 't', fetchImpl,
    });
    assert.equal(r.action, 'opened');
    assert.equal(r.number, 55);
    const createCall = calls[calls.length - 1];
    assert.equal(createCall.init.method, 'POST');
    const payload = JSON.parse(createCall.init.body);
    assert.equal(payload.title, TITLE);
    assert.deepEqual(payload.labels, [LABEL]);
    assert.deepEqual(payload.assignees, ['ccantynz-alt']);
    assert.match(payload.body, /git fetch failed/);
  });

  it('comments on the existing open issue instead of opening a second one (a later failure)', async () => {
    const { fetchImpl, calls } = makeFetchMock([
      { status: 200, body: [{ number: 9, body: `${MARKER}\nprior body` }] }, // list: one open
      { status: 201, body: {} },                                             // comment
    ]);
    const r = await upsertDeployStalledIssue({
      stalled: true,
      reason: 'still failing',
      source: 'deploy-box.yml poll-pull-deploy',
      owner: 'o', repo: 'r', token: 't', fetchImpl,
    });
    assert.equal(r.action, 'commented');
    assert.equal(r.number, 9);
    assert.equal(calls.length, 2, 'must not have POSTed a new issue');
    assert.match(calls[1].url, /\/issues\/9\/comments$/);
  });

  it('closes the existing open issue with a resolved comment once the box has caught up', async () => {
    const { fetchImpl, calls } = makeFetchMock([
      { status: 200, body: [{ number: 9, body: `${MARKER}\nprior body` }] }, // list: one open
      { status: 201, body: {} },                                             // comment
      { status: 200, body: { state: 'closed' } },                            // close (PATCH)
    ]);
    const r = await upsertDeployStalledIssue({
      stalled: false,
      source: 'deploy-box.yml poll-pull-deploy',
      owner: 'o', repo: 'r', token: 't', fetchImpl,
    });
    assert.equal(r.action, 'closed');
    assert.equal(r.number, 9);
    assert.equal(calls[1].init.method, 'POST');
    assert.match(JSON.parse(calls[1].init.body).body, /Resolved/);
    assert.equal(calls[2].init.method, 'PATCH');
    assert.equal(JSON.parse(calls[2].init.body).state, 'closed');
  });

  it('does nothing when the box is fine and no issue is open (the common case, every tick)', async () => {
    const { fetchImpl, calls } = makeFetchMock([{ status: 200, body: [] }]);
    const r = await upsertDeployStalledIssue({
      stalled: false, source: 'x', owner: 'o', repo: 'r', token: 't', fetchImpl,
    });
    assert.equal(r.action, 'none');
    assert.equal(calls.length, 1, 'must only have listed — never opened, commented or closed anything');
  });

  it('requires fetchImpl, owner, repo and token', async () => {
    await assert.rejects(() => upsertDeployStalledIssue({ stalled: true, owner: 'o', repo: 'r', token: 't' }));
    await assert.rejects(() => upsertDeployStalledIssue({ stalled: true, fetchImpl: async () => {} }));
  });
});
