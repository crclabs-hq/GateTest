#!/usr/bin/env node
/**
 * GateTest MCP Server
 *
 * Exposes GateTest as a Model Context Protocol server. Any MCP-compatible
 * AI — Claude Code, Cursor, Continue, etc. — can call GateTest directly
 * without needing webhooks, the web app, or any external infrastructure.
 *
 * Transport: stdio (connect via "command" in mcp_servers config)
 *
 * Usage in Claude Code (.claude/mcp_servers.json or settings.json):
 *   {
 *     "mcpServers": {
 *       "gatetest": {
 *         "command": "node",
 *         "args": ["/path/to/GateTest/bin/gatetest-mcp.mjs"]
 *       }
 *     }
 *   }
 *
 * Or if installed globally:
 *   { "command": "gatetest-mcp" }
 *
 * Tools exposed:
 *   scan_local       — scan a local directory path
 *   run_module       — run one specific module against a path
 *   list_modules     — list all 120 modules with descriptions
 *   check_health     — verify GateTest engine is operational
 *   fix_issue        — AI-driven fix for a single finding (needs ANTHROPIC_API_KEY)
 *   compose_pr       — render a PR body markdown for a set of fixes
 *   explain_finding  — Nuclear-tier diagnosis of a finding (needs ANTHROPIC_API_KEY)
 *   audit_log        — query past local scans recorded in the memory store
 *   compare_repos    — cross-repo lookup (uses memory store; informational fallback when empty)
 *   scan_url         — scan any live public URL via the hosted gatetest.ai free quick-tier API
 *   scan_repo        — scan any public GitHub repo via the hosted gatetest.ai free quick-tier API
 *   get_badge        — get the embeddable README badge markdown for a repo
 *   get_report       — retrieve the full result of the last scan_local/scan_url/scan_repo call this session
 *   verify_fix       — after editing code, re-run the modules relevant to the changed files and get a fix-scoped pass/fail verdict
 *   capture_screenshot — screenshot a live URL and return it as an actual image (the AI's eyes on the rendered page)
 *   get_visual_diff  — fetch a visualRegression baseline/current/diff (or composite) as an image
 *   run_live_checks  — run the runtime triad (runtimeErrors/consoleErrors/apiHealth) against a live URL (the AI's ears)
 *   get_production_errors — top Sentry/Datadog/Rollbar errors with file:line (fix what prod says is broken, first)
 *
 * scan_local/run_module/list_modules/check_health/fix_issue/compose_pr/
 * explain_finding/audit_log/compare_repos all run the engine IN-PROCESS
 * against the local filesystem — no network call, no account, works
 * offline. scan_url/scan_repo/get_badge instead call the hosted
 * gatetest.ai API (override with GATETEST_API_BASE_URL) — useful when the
 * agent wants to check a URL or repo it doesn't have local disk access
 * to. Both families are genuinely useful for different situations; this
 * server exposes both rather than picking one.
 */

