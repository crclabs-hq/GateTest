/**
 * GateTest MCP Server — Model Context Protocol stdio server.
 *
 * Lets any MCP-capable AI client (Claude Code, Cursor, Cline, Windsurf,
 * Continue, custom agents) invoke GateTest as a native tool.
 *
 * Wire format: JSON-RPC 2.0, newline-delimited, over stdin/stdout.
 * Protocol version: 2024-11-05 (current MCP stable).
 *
 * Zero dependencies per Bible: Aggressive Stack → "Zero dependencies, runs
 * anywhere." The MCP transport is hand-rolled stdio.
 *
 * CRITICAL: stdout is the protocol channel. All diagnostics MUST go to
 * stderr. Never console.log() from here.
 */

const path = require('path');
const fs = require('fs');
const { GateTest } = require('../index');
const { GateTestRunner } = require('../core/runner');
const { BUILT_IN_MODULES } = require('../core/registry');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'gatetest';
const SERVER_VERSION = require('../../package.json').version;

// JSON-RPC 2.0 standard error codes
const ERROR_PARSE = -32700;
const ERROR_INVALID_REQUEST = -32600;
const ERROR_METHOD_NOT_FOUND = -32601;
const ERROR_INVALID_PARAMS = -32602;
const ERROR_INTERNAL = -32603;

// ---------------------------------------------------------------------------
// Tool registry — declarative. Each tool is { description, inputSchema, handler }.
// ---------------------------------------------------------------------------

const TOOLS = {
  gatetest_version: {
    description:
      'Returns GateTest version, total module count, and the list of every module name. ' +
      'Use this for capability discovery before calling gatetest_scan.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const moduleNames = Object.keys(BUILT_IN_MODULES);
      return {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        moduleCount: moduleNames.length,
        modules: moduleNames,
      };
    },
  },

  gatetest_list_modules: {
    description:
      'Lists every available GateTest module with its name and a one-line description. ' +
      'Use the returned names with gatetest_scan { modules: [...] }.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      // Instantiate without running anything just to read .name / .description
      const gt = new GateTest(process.cwd()).init();
      const modules = [];
      for (const [name, mod] of gt.registry.getAll()) {
        modules.push({
          name,
          description: mod.description || '',
        });
      }
      return { total: modules.length, modules };
    },
  },

  gatetest_scan: {
    description:
      'Runs a GateTest scan on a local project directory. Either supply a suite name ' +
      '(quick, standard, full) OR an explicit modules array. Returns the full scan summary ' +
      '(gateStatus PASSED/BLOCKED, per-module results, error/warning counts, failed checks). ' +
      'Default suite is "standard" if neither is given.',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: {
          type: 'string',
          description:
            'Absolute path to the project directory to scan. If omitted, the MCP server ' +
            'process CWD is used.',
        },
        suite: {
          type: 'string',
          enum: ['quick', 'standard', 'full'],
          description: 'Which built-in suite to run. Mutually exclusive with `modules`.',
        },
        modules: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Explicit list of module names (from gatetest_list_modules). ' +
            'Mutually exclusive with `suite`.',
        },
      },
      additionalProperties: false,
    },
    handler: async (params) => {
      const projectRoot = params.projectRoot
        ? path.resolve(params.projectRoot)
        : process.cwd();

      if (!fs.existsSync(projectRoot)) {
        throw new Error(`projectRoot does not exist: ${projectRoot}`);
      }

      if (params.suite && params.modules) {
        throw new Error('Pass either `suite` or `modules`, not both.');
      }

      const gt = new GateTest(projectRoot).init();

      // CRITICAL: do NOT use gt._run() — it attaches ConsoleReporter, which
      // writes to stdout and would corrupt the MCP JSON-RPC protocol channel.
      // We build a bare runner with zero reporters so only the summary
      // crosses the wire.
      const runner = new GateTestRunner(gt.config, {});
      for (const [name, mod] of gt.registry.getAll()) {
        runner.register(name, mod);
      }

      const moduleNames =
        params.modules && params.modules.length > 0
          ? params.modules
          : gt.config.getSuite(params.suite || 'standard');

      const summary = await runner.run(moduleNames);
      // The bare runner does not poison process.exitCode (only _run does),
      // but defensively normalise anyway — long-lived server mode must never
      // taint the parent process.
      process.exitCode = 0;
      return summary;
    },
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 framing
// ---------------------------------------------------------------------------

