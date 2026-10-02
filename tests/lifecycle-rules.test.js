'use strict';

// Control pairs for src/core/lifecycle-rules.js. Firing halves paraphrase
// Tallrig's shipped shapes (TALLRIG-2026-023 / -029 / -047 / -048; the corpus
// is private and never committed here); quiet halves are the fixes.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scanLifecycle } = require('../src/core/lifecycle-rules');

const rules = (src, rel = 'src/trpc/procedures/projects.ts') => scanLifecycle(rel, src).map((f) => f.rule);

describe('delete-without-teardown', () => {
  const handler = (extra) => [
    'export const router = {',
    '  delete: protectedProcedure.mutation(async ({ ctx, input }) => {',
    '    await requireProjectOwnership(ctx.db, input.projectId, ctx.userId);',
    ...extra,
    '    const result = await ctx.db.delete(projects).where(eq(projects.id, input.projectId));',
    '    return { success: true };',
    '  }),',
    '};',
  ].join('\n');
  it('fires: the row is deleted, the app is never stopped', () => {
    assert.deepEqual(rules(handler([])), ['delete-without-teardown']);
  });
  it('quiet: the app is stopped first (the Tallrig fix)', () => {
    assert.deepEqual(rules(handler(['    await stopProjectApp(ctx.db, { projectId: input.projectId });'])), []);
  });
  it('quiet: deleting a row that runs nothing (a comment)', () => {
    assert.deepEqual(rules([
      'export async function deleteComment(db, id) {',
      '  await db.delete(comments).where(eq(comments.id, id));',
      '}',
    ].join('\n')), []);
  });
});

describe('stop-keeps-claim', () => {
  const handler = (extra) => [
    'export const appUndeploy = adminProcedure.mutation(async ({ ctx, input }) => {',
    '  await markProjectStoppedBySlug(ctx.db, input.appName, "admin", new Date());',
    '  const undeployed = await orchestratorFetch("/undeploy", { method: "POST", body: JSON.stringify({ appName: input.appName }) });',
    ...extra,
    '  return undeployed;',
    '});',
  ].join('\n');
  it('fires: the process is stopped, its port claim kept', () => {
    assert.deepEqual(rules(handler([]), 'src/trpc/procedures/tenant.ts'), ['stop-keeps-claim']);
  });
  it('quiet: the claim is released too (the Tallrig fix)', () => {
    assert.deepEqual(rules(handler(['  await releaseProjectPortsBySlug(ctx.db, input.appName);']), 'src/trpc/procedures/tenant.ts'), []);
  });
});

describe('job-ignores-account-state', () => {
  const tick = (extra) => [
    'export async function runSmsSchedulerTick(deps) {',
    '  const pending = await deps.db.select().from(smsMessages)',
    '    .where(and(eq(smsMessages.status, "queued"), lte(smsMessages.scheduledAt, now), ...[' + extra + ']))',
    '    .limit(50);',
    '  for (const m of pending) await send(m);',
    '}',
  ].join('\n');
  it('fires: a scheduler sends queued work without reading the owner\'s state', () => {
    assert.deepEqual(rules(tick(''), 'src/sms/scheduler.ts'), ['job-ignores-account-state']);
  });
  it('quiet: the owner-active predicate in the query (the Tallrig fix)', () => {
    assert.deepEqual(rules(tick('SMS_OWNER_ACTIVE'), 'src/sms/scheduler.ts'), []);
  });
  it('quiet: a request handler outside any job path, with no job-shaped name', () => {
    assert.deepEqual(rules([
      'export async function listQueued(db) {',
      '  return db.select().from(smsMessages).where(eq(smsMessages.status, "queued"));',
      '}',
    ].join('\n'), 'src/routes/sms.ts'), []);
  });
});
