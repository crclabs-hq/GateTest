'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveFullReportAccess } = require('../website/app/lib/full-report-auth-core.js');

test('admin request always gets fullReport, regardless of sessionId/Stripe', async () => {
  const result = await resolveFullReportAccess({
    isAdmin: true,
    sessionId: undefined,
    stripeSecretKey: '',
    fetchStripeSession: async () => { throw new Error('must not be called for admin'); },
  });
  assert.equal(result, true);
});

test('no sessionId and not admin → false, even if Stripe is configured', async () => {
  const result = await resolveFullReportAccess({
    isAdmin: false,
    sessionId: undefined,
    stripeSecretKey: 'sk_test_x',
    fetchStripeSession: async () => { throw new Error('must not be called without a sessionId'); },
  });
  assert.equal(result, false);
});

test('sessionId present but STRIPE_SECRET_KEY unset → false (cannot verify)', async () => {
  const result = await resolveFullReportAccess({
    isAdmin: false,
    sessionId: 'cs_test_123',
    stripeSecretKey: '',
    fetchStripeSession: async () => { throw new Error('must not be called without a key'); },
  });
  assert.equal(result, false);
});

test('a real paid Stripe session grants fullReport', async () => {
  const result = await resolveFullReportAccess({
    isAdmin: false,
    sessionId: 'cs_test_paid',
    stripeSecretKey: 'sk_test_x',
    fetchStripeSession: async (sessionId, key) => {
      assert.equal(sessionId, 'cs_test_paid');
      assert.equal(key, 'sk_test_x');
      return { payment_status: 'paid' };
    },
  });
  assert.equal(result, true);
});

test('an unpaid Stripe session (payment_status !== "paid") is rejected', async () => {
  const result = await resolveFullReportAccess({
    isAdmin: false,
    sessionId: 'cs_test_unpaid',
    stripeSecretKey: 'sk_test_x',
    fetchStripeSession: async () => ({ payment_status: 'unpaid' }),
  });
  assert.equal(result, false);
});

test('a client-supplied sessionId that Stripe has never heard of (empty response) is rejected', async () => {
  const result = await resolveFullReportAccess({
    isAdmin: false,
    sessionId: 'cs_made_up',
    stripeSecretKey: 'sk_test_x',
    fetchStripeSession: async () => ({}),
  });
  assert.equal(result, false);
});

test('a Stripe API error fails closed (no report), not open', async () => {
  const result = await resolveFullReportAccess({
    isAdmin: false,
    sessionId: 'cs_test_err',
    stripeSecretKey: 'sk_test_x',
    fetchStripeSession: async () => { throw new Error('network error'); },
  });
  assert.equal(result, false);
});

test('a non-string sessionId (e.g. client sends {sessionId: true}) is rejected before any network call', async () => {
  const result = await resolveFullReportAccess({
    isAdmin: false,
    sessionId: true,
    stripeSecretKey: 'sk_test_x',
    fetchStripeSession: async () => { throw new Error('must not be called for a non-string sessionId'); },
  });
  assert.equal(result, false);
});

// ── defaultFetchStripeSession is exported for the .ts wrapper to use ────
test('module exports defaultFetchStripeSession for production wiring', () => {
  const core = require('../website/app/lib/full-report-auth-core.js');
  assert.equal(typeof core.defaultFetchStripeSession, 'function');
});
