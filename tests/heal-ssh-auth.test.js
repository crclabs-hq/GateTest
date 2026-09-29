"use strict";

// /api/heal/ssh runs sudo playbooks over SSH on the production server and
// authenticates with GATETEST_SSH_PASSWORD / GATETEST_SSH_KEY. Finding #149:
// the route shipped with no auth gate and let the request body choose the SSH
// target host + credentials, so an anonymous POST could either fire the sudo
// playbooks on the real server or redirect the password to an attacker host.
// These tests pin both halves of the fix.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ROUTE = path.join(ROOT, "website/app/api/heal/ssh/route.ts");

test("heal/ssh route: file exists", () => {
  assert.ok(fs.existsSync(ROUTE), `expected route at ${ROUTE}`);
});

test("heal/ssh route: imports the shared admin gate", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /import \{ requireAdminRoute \} from "@\/app\/lib\/admin-guard"/);
});

test("heal/ssh route: admin-only and same-origin — requireAdminRoute is the first statement", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /export async function POST\(req: NextRequest\) \{[\s\S]*?const refused = requireAdminRoute\(req, \{ mutating: true \}\);\s*if \(refused\) return refused;/);
});

test("heal/ssh route: SSH target and credentials come from env only, never the request body", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.doesNotMatch(src, /body\.host\b/, "host must not be readable from the request body");
  assert.doesNotMatch(src, /body\.port\b/, "port must not be readable from the request body");
  assert.doesNotMatch(src, /body\.username\b/, "username must not be readable from the request body");
  assert.doesNotMatch(src, /body\.password\b/, "password must not be readable from the request body");
  assert.match(src, /process\.env\.GATETEST_SSH_HOST/);
});