import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Import CJS GateTest engine via createRequire (SDK is ESM, engine is CJS)
const require = createRequire(import.meta.url);
const fsSync = require('fs');
const nodePath = require('path');
const { GateTest, GateTestConfig } = require('../src/index.js');
const { aiFix } = require('../src/core/ai-fix-engine.js');
const { MemoryStore } = require('../src/core/memory.js');
const { computeSmartSuite } = require('../src/core/smart-suite-selector.js');
const { captureUrlScreenshot, slugifyRoute } = require('../src/core/screenshot-capture.js');
const {
  buildSideBySideComposite,
  encodeUnderByteCap,
  readPngDimensions,
} = require('../src/core/visual-diff-engine.js');
const { extractDiffRegions } = require('../src/core/visual-facts.js');
const { fetchProductionErrors, resolveSourcesFromEnv } = require('../src/core/production-errors.js');
const { composePrBody } = require('../website/app/lib/pr-composer.js');
const { diagnoseFinding } = require('../website/app/lib/nuclear-diagnoser.js');

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'scan_local',
    description:
      'Scan a local directory with GateTest\'s 120-module engine. ' +
      'Returns issues found across security, reliability, code quality, ' +
      'and more. Use suite="quick" for the 4 core modules or suite="full" ' +
      'for all 120 modules. Optionally pass a list of specific module names.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the directory to scan',
        },
        suite: {
          type: 'string',
          enum: ['quick', 'standard', 'full'],
          description: 'Which module suite to run (default: standard)',
        },
        modules: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of specific module names to run instead of a suite',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_module',
    description:
      'Run a single GateTest module against a local directory. ' +
      'Use list_modules to see all available module names.',
    inputSchema: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          description: 'Module name (e.g. "secrets", "tlsSecurity", "importCycle")',
        },
        path: {
          type: 'string',
          description: 'Absolute path to the directory to scan',
        },
      },
      required: ['module', 'path'],
    },
  },
  {
    name: 'list_modules',
    description:
      'List all 120 GateTest modules with their names and descriptions. ' +
      'Use this to discover what modules are available before calling ' +
      'scan_local with a specific modules list.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'check_health',
    description:
      'Verify GateTest is operational. Returns version, module count (120), ' +
      'and a list of all loaded module names.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'fix_issue',
    description:
      'Apply an AI-generated fix to a single finding in a file. Reads the file, ' +
      'sends the relevant slice + the finding to Claude, and writes the fix in place. ' +
      'When `line` is supplied the fix runs in surgical mode (±20-line window); ' +
      'otherwise whole-file mode with a mutation guard. Requires ANTHROPIC_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Absolute path to the file containing the issue',
        },
        issue: {
          type: 'string',
          description: 'The finding text exactly as GateTest emitted it',
        },
        module: {
          type: 'string',
          description: 'The module name that produced the finding (e.g. "secrets")',
        },
        line: {
          type: 'number',
          description: 'Optional line number the finding points to — enables surgical mode',
        },
      },
      required: ['file', 'issue'],
    },
  },
  {
    name: 'compose_pr',
    description:
      'Render a PR body markdown describing a batch of fixes — Before/After scan ' +
      'comparison, per-file attempt history, gate results, fixed-files block, ' +
      'and footer. Pure formatting; no API calls.',
    inputSchema: {
      type: 'object',
      properties: {
        fixes: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of { file, issues, attempts } objects',
        },
        repoUrl: {
          type: 'string',
          description: 'Repository URL for the PR header',
        },
        tier: {
          type: 'string',
          description: 'Tier identifier (quick / full / scan_fix / nuclear)',
        },
      },
      required: ['fixes'],
    },
  },
  {
    name: 'explain_finding',
    description:
      'Nuclear-tier Claude diagnosis of a single finding. Returns explanation, ' +
      'root cause, recommendation, and platform notes. Requires ANTHROPIC_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        finding: {
          type: 'object',
          description: 'The finding object with at least { detail, module, severity }',
        },
        hostname: {
          type: 'string',
          description: 'Customer hostname for context (e.g. "example.com")',
        },
        scanContext: {
          type: 'object',
          description: 'Optional { platform, stack } context to sharpen the diagnosis',
        },
      },
      required: ['finding'],
    },
  },
  {
    name: 'audit_log',
    description:
      'Query the local GateTest memory store for past scan history at a given ' +
      'project path. Returns total scans run, recent run summaries, and persistent ' +
      'issues that have appeared in multiple scans. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project root path whose memory store should be read',
        },
        limit: {
          type: 'number',
          description: 'Max number of recent runs to return (default 10)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'compare_repos',
    description:
      'Look up similar codebases the memory store has seen recently and summarise ' +
      'finding patterns. Useful for "is this finding common?" and "what do similar ' +
      'repos fix first?" Falls back to an informational message when the local ' +
      'memory store has insufficient prior scans to compare against.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project root path whose memory store should be queried',
        },
        moduleHint: {
          type: 'string',
          description: 'Optional module name to narrow the comparison',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'scan_url',
    description:
      'Scan any live public URL via the hosted gatetest.ai free quick-tier API ' +
      '(webHeaders, tlsSecurity, accessibility, seo, links, runtimeErrors, and more). ' +
      'No account needed. Returns the top findings — the free tier is a truncated ' +
      'preview; full results require a paid scan at gatetest.ai. Requires network access.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The public URL to scan, e.g. https://example.com',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'scan_repo',
    description:
      'Scan any public GitHub repo via the hosted gatetest.ai free quick-tier API ' +
      '(syntax, lint, secrets, codeQuality — 4 of the full module catalogue). ' +
      'No account needed. Returns a health grade + top findings. Requires network access.',
    inputSchema: {
      type: 'object',
      properties: {
        repoUrl: {
          type: 'string',
          description: 'Public GitHub repo URL, e.g. https://github.com/owner/repo',
        },
      },
      required: ['repoUrl'],
    },
  },
  {
    name: 'get_badge',
    description:
      'Get the embeddable GateTest quality badge for a GitHub repo — Markdown ready ' +
      'to paste into a README, plus the raw badge image URL. The badge is a live SVG ' +
      '(dynamic SVG endpoint, 5-minute cache) — it always reflects the repo\'s most ' +
      'recent completed scan, showing "not scanned" until one exists.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'GitHub org/user, e.g. "facebook"' },
        repo: { type: 'string', description: 'Repo name, e.g. "react"' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_report',
    description:
      'Retrieve the full result of the most recent scan_local, scan_url, or scan_repo ' +
      'call made earlier in this same MCP session. Returns an error if no scan has run yet.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'verify_fix',
    description:
      'After editing code, verify the fix actually worked: selects the modules relevant ' +
      'to the changed files (smart suite selection), re-runs them in-process, and returns ' +
      'a pass/fail verdict scoped to those files plus any remaining findings. ' +
      '✅ FIX VERIFIED means zero error-severity findings remain on the changed files. ' +
      'Pass "files" explicitly with your edited paths for the most precise verdict; ' +
      'without it, changed files are detected from git (staged → last commit → working tree).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the project root' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changed file paths (relative to the project root). Recommended: pass the exact files you edited.',
        },
        base: { type: 'string', description: 'Git base ref to diff against, e.g. "main" (used only when files is omitted)' },
        maxModules: { type: 'number', description: 'Cap on dynamically-selected modules (default 22)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'capture_screenshot',
    description:
      'Take a screenshot of a live URL and return it as an actual image you can SEE — ' +
      'your eyes on the rendered page. Use after editing UI code to look at what you ' +
      'built, or before editing to see the current state. Defaults to a 1280×900 ' +
      'viewport JPEG (payload-safe); pass fullPage:true for the whole page (will be ' +
      'downscaled/recompressed if large). Requires Playwright + Chromium locally; ' +
      'degrades to an explanatory message when unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to screenshot, e.g. "https://example.com/pricing"' },
        width: { type: 'number', description: 'Viewport width in px (default 1280). Use 390 for mobile.' },
        height: { type: 'number', description: 'Viewport height in px (default 900)' },
        fullPage: { type: 'boolean', description: 'Capture the full scroll height (default false)' },
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'Image format (default jpeg — smaller payloads)' },
        quality: { type: 'number', description: 'JPEG quality 1-100 (default 70)' },
        waitMs: { type: 'number', description: 'Extra settle time after load in ms (default 1000)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_visual_diff',
    description:
      'Fetch visual-regression screenshots recorded by the visualRegression module as ' +
      'an actual image: the stored baseline, the latest capture, the pixel-diff, or a ' +
      'side-by-side composite of all three. Call after a scan reports a visual ' +
      'regression to SEE what changed. When platform/viewport/route are ambiguous, ' +
      'returns a listing of what exists in the baseline directory instead of an error.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project root (locates the baseline dir via .gatetest.json or the default .gatetest/visual-baselines)' },
        route: { type: 'string', description: 'Route as configured, e.g. "/" or "/pricing"' },
        platform: { type: 'string', description: 'Platform folder name (hostname). Omit to auto-detect when only one exists.' },
        viewport: { type: 'string', description: '"desktop" | "mobile" | custom viewport name (default desktop)' },
        panel: {
          type: 'string',
          enum: ['composite', 'baseline', 'current', 'diff'],
          description: 'Which image: side-by-side composite (default when diff exists) or a single panel (3× smaller payload)',
        },
        baselineDir: { type: 'string', description: 'Explicit baseline directory (overrides config resolution)' },
        maxWidth: { type: 'number', description: 'Downscale the returned image to at most this width' },
        includeFacts: {
          type: 'boolean',
          description: 'Also return the changed-region bounding boxes extracted from the diff (coordinates + size). Full selector/style mapping is attached to scan findings by the visualRegression module at scan time.',
        },
      },
      required: ['path', 'route'],
    },
  },
  {
    name: 'run_live_checks',
    description:
      'Run the runtime-triad against a live URL — the AI\'s ears on the running app: ' +
      'runtimeErrors (uncaught JS errors, console errors, failed requests, CSP violations, ' +
      'hydration mismatches), consoleErrors (site-wide crawl, fingerprinted + deduped), and ' +
      'apiHealth (probes discoverable API endpoints for 5xx/404/wrong-content-type/slow). ' +
      'Use after editing code and deploying locally, or before editing to hear what\'s ' +
      'already failing. Browser-based modules skip gracefully without Chromium — the ' +
      'result says explicitly which ears were available.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The live URL to check, e.g. "http://localhost:3000" or "https://example.com"' },
        modules: {
          type: 'array',
          items: { type: 'string', enum: ['runtimeErrors', 'consoleErrors', 'apiHealth'] },
          description: 'Subset of the runtime triad to run (default: all three)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_production_errors',
    description:
      'Pull the top errors real users are hitting in production from configured ' +
      'observability vendors (Sentry / Datadog / Rollbar) with file:line locations — ' +
      'so you can fix what production says is broken, first. Reads credentials from ' +
      'environment variables (SENTRY_AUTH_TOKEN+SENTRY_ORG+SENTRY_PROJECT, ' +
      'DATADOG_API_KEY+DATADOG_APP_KEY, ROLLBAR_READ_TOKEN); returns setup ' +
      'instructions when none are configured.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['sentry', 'datadog', 'rollbar', 'all'], description: 'Vendor filter (default all configured)' },
        limit: { type: 'number', description: 'Max errors returned (default 20)' },
        service: { type: 'string', description: 'Datadog service filter' },
        hoursBack: { type: 'number', description: 'Datadog time window in hours (default 24)' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function formatScanResult(result) {
  const lines = [];
  const blocked = result.gateStatus === 'BLOCKED';
  const status = blocked ? '❌ BLOCKED' : '✅ PASSED';
  lines.push(`## GateTest Scan — ${status}`);
  lines.push('');

  const allResults = result.results || [];
  const totalErrors = allResults.reduce((s, r) => s + (r.errors || 0), 0);
  const totalWarnings = allResults.reduce((s, r) => s + (r.warnings || 0), 0);
  const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}s` : '?';
  lines.push(`**Duration:** ${duration}  |  **Errors:** ${totalErrors}  |  **Warnings:** ${totalWarnings}`);
  lines.push('');

  if (allResults.length === 0) {
    lines.push('No modules ran.');
    return lines.join('\n');
  }

  const withIssues = allResults.filter(r => (r.errors || 0) > 0 || (r.warnings || 0) > 0);
  const passed = allResults.filter(r => (r.errors || 0) === 0 && (r.warnings || 0) === 0);

  if (withIssues.length > 0) {
    lines.push('### Issues found');
    lines.push('');
    for (const mod of withIssues) {
      const modName = mod.module || mod.name || 'unknown';
      const issueCount = (mod.errors || 0) + (mod.warnings || 0);
      lines.push(`**\`${modName}\`** — ${issueCount} issue${issueCount === 1 ? '' : 's'} (${mod.errors || 0} errors, ${mod.warnings || 0} warnings)`);
      const flaggedChecks = (mod.checks || []).filter(c => c.severity === 'error' || c.severity === 'warning');
      for (const check of flaggedChecks.slice(0, 5)) {
        const loc = check.file ? ` (${check.file}${check.line ? `:${check.line}` : ''})` : '';
        lines.push(`  - [${check.severity}] ${check.message}${loc}`);
      }
      if (flaggedChecks.length > 5) {
        lines.push(`  - …and ${flaggedChecks.length - 5} more`);
      }
      lines.push('');
    }
  }

  if (passed.length > 0) {
    lines.push(`### Passed (${passed.length} module${passed.length === 1 ? '' : 's'})`);
    lines.push(passed.map(r => `\`${r.module || r.name}\``).join(', '));
  }

  return lines.join('\n');
}

