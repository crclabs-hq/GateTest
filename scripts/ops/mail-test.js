#!/usr/bin/env node
/**
 * Prove the configured e-mail provider can actually deliver — from the box,
 * using the env file, without any secret passing through a chat or a log.
 *
 *   set -a; . /opt/gatetest/website/.env.local; set +a
 *   node scripts/ops/mail-test.js support@gatetest.io            # current provider
 *   MAIL_PROVIDER=vapron node scripts/ops/mail-test.js support@gatetest.io
 *
 * Exit 0 and a message id = the provider accepted it; then check the inbox.
 * This is the exact path the MCP API-key and billing-portal e-mails take.
 */
const path = require('path');
const { deliver, mailProvider, mailConfigured, fromAddress } = require(path.join(__dirname, '..', '..', 'website', 'app', 'lib', 'mail-transport.js'));

const to = process.argv[2];
if (!to || !to.includes('@')) {
  console.error('usage: node scripts/ops/mail-test.js <recipient@domain>');
  process.exit(2);
}

const provider = mailProvider();
console.log(`[mail-test] provider=${provider} configured=${mailConfigured()} from=${fromAddress()} to=${to}`);
if (!mailConfigured()) {
  console.error(`[mail-test] provider "${provider}" is not configured — check RESEND_API_KEY or VAPRON_API_KEY (or VAPRON_API_TOKEN) in the env file`);
  process.exit(1);
}

const stamp = new Date().toISOString();
deliver({
  to,
  subject: `GateTest mail test (${provider}) ${stamp}`,
  text: `If you can read this, GateTest can send e-mail through ${provider} from ${fromAddress()}.\nSent ${stamp}.`,
  html: `<p>If you can read this, GateTest can send e-mail through <b>${provider}</b> from ${fromAddress()}.</p><p>Sent ${stamp}.</p>`,
}).then((r) => {
  if (r.ok) { console.log(`[mail-test] accepted by ${r.provider}${r.id ? ` id=${r.id}` : ''} — now check ${to}`); process.exit(0); }
  console.error(`[mail-test] ${r.provider} refused: ${r.error}`);
  process.exit(1);
});
