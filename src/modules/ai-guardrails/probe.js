/**
 * AI Guardrails — HTTP probe.
 *
 * Sends a single scenario's prompt to the customer's LLM endpoint and extracts
 * the model's text response. Network-level: timeout + abort, classified errors,
 * no retries (a flaky guardrail test isn't worth re-running automatically).
 *
 * Customer config shape (one of):
 *   {
 *     endpoint: "https://api.example.com/v1/chat",
 *     method: "POST",                                 // default
 *     headers: { Authorization: "Bearer ${TOKEN}" },  // ${VAR} expanded from env
 *     requestTemplate: { messages: [{ role: "user", content: "${prompt}" }] },
 *     responsePath: "choices.0.message.content",      // dotted path; numbers = array index
 *     timeoutMs: 20000,                                // default 20s
 *   }
 *
 * No node_modules deps — uses the built-in fetch (Node 18+).
 */

'use strict';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1_000_000; // 1MB hard cap so a runaway model can't OOM the runner

// Expand ${VAR} references in strings (headers + auth tokens) against process.env.
// Anything not in the env stays as-is so the customer sees the literal in the failure.
function expandEnv(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\$\{([A-Z0-9_]+)\}/g, (m, name) => {
    const v = process.env[name];
    return typeof v === 'string' ? v : m;
  });
}

function expandHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const k of Object.keys(headers)) {
    out[k] = expandEnv(headers[k]);
  }
  return out;
}

// Substitute ${prompt} placeholder in the request template tree.
function substitutePrompt(template, promptText) {
  if (typeof template === 'string') {
    return template.replace(/\$\{prompt\}/g, promptText);
  }
  if (Array.isArray(template)) {
    return template.map((v) => substitutePrompt(v, promptText));
  }
  if (template && typeof template === 'object') {
    const out = {};
    for (const k of Object.keys(template)) {
      out[k] = substitutePrompt(template[k], promptText);
    }
    return out;
  }
  return template;
}

// Pluck a value from `obj` by a dotted path. Numeric segments index arrays.
function pluckByPath(obj, path) {
  if (!path || typeof path !== 'string') return null;
  const segments = path.split('.');
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur)) {
      const idx = parseInt(seg, 10);
      if (Number.isNaN(idx)) return null;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = cur[seg];
    } else {
      return null;
    }
  }
  return cur;
}

async function readResponseTextCapped(response) {
  // Stream the response body to a byte-capped buffer so a runaway response
  // (cost-control attacks!) can't blow the runner.
  const reader = response.body && typeof response.body.getReader === 'function'
    ? response.body.getReader()
    : null;
  if (!reader) {
    const txt = await response.text();
    return txt.length > MAX_RESPONSE_BYTES ? txt.slice(0, MAX_RESPONSE_BYTES) : txt;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      chunks.push(value);
      if (total >= MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* probe-cleanup-ok */ }
        break;
      }
    }
  }
  const joined = new Uint8Array(total > MAX_RESPONSE_BYTES ? MAX_RESPONSE_BYTES : total);
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, joined.length - offset);
    joined.set(c.subarray ? c.subarray(0, take) : c.slice(0, take), offset);
    offset += take;
    if (offset >= joined.length) break;
  }
  return Buffer.from(joined).toString('utf8');
}

/**
 * Run a single scenario against the customer's LLM endpoint.
 * Returns { ok, status, responseText, responseRaw, errorCode, durationMs }.
 * Never throws — every failure path becomes a classified result.
 */
async function probe(scenario, customerConfig) {
  const start = Date.now();
  const endpoint = customerConfig && customerConfig.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return {
      ok: false,
      status: 0,
      responseText: null,
      responseRaw: null,
      errorCode: 'no-endpoint',
      durationMs: 0,
    };
  }

  const method = (customerConfig.method || 'POST').toUpperCase();
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'GateTest-AIGuardrails/1.0',
    // Each scenario is a discrete one-shot probe (often to a different
    // endpoint), so connection pooling buys nothing here — and an idle
    // keep-alive socket left in undici's pool trips a libuv async-handle
    // assertion on Windows when the test runner force-exits mid-teardown.
    // Close the socket after each probe so nothing lingers.
    Connection: 'close',
    ...expandHeaders(customerConfig.headers || {}),
  };
  const template = customerConfig.requestTemplate || {
    messages: [{ role: 'user', content: '${prompt}' }],
  };
  const body = JSON.stringify(substitutePrompt(template, scenario.prompt));
  const timeoutMs = Number.isFinite(customerConfig.timeoutMs) && customerConfig.timeoutMs > 0
    ? customerConfig.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    return {
      ok: false,
      status: 0,
      responseText: null,
      responseRaw: null,
      errorCode: aborted ? 'timeout' : 'network-error',
      errorMessage: err && err.message ? String(err.message).slice(0, 500) : null,
      durationMs: Date.now() - start,
    };
  }
  clearTimeout(timer);

  let raw;
  try {
    raw = await readResponseTextCapped(response);
  } catch (err) {
    return {
      ok: false,
      status: response.status,
      responseText: null,
      responseRaw: null,
      errorCode: 'response-read-error',
      errorMessage: err && err.message ? String(err.message).slice(0, 500) : null,
      durationMs: Date.now() - start,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      responseText: null,
      responseRaw: raw,
      errorCode: 'http-error',
      durationMs: Date.now() - start,
    };
  }

  // Extract the model text via the configured path.
  const responsePath = customerConfig.responsePath || 'choices.0.message.content';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Endpoint returned non-JSON (could be plain-text completion). Treat the
    // whole body as the response text.
    return {
      ok: true,
      status: response.status,
      responseText: raw,
      responseRaw: raw,
      errorCode: null,
      durationMs: Date.now() - start,
    };
  }
  const text = pluckByPath(parsed, responsePath);
  if (typeof text !== 'string') {
    return {
      ok: false,
      status: response.status,
      responseText: null,
      responseRaw: raw,
      errorCode: 'response-path-miss',
      errorMessage: `Path "${responsePath}" did not resolve to a string`,
      durationMs: Date.now() - start,
    };
  }
  return {
    ok: true,
    status: response.status,
    responseText: text,
    responseRaw: raw,
    errorCode: null,
    durationMs: Date.now() - start,
  };
}

module.exports = {
  probe,
  // Internal helpers for unit testing only.
  __test__: {
    expandEnv,
    expandHeaders,
    substitutePrompt,
    pluckByPath,
  },
};