async function handleScanLocal(args) {
  const { path: scanPath, suite, modules } = args;

  if (!scanPath || typeof scanPath !== 'string') {
    return { content: [{ type: 'text', text: 'Error: path is required and must be a string' }], isError: true };
  }

  try {
    const gt = new GateTest(scanPath, { silent: true }).init();

    let result;
    if (modules && Array.isArray(modules) && modules.length > 0) {
      // Run specific modules
      result = await runPreservingExitCode(() => gt._run(modules));
    } else {
      const s = suite || 'standard';
      result = await runPreservingExitCode(() => gt.runSuite(s));
    }

    lastScanResult = { source: 'scan_local', path: scanPath, data: result, at: new Date().toISOString() };
    const text = formatScanResult(result);
    const json = JSON.stringify(result, null, 2);
    return {
      content: [
        { type: 'text', text },
        { type: 'text', text: `\n<details>\n<summary>Full JSON result</summary>\n\n\`\`\`json\n${json}\n\`\`\`\n</details>` },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Scan failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

async function handleRunModule(args) {
  const { module: moduleName, path: scanPath } = args;

  if (!moduleName || !scanPath) {
    return { content: [{ type: 'text', text: 'Error: module and path are both required' }], isError: true };
  }

  try {
    const gt = new GateTest(scanPath, { silent: true }).init();
    const result = await runPreservingExitCode(() => gt.runModule(moduleName));
    const text = formatScanResult(result);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Module run failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

async function handleListModules() {
  try {
    const gt = new GateTest(process.cwd()).init();
    const allModules = gt.registry.getAll();
    const lines = [`## GateTest Modules (${allModules.size} total)`, ''];

    for (const [name, mod] of allModules) {
      const desc = mod.description || mod.name || name;
      lines.push(`**\`${name}\`** — ${desc}`);
    }

    lines.push('');
    lines.push(`Total: ${allModules.size} modules loaded`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to list modules: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

async function handleCheckHealth() {
  try {
    const gt = new GateTest(process.cwd()).init();
    const moduleNames = gt.registry.list();
    const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
    return {
      content: [{
        type: 'text',
        text:
          `## GateTest Health\n\n✅ **Operational**\n\n` +
          `- Engine: GateTest v1.55.0\n` +
          `- Modules loaded: ${moduleNames.length}\n` +
          `- Transport: stdio\n` +
          `- Anthropic API key: ${hasAnthropic ? '✅ present (fix_issue, explain_finding available)' : '⚠️ missing (fix_issue, explain_finding will return an error)'}`,
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Health check failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Shared Anthropic call wrapper used by fix_issue / explain_finding. Same
// shape as website/app/api/scan/fix/route.ts's askClaude wrapper but minimal —
// no streaming, no retry, just one call. Returns the assistant text or
// throws.
// ---------------------------------------------------------------------------
async function callClaude(prompt, { maxTokens = 4096, model = 'claude-sonnet-4-6' } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY not set');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (res.status !== 200) {
      throw new Error(`Anthropic API error ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data?.content?.[0]?.text || '';
  } finally {
    clearTimeout(timer);
  }
}

async function handleFixIssue(args) {
  const { file, issue, module: moduleName, line } = args || {};
  if (!file || !issue) {
    return { content: [{ type: 'text', text: 'Error: file and issue are both required' }], isError: true };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      content: [{
        type: 'text',
        text:
          'fix_issue requires ANTHROPIC_API_KEY in the environment. Set it and retry — ' +
          'this tool calls Claude directly to generate the fix.',
      }],
      isError: true,
    };
  }
  try {
    // aiFix reads the file itself; returns { fixed: bool, description, filesChanged }.
    // When fixed === true the file on disk has been rewritten in place.
    const result = await aiFix({
      filePath: file,
      issueTitle: moduleName || 'finding',
      issueMessage: issue,
      lineNumber: typeof line === 'number' ? line : undefined,
    });
    if (!result || result.fixed !== true) {
      return {
        content: [{ type: 'text', text: `No fix produced. ${result?.description || 'unknown reason'}` }],
        isError: true,
      };
    }
    return {
      content: [{
        type: 'text',
        text:
          `## Fix applied to \`${file}\`\n\n` +
          `**Issue:** ${issue}\n` +
          (result.description ? `\n**What changed:** ${result.description}\n` : '') +
          (Array.isArray(result.filesChanged) && result.filesChanged.length
            ? `\n**Files written:** ${result.filesChanged.map((f) => `\`${f}\``).join(', ')}\n`
            : ''),
      }],
    };
  } catch (err) {
    return { content: [{ type: 'text', text: `fix_issue failed: ${err && err.message ? err.message : String(err)}` }], isError: true };
  }
}

async function handleComposePr(args) {
  const { fixes, repoUrl, tier } = args || {};
  if (!Array.isArray(fixes)) {
    return { content: [{ type: 'text', text: 'Error: fixes must be an array' }], isError: true };
  }
  try {
    const body = composePrBody({
      fixes,
      repoUrl: repoUrl || 'unknown',
      tier: tier || 'full',
    });
    return { content: [{ type: 'text', text: body }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `compose_pr failed: ${err && err.message ? err.message : String(err)}` }], isError: true };
  }
}

async function handleExplainFinding(args) {
  const { finding, hostname, scanContext } = args || {};
  if (!finding || typeof finding !== 'object') {
    return { content: [{ type: 'text', text: 'Error: finding must be an object with at least { detail, module, severity }' }], isError: true };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      content: [{
        type: 'text',
        text:
          'explain_finding requires ANTHROPIC_API_KEY in the environment. Set it and retry — ' +
          'this tool calls Claude directly for Nuclear-tier diagnosis.',
      }],
      isError: true,
    };
  }
  try {
    const result = await diagnoseFinding({
      finding,
      hostname: hostname || 'your-domain.com',
      scanContext: scanContext || {},
      askClaudeForDiagnosis: (p) => callClaude(p, { maxTokens: 1024 }),
    });
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Diagnosis skipped: ${result.reason}` }], isError: true };
    }
    const d = result.diagnosis;
    return {
      content: [{
        type: 'text',
        text:
          `## Diagnosis\n\n` +
          `**Module:** ${finding.module || 'unknown'}  |  **Severity:** ${finding.severity || 'unknown'}\n\n` +
          `### Explanation\n${d.explanation || '(none)'}\n\n` +
          `### Root cause\n${d.rootCause || '(none)'}\n\n` +
          `### Recommendation\n${d.recommendation || '(none)'}\n\n` +
          (d.platformNotes ? `### Platform notes\n${d.platformNotes}\n` : ''),
      }],
    };
  } catch (err) {
    return { content: [{ type: 'text', text: `explain_finding failed: ${err && err.message ? err.message : String(err)}` }], isError: true };
  }
}

async function handleAuditLog(args) {
  const { path: projectPath, limit = 10 } = args || {};
  if (!projectPath) {
    return { content: [{ type: 'text', text: 'Error: path is required' }], isError: true };
  }
  try {
    const store = new MemoryStore(projectPath);
    const memory = store.load();
    const scans = memory?.scans;
    const totalScans = scans?.totalScans || 0;
    const runs = Array.isArray(scans?.runs) ? scans.runs.slice(-limit).reverse() : [];
    const lines = [`## GateTest Audit Log for \`${projectPath}\``, ''];
    if (totalScans === 0) {
      lines.push('No scans on record. Run GateTest at least once to populate the memory store.');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    lines.push(`**Total scans:** ${totalScans}  |  **Showing:** last ${runs.length} (newest first)`);
    lines.push('');
    for (const r of runs) {
      const when = r.timestamp ? new Date(r.timestamp).toISOString() : '(no timestamp)';
      const status = r.status || (r.gateStatus === 'BLOCKED' ? 'BLOCKED' : 'PASSED');
      lines.push(`- **${when}** — ${status} — errors:${r.errors ?? '?'} warnings:${r.warnings ?? '?'} duration:${r.duration ? `${(r.duration / 1000).toFixed(1)}s` : '?'}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `audit_log failed: ${err && err.message ? err.message : String(err)}` }], isError: true };
  }
}

async function handleCompareRepos(args) {
  const { path: projectPath, moduleHint } = args || {};
  if (!projectPath) {
    return { content: [{ type: 'text', text: 'Error: path is required' }], isError: true };
  }
  try {
    const store = new MemoryStore(projectPath);
    const memory = store.load();
    const scans = memory?.scans;
    const totalScans = scans?.totalScans || 0;
    if (totalScans < 3) {
      return {
        content: [{
          type: 'text',
          text:
            `## Cross-repo comparison — insufficient data\n\n` +
            `Need at least 3 prior scans in the local memory store to compare against. ` +
            `Currently have ${totalScans}. Run more scans (or connect a shared brain when ` +
            `the central memory service ships) to enable cross-codebase pattern matching.`,
        }],
      };
    }
    // Local store doesn't have cross-repo data — this is a local-only summary
    // of the SAME repo's history. Note the limitation clearly.
    const runs = scans.runs || [];
    const moduleFreq = new Map();
    for (const r of runs) {
      const mods = r.moduleSummary || r.byModule || {};
      for (const [m, stats] of Object.entries(mods)) {
        if (moduleHint && m !== moduleHint) continue;
        const errors = (stats && (stats.errors || stats.errorCount)) || 0;
        moduleFreq.set(m, (moduleFreq.get(m) || 0) + errors);
      }
    }
    const top = [...moduleFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const lines = [
      `## Local scan-history comparison`,
      '',
      `Note: this MCP server runs on a single local memory store. True cross-repo `,
      `pattern matching requires the central brain service (Memory-as-a-Service in `,
      `the roadmap). For now this summarises THIS repo's recurring patterns.`,
      '',
      `**Scans analysed:** ${runs.length}${moduleHint ? `  |  **Filter:** module=${moduleHint}` : ''}`,
      '',
      '### Top modules by total error count (history)',
    ];
    for (const [m, count] of top) {
      lines.push(`- \`${m}\` — ${count} historical errors`);
    }
    if (top.length === 0) {
      lines.push('(no module breakdown stored in scan history)');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `compare_repos failed: ${err && err.message ? err.message : String(err)}` }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// Hosted-API tools — scan_url / scan_repo / get_badge / get_report.
//
// Everything above runs the engine in-process against the local
// filesystem. These four instead call the hosted gatetest.ai product
// (free quick-tier, no account) — for a URL or repo the agent doesn't
// have local disk access to. GATETEST_API_BASE_URL overrides the base
// URL for self-hosted / dev use.
// ---------------------------------------------------------------------------

const API_BASE_URL = (process.env.GATETEST_API_BASE_URL || 'https://gatetest.ai').replace(/\/+$/, '');

// Holds the result of the most recent scan_local/scan_url/scan_repo call
// made in THIS server process — get_report reads it back. Deliberately
// simple in-memory state: one MCP server process is one conversation's
// worth of tool calls, not a shared/concurrent service (same assumption
// audit_log/compare_repos already make about the local memory store).
let lastScanResult = null;

async function postJson(path, body, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function formatHostedFindings(title, findings) {
  if (!Array.isArray(findings) || findings.length === 0) return `${title}\n\nNo findings — clean.`;
  const lines = [title, ''];
  for (const f of findings) {
    const sev = f.severity ? `[${f.severity}] ` : '';
    const mod = f.module ? `\`${f.module}\` — ` : '';
    lines.push(`- ${sev}${mod}${f.title || f.message || JSON.stringify(f)}`);
  }
  return lines.join('\n');
}

async function handleScanUrl(args) {
  const { url } = args || {};
  if (!url || typeof url !== 'string') {
    return { content: [{ type: 'text', text: 'Error: url is required and must be a string' }], isError: true };
  }
  try {
    const { status, data } = await postJson('/api/web/scan', { url });
    if (status !== 200 || data.error) {
      return { content: [{ type: 'text', text: `scan_url failed: ${data.error || `HTTP ${status}`}` }], isError: true };
    }
    lastScanResult = { source: 'scan_url', url, data, at: new Date().toISOString() };
    const header =
      `## GateTest scan — ${url}\n\n` +
      `**Health score:** ${data.healthScore?.score ?? '?'}/100 (${data.healthScore?.grade ?? '?'})  |  ` +
      `**Total findings:** ${data.totalFindings ?? '?'} (${data.errorCount ?? 0} errors, ${data.warningCount ?? 0} warnings)\n`;
    const findingsText = formatHostedFindings('### Findings (free-tier preview)', data.findings);
    const upsell = data.paywall
      ? `\n\n---\n${data.paywall.remainingCount} more finding(s) available — full report from $${data.paywall.fullReportPriceUsd} at ${API_BASE_URL}${data.paywall.ctaUrl || '/#pricing'}`
      : '';
    return { content: [{ type: 'text', text: `${header}\n${findingsText}${upsell}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `scan_url failed: ${err && err.message ? err.message : String(err)}` }], isError: true };
  }
}

async function handleScanRepo(args) {
  const { repoUrl } = args || {};
  if (!repoUrl || typeof repoUrl !== 'string') {
    return { content: [{ type: 'text', text: 'Error: repoUrl is required and must be a string' }], isError: true };
  }
  try {
    const { status, data } = await postJson('/api/playground/scan', { repo_url: repoUrl });
    if (status !== 200 || data.error) {
      return { content: [{ type: 'text', text: `scan_repo failed: ${data.error || `HTTP ${status}`}` }], isError: true };
    }
    lastScanResult = { source: 'scan_repo', repoUrl, data, at: new Date().toISOString() };
    const header =
      `## GateTest scan — ${repoUrl}\n\n` +
      `**Grade:** ${data.grade ?? '?'} (${data.healthScore ?? '?'}/100)  |  ` +
      `**Total issues:** ${data.totalIssues ?? '?'}  |  **Duration:** ${data.duration ? `${(data.duration / 1000).toFixed(1)}s` : '?'}\n`;
    const findingsText = formatHostedFindings('### Top findings (free-tier preview)', data.topFindings);
    const upsell = data.upgradeNote ? `\n\n---\n${data.upgradeNote} ${API_BASE_URL}/playground` : '';
    return { content: [{ type: 'text', text: `${header}\n${findingsText}${upsell}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `scan_repo failed: ${err && err.message ? err.message : String(err)}` }], isError: true };
  }
}

async function handleGetBadge(args) {
  const { owner, repo } = args || {};
  if (!owner || !repo) {
    return { content: [{ type: 'text', text: 'Error: owner and repo are both required' }], isError: true };
  }
  const badgeUrl = `${API_BASE_URL}/badge/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const markdown = `[![GateTest](${badgeUrl})](${API_BASE_URL})`;
  return {
    content: [{
      type: 'text',
      text:
        `## GateTest badge — ${owner}/${repo}\n\n` +
        `**Markdown (paste into README):**\n\`\`\`md\n${markdown}\n\`\`\`\n\n` +
        `**Raw badge URL:** ${badgeUrl}\n\n` +
        `Shows "not scanned" until this repo has a completed scan on record (run scan_repo or ` +
        `scan it at ${API_BASE_URL}/playground first).`,
    }],
  };
}

// ── engine-run helper ───────────────────────────────────────────────────────

/**
 * The engine sets `process.exitCode = 1` when a scan's gate is BLOCKED
 * (src/index.js — correct for the CLI). An MCP server must not let a scan
 * verdict poison its own process exit status, so every in-process engine
 * run goes through this wrapper.
 */
async function runPreservingExitCode(fn) {
  const prev = process.exitCode;
  try {
    return await fn();
  } finally {
    process.exitCode = prev;
  }
}

// ── verify_fix helpers ──────────────────────────────────────────────────────

function normalizeRelPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Fuzzy path-tail match: module-emitted check.file paths are usually
 * repo-relative posix, while callers may pass Windows separators or
 * deeper/shallower prefixes. Two paths match when one ends with the other
 * on a path-segment boundary.
 */
function pathsTailMatch(a, b) {
  const na = normalizeRelPath(a).toLowerCase();
  const nb = normalizeRelPath(b).toLowerCase();
  if (!na || !nb) return false;
  return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

function collectFlaggedChecks(result) {
  const out = [];
  for (const mod of result.results || []) {
    for (const check of mod.checks || []) {
      if (check.severity === 'error' || check.severity === 'warning') {
        out.push({ module: mod.module || mod.name || 'unknown', ...check });
      }
    }
  }
  return out;
}

async function handleVerifyFix(args) {
  const { path: projectPath, files, base, maxModules } = args;

  if (!projectPath || typeof projectPath !== 'string') {
    return { content: [{ type: 'text', text: 'Error: path is required and must be a string' }], isError: true };
  }

  try {
    const smart = computeSmartSuite({
      projectRoot: projectPath,
      files: Array.isArray(files) && files.length > 0 ? files : undefined,
      base,
      max: typeof maxModules === 'number' && maxModules > 0 ? maxModules : undefined,
    });

    const gt = new GateTest(projectPath, { silent: true }).init();

    let result;
    let modulesRan;
    let selectionNote;
    if (smart.modules) {
      result = await runPreservingExitCode(() => gt._run(smart.modules));
      modulesRan = smart.modules;
      selectionNote = smart.selectionReason;
    } else {
      result = await runPreservingExitCode(() => gt.runSuite('quick'));
      modulesRan = null;
      selectionNote = 'no diff detected (no files passed, git found no changes) — ran the quick suite as fallback';
    }

    lastScanResult = { source: 'verify_fix', path: projectPath, data: result, at: new Date().toISOString() };

    const changedFiles = smart.changedFiles || [];
    const flagged = collectFlaggedChecks(result);
    const totalErrors = flagged.filter((c) => c.severity === 'error').length;
    const totalWarnings = flagged.filter((c) => c.severity === 'warning').length;

    const lines = [];

    if (changedFiles.length === 0) {
      // No file scope — be honest: the verdict is project-wide, not fix-scoped.
      const verified = totalErrors === 0;
      lines.push(verified
        ? `✅ PROJECT CLEAN — 0 error-severity findings (no changed files detected, so this verdict is project-wide, not fix-scoped)`
        : `❌ NOT VERIFIED — ${totalErrors} error-severity finding${totalErrors === 1 ? '' : 's'} project-wide (no changed files detected to scope the verdict)`);
      lines.push('');
      lines.push('Tip: pass `files: ["src/the/file/you/edited.js"]` for a fix-scoped verdict.');
    } else {
      const scoped = flagged.filter((c) => c.file && changedFiles.some((f) => pathsTailMatch(c.file, f)));
      const scopedErrors = scoped.filter((c) => c.severity === 'error');
      const scopedWarnings = scoped.filter((c) => c.severity === 'warning');
      const verified = scopedErrors.length === 0;

      lines.push(verified
        ? `✅ FIX VERIFIED — 0 error-severity findings remain on your ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}`
        : `❌ NOT VERIFIED — ${scopedErrors.length} error-severity finding${scopedErrors.length === 1 ? '' : 's'} remain on your changed files`);
      lines.push('');
      lines.push(`**Changed files:** ${changedFiles.map((f) => `\`${normalizeRelPath(f)}\``).join(', ')}`);

      const listFindings = (items, label) => {
        if (items.length === 0) return;
        lines.push('');
        lines.push(`### ${label}`);
        for (const c of items.slice(0, 20)) {
          const loc = c.file ? ` (${c.file}${c.line ? `:${c.line}` : ''})` : '';
          lines.push(`- [${c.severity}] [\`${c.module}\`] ${c.message}${loc}`);
          if (c.suggestion) lines.push(`  - Fix: ${c.suggestion}`);
        }
        if (items.length > 20) lines.push(`- …and ${items.length - 20} more`);
      };
      listFindings(scopedErrors, 'Remaining errors on changed files');
      listFindings(scopedWarnings, 'Warnings on changed files (advisory — does not block the verdict)');
    }

    lines.push('');
    if (modulesRan) {
      lines.push(`**Modules run (smart selection — ${selectionNote}):** ${modulesRan.map((m) => `\`${m}\``).join(', ')}`);
    } else {
      lines.push(`**Modules run:** quick suite (${selectionNote})`);
    }
    const gateStatus = result.gateStatus || (totalErrors > 0 ? 'BLOCKED' : 'PASSED');
    lines.push(`**Project-wide:** ${totalErrors} error(s) / ${totalWarnings} warning(s) — gate ${gateStatus}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `verify_fix failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

// ── eyes tools: capture_screenshot + get_visual_diff ────────────────────────

// MCP hosts practically cap tool results around ~1MB and base64 inflates
// raw bytes by 33% — 700KB raw ≈ 933KB encoded, safely under the line.
const MAX_IMAGE_BYTES = 700_000;
// A 1280×20000 full-page PNG decodes to ~100MB RGBA; refuse to composite
// anything whose decoded area would explode memory.
const MAX_DECODED_PIXELS = 40_000_000;

function imageResponse(buffer, mimeType, caption) {
  return {
    content: [
      { type: 'image', data: buffer.toString('base64'), mimeType },
      { type: 'text', text: caption },
    ],
  };
}

async function handleCaptureScreenshot(args) {
  const { url, width, height, fullPage, format, quality, waitMs } = args;

  if (!url || typeof url !== 'string') {
    return { content: [{ type: 'text', text: 'Error: url is required and must be a string' }], isError: true };
  }

  const viewport = {
    width: typeof width === 'number' && width > 0 ? Math.min(width, 3840) : 1280,
    height: typeof height === 'number' && height > 0 ? Math.min(height, 2160) : 900,
  };
  const fmt = format === 'png' ? 'png' : 'jpeg';

  try {
    // JPEG oversize → retry at lower quality; PNG oversize → pixel downscale.
    const qualities = fmt === 'jpeg'
      ? [typeof quality === 'number' ? Math.min(Math.max(quality, 1), 100) : 70, 50, 35]
      : [undefined];

    let shot = null;
    for (const q of qualities) {
      shot = await captureUrlScreenshot({
        url,
        viewport,
        fullPage: fullPage === true,
        waitMs: typeof waitMs === 'number' ? waitMs : 1000,
        format: fmt,
        quality: q,
      });
      if (shot.buffer.length <= MAX_IMAGE_BYTES) break;
    }

    let { buffer, mimeType } = shot;
    let sizeNote = '';
    if (buffer.length > MAX_IMAGE_BYTES && mimeType === 'image/png') {
      const capped = encodeUnderByteCap(buffer, MAX_IMAGE_BYTES);
      buffer = capped.buffer;
      if (capped.downscaled) sizeNote = `, downscaled to ${capped.width}×${capped.height} to fit the payload budget`;
    } else if (buffer.length > MAX_IMAGE_BYTES) {
      sizeNote = ' — still large after recompression; consider fullPage:false or a smaller viewport';
    }

    return imageResponse(
      buffer,
      mimeType,
      `Captured ${url} at ${shot.width}×${shot.height} (${Math.round(buffer.length / 1024)} KB${fullPage === true ? ', full page' : ''}${sizeNote})`,
    );
  } catch (err) {
    if (err && (err.code === 'PLAYWRIGHT_MISSING' || err.code === 'BROWSER_LAUNCH_FAILED')) {
      return {
        content: [{
          type: 'text',
          text:
            `Screenshot unavailable: ${err.message}\n\n` +
            'This tool needs Playwright + Chromium on the machine running the MCP server.\n' +
            'Install with: npm install playwright && npx playwright install chromium',
        }],
      };
    }
    return {
      content: [{ type: 'text', text: `capture_screenshot failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

function listBaselineTree(baselineDir) {
  const triples = [];
  let platforms = [];
  try {
    platforms = fsSync.readdirSync(baselineDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return triples;
  }
  for (const p of platforms) {
    let viewports = [];
    try {
      viewports = fsSync
        .readdirSync(nodePath.join(baselineDir, p.name), { withFileTypes: true })
        .filter((d) => d.isDirectory());
    } catch { continue; }
    for (const v of viewports) {
      let files = [];
      try {
        files = fsSync.readdirSync(nodePath.join(baselineDir, p.name, v.name)).filter((f) => f.endsWith('.png'));
      } catch { continue; }
      for (const f of files) {
        triples.push({ platform: p.name, viewport: v.name, slug: f.replace(/\.png$/, '') });
      }
    }
  }
  return triples;
}

async function handleGetVisualDiff(args) {
  const { path: projectPath, route, platform, viewport, panel, baselineDir: explicitDir, maxWidth, includeFacts } = args;

  if (!projectPath || !route) {
    return { content: [{ type: 'text', text: 'Error: path and route are both required' }], isError: true };
  }

  try {
    // Resolve baselineDir exactly like the visualRegression module does.
    let baselineDir = explicitDir;
    if (!baselineDir) {
      const cfg = new GateTestConfig(projectPath);
      const moduleCfg = cfg.getModuleConfig('visualRegression') || {};
      baselineDir = moduleCfg.baselineDir || nodePath.join(projectPath, '.gatetest', 'visual-baselines');
    }

    const triples = listBaselineTree(baselineDir);
    if (triples.length === 0) {
      return {
        content: [{
          type: 'text',
          text:
            `No visual baselines found under ${baselineDir}.\n` +
            'Run the visualRegression module first (suite "web" or "wp" with a target URL) to create baselines.',
        }],
      };
    }

    const slug = slugifyRoute(route);
    const platforms = [...new Set(triples.map((t) => t.platform))];
    const resolvedPlatform = platform || (platforms.length === 1 ? platforms[0] : null);
    const viewportsForPlatform = [
      ...new Set(triples.filter((t) => t.platform === resolvedPlatform).map((t) => t.viewport)),
    ];
    const resolvedViewport =
      viewport || (viewportsForPlatform.includes('desktop') ? 'desktop' : viewportsForPlatform[0]);

    const match = triples.find(
      (t) => t.platform === resolvedPlatform && t.viewport === resolvedViewport && t.slug === slug,
    );

    if (!resolvedPlatform || !match) {
      // Discoverability instead of a dead-end: list what exists.
      const listing = triples
        .slice(0, 60)
        .map((t) => `- platform: \`${t.platform}\`  viewport: \`${t.viewport}\`  route-slug: \`${t.slug}\``)
        .join('\n');
      return {
        content: [{
          type: 'text',
          text:
            (resolvedPlatform
              ? `No baseline for route "${route}" (slug \`${slug}\`) under platform \`${resolvedPlatform}\`, viewport \`${resolvedViewport}\`.`
              : `Multiple platforms exist — pass \`platform\` explicitly.`) +
            `\n\nAvailable baselines in ${baselineDir}:\n${listing}${triples.length > 60 ? `\n…and ${triples.length - 60} more` : ''}`,
        }],
      };
    }

    const viewportDir = nodePath.join(baselineDir, match.platform, match.viewport);
    const baselinePath = nodePath.join(viewportDir, `${slug}.png`);
    const currentPath = nodePath.join(viewportDir, 'current', `${slug}.png`);
    const diffPath = nodePath.join(viewportDir, 'diff', `${slug}.png`);

    const available = {
      baseline: fsSync.existsSync(baselinePath),
      current: fsSync.existsSync(currentPath),
      diff: fsSync.existsSync(diffPath),
    };

    // Panel default: composite when a diff exists (a scan has compared),
    // otherwise the baseline alone (first run — nothing to diff yet).
    let resolvedPanel = panel || (available.diff ? 'composite' : 'baseline');
    if (resolvedPanel === 'composite' && (!available.current || !available.diff)) {
      resolvedPanel = 'baseline';
    }

    const readPanel = (p) => fsSync.readFileSync(p);
    let buffer;
    if (resolvedPanel === 'composite') {
      // Pixel-area guard BEFORE decoding three full-page PNGs into RGBA.
      const dims = [baselinePath, currentPath, diffPath].map((p) => readPngDimensions(readPanel(p)));
      const totalArea = dims.reduce((s, d) => s + (d ? d.width * d.height : 0), 0);
      if (totalArea > MAX_DECODED_PIXELS) {
        return {
          content: [{
            type: 'text',
            text:
              `Composite refused: the three panels total ${Math.round(totalArea / 1e6)}M decoded pixels ` +
              `(guard: ${MAX_DECODED_PIXELS / 1e6}M). Request a single panel instead — panel:"diff" shows what changed.`,
          }],
        };
      }
      buffer = buildSideBySideComposite(readPanel(baselinePath), readPanel(currentPath), readPanel(diffPath));
    } else {
      const panelPath = resolvedPanel === 'baseline' ? baselinePath : resolvedPanel === 'current' ? currentPath : diffPath;
      if (!available[resolvedPanel]) {
        return {
          content: [{
            type: 'text',
            text: `Panel "${resolvedPanel}" does not exist yet for ${route} (${match.viewport}). Available: ${Object.keys(available).filter((k) => available[k]).join(', ')}.`,
          }],
        };
      }
      buffer = readPanel(panelPath);
    }

    if (typeof maxWidth === 'number' && maxWidth > 0) {
      const dims = readPngDimensions(buffer);
      if (dims && dims.width > maxWidth) {
        const { downscaleToWidth } = require('../src/core/visual-diff-engine.js');
        buffer = downscaleToWidth(buffer, maxWidth);
      }
    }

    const capped = encodeUnderByteCap(buffer, MAX_IMAGE_BYTES);
    const finalDims = readPngDimensions(capped.buffer);
    const response = imageResponse(
      capped.buffer,
      'image/png',
      `${resolvedPanel} for ${route} — platform \`${match.platform}\`, viewport \`${match.viewport}\`` +
        (finalDims ? `, ${finalDims.width}×${finalDims.height}` : '') +
        ` (${Math.round(capped.buffer.length / 1024)} KB${capped.downscaled ? ', downscaled to fit payload budget' : ''})` +
        (resolvedPanel === 'composite' ? '. Order: baseline | current | diff.' : ''),
    );

    // Visual facts — changed-region bounding boxes clustered from the raw
    // diff PNG (fs-only here; the full selector/computed-style mapping
    // needs the LIVE page and is attached to scan findings by the
    // visualRegression module at scan time).
    if (includeFacts === true && available.diff) {
      try {
        const regions = extractDiffRegions(readPanel(diffPath));
        response.content.push({
          type: 'text',
          text:
            regions.length === 0
              ? 'Changed regions: none above the noise floor.'
              : `Changed regions (from diff, full-page coordinates):\n\`\`\`json\n${JSON.stringify(regions, null, 2)}\n\`\`\`\n` +
                'Selector + computed-style mapping for these regions is attached to the scan finding (`visualFacts`) when the visualRegression module runs with a live URL.',
        });
      } catch { /* facts are additive — image already in the response */ }
    }

    return response;
  } catch (err) {
    return {
      content: [{ type: 'text', text: `get_visual_diff failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

// ── ears tools: run_live_checks + get_production_errors ─────────────────────

const RUNTIME_TRIAD = ['runtimeErrors', 'consoleErrors', 'apiHealth'];

async function handleRunLiveChecks(args) {
  const { url, modules } = args;

  if (!url || typeof url !== 'string') {
    return { content: [{ type: 'text', text: 'Error: url is required and must be a string' }], isError: true };
  }

  const requested = Array.isArray(modules) && modules.length > 0
    ? modules.filter((m) => RUNTIME_TRIAD.includes(m))
    : RUNTIME_TRIAD;
  if (requested.length === 0) {
    return {
      content: [{ type: 'text', text: `Error: modules must be a subset of ${RUNTIME_TRIAD.join(', ')}` }],
      isError: true,
    };
  }

  try {
    const gt = new GateTest(process.cwd(), { silent: true }).init();
    // Every module in the triad reads targetUrl at the end of its
    // URL-fallback chain — injecting here scopes the run to the given URL.
    gt.config.config.targetUrl = url;
    const result = await runPreservingExitCode(() => gt._run(requested));

    lastScanResult = { source: 'run_live_checks', url, data: result, at: new Date().toISOString() };

    // Honesty: browser-based modules skip gracefully when Playwright /
    // Chromium is unavailable — detect the skip checks and SAY so instead
    // of implying a clean bill of health.
    const allChecks = [];
    for (const mod of result.results || []) {
      for (const check of mod.checks || []) {
        allChecks.push({ module: mod.module || mod.name || 'unknown', ...check });
      }
    }
    const skippedEars = allChecks
      .filter((c) => /playwright-missing|browser-launch/.test(c.name || ''))
      .map((c) => c.module);
    const liveEars = requested.filter((m) => !skippedEars.includes(m));

    const flagged = allChecks.filter((c) => c.severity === 'error' || c.severity === 'warning');
    const lines = [formatScanResult(result)];
    if (skippedEars.length > 0) {
      lines.unshift(
        `⚠️ Browser unavailable in this environment — ${skippedEars.join(' + ')} skipped; ` +
          `only ${liveEars.join(' + ') || 'no module'} produced live signal. ` +
          'Install Chromium (npx playwright install chromium) for full ears.\n',
      );
    }
    // Machine-consumable digest for the caller.
    const digest = flagged.map((c) => ({
      module: c.module,
      name: c.name,
      severity: c.severity,
      message: c.message,
      ...(c.file ? { file: c.file } : {}),
      ...(c.line ? { line: c.line } : {}),
    }));
    lines.push(`\n\`\`\`json\n${JSON.stringify({ url, earsDigest: digest }, null, 2)}\n\`\`\``);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `run_live_checks failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

async function handleGetProductionErrors(args) {
  const { source, limit, service, hoursBack } = args || {};

  try {
    const envSources = resolveSourcesFromEnv();
    const filtered = {};
    for (const vendor of ['sentry', 'datadog', 'rollbar']) {
      if (!envSources[vendor]) continue;
      if (source && source !== 'all' && source !== vendor) continue;
      filtered[vendor] = envSources[vendor];
    }
    if (filtered.datadog) {
      if (service) filtered.datadog.service = service;
      if (typeof hoursBack === 'number') filtered.datadog.hoursBack = hoursBack;
    }

    if (Object.keys(filtered).length === 0) {
      return {
        content: [{
          type: 'text',
          text:
            'No observability vendors configured' + (source && source !== 'all' ? ` for source "${source}"` : '') + '. Set environment variables on the machine running the MCP server:\n\n' +
            '- **Sentry**: `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT`\n' +
            '- **Datadog**: `DATADOG_API_KEY` + `DATADOG_APP_KEY` (optional `DD_SITE`, `DD_SERVICE`)\n' +
            '- **Rollbar**: `ROLLBAR_READ_TOKEN` (project read token)\n\n' +
            'Then call this tool again to see the top errors real users are hitting, with file:line locations.',
        }],
      };
    }

    const res = await fetchProductionErrors({
      ...filtered,
      limit: typeof limit === 'number' && limit > 0 ? limit : 20,
    });

    const lines = ['## Production errors (what real users are hitting)', ''];
    for (const [vendor, status] of Object.entries(res.sources)) {
      if (status !== 'skipped') lines.push(`- ${vendor}: ${status}`);
    }
    lines.push('');

    if (res.items.length === 0) {
      lines.push('No errors returned — either production is clean or the queried window is quiet.');
    } else {
      lines.push('| # | message | location | count | last seen | source |');
      lines.push('|---|---------|----------|-------|-----------|--------|');
      res.items.forEach((item, i) => {
        const loc = item.file ? `\`${item.file}:${item.line != null ? item.line : '?'}\`` : '—';
        const msg = (item.message || '').replace(/\|/g, '\\|').slice(0, 120);
        lines.push(`| ${i + 1} | ${msg} | ${loc} | ${item.count} | ${item.lastSeen || '—'} | ${item.source} |`);
      });
      lines.push('');
      lines.push(
        '**Tip:** findings at these file:line locations are the ones to fix FIRST — ' +
          'pass them as `runtimeEvents` to the fix flow (or fix locally and prove it with `verify_fix`).',
      );
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `get_production_errors failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

async function handleGetReport() {
  if (!lastScanResult) {
    return {
      content: [{ type: 'text', text: 'No scan has run yet in this session. Call scan_local, scan_url, or scan_repo first.' }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text',
      text:
        `## Last scan report (${lastScanResult.source}, ${lastScanResult.at})\n\n` +
        `\`\`\`json\n${JSON.stringify(lastScanResult.data, null, 2)}\n\`\`\``,
    }],
  };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'gatetest', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'scan_local':       return handleScanLocal(args);
    case 'run_module':       return handleRunModule(args);
    case 'list_modules':     return handleListModules();
    case 'check_health':     return handleCheckHealth();
    case 'fix_issue':        return handleFixIssue(args);
    case 'compose_pr':       return handleComposePr(args);
    case 'explain_finding':  return handleExplainFinding(args);
    case 'audit_log':        return handleAuditLog(args);
    case 'compare_repos':    return handleCompareRepos(args);
    case 'scan_url':         return handleScanUrl(args);
    case 'scan_repo':        return handleScanRepo(args);
    case 'get_badge':        return handleGetBadge(args);
    case 'get_report':       return handleGetReport();
    case 'verify_fix':       return handleVerifyFix(args);
    case 'capture_screenshot': return handleCaptureScreenshot(args);
    case 'get_visual_diff':  return handleGetVisualDiff(args);
    case 'run_live_checks':  return handleRunLiveChecks(args);
    case 'get_production_errors': return handleGetProductionErrors(args);
    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Only attach the stdio transport when this file is the process entrypoint
// (i.e. `node bin/gatetest-mcp.mjs` / the `gatetest-mcp` bin). When imported
// by tests via `await import()`, we export the handlers instead so the real
// handler logic can be exercised in-process without hijacking stdin/stdout.
import { pathToFileURL } from 'url';
import { realpathSync } from 'fs';

// realpathSync matters: a global npm install runs this file through a
// .bin symlink, so argv[1] is the symlink path while import.meta.url is
// the resolved real path — without realpath the guard would never match
// and the installed server would silently not start.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Test-only surface — NOT part of the MCP protocol. See tests/mcp-verify-fix.test.js
// and tests/mcp-eyes-tools.test.js.
export {
  TOOLS,
  handleVerifyFix,
  handleCaptureScreenshot,
  handleGetVisualDiff,
  handleRunLiveChecks,
  handleGetProductionErrors,
  normalizeRelPath,
  pathsTailMatch,
  collectFlaggedChecks,
  formatScanResult,
};
