'use strict';
/**
 * Credential liveness — three states, never a guess.
 *
 *   alive        the vendor accepted the credential on a read-only call
 *   dead         the vendor REJECTED it (401/403), or it cannot be a key at all
 *   cannot-tell  no probe for this name, the other half of a pair is missing,
 *                a timeout, a network error, a 5xx, a 429 — anything that is
 *                not the vendor saying yes or no
 *
 * Every probe is a cheap, read-only GET. probeLiveness() never throws, gives
 * each probe 5 s by default, and never logs — the value goes into one request
 * header and nowhere else.
 */

const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 5000;

function verdict(status) {
  if (status >= 200 && status < 300) return 'alive';
  if (status === 401 || status === 403) return 'dead';
  return 'cannot-tell';
}

async function timedFetch(fetchImpl, url, init, timeoutMs) {
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { ac.abort(); resolve(null); }, timeoutMs);
  });
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: ac.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeStripe(ctx) {
  const key = ctx.get('STRIPE_SECRET_KEY');
  if (!key) return 'cannot-tell';
  const res = await ctx.fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${key}` } });
  return res ? verdict(res.status) : 'cannot-tell';
}

async function probeResend(ctx) {
  const key = ctx.get('RESEND_API_KEY');
  if (!key) return 'cannot-tell';
  const res = await ctx.fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${key}` } });
  if (!res) return 'cannot-tell';
  if (res.status === 401 || res.status === 403) {
    // A sending-only key is valid but may not list domains; Resend says so by
    // name. That is the vendor recognising the key — alive, not dead.
    let body = '';
    try { body = await res.text(); } catch { body = ''; }
    if (/restricted_api_key/.test(body)) return 'alive';
  }
  return verdict(res.status);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function normalisePem(raw) {
  let key = String(raw).trim().replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  if (!key.includes('BEGIN')) {
    const decoded = Buffer.from(key, 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) key = decoded;
  }
  return key;
}

/** App JWT (RS256, 9-minute life), or null when the key is not a usable private key. */
function appJwt(appId, pem, nowMs) {
  let keyObj;
  try { keyObj = crypto.createPrivateKey(normalisePem(pem)); } catch { return null; }
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: String(appId).trim() }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), keyObj);
  return `${head}.${body}.${b64url(sig)}`;
}

async function probeGithubApp(ctx) {
  const appId = ctx.get('GATETEST_APP_ID');
  const pem = ctx.get('GATETEST_PRIVATE_KEY');
  if (!appId || !pem) return 'cannot-tell';
  const jwt = appJwt(appId, pem, ctx.now());
  if (!jwt) return 'dead'; // the stored key is not a private key at all
  const res = await ctx.fetch('https://api.github.com/app', {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'gatetest-secrets-liveness' },
  });
  return res ? verdict(res.status) : 'cannot-tell';
}

async function probeAiProvider(ctx) {
  const key = ctx.get('ANTHROPIC_API_KEY');
  if (!key) return 'cannot-tell';
  const cfg = require('../anthropic-config');
  const res = await ctx.fetch(cfg.apiUrl('/v1/models'), { headers: cfg.headers(key) });
  return res ? verdict(res.status) : 'cannot-tell';
}

/** name → probe. Anything absent is cannot-tell (CRON_SECRET and other shared secrets have no vendor to ask). */
const CREDENTIAL_COVERAGE = Object.freeze({
  STRIPE_SECRET_KEY: probeStripe,
  RESEND_API_KEY: probeResend,
  GATETEST_APP_ID: probeGithubApp,
  GATETEST_PRIVATE_KEY: probeGithubApp,
  ANTHROPIC_API_KEY: probeAiProvider,
});

/**
 * @param {string} name
 * @param {{ get:(name:string)=>string|undefined, fetch?:Function, timeoutMs?:number, now?:()=>number }} opts
 * @returns {Promise<'alive'|'dead'|'cannot-tell'>}
 */
async function probeLiveness(name, opts) {
  const probe = Object.prototype.hasOwnProperty.call(CREDENTIAL_COVERAGE, name) ? CREDENTIAL_COVERAGE[name] : null;
  if (!probe) return 'cannot-tell';
  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const ctx = {
    get: (n) => {
      try { const v = opts.get(n); return typeof v === 'string' && v.trim() ? v : undefined; } catch { return undefined; }
    },
    fetch: async (url, init) => {
      try { return await timedFetch(fetchImpl, url, init, timeoutMs); } catch { return null; }
    },
    now: opts.now || Date.now,
  };
  try {
    const out = await probe(ctx);
    return out === 'alive' || out === 'dead' ? out : 'cannot-tell';
  } catch {
    return 'cannot-tell';
  }
}

module.exports = { probeLiveness };
