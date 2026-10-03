'use strict';

/**
 * Is the TLS session we observed the site's own, or a local intercepting
 * proxy's?
 *
 * One definition (Doctrine §4) for the live server checks. Scanned from a host
 * behind an intercepting proxy (a sandbox, a corporate gateway), the leaf
 * certificate is minted by the proxy's CA — "issued by Anthropic, expires in
 * 29 days" (2026-10-03) was a fact about the proxy, not about the site — and
 * every request pays the proxy's hop, so TTFB is inflated too. Reporting either
 * as a finding about the site is a false positive; the honest answer is the
 * third state: not checked (Doctrine §1, §6).
 *
 * Intercepted only on EVIDENCE in the certificate we were handed:
 *   - the leaf certificate is itself in the CA bundle at NODE_EXTRA_CA_CERTS;
 *   - the leaf's issuer (CN + O) is the subject of a certificate in that bundle.
 * A proxy variable alone is not evidence: a plain forwarding proxy (CONNECT
 * tunnel, the common corporate setup) passes the site's own certificate
 * through, and treating it as interception would silently drop the expiry
 * check for every customer scanning from behind one.
 */

const fs = require('fs');
const crypto = require('crypto');

function parseDn(str) {
  const out = {};
  for (const line of String(str || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function sameDn(a, b) {
  if (!a || !b) return false;
  const cn = a.CN || '';
  const o = a.O || '';
  if (!cn && !o) return false;
  return cn === (b.CN || '') && o === (b.O || '');
}

// Node's built-in public roots. A NODE_EXTRA_CA_CERTS bundle commonly
// carries the whole system store too (155 certs in this sandbox), and a
// public root in it is no evidence of interception — every Let's Encrypt
// site chains to one. Only certificates the bundle ADDS count.
let publicRootFingerprints = null;
function publicRoots() {
  if (!publicRootFingerprints) {
    publicRootFingerprints = new Set();
    for (const pem of require('tls').rootCertificates || []) {
      try { publicRootFingerprints.add(new crypto.X509Certificate(pem).fingerprint256); } catch { /* error-ok — skip an unparsable root */ }
    }
  }
  return publicRootFingerprints;
}

/** Certificates the NODE_EXTRA_CA_CERTS bundle adds beyond Node's public roots: [{ subject, fingerprint256 }]. */
function extraCaBundle(env) {
  const file = env && env.NODE_EXTRA_CA_CERTS;
  if (!file) return [];
  let pem;
  try {
    pem = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // error-ok — an unreadable bundle is "no local CA known"
  }
  const out = [];
  for (const block of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []) {
    try {
      const x = new crypto.X509Certificate(block);
      if (publicRoots().has(x.fingerprint256)) continue;
      out.push({ subject: parseDn(x.subject), fingerprint256: x.fingerprint256 });
    } catch {
      // error-ok — one malformed block must not hide the others
    }
  }
  return out;
}

/**
 * @param {{ cert?: object, env?: object }} p  `cert` is the object from
 *   `socket.getPeerCertificate()`. Without one there is no evidence, so the
 *   answer is "not intercepted" (the TTFB check reuses the SSL check's verdict).
 * @returns {{ intercepted: boolean, reason: string|null }}
 */
function detectTlsIntercept({ cert, env = process.env } = {}) {
  if (cert) {
    const bundle = extraCaBundle(env);
    if (bundle.length === 0) return { intercepted: false, reason: null };
    // Walk the presented chain (getPeerCertificate(true) links each cert to
    // its issuer): the leaf is usually signed by an intermediate, and only
    // the root or an intermediate is in the local bundle (2026-10-03: leaf
    // issued by "Egress Gateway SDS Issuing CA", root in the bundle).
    const seen = new Set();
    for (let c = cert; c && !seen.has(c); c = c.issuerCertificate) {
      seen.add(c);
      if (c.fingerprint256 && bundle.some((b) => b.fingerprint256 === c.fingerprint256)) {
        return { intercepted: true, reason: 'the certificate chain includes a CA from the local CA bundle (NODE_EXTRA_CA_CERTS)' };
      }
      if (c.issuer && bundle.some((b) => sameDn(c.issuer, b.subject))) {
        return { intercepted: true, reason: 'the certificate chain is issued by a CA from the local CA bundle (NODE_EXTRA_CA_CERTS)' };
      }
      if (c.issuerCertificate === c) break;
    }
  }
  return { intercepted: false, reason: null };
}

module.exports = { detectTlsIntercept, extraCaBundle };
