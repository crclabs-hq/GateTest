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
 *   list_modules     — list all 112 modules with descriptions
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
const { GateTest } = require('../src/index.js');
const { aiFix } = require('../src/core/ai-fix-engine.js');
const { MemoryStore } = require('../src/core/memory.js');
const { composePrBody } = require('../website/app/lib/pr-composer.js');
const { diagnoseFinding } = require('../website/app/lib/nuclear-diagnoser.js');

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'scan_local',
    description:
      'Scan a local directory with GateTest\'s 112-module engine. ' +
      'Returns issues found across security, reliability, code quality, ' +
      'and more. Use suite="quick" for the 4 core modules or suite="full" ' +
      'for all 112 modules. Optionally pass a list of specific module names.',
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
      'List all 112 GateTest modules with their names and descriptions. ' +
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
      'Verify GateTest is operational. Returns version, module count (112), ' +
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
      result = await gt._run(modules);
    } else {
      const s = suite || 'standard';
      result = await gt.runSuite(s);
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
    const result = await gt.runModule(moduleName);
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
          `- Engine: GateTest v1.53.1\n` +
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

const transport = new StdioServerTransport();
await server.connect(transport);
