'use strict';

// Control pairs for src/core/account-state-rules.js. Firing halves
// paraphrase Tallrig's shipped shapes (TALLRIG-2026-043..046; the corpus is
// private and never committed here) and the Gluecron door found the same
// day; quiet halves are the fixes plus the idioms real code uses.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scanAccountState } = require('../src/core/account-state-rules');

const rules = (src, rel = 'src/auth/vendor-auth.ts') => scanAccountState(rel, src).map((f) => f.rule);

describe('identifier-as-credential', () => {
  const door = (check) => [
    'export async function authBasic(header, db) {',
    '  const parts = decodeBasic(header);',
    '  if (!parts) return { ok: false };',
    ...check,
    '  return { ok: true, userId };',
    '}',
  ].join('\n');
  it('fires: only the id half is resolved', () => {
    assert.deepEqual(rules(door(['  const userId = await resolveUser(parts.user, db);', '  if (!userId) return { ok: false };'])), ['identifier-as-credential']);
  });
  it('quiet: the secret is verified too (the Tallrig fix)', () => {
    assert.deepEqual(rules(door([
      '  const userId = await resolveUserFromKey(parts.secret, db);',
      '  const idUser = await resolveUser(parts.user, db);',
      '  if (!userId || idUser !== userId) return { ok: false };',
    ])), []);
  });
});

describe('deny-list-status', () => {
  it('fires: one named shut-off state in auth code', () => {
    assert.deepEqual(rules('  if (!tenant || tenant.status === "suspended") return null;'), ['deny-list-status']);
    assert.deepEqual(rules('  if (owned && owned.status !== "suspended") {'), ['deny-list-status']);
  });
  it('quiet: an allow-list predicate (the Tallrig fix)', () => {
    assert.deepEqual(rules('  if (!tenant || !["active", "provisioning"].includes(tenant.status)) return null;'), []);
  });
  it('quiet: the same comparison outside auth code (a UI banner)', () => {
    assert.deepEqual(rules('  if (org.status === "suspended") showBanner();', 'src/components/OrgHeader.tsx'), []);
  });
  it('quiet: a comparison to a positive state', () => {
    assert.deepEqual(rules('  if (tenant.status !== "active") return null;'), []);
  });
});

describe('key-door-owner-unchecked', () => {
  const door = (extra) => [
    'app.use("/api/*", async (c, next) => {',
    '  const key = results[0];',
    '  if (!key) return c.json({ error: "Invalid API key" }, 401);',
    '  if (key.expiresAt && key.expiresAt < new Date()) return c.json({ error: "expired" }, 401);',
    ...extra,
    '  c.set("userId", key.userId);',
    '  return next();',
    '});',
  ].join('\n');
  it('fires: key row checked, owner state never read', () => {
    assert.deepEqual(rules(door([]), 'src/middleware/api-key-auth.ts'), ['key-door-owner-unchecked']);
  });
  it('quiet: the owner\'s suspension is checked (the Tallrig fix)', () => {
    assert.deepEqual(rules(door(['  if (await isUserSuspended(db, key.userId)) return c.json({ error: "Invalid API key" }, 401);']), 'src/middleware/api-key-auth.ts'), []);
  });
  it('quiet: a lookup that never sets a principal from the key', () => {
    assert.deepEqual(rules([
      'async function purge(db) {',
      '  const key = rows[0];',
      '  if (key.expiresAt < new Date()) await db.delete(apiKeys).where(eq(apiKeys.id, key.id));',
      '}',
    ].join('\n')), []);
  });
});

describe('suspend-keeps-keys', () => {
  const handler = (extra) => [
    'export const suspendUser = adminProcedure.mutation(async ({ ctx, input }) => {',
    '  await ctx.db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, input.userId));',
    '  await ctx.db.delete(sessions).where(eq(sessions.userId, input.userId));',
    ...extra,
    '  return { ok: true };',
    '});',
  ].join('\n');
  it('fires: sessions revoked, keys left', () => {
    assert.deepEqual(rules(handler([]), 'src/trpc/procedures/admin.ts'), ['suspend-keeps-keys']);
  });
  it('quiet: keys revoked too (the Tallrig fix)', () => {
    assert.deepEqual(rules(handler(['  await revokeSuspendedUserKeys(ctx.db, input.userId);']), 'src/trpc/procedures/admin.ts'), []);
  });
  it('quiet: a suspend that revokes nothing is a different shape (not this rule)', () => {
    assert.deepEqual(rules([
      'export async function pause(db, id) {',
      '  await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, id));',
      '}',
    ].join('\n'), 'src/trpc/procedures/admin.ts'), []);
  });
});
