'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const DeploySecretSyncModule = require('../src/modules/deploy-secret-sync');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-dss-'));
}

function write(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function makeResult() {
  const checks = [];
  return {
    addCheck(id, passed, meta) {
      checks.push({ id, passed, meta: meta || {} });
    },
    checks,
    passed(id)       { return checks.find(c => c.id === id)?.passed; },
    hasFailing(pfx)  { return checks.some(c => c.id.startsWith(pfx) && !c.passed); },
    hasPassing(pfx)  { return checks.some(c => c.id.startsWith(pfx) && c.passed); },
    failingIds(pfx)  { return checks.filter(c => c.id.startsWith(pfx) && !c.passed).map(c => c.id); },
  };
}

async function run(root) {
  const mod = new DeploySecretSyncModule();
  const result = makeResult();
  await mod.run(result, { projectRoot: root });
  return result;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('DeploySecretSyncModule — shape', () => {
  test('has name and description', () => {
    const mod = new DeploySecretSyncModule();
    assert.equal(mod.name, 'deploySecretSync');
    assert.ok(mod.description.length > 10);
  });

  test('run is a function', () => {
    assert.equal(typeof new DeploySecretSyncModule().run, 'function');
  });
});

// ---------------------------------------------------------------------------
// No-op conditions
// ---------------------------------------------------------------------------

describe('DeploySecretSyncModule — no-op conditions', () => {
  test('no-op when no .env.example exists', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.github/workflows/ci.yml',
        'on: push\njobs:\n  build:\n    steps:\n      - env:\n          SECRET_KEY: ${{ secrets.SECRET_KEY }}\n'
      );
      const result = await run(dir);
      assert.equal(result.checks.length, 0);
    } finally { cleanup(dir); }
  });

  test('no-op when no deploy configs', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', 'SECRET_KEY=\nDATABASE_URL=\n');
      const result = await run(dir);
      assert.equal(result.checks.length, 0);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// GitHub Actions
// ---------------------------------------------------------------------------

describe('DeploySecretSyncModule — GitHub Actions', () => {
  test('flags secrets.X not in .env.example', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', 'DATABASE_URL=\n');
      write(dir, '.github/workflows/deploy.yml',
        'steps:\n  - name: deploy\n    env:\n      STRIPE_KEY: ${{ secrets.STRIPE_KEY }}\n'
      );
      const result = await run(dir);
      assert.ok(result.hasFailing('deploySecret:missing-from-example:STRIPE_KEY'));
    } finally { cleanup(dir); }
  });

  test('no flag when secrets.X matches .env.example', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', 'DATABASE_URL=\nSTRIPE_KEY=\n');
      write(dir, '.github/workflows/deploy.yml',
        'steps:\n  - name: deploy\n    env:\n      STRIPE_KEY: ${{ secrets.STRIPE_KEY }}\n'
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('deploySecret:missing-from-example'));
    } finally { cleanup(dir); }
  });

  test('allowlists GITHUB_* runtime vars', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', 'MY_APP_KEY=\n');
      write(dir, '.github/workflows/ci.yml',
        'env:\n  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n  MY_APP_KEY: ${{ secrets.MY_APP_KEY }}\n'
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('deploySecret:missing-from-example:GITHUB_TOKEN'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// vercel.json
// ---------------------------------------------------------------------------

describe('DeploySecretSyncModule — vercel.json', () => {
  test('flags vercel env not in .env.example', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', 'DATABASE_URL=\n');
      write(dir, 'vercel.json', {
        env: { ANTHROPIC_API_KEY: '@anthropic-api-key' },
      });
      const result = await run(dir);
      assert.ok(result.hasFailing('deploySecret:missing-from-example:ANTHROPIC_API_KEY'));
    } finally { cleanup(dir); }
  });

  test('passes when vercel env vars match .env.example', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', 'DATABASE_URL=\nANTHROPIC_API_KEY=\n');
      write(dir, 'vercel.json', {
        env: { ANTHROPIC_API_KEY: '@anthropic-api-key', DATABASE_URL: '@db-url' },
      });
      const result = await run(dir);
      assert.ok(!result.hasFailing('deploySecret:missing-from-example'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// netlify.toml
// ---------------------------------------------------------------------------

describe('DeploySecretSyncModule — netlify.toml', () => {
  test('flags netlify env vars not in .env.example', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', 'MY_VAR=\n');
      write(dir, 'netlify.toml',
        '[build.environment]\nANOTHER_SECRET = "placeholder"\n'
      );
      const result = await run(dir);
      assert.ok(result.hasFailing('deploySecret:missing-from-example:ANOTHER_SECRET'));
    } finally { cleanup(dir); }
  });

  test('no flag when netlify vars are in .env.example', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', 'ANOTHER_SECRET=\n');
      write(dir, 'netlify.toml',
        '[build.environment]\nANOTHER_SECRET = "placeholder"\n'
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('deploySecret:missing-from-example'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// docker-compose
// ---------------------------------------------------------------------------

describe('DeploySecretSyncModule — docker-compose', () => {
  test('flags docker-compose env var not in .env.example', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', 'APP_PORT=\n');
      write(dir, 'docker-compose.yml',
        'services:\n  app:\n    environment:\n      - REDIS_URL\n      - APP_PORT\n'
      );
      const result = await run(dir);
      assert.ok(result.hasFailing('deploySecret:missing-from-example:REDIS_URL'));
      assert.ok(!result.hasFailing('deploySecret:missing-from-example:APP_PORT'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// In-sync pass
// ---------------------------------------------------------------------------

describe('DeploySecretSyncModule — in-sync pass', () => {
  test('emits in-sync check when everything matches', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', 'STRIPE_KEY=\nDATABASE_URL=\n');
      write(dir, 'vercel.json', {
        env: {
          STRIPE_KEY: '@stripe-key',
          DATABASE_URL: '@db-url',
        },
      });
      const result = await run(dir);
      assert.ok(result.hasPassing('deploySecret:in-sync'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// .env.example variants
// ---------------------------------------------------------------------------

describe('DeploySecretSyncModule — .env.example variants', () => {
  test('reads from .env.sample as fallback', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.sample', 'MY_SECRET=\n');
      write(dir, 'vercel.json', { env: { MY_SECRET: '@my-secret' } });
      const result = await run(dir);
      assert.ok(!result.hasFailing('deploySecret:missing-from-example:MY_SECRET'));
    } finally { cleanup(dir); }
  });

  test('ignores comment lines in .env.example', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', '# This is a comment\nMY_KEY=placeholder\n# another comment\n');
      write(dir, 'vercel.json', { env: { MY_KEY: '@my-key' } });
      const result = await run(dir);
      assert.ok(!result.hasFailing('deploySecret:missing-from-example:MY_KEY'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// Allowlist coverage
// ---------------------------------------------------------------------------

describe('DeploySecretSyncModule — runtime allowlist', () => {
  test('CI is allowlisted', async () => {
    const dir = makeTmp();
    try {
      write(dir, '.env.example', 'APP_KEY=\n');
      write(dir, '.github/workflows/ci.yml',
        'steps:\n  - run: echo $CI\n    env:\n      CI: true\n'
      );
      // CI is in allowlist, so even if extracted it should not flag
      const result = await run(dir);
      assert.ok(!result.hasFailing('deploySecret:missing-from-example:CI'));
    } finally { cleanup(dir); }
  });
});
