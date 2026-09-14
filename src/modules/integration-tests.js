/**
 * Integration Tests Module - Validates integration test infrastructure and execution.
 * Detects API endpoints, database operations, and external service integrations,
 * then verifies they have corresponding integration tests.
 */

const BaseModule = require('./base-module');
const { JS_SOURCE_EXTS, JS_SOURCE_EXTS_NO_JSX } = require('../core/source-extensions');
const { ROUTE_OBJECTS, ROUTE_VERBS } = require('../core/route-grammar');
const { looksLikeMissingToolchain, nodeDepsMissing } = require('../core/toolchain-signals');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');

// One grammar for "this line registers a route" (src/core/route-grammar.js),
// with captures for the verb and the path. Until 2026-09-05 this module
// knew `app.`/`router.` and five Express verbs: a Fastify, Hono, Koa or
// Elysia service, a NestJS controller or a SvelteKit `+server.ts` reported
// `integration-tests:not-needed` — "no API endpoints detected" (KI #106).
const ROUTE_CALL_CAPTURE_RE = new RegExp(
  String.raw`\b${ROUTE_OBJECTS}\s*\.\s*(${ROUTE_VERBS})\s*\(\s*['"\x60]([^'"\x60]+)['"\x60]`, 'g',
);
const USE_CALL_RE = /(?:app|router)\.(use)\s*\(\s*['"]([^'"]+)['"]/g;
/** NestJS / routing-controllers: `@Get(':id')`, `@Post()` — path optional. */
const VERB_DECORATOR_CAPTURE_RE = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*(?:['"\x60]([^'"\x60]*)['"\x60])?/g;
const CONTROLLER_PREFIX_RE = /@(?:Controller|JsonController)\s*\(\s*['"\x60]([^'"\x60]*)['"\x60]/;
/** Next.js App Router `route.ts`, SvelteKit `+server.ts`, Remix/Nuxt verb exports. */
const VERB_EXPORT_CAPTURE_RE = /\bexport\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
const FILE_ROUTE_RE = /(?:^|\/)(?:route|\+server|server)\.[cm]?[jt]sx?$/;
const VERB_ALIASES = { del: 'DELETE', route: 'ALL' };

class IntegrationTestsModule extends BaseModule {
  constructor() {
    super('integrationTests', 'Integration Test Execution');
    this._testTimeoutMs = 300000; // overridable for tests
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Detect integration test files
    const testInfo = this._findIntegrationTests(projectRoot);

    // Detect what NEEDS integration tests
    const endpoints = this._detectApiEndpoints(projectRoot);
    const dbOps = this._detectDatabaseOperations(projectRoot);
    const externalServices = this._detectExternalServices(projectRoot);

    // Report what was detected
    if (endpoints.length > 0) {
      result.addCheck('integration:endpoints-detected', true, {
        severity: 'info',
        message: `${endpoints.length} API endpoint(s) detected`,
      });
    }

    if (dbOps.length > 0) {
      result.addCheck('integration:db-ops-detected', true, {
        severity: 'info',
        message: `${dbOps.length} database operation pattern(s) detected`,
      });
    }

    if (externalServices.length > 0) {
      result.addCheck('integration:services-detected', true, {
        severity: 'info',
        message: `External services: ${externalServices.join(', ')}`,
      });
    }

    // If no integration points found, skip
    if (endpoints.length === 0 && dbOps.length === 0 && externalServices.length === 0) {
      result.addCheck('integration-tests:not-needed', true, {
        severity: 'info',
        message: 'No API endpoints, database ops, or external services detected — skipping',
      });
      return;
    }

    // Run integration tests if available
    if (testInfo.testDir || testInfo.testFiles.length > 0) {
      result.addCheck('integration-tests:found', true, {
        severity: 'info',
        message: `${testInfo.testFiles.length} integration test file(s) found`,
      });

      const ran = await this._runTests(projectRoot, testInfo, result);
      if (!ran) {
        result.addCheck('integration-tests:run', false, {
          severity: 'warning',
          message: 'Could not execute integration tests — no test:integration script found',
          suggestion: 'Add "test:integration" script to package.json',
        });
      }
    } else {
      // Integration points exist but no tests — this is a real problem
      result.addCheck('integration-tests:missing', false, {
        severity: 'warning',
        message: `${endpoints.length + dbOps.length} integration points found but no integration tests`,
        suggestion: 'Create tests/integration/ directory with tests for API endpoints and database operations',
      });
    }

    // Coverage gap analysis
    this._analyzeCoverageGaps(endpoints, testInfo.testFiles, projectRoot, result);
  }

  _findIntegrationTests(projectRoot) {
    const integrationDirs = [
      'tests/integration', 'test/integration', '__tests__/integration',
      'integration-tests', 'tests/api', 'test/api',
      'tests/e2e', 'test/e2e', '__tests__/e2e', 'e2e',
      'spec/requests', 'spec/integration', 'spec/api',
    ];

    let testDir = null;
    for (const dir of integrationDirs) {
      const fullPath = path.join(projectRoot, dir);
      if (fs.existsSync(fullPath)) {
        testDir = fullPath;
        break;
      }
    }

    // Test files by name. `_collectFiles` matches on path.extname, so the
    // old call with ['.test.js', '.spec.js', …] matched NOTHING — every
    // repo had zero integration test files, every endpoint was "untested",
    // and a test dir was the only way to be "found" (2026-09-05). Walk real
    // extensions and ask the one test-path definition instead.
    const allTestFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS)
      .filter((f) => this._isTestPath(repoRelative(projectRoot, f)));
    const byName = allTestFiles.filter((f) => {
      const base = path.basename(f).toLowerCase();
      return base.includes('integration') || base.includes('.int.') ||
             base.includes('.api.') || base.includes('endpoint') || base.includes('e2e');
    });
    const inDir = testDir
      ? allTestFiles.filter((f) => f.startsWith(testDir + path.sep))
      : [];
    const testFiles = Array.from(new Set([...byName, ...inDir]));

    return { testDir, testFiles };
  }

  async _runTests(projectRoot, testInfo, result) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const testCmd = pkg.scripts?.['test:integration'] || pkg.scripts?.['test:int'] || pkg.scripts?.['test:api'];

      if (testCmd) {
        const scriptName = pkg.scripts['test:integration'] ? 'test:integration' :
                          pkg.scripts['test:int'] ? 'test:int' : 'test:api';
        // Dependencies never installed (a fresh clone): the script cannot
        // run, and that is a fact about this box, not the suite.
        if (nodeDepsMissing(projectRoot)) {
          result.addCheck('integration-tests:run', true, {
            severity: 'info',
            message: `Integration tests not executed — dependencies are not installed here (\`npm run ${scriptName}\` needs node_modules)`,
            suggestion: 'Run the scan where dependencies are installed (CI) to include integration test results',
          });
          return true;
        }
        const { exitCode, stdout, stderr, timedOut } = this._exec(`npm run ${scriptName} 2>&1`, {
          cwd: projectRoot,
          timeout: this._testTimeoutMs,
        });
        const out = `${stdout || ''}${stderr || ''}`;

        if (exitCode === 0) {
          result.addCheck('integration-tests:run', true, { message: 'Integration tests passed' });
        } else if (timedOut) {
          // A timeout is not a verdict (doctrine, move 18).
          result.addCheck('integration-tests:run', true, {
            severity: 'info',
            message: `Integration tests not executed — \`npm run ${scriptName}\` did not finish within ${Math.round(this._testTimeoutMs / 1000)}s here`,
            suggestion: 'Run the scan where the suite normally runs (CI) to include integration test results',
          });
        } else if (looksLikeMissingToolchain(out)) {
          // The runner never reached a test (missing binary/module, a build
          // that failed first). "Integration tests failed" would blame the
          // customer's suite for our environment (nest, prisma 2026-09-05).
          result.addCheck('integration-tests:run', true, {
            severity: 'info',
            message: 'Integration tests not executed — the toolchain is missing here',
            details: out.split(/\r?\n/).slice(-10),
            suggestion: 'Run the scan where the toolchain is installed (CI) to include integration test results',
          });
        } else {
          result.addCheck('integration-tests:run', false, {
            message: 'Integration tests failed',
            details: out.split(/\r?\n/).slice(-20),
            suggestion: 'Fix failing integration tests',
          });
        }
        return true;
      }
    } catch { /* error-ok — unreadable package.json — the syntax module reports it; this check has nothing to read */ }

    return false;
  }

  _detectApiEndpoints(projectRoot) {
    const endpoints = [];
    const jsFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS);

    for (const file of jsFiles) {
      const relPath = repoRelative(projectRoot, file);
      // `includes('test')` also matched `src/latest/`, `attestation.js`
      // and `testimonials/` — real shipped code, silently skipped.
      // BaseModule._isTestPath() is the canonical segment-anchored form.
      if (this._isTestPath(relPath) || relPath.split(/[\\/]/).includes('node_modules')) continue;

      const content = fs.readFileSync(file, 'utf-8');

      // Route registrations (any framework object the shared grammar knows),
      // `app.use('/prefix', …)` mounts, and NestJS-style verb decorators.
      const ctrl = content.match(CONTROLLER_PREFIX_RE);
      const prefix = ctrl ? `/${ctrl[1].replace(/^\/+|\/+$/g, '')}` : '';
      const routePatterns = [ROUTE_CALL_CAPTURE_RE, USE_CALL_RE, VERB_DECORATOR_CAPTURE_RE];

      const lines = content.split(/\r?\n/);
      // Strings, regex literals and comments blanked to spaces, offsets kept
      // (BaseModule._maskedLines — the one stripper). The route regexes read
      // the path out of its quotes, so they still run on the raw content;
      // whether the match START is code is decided here: a character the
      // mask blanked sits inside a string literal or a comment.
      const masked = this._maskedLines(content);

      for (const pattern of routePatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          // A route quoted inside a string literal or a comment is not a route,
          // so it cannot be an untested endpoint. Same root cause as the
          // auth-bypass false positive found by the inert sweep: route regexes
          // run against whole-file content, so a documentation example like
          //     example: "app.get('/r', handler)",
          // was discovered as a real endpoint and then reported as untested.
          // Before 2026-09-05 a per-line quote counter judged the position;
          // it could not see a template literal or a block comment that
          // spans lines.
          const lineNo = content.slice(0, match.index).split(/\r?\n/).length;
          const lineText = lines[lineNo - 1] || '';
          if (this._isCommentLine(lineText)) continue;
          const col = match.index - (content.lastIndexOf('\n', match.index - 1) + 1);
          if ((masked[lineNo - 1] || '')[col] !== lineText[col]) continue;

          const verb = match[1].toLowerCase();
          const method = VERB_ALIASES[verb] || verb.toUpperCase();
          const routePath = pattern === VERB_DECORATOR_CAPTURE_RE
            ? `${prefix}/${(match[2] || '').replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/'
            : match[2];
          endpoints.push({ method, path: routePath, file: relPath });
        }
        pattern.lastIndex = 0;
      }

      // File-based routes: Next.js App Router `route.ts`, SvelteKit
      // `+server.ts`, Remix/Nuxt server files — any verb export counts.
      const relUnix = relPath.replace(/\\/g, '/');
      if (FILE_ROUTE_RE.test(relUnix)) {
        VERB_EXPORT_CAPTURE_RE.lastIndex = 0;
        let m;
        while ((m = VERB_EXPORT_CAPTURE_RE.exec(content)) !== null) {
          endpoints.push({ method: m[1], path: relPath, file: relPath });
        }
        VERB_EXPORT_CAPTURE_RE.lastIndex = 0;
      }
    }

    return endpoints;
  }

  _detectDatabaseOperations(projectRoot) {
    const ops = [];
    const jsFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS_NO_JSX);

    for (const file of jsFiles) {
      const relPath = repoRelative(projectRoot, file);
      // `includes('test')` also matched `src/latest/`, `attestation.js`
      // and `testimonials/` — real shipped code, silently skipped.
      // BaseModule._isTestPath() is the canonical segment-anchored form.
      if (this._isTestPath(relPath) || relPath.split(/[\\/]/).includes('node_modules')) continue;

      const content = fs.readFileSync(file, 'utf-8');

      const dbPatterns = [
        { pattern: /prisma\.\w+\.(findMany|findFirst|create|update|delete|upsert)/g, type: 'Prisma' },
        { pattern: /\.query\s*\(\s*['"`]/g, type: 'SQL query' },
        { pattern: /mongoose\.\w+|\.findById|\.findOne/g, type: 'Mongoose' },
        { pattern: /knex\s*\(\s*['"`]\w+['"`]\s*\)/g, type: 'Knex' },
        { pattern: /sequelize\.define|Model\.findAll/g, type: 'Sequelize' },
      ];

      for (const { pattern, type } of dbPatterns) {
        if (pattern.test(content)) {
          ops.push({ type, file: relPath });
          break; // One per file per type
        }
      }
    }

    return ops;
  }

  _detectExternalServices(projectRoot) {
    const services = new Set();
    const jsFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS);

    const servicePatterns = [
      { pattern: /stripe/i, name: 'Stripe' },
      { pattern: /sendgrid|@sendgrid/i, name: 'SendGrid' },
      { pattern: /twilio/i, name: 'Twilio' },
      { pattern: /aws-sdk|@aws-sdk/i, name: 'AWS' },
      { pattern: /firebase|@firebase/i, name: 'Firebase' },
      { pattern: /supabase|@supabase/i, name: 'Supabase' },
      { pattern: /redis/i, name: 'Redis' },
      { pattern: /elasticsearch/i, name: 'Elasticsearch' },
      { pattern: /cloudflare/i, name: 'Cloudflare' },
      { pattern: /openai/i, name: 'OpenAI' },
      { pattern: /anthropic/i, name: 'Anthropic' },
    ];

    for (const file of jsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const { pattern, name } of servicePatterns) {
        if (pattern.test(content)) services.add(name);
      }
    }

    return Array.from(services);
  }

  _analyzeCoverageGaps(endpoints, testFiles, projectRoot, result) {
    if (endpoints.length === 0) return;

    const testContent = testFiles.map(f => {
      try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; }
    }).join('\n');

    let untestedEndpoints = 0;
    for (const ep of endpoints) {
      // Check if any test references this endpoint path
      if (!testContent.includes(ep.path)) {
        untestedEndpoints++;
        if (untestedEndpoints <= 5) {
          result.addCheck(`integration:untested:${ep.method}:${ep.path}`, false, {
            file: ep.file,
            severity: 'warning',
            message: `${ep.method} ${ep.path} has no integration test`,
            suggestion: `Add integration test covering ${ep.method} ${ep.path}`,
          });
        }
      }
    }

    if (untestedEndpoints > 5) {
      result.addCheck('integration:untested-count', false, {
        severity: 'warning',
        message: `${untestedEndpoints} endpoints lack integration tests (showing first 5)`,
      });
    }
  }
}

module.exports = IntegrationTestsModule;
