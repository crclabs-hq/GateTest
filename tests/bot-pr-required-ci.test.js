// =============================================================================
// Bot-authored PRs must actually get the required checks (2026-09-19)
// =============================================================================
// GitHub does not start `pull_request` workflows for events created with
// secrets.GITHUB_TOKEN. The nightly bot workflows that open/update their own
// PR with GITHUB_TOKEN — dogfood-nightly.yml, trainer-nightly.yml,
// head-to-head.yml — therefore never got ci.yml's four required checks
// ("Test + Build", "Pre-Merge Sweep", "GateTest Quality Gate", "GateTest
// Full Scan") to report, so branch protection left the PR BLOCKED forever
// (done by hand for #609/#610 on 2026-09-19). The fix: ci.yml gained a
// `workflow_dispatch` trigger (GitHub's documented exception — it DOES start
// workflows fired by GITHUB_TOKEN), and every bot workflow that opens a PR
// now dispatches it on that branch via scripts/ops/dispatch-required-ci.sh.
//
// This is a STATIC test — it parses the workflow YAML and the one-definition
// module, it does not fire a real dispatch (that only proves out on the next
// scheduled run). What it guards:
//   (a) ci.yml declares workflow_dispatch as a trigger
//   (b) the four required check names (scripts/ops/required-checks.js — the
//       ONE place, Doctrine #4) are still job `name:` values in ci.yml, so a
//       silent rename can't leave every bot PR blocked with nothing to fail
//   (c) every workflow that calls `gh pr create` also dispatches ci.yml via
//       the shared script, and its job carries `actions: write`
//   (d) none of the four required jobs is gated off for workflow_dispatch
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { REQUIRED_CHECKS } = require('../scripts/ops/required-checks');

function loadYaml(rel) {
  // js-yaml ships transitively with eslint (root package-lock); resolve it
  // from this checkout's node_modules first, then wherever Node finds it.
  let yaml;
  try {
    yaml = require(path.join(ROOT, 'node_modules', 'js-yaml'));
  } catch {
    yaml = require('js-yaml');
  }
  return yaml.load(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function jobNames(wf) {
  return Object.values(wf.jobs || {}).map((j) => j.name).filter(Boolean);
}

function findJobByName(wf, name) {
  return Object.values(wf.jobs || {}).find((j) => j.name === name);
}

const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

function listWorkflowFiles() {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => path.join('.github', 'workflows', f));
}

// A workflow "creates or updates a PR with the bot token" if it calls
// `gh pr create` anywhere in its source — the same signal CLAUDE.md's defect
// writeup used to enumerate dogfood-nightly.yml, trainer-nightly.yml and
// head-to-head.yml.
function botPrWorkflows() {
  return listWorkflowFiles().filter((rel) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('gh pr create'),
  );
}

describe('ci.yml: workflow_dispatch trigger exists', () => {
  it('declares workflow_dispatch under `on:`', () => {
    const wf = loadYaml('.github/workflows/ci.yml');
    assert.ok(wf.on, 'ci.yml has an `on:` block');
    assert.ok(
      Object.prototype.hasOwnProperty.call(wf.on, 'workflow_dispatch'),
      'ci.yml must declare `workflow_dispatch:` as a trigger so a workflow_dispatch run can attach the required check runs to a bot PR branch',
    );
  });
});

describe('scripts/ops/required-checks.js: the one definition of the required check names', () => {
  it('exports a non-empty array of check names', () => {
    assert.ok(Array.isArray(REQUIRED_CHECKS), 'REQUIRED_CHECKS must be an array');
    assert.ok(REQUIRED_CHECKS.length > 0, 'REQUIRED_CHECKS must not be empty');
  });

  it('every required check name is a job `name:` in ci.yml', () => {
    const wf = loadYaml('.github/workflows/ci.yml');
    const names = jobNames(wf);
    for (const required of REQUIRED_CHECKS) {
      assert.ok(
        names.includes(required),
        `required check "${required}" (scripts/ops/required-checks.js) is not a job name in ci.yml — ` +
          `either the job was renamed (update required-checks.js) or branch protection is about to go dark on it`,
      );
    }
  });
});

describe('none of the required jobs is gated off for workflow_dispatch', () => {
  const wf = loadYaml('.github/workflows/ci.yml');
  for (const required of REQUIRED_CHECKS) {
    it(`"${required}" has no job-level \`if:\` that excludes workflow_dispatch`, () => {
      const job = findJobByName(wf, required);
      assert.ok(job, `job "${required}" exists in ci.yml`);
      if (job.if === undefined || job.if === null) {
        // No condition at all — the job runs on every trigger, including
        // workflow_dispatch. Nothing to check.
        return;
      }
      const condition = String(job.if);
      assert.match(
        condition,
        /workflow_dispatch/,
        `job "${required}" has an \`if:\` condition ("${condition}") that does not mention workflow_dispatch — ` +
          `a dispatched run would be SKIPPED (not reported), which required status checks treat the same as never running`,
      );
    });
  }
});

describe('every bot workflow that opens a PR with GITHUB_TOKEN dispatches ci.yml', () => {
  const botWorkflows = botPrWorkflows();

  it('found at least one bot PR workflow to check (the check itself is not a no-op)', () => {
    assert.ok(botWorkflows.length > 0, 'expected at least one workflow calling `gh pr create`');
  });

  for (const rel of botWorkflows) {
    it(`${rel}: calls the shared dispatch script`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.match(
        src,
        /scripts\/ops\/dispatch-required-ci\.sh/,
        `${rel} opens/updates a PR via \`gh pr create\` but never calls scripts/ops/dispatch-required-ci.sh — ` +
          `its PR's required checks will never report (GitHub does not start pull_request workflows for GITHUB_TOKEN events)`,
      );
    });

    it(`${rel}: its job declares actions: write`, () => {
      const wf = loadYaml(rel);
      const jobs = Object.values(wf.jobs || {});
      const hasActionsWrite = jobs.some((job) => {
        const perms = job.permissions || wf.permissions || {};
        return perms.actions === 'write';
      });
      assert.ok(
        hasActionsWrite,
        `${rel} calls dispatch-required-ci.sh (which runs \`gh workflow run\`) but no job/workflow-level ` +
          `\`permissions:\` block grants actions: write — the dispatch call will be rejected`,
      );
    });
  }
});
