'use strict';

/**
 * Hard-coded host rules — built against Tallrig's bug corpus (scored by
 * scripts/cross-test-score.js). A platform that renames or retires a domain
 * keeps every literal that spelled the old one:
 *
 *   hardcoded-dns-target    a generated DNS record (MX / CNAME / NS / SRV)
 *                           whose target is a hostname literal, or a const
 *                           bound to one in this file — customer zones keep
 *                           pointing at it after the host is retired
 *                           (TALLRIG-2026-006: every connected domain's MX
 *                           pointed at a third-party mail host)
 *   hardcoded-tenant-domain a tenant host built as `${slug}.<literal domain>`
 *                           — the platform's own base domain typed inline,
 *                           so a rename leaves live URLs on the old domain
 *                           (TALLRIG-2026-011: `${slug}.vapron.app` after
 *                           the Tallrig rename)
 *
 * Warnings. Pure: (relPath, content) → findings. Control pairs in
 * tests/hardcoded-host-rules.test.js.
 */

const HOST_LITERAL_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}\.?$/i;
const DNS_TYPE_RE = /\btype\s*:\s*["'`](MX|CNAME|NS|SRV)["'`]/;

/** `export const NAME = "mx1.example.com";` → Map(NAME → host). */
function hostConstants(lines) {
  const out = new Map();
  for (const line of lines) {
    const m = line.match(/\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*string)?\s*=\s*["'`]([^"'`$]+)["'`]\s*;?\s*$/);
    if (m && HOST_LITERAL_RE.test(m[2])) out.set(m[1], m[2]);
  }
  return out;
}

function hardcodedDnsTarget(relPath, lines) {
  const consts = hostConstants(lines);
  const findings = [];
  lines.forEach((line, i) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
    const t = line.match(DNS_TYPE_RE);
    if (!t) return;
    const c = line.match(/\bcontent\s*:\s*(?:["'`]([^"'`$]+)["'`]|([A-Za-z_$][\w$]*)\s*[,}])/);
    if (!c) return;
    const host = c[1] && HOST_LITERAL_RE.test(c[1]) ? c[1] : (c[2] && consts.get(c[2]));
    if (!host) return;
    findings.push({
      rule: 'hardcoded-dns-target',
      line: i + 1,
      severity: 'warning',
      message: `${relPath}:${i + 1} generates a ${t[1]} record pointing at the hard-coded host ${host} — every zone created this way keeps targeting it after the host is retired or the provider changes`,
      suggestion: 'Read the target from the platform identity/config in one place, and refuse to generate a record whose target is on a retired-host list.',
    });
  });
  return findings;
}

// Hosts that are always a third party's, never the platform's own base domain.
const THIRD_PARTY_DOMAIN_RE = /(?:^|\.)(?:amazonaws\.com|cloudfront\.net|googleapis\.com|googleusercontent\.com|azurewebsites\.net|blob\.core\.windows\.net|github\.io|githubusercontent\.com|herokuapp\.com|vercel\.app|netlify\.app|pages\.dev|workers\.dev|fly\.dev|onrender\.com|supabase\.co|firebaseapp\.com|web\.app|myshopify\.com|slack\.com|atlassian\.net|zendesk\.com|salesforce\.com|example\.(?:com|org|net)|localhost|test|invalid)$/i;
const TENANT_VAR_RE = /^(?:[\w$.]*\.)?(?:slug|subdomain|tenant\w*|project\w*|app\w*|site\w*|workspace\w*|org\w*|account\w*)$/i;

function hardcodedTenantDomain(relPath, lines) {
  const findings = [];
  lines.forEach((line, i) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
    const re = /\$\{\s*([\w$.?]+)\s*\}\.((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[`/:"'\s?#]|$)/gi;
    let m;
    while ((m = re.exec(line))) {
      const v = m[1].replace(/\?/g, '');
      const domain = m[2];
      if (!TENANT_VAR_RE.test(v) || THIRD_PARTY_DOMAIN_RE.test(domain)) continue;
      findings.push({
        rule: 'hardcoded-tenant-domain',
        line: i + 1,
        severity: 'warning',
        message: `${relPath}:${i + 1} builds a tenant host as \`\${${v}}.${domain}\` with the base domain typed inline — a rename or move of ${domain} leaves these URLs on the old domain`,
        suggestion: 'Build tenant hosts through one helper that reads the platform domain from config, so a rename changes one line.',
      });
    }
  });
  return findings;
}

function scanHardcodedHosts(relPath, content) {
  const lines = String(content).split(/\r?\n/);
  return [...hardcodedDnsTarget(relPath, lines), ...hardcodedTenantDomain(relPath, lines)];
}

module.exports = { scanHardcodedHosts, hardcodedDnsTarget, hardcodedTenantDomain };