function send(message) {
  // MCP stdio framing: newline-delimited JSON. One message per line.
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResponse(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

function diag(...args) {
  // Diagnostic output goes to stderr to avoid corrupting the protocol channel.
  process.stderr.write('[gatetest-mcp] ' + args.join(' ') + '\n');
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

async function handleInitialize(params) {
  // Client sends its protocol version; we acknowledge ours. MCP spec lets the
  // server pick its own supported version — clients must accept or close.
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
  };
}

async function handleToolsList() {
  return {
    tools: Object.entries(TOOLS).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.inputSchema,
    })),
  };
}

async function handleToolsCall(params) {
  if (!params || typeof params.name !== 'string') {
    const err = new Error('tools/call requires a `name` parameter');
    err.code = ERROR_INVALID_PARAMS;
    throw err;
  }
  const tool = TOOLS[params.name];
  if (!tool) {
    const err = new Error(`Unknown tool: ${params.name}`);
    err.code = ERROR_INVALID_PARAMS;
    throw err;
  }
  const args = params.arguments || {};
  try {
    const result = await tool.handler(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    // Tool errors return isError: true rather than a JSON-RPC error so the
    // client can show the error message to the user and the LLM can react.
    return {
      content: [{ type: 'text', text: `Tool error: ${err.message}` }],
      isError: true,
    };
  }
}

const METHODS = {
  initialize: handleInitialize,
  'tools/list': handleToolsList,
  'tools/call': handleToolsCall,
  ping: async () => ({}),
  shutdown: async () => ({}),
};

// Notifications (no response): just absorb. MCP sends notifications/initialized
// after the initialize handshake completes.
const NOTIFICATIONS = new Set([
  'notifications/initialized',
  'notifications/cancelled',
  'initialized',
]);

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

async function dispatch(message) {
  if (!message || typeof message !== 'object') {
    sendError(null, ERROR_INVALID_REQUEST, 'Request must be a JSON object');
    return;
  }
  if (message.jsonrpc !== '2.0') {
    sendError(
      message.id ?? null,
      ERROR_INVALID_REQUEST,
      'Only JSON-RPC 2.0 is supported',
    );
    return;
  }

  const { id, method, params } = message;

  // Notification — no id, no response.
  if (id === undefined || id === null) {
    if (!NOTIFICATIONS.has(method)) {
      diag('Unknown notification:', method);
    }
    return;
  }

  const handler = METHODS[method];
  if (!handler) {
    sendError(id, ERROR_METHOD_NOT_FOUND, `Method not found: ${method}`);
    return;
  }

  try {
    const result = await handler(params);
    sendResponse(id, result);
  } catch (err) {
    const code = typeof err.code === 'number' ? err.code : ERROR_INTERNAL;
    sendError(id, code, err.message || 'Internal error');
  }
}

// ---------------------------------------------------------------------------
// stdio transport — newline-delimited JSON
// ---------------------------------------------------------------------------

function start(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;

  // Allow tests to swap stdout — the send() function uses process.stdout
  // directly so for testability we provide an override here too.
  if (options.output) {
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      output.write(chunk, ...rest);
      // Still return true so callers don't try to drain.
      return true;
    };
    // Best-effort restore on exit so we don't permanently bork the process.
    process.once('beforeExit', () => {
      process.stdout.write = origWrite;
    });
  }

  let buffer = '';
  input.setEncoding('utf-8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        sendError(null, ERROR_PARSE, `Parse error: ${err.message}`);
        continue;
      }
      // Dispatch asynchronously but don't await — JSON-RPC permits
      // out-of-order responses, and a slow scan must not block other RPCs.
      dispatch(message).catch((err) => {
        diag('Unhandled dispatch error:', err.message);
      });
    }
  });

  input.on('end', () => {
    // stdin closed — client has gone away. Exit cleanly.
    process.exit(0);
  });

  // Never let an uncaught exception kill the server silently. Log to stderr
  // and keep serving.
  process.on('uncaughtException', (err) => {
    diag('uncaughtException:', err.stack || err.message);
  });
  process.on('unhandledRejection', (reason) => {
    diag('unhandledRejection:', String(reason));
  });

  diag(`server ready — protocol ${PROTOCOL_VERSION}, version ${SERVER_VERSION}`);
}

module.exports = {
  start,
  dispatch,
  TOOLS,
  METHODS,
  PROTOCOL_VERSION,
  SERVER_VERSION,
  SERVER_NAME,
  // Exported for tests
  _internals: { ERROR_PARSE, ERROR_INVALID_REQUEST, ERROR_METHOD_NOT_FOUND, ERROR_INVALID_PARAMS, ERROR_INTERNAL },
};
