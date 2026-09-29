'use strict';
/**
 * Is `<receiver>.<verb>('/path', …)` an HTTP CLIENT call or a ROUTE
 * registration? ONE definition (issue #842, DR-4).
 *
 * The route grammar in src/modules/auth-bypass.js reads
 * `api.post('/support/tickets', body)` exactly as it reads
 * `app.post('/support/tickets', handler)` — the receiver `api` is on its
 * list because Express apps are routinely called `api`. On DavenRoe
 * (ccantynz-alt/davenroe.com @ 1dea3658) every one of the module's 73 errors
 * was a frontend axios call: `const api = axios.create(…)` in
 * frontend/src/services/api.js, then `await api.get('/transactions/')` in
 * 70 page components. Client code cannot protect a route; it can only ask
 * one. Reporting the ASK as an unprotected endpoint says "you shipped an
 * endpoint with no auth" about code that ships no endpoint.
 *
 * Three signals, any one of which makes the call a consumer, never a route:
 *
 *   1. The receiver is BOUND to an HTTP client in this file —
 *      `const api = axios.create(…)`, `= ky.extend(…)`, `= got.extend(…)`,
 *      `= wretch(…)`, `= new Axios(…)`, or imported/required from a module
 *      whose basename is a client name (`services/api`, `lib/http-client`,
 *      `apiClient`).
 *   2. The file imports an HTTP client library (axios / ky / got /
 *      superagent / wretch / ofetch / node-fetch) and NO server framework
 *      (express / fastify / hono / koa / hapi / restify / polka / itty /
 *      next/server). A file that only knows how to send requests cannot
 *      register a route.
 *   3. The call's VALUE is consumed — `await api.get(…)`, `const r =
 *      api.post(…)`, `return api.get(…)`, `() => api.post(…)`, an argument
 *      or array element, or a `.then(` / `.catch(` chained after it. A
 *      route registration is a statement: nothing awaits `app.get(…)`.
 *
 * Positive control (must still be a route): `app.get('/admin', handler)` at
 * statement level in a file that imports express — none of the three fire.
 * See tests/auth-bypass-http-client.test.js.
 */

const HTTP_CLIENT_LIBS = ['axios', 'ky', 'got', 'superagent', 'wretch', 'ofetch', 'node-fetch', 'cross-fetch', 'redaxios', '@tanstack/query-core'];
const SERVER_FRAMEWORKS = ['express', 'fastify', 'hono', 'koa', '@koa/router', 'koa-router', '@hapi/hapi', 'restify', 'polka', 'itty-router', 'next/server', 'h3', 'elysia', '@nestjs/common'];

const IMPORT_FROM_RE = /(?:from\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

// Basenames (extension stripped) that name an HTTP client module.
const CLIENT_MODULE_BASENAME_RE = /^(?:api|api[-_.]?client|apiclient|http|http[-_.]?client|httpclient|client|fetch|fetcher|axios|request|ky|got)$/i;

// `= axios.create(`, `= ky.extend(`, `= got(`, `= new Axios(`, `= wretch(`
const CLIENT_FACTORY_RE = /(?:axios|ky|got|wretch|ofetch|superagent|redaxios|\$fetch)(?:\s*\.\s*(?:create|extend|default))?\s*\(|new\s+Axios\s*\(|axios\s*$/;

function importedSpecifiers(content) {
  const out = [];
  let m;
  IMPORT_FROM_RE.lastIndex = 0;
  while ((m = IMPORT_FROM_RE.exec(content)) !== null) out.push(m[1] || m[2]);
  return out;
}

function packageOf(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

/** Signal 2 — the file imports a client library and no server framework. */
function fileIsPureHttpClient(content) {
  const specs = importedSpecifiers(content);
  if (specs.length === 0) return false;
  let client = false;
  for (const spec of specs) {
    const pkg = packageOf(spec);
    if (SERVER_FRAMEWORKS.includes(pkg) || SERVER_FRAMEWORKS.includes(spec)) return false;
    if (HTTP_CLIENT_LIBS.includes(pkg)) client = true;
  }
  return client;
}

/** Signal 1 — `receiver` is bound to an HTTP client in this file. */
function receiverIsHttpClient(content, receiver) {
  if (!receiver) return false;
  const id = receiver.replace(/[$]/g, '\\$');
  // const api = axios.create({ … }) / = ky.extend(…) / = new Axios(…)
  const bound = new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*(?::[^=]+)?=\\s*([^;\\n]{0,80})`, 'g');
  let m;
  while ((m = bound.exec(content)) !== null) {
    if (CLIENT_FACTORY_RE.test(m[1])) return true;
  }
  // import api from '../services/api' / import { api } from '@/lib/http-client'
  // / const api = require('./api-client')
  const importRe = new RegExp(
    `import\\s+(?:${id}|\\{[^}]*\\b${id}\\b[^}]*\\}|\\*\\s+as\\s+${id})\\s+from\\s*['"]([^'"]+)['"]` +
    `|(?:const|let|var)\\s+(?:${id}|\\{[^}]*\\b${id}\\b[^}]*\\})\\s*=\\s*require\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)`,
    'g',
  );
  while ((m = importRe.exec(content)) !== null) {
    const spec = m[1] || m[2];
    const pkg = packageOf(spec);
    if (HTTP_CLIENT_LIBS.includes(pkg)) return true;
    const base = spec.split('/').pop().replace(/\.[cm]?[jt]sx?$/, '');
    if (CLIENT_MODULE_BASENAME_RE.test(base)) return true;
  }
  return false;
}

/**
 * Signal 3 — the call expression's value is used. `before` is the code
 * immediately preceding the receiver; `after` the code immediately following
 * the closing paren. Both are read from MASKED source (strings/comments
 * blanked) so a quoted `await` cannot count.
 */
function callValueIsConsumed(maskedBefore, maskedAfter) {
  const lead = maskedBefore.replace(/\s+$/, '');
  if (/(?:\bawait|\breturn|\byield|=>|[=:(,[?]|\|\||&&)$/.test(lead) && !/[!=<>]=$/.test(lead.slice(-2))) return true;
  return /^\s*\.\s*(?:then|catch|finally|json|data)\b/.test(maskedAfter);
}

/**
 * @param {object} args
 * @param {string} args.content    raw file text
 * @param {string} args.masked     the same text with strings/comments blanked
 *                                 (src/core/source-strip.js), offsets preserved
 * @param {string} args.receiver   the identifier before `.get(` / `.post(`
 * @param {number} args.start      offset of the receiver in `content`
 * @param {number} args.end        offset just past the call's closing paren,
 *                                 or -1 when unknown
 * @returns {boolean} true when the call is a consumer of an HTTP API, never a
 *                    route registration
 */
function isHttpClientCall({ content, masked, receiver, start, end }) {
  if (typeof content !== 'string') return false;
  if (receiverIsHttpClient(content, receiver)) return true;
  if (fileIsPureHttpClient(content)) return true;
  const src = typeof masked === 'string' ? masked : content;
  const before = src.slice(Math.max(0, start - 40), start);
  const after = end >= 0 ? src.slice(end, end + 20) : '';
  return callValueIsConsumed(before, after);
}

module.exports = {
  isHttpClientCall,
  receiverIsHttpClient,
  fileIsPureHttpClient,
  callValueIsConsumed,
  HTTP_CLIENT_LIBS,
  SERVER_FRAMEWORKS,
};
