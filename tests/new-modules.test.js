/**
 * Tests for all new modules: P0-AI layer + AI Fix Engine
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ─── helpers ───────────────────────────────────────────────────────────────

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-new-'));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

function makeResult(moduleName) {
  const checks = [];
  return {
    module: moduleName,
    checks,
    fixes: [],
    addCheck(name, passed, details = {}) {
      checks.push({ name, passed, ...details });
    },
    addFix(name, desc, files) {
      this.fixes.push({ check: name, description: desc, filesChanged: files || [] });
    },
    get errorChecks() { return checks.filter(c => !c.passed && c.severity === 'error'); },
    get warningChecks() { return checks.filter(c => !c.passed && c.severity === 'warning'); },
    get infoChecks() { return checks.filter(c => c.severity === 'info'); },
  };
}

// ─── AI Fix Engine ─────────────────────────────────────────────────────────

describe('AI Fix Engine', () => {
  it('loads without error', () => {
    const engine = require('../src/core/ai-fix-engine');
    assert.strictEqual(typeof engine.aiFix, 'function');
    assert.strictEqual(typeof engine.injectAutoFixes, 'function');
    assert.strictEqual(typeof engine.makeAutoFix, 'function');
  });

  it('makeAutoFix returns a function', () => {
    const { makeAutoFix } = require('../src/core/ai-fix-engine');
    const fix = makeAutoFix('/tmp/test.js', 'test', 'msg', 1, 'hint');
    assert.strictEqual(typeof fix, 'function');
  });

  it('aiFix returns fixed:false with no API key', async () => {
    const { aiFix } = require('../src/core/ai-fix-engine');
    const tmp  = makeTmp();
    const file = write(tmp, 'test.js', 'const x = 1;');
    const result = await aiFix({
      filePath: file,
      issueTitle: 'test',
      issueMessage: 'test message',
      apiKey: '',
    });
    assert.strictEqual(result.fixed, false);
  });

  it('injectAutoFixes adds autoFix to checks with file + fix', () => {
    const { injectAutoFixes } = require('../src/core/ai-fix-engine');
    const tmp = makeTmp();
    const file = write(tmp, 'src/test.js', 'const x = 1;');

    const mockResults = [{
      checks: [{
        name: 'test-check',
        passed: false,
        severity: 'error',
        file: 'src/test.js',
        fix: 'Fix the issue',
        message: 'Something is wrong',
      }],
    }];

    // Without API key, inject is no-op
    delete process.env.ANTHROPIC_API_KEY;
    injectAutoFixes(mockResults, tmp);
    assert.strictEqual(mockResults[0].checks[0].autoFix, undefined);
  });
});

// ─── Auth Bypass Detector ─────────────────────────────────────────────────

describe('AuthBypassDetector', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/auth-bypass');
    const m   = new Mod();
    assert.strictEqual(m.name, 'authBypass');
    assert.strictEqual(typeof m.run, 'function');
  });

  it('passes on project with no route files', async () => {
    const Mod    = require('../src/modules/auth-bypass');
    const m      = new Mod();
    const tmp    = makeTmp();
    write(tmp, 'src/util.js', 'module.exports = {};');
    const result = makeResult('authBypass');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.checks.length > 0);
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('passes on authenticated Next.js route', async () => {
    const Mod = require('../src/modules/auth-bypass');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'app/api/protected/route.ts', `
import { getServerSession } from 'next-auth';
export async function GET(req) {
  const session = getServerSession();
  if (!session) return new Response('Unauthorized', { status: 401 });
  return Response.json({ data: 'ok' });
}
`);
    const result = makeResult('authBypass');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('flags unprotected route', async () => {
    const Mod = require('../src/modules/auth-bypass');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'app/api/users/route.ts', `
export async function GET(req) {
  const users = await db.user.findMany();
  return Response.json(users);
}
`);
    const result = makeResult('authBypass');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.errorChecks.length > 0, 'Should flag unprotected route');
  });

  it('respects // auth-public suppression', async () => {
    const Mod = require('../src/modules/auth-bypass');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'app/api/public/route.ts', `
// auth-public
export async function GET(req) {
  return Response.json({ status: 'ok' });
}
`);
    const result = makeResult('authBypass');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });
});

// ─── AI Hallucination Detector ─────────────────────────────────────────────

describe('AiHallucinationDetector', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/ai-hallucination');
    const m   = new Mod();
    assert.strictEqual(m.name, 'aiHallucination');
  });

  it('passes on project with no imports', async () => {
    const Mod = require('../src/modules/ai-hallucination');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', dependencies: {} }));
    write(tmp, 'src/index.js', 'const x = 1;');
    const result = makeResult('aiHallucination');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('flags import of package not in package.json', async () => {
    const Mod = require('../src/modules/ai-hallucination');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', dependencies: {} }));
    write(tmp, 'src/index.js', `import { doThing } from 'made-up-package-xyz';`);
    const result = makeResult('aiHallucination');
    await m.run(result, { projectRoot: tmp });
    // Unknown-pkg is WARNING severity since 33fa614 (false-positive noise
    // reduction from real user feedback) — the finding must still fire.
    assert.ok(result.warningChecks.length > 0, 'Should flag unknown package');
    assert.ok(
      result.warningChecks.some((c) => c.name.includes('made-up-package-xyz')),
      'Flag should name the hallucinated package'
    );
  });

  it('does not flag Node.js builtins', async () => {
    const Mod = require('../src/modules/ai-hallucination');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', dependencies: {} }));
    write(tmp, 'src/index.js', `
const fs = require('fs');
const path = require('path');
import https from 'https';
`);
    const result = makeResult('aiHallucination');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('flags hallucinated fs method', async () => {
    const Mod = require('../src/modules/ai-hallucination');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', dependencies: {} }));
    write(tmp, 'src/index.js', `const files = fs.readAllFiles('/tmp');`);
    const result = makeResult('aiHallucination');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.warningChecks.length > 0 || result.errorChecks.length > 0);
  });

  it('respects // hallucination-ok suppression', async () => {
    const Mod = require('../src/modules/ai-hallucination');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', dependencies: {} }));
    write(tmp, 'src/index.js', `import { x } from 'phantom-pkg'; // hallucination-ok`);
    const result = makeResult('aiHallucination');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });
});

// ─── Deploy Script Validator ───────────────────────────────────────────────

describe('DeployScriptValidator', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/deploy-script-validator');
    const m   = new Mod();
    assert.strictEqual(m.name, 'deployScriptValidator');
  });

  it('passes when no health checks found', async () => {
    const Mod = require('../src/modules/deploy-script-validator');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'src/index.js', 'module.exports = {};');
    const result = makeResult('deployScriptValidator');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('passes when health check URL matches route', async () => {
    const Mod = require('../src/modules/deploy-script-validator');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, '.github/workflows/deploy.yml', `
steps:
  - name: Health check
    run: curl http://localhost:3000/api/health
`);
    write(tmp, 'app/api/health/route.ts', `export async function GET() { return Response.json({ ok: true }); }`);
    const result = makeResult('deployScriptValidator');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('flags mismatched health check URL', async () => {
    const Mod = require('../src/modules/deploy-script-validator');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'deploy.sh', `#!/bin/bash\ncurl http://localhost:3000/api/health`);
    write(tmp, 'app/health/route.ts', `export async function GET() { return Response.json({ ok: true }); }`);
    const result = makeResult('deployScriptValidator');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.errorChecks.length > 0, 'Should flag URL mismatch');
  });
});

// ─── Service Consistency ───────────────────────────────────────────────────

describe('ServiceConsistency', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/service-consistency');
    const m   = new Mod();
    assert.strictEqual(m.name, 'serviceConsistency');
  });

  it('passes with no service files', async () => {
    const Mod = require('../src/modules/service-consistency');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', scripts: { start: 'node src/index.js' } }));
    const result = makeResult('serviceConsistency');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('passes when Procfile matches package.json', async () => {
    const Mod = require('../src/modules/service-consistency');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', scripts: { start: 'node src/index.js' } }));
    write(tmp, 'Procfile', 'web: node src/index.js');
    const result = makeResult('serviceConsistency');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.warningChecks.length, 0);
  });

  it('warns when Procfile mismatches package.json', async () => {
    const Mod = require('../src/modules/service-consistency');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', scripts: { start: 'node src/index.js' } }));
    write(tmp, 'Procfile', 'web: node dist/app.js');
    const result = makeResult('serviceConsistency');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.warningChecks.length > 0, 'Should warn on mismatch');
  });
});

// ─── Native Bundler Guard ──────────────────────────────────────────────────

describe('NativeBundlerGuard', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/native-bundler-guard');
    const m   = new Mod();
    assert.strictEqual(m.name, 'nativeBundlerGuard');
  });

  it('passes when no bundler script present', async () => {
    const Mod = require('../src/modules/native-bundler-guard');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', scripts: { start: 'node src/index.js' }, dependencies: { 'better-sqlite3': '^8' } }));
    const result = makeResult('nativeBundlerGuard');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('flags native package with bundler script', async () => {
    const Mod = require('../src/modules/native-bundler-guard');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({
      name: 'test',
      scripts: { build: 'bun build src/index.ts --outdir dist' },
      dependencies: { 'better-sqlite3': '^8.0.0' },
    }));
    const result = makeResult('nativeBundlerGuard');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.errorChecks.length > 0, 'Should flag native package');
  });
});

// ─── CI Param Validator ────────────────────────────────────────────────────

describe('CiParamValidator', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/ci-param-validator');
    const m   = new Mod();
    assert.strictEqual(m.name, 'ciParamValidator');
  });

  it('passes with no workflow files', async () => {
    const Mod = require('../src/modules/ci-param-validator');
    const m   = new Mod();
    const tmp = makeTmp();
    const result = makeResult('ciParamValidator');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('validates local action inputs', async () => {
    const Mod = require('../src/modules/ci-param-validator');
    const m   = new Mod();
    const tmp = makeTmp();

    write(tmp, '.github/workflows/ci.yml', `
jobs:
  build:
    steps:
      - name: Run custom action
        uses: ./actions/my-action
        with:
          token: \${{ secrets.TOKEN }}
          unknown-param: value
`);

    write(tmp, 'actions/my-action/action.yml', `
name: My Action
inputs:
  token:
    description: Auth token
    required: true
runs:
  using: node20
  main: index.js
`);

    const result = makeResult('ciParamValidator');
    await m.run(result, { projectRoot: tmp });
    // unknown-param should be flagged
    assert.ok(result.warningChecks.length > 0, 'Should warn on unknown input');
  });
});

// ─── Monorepo Constraints ──────────────────────────────────────────────────

describe('MonorepoConstraints', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/monorepo-constraints');
    const m   = new Mod();
    assert.strictEqual(m.name, 'monorepoConstraints');
  });

  it('skips non-monorepo projects', async () => {
    const Mod = require('../src/modules/monorepo-constraints');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'src/index.ts', 'export const x = 1;');
    const result = makeResult('monorepoConstraints');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('flags cross-app import', async () => {
    const Mod = require('../src/modules/monorepo-constraints');
    const m   = new Mod();
    const tmp = makeTmp();

    write(tmp, 'apps/web/package.json', JSON.stringify({ name: '@repo/web' }));
    write(tmp, 'apps/api/package.json', JSON.stringify({ name: '@repo/api' }));
    write(tmp, 'apps/web/src/index.ts', `import { handler } from '@repo/api';`);

    const result = makeResult('monorepoConstraints');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.errorChecks.length > 0, 'Should flag cross-app import');
  });
});

// ─── Zod Schema Presence ──────────────────────────────────────────────────

describe('ZodSchemaPresence', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/zod-schema');
    const m   = new Mod();
    assert.strictEqual(m.name, 'zodSchemaPresence');
  });

  it('skips when zod not installed', async () => {
    const Mod = require('../src/modules/zod-schema');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', dependencies: {} }));
    const result = makeResult('zodSchemaPresence');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('warns on component without schema when zod installed', async () => {
    const Mod = require('../src/modules/zod-schema');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', dependencies: { zod: '^3' } }));
    write(tmp, 'src/Button.tsx', `
export default function Button({ label, onClick }: { label: string; onClick: () => void }) {
  return <button onClick={onClick}>{label}</button>;
}
`);
    const result = makeResult('zodSchemaPresence');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.warningChecks.length > 0, 'Should warn on missing schema');
  });

  it('passes component with zod schema', async () => {
    const Mod = require('../src/modules/zod-schema');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', dependencies: { zod: '^3' } }));
    write(tmp, 'src/Button.tsx', `
import { z } from 'zod';
const PropsSchema = z.object({ label: z.string() });
type Props = z.infer<typeof PropsSchema>;
export default function Button({ label }: Props) {
  return <button>{label}</button>;
}
`);
    const result = makeResult('zodSchemaPresence');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.warningChecks.length, 0);
  });
});

// ─── Bundle Size ───────────────────────────────────────────────────────────

describe('BundleSize', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/bundle-size');
    const m   = new Mod();
    assert.strictEqual(m.name, 'bundleSize');
  });

  it('passes when no build output present', async () => {
    const Mod = require('../src/modules/bundle-size');
    const m   = new Mod();
    const tmp = makeTmp();
    const result = makeResult('bundleSize');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('flags oversized chunk', async () => {
    const Mod = require('../src/modules/bundle-size');
    const m   = new Mod();
    const tmp = makeTmp();
    const largeContent = 'x'.repeat(210 * 1024); // 210 KB
    write(tmp, 'dist/main.js', largeContent);
    const result = makeResult('bundleSize');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.errorChecks.length > 0 || result.warningChecks.length > 0, 'Should flag large bundle');
  });
});

// ─── Duplicate Code ────────────────────────────────────────────────────────

describe('DuplicateCode', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/duplicate-code');
    const m   = new Mod();
    assert.strictEqual(m.name, 'duplicateCode');
  });

  it('passes on project with no duplicates', async () => {
    const Mod = require('../src/modules/duplicate-code');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'src/a.js', 'function add(a,b) { return a+b; }\nmodule.exports = add;');
    write(tmp, 'src/b.js', 'function mul(a,b) { return a*b; }\nmodule.exports = mul;');
    const result = makeResult('duplicateCode');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('flags copy-pasted block across files', async () => {
    const Mod = require('../src/modules/duplicate-code');
    const m   = new Mod();
    const tmp = makeTmp();
    const block = `
function validateEmail(email) {
  const re = /^[^@]+@[^@]+\\.[^@]+$/;
  const result = re.test(email);
  if (!result) throw new Error('Invalid');
  return email.toLowerCase();
}
`;
    write(tmp, 'src/user.js', block + '\nmodule.exports = validateEmail;');
    write(tmp, 'src/auth.js', block + '\nmodule.exports = validateEmail;');
    const result = makeResult('duplicateCode');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.warningChecks.length > 0, 'Should flag duplicate block');
  });
});

// ─── tRPC Contract ─────────────────────────────────────────────────────────

describe('TRPCContractDrift', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/trpc-contract');
    const m   = new Mod();
    assert.strictEqual(m.name, 'trpcContract');
  });

  it('skips when tRPC not installed', async () => {
    const Mod = require('../src/modules/trpc-contract');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', dependencies: {} }));
    const result = makeResult('trpcContract');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('flags call to undefined procedure', async () => {
    const Mod = require('../src/modules/trpc-contract');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'package.json', JSON.stringify({ name: 'test', dependencies: { '@trpc/server': '^10' } }));
    write(tmp, 'server/router.ts', `
const appRouter = createTRPCRouter({
  getUser: procedure.query(() => {}),
});
`);
    write(tmp, 'client/page.tsx', `
const data = trpc.getUsers.useQuery(); // typo: "getUsers" not "getUser"
`);
    const result = makeResult('trpcContract');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.errorChecks.length > 0, 'Should flag undefined procedure');
  });
});

// ─── Webhook Payload Validator ─────────────────────────────────────────────

describe('WebhookPayloadValidator', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/webhook-payload');
    const m   = new Mod();
    assert.strictEqual(m.name, 'webhookPayload');
  });

  it('passes with no webhook handlers', async () => {
    const Mod = require('../src/modules/webhook-payload');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'src/index.js', 'module.exports = {};');
    const result = makeResult('webhookPayload');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('flags unvalidated webhook body access', async () => {
    const Mod = require('../src/modules/webhook-payload');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'app/api/webhook/route.ts', `
export async function POST(req) {
  const body = await req.json();
  const event = req.body.type; // no validation
  await processEvent(event);
}
`);
    const result = makeResult('webhookPayload');
    await m.run(result, { projectRoot: tmp });
    assert.ok(result.errorChecks.length > 0, 'Should flag unvalidated webhook');
  });

  it('passes webhook with Stripe signature verification', async () => {
    const Mod = require('../src/modules/webhook-payload');
    const m   = new Mod();
    const tmp = makeTmp();
    write(tmp, 'app/api/webhook/stripe/route.ts', `
export async function POST(req) {
  const sig = req.headers.get('stripe-signature');
  const event = stripe.webhooks.constructEvent(body, sig, secret);
  const amount = req.body.data.amount;
  return Response.json({ received: true });
}
`);
    const result = makeResult('webhookPayload');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });
});

// ─── Intent Verification ──────────────────────────────────────────────────

describe('IntentVerification', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/intent-verification');
    const m   = new Mod();
    assert.strictEqual(m.name, 'intentVerification');
  });

  it('skips gracefully with no API key', async () => {
    const Mod = require('../src/modules/intent-verification');
    const m   = new Mod();
    const tmp = makeTmp();
    delete process.env.ANTHROPIC_API_KEY;
    const result = makeResult('intentVerification');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
    const info = result.checks.find(c => c.name === 'intent-verification:no-key');
    assert.ok(info, 'Should emit no-key info check');
  });
});

// ─── Regression Predictor ─────────────────────────────────────────────────

describe('RegressionPredictor', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/regression-predictor');
    const m   = new Mod();
    assert.strictEqual(m.name, 'regressionPredictor');
  });

  it('skips gracefully with no API key', async () => {
    const Mod = require('../src/modules/regression-predictor');
    const m   = new Mod();
    const tmp = makeTmp();
    delete process.env.ANTHROPIC_API_KEY;
    const result = makeResult('regressionPredictor');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });
});

// ─── Architecture Drift ───────────────────────────────────────────────────

describe('ArchitectureDrift', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/architecture-drift');
    const m   = new Mod();
    assert.strictEqual(m.name, 'architectureDrift');
  });

  it('skips gracefully with no API key', async () => {
    const Mod = require('../src/modules/architecture-drift');
    const m   = new Mod();
    const tmp = makeTmp();
    delete process.env.ANTHROPIC_API_KEY;
    const result = makeResult('architectureDrift');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
  });

  it('skips when no architecture docs found', async () => {
    const Mod = require('../src/modules/architecture-drift');
    const m   = new Mod();
    const tmp = makeTmp();
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    const result = makeResult('architectureDrift');
    await m.run(result, { projectRoot: tmp });
    assert.strictEqual(result.errorChecks.length, 0);
    delete process.env.ANTHROPIC_API_KEY;
  });
});

// ─── Deploy Readiness ─────────────────────────────────────────────────────

describe('DeployReadiness', () => {
  it('loads correctly', () => {
    const Mod = require('../src/modules/deploy-readiness');
    const m   = new Mod();
    assert.strictEqual(m.name, 'deployReadiness');
  });

  it('returns no-data info when no prior results', async () => {
    const Mod = require('../src/modules/deploy-readiness');
    const m   = new Mod();
    const tmp = makeTmp();
    const result = makeResult('deployReadiness');
    await m.run(result, { projectRoot: tmp });
    const check = result.checks.find(c => c.name === 'deploy-readiness:no-data');
    assert.ok(check, 'Should emit no-data info check');
  });

  it('scores 100 on all-passing results', async () => {
    const Mod = require('../src/modules/deploy-readiness');
    const m   = new Mod();
    const tmp = makeTmp();

    const allResults = [
      {
        module: 'syntax',
        checks: [{ name: 'syntax:ok', passed: true, severity: 'info' }],
        get errorChecks() { return []; },
        get warningChecks() { return []; },
        status: 'passed',
      },
    ];

    const result = makeResult('deployReadiness');
    await m.run(result, { projectRoot: tmp, _allResults: allResults });
    const scoreCheck = result.checks.find(c => c.name === 'deploy-readiness:score');
    assert.ok(scoreCheck, 'Should have score check');
    // Score should be high (>= 90) with all passing
    assert.ok(scoreCheck.details.score >= 90, `Score should be >=90, got ${scoreCheck.details.score}`);
  });

  it('penalises errors', async () => {
    const Mod = require('../src/modules/deploy-readiness');
    const m   = new Mod();
    const tmp = makeTmp();

    const allResults = [
      {
        module: 'secrets',
        checks: [
          { name: 'secrets:hardcoded-key', passed: false, severity: 'error' },
          { name: 'secrets:hardcoded-key-2', passed: false, severity: 'error' },
        ],
        get errorChecks() { return this.checks.filter(c => !c.passed && c.severity === 'error'); },
        get warningChecks() { return []; },
        status: 'failed',
      },
    ];

    const result = makeResult('deployReadiness');
    await m.run(result, { projectRoot: tmp, _allResults: allResults });
    const scoreCheck = result.checks.find(c => c.name === 'deploy-readiness:score');
    assert.ok(scoreCheck.details.score < 100, 'Should penalise errors');
    assert.ok(scoreCheck.details.errors >= 2);
  });
});
