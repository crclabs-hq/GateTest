'use strict';
/**
 * Python route registrations and their auth signals — ONE definition
 * (issue #842, DR-4).
 *
 * authBypass graded only JavaScript. On an SPA + API repo that is the wrong
 * half: DavenRoe's endpoints are FastAPI (`@router.get("/transactions/")`)
 * guarded by dependency injection — `user: User = Depends(get_current_user)`
 * on the endpoint, `APIRouter(dependencies=[Depends(...)])` on the router,
 * or `app.include_router(transactions.router, dependencies=[Depends(...)])`
 * in backend/main.py. This module recognises the registration grammar of
 * FastAPI / Starlette and Flask-style blueprints, and the three places the
 * auth check can live, so the rule grades the server and never the client.
 *
 * A file is a Python route file only when it IMPORTS a web framework — a
 * `@router.get` on a class named `router` in an unrelated library is not a
 * route.
 */

const PY_FRAMEWORK_IMPORT_RE =
  /^[ \t]*(?:from\s+(?:fastapi|flask|starlette|sanic|quart|blacksheep|litestar)\b|import\s+(?:fastapi|flask|starlette|sanic|quart|litestar)\b)/m;

// `@router.get("/x")`, `@app.post('/x', response_model=…)`,
// `@bp.route("/x", methods=["POST"])`, `@api.api_route(path="/x")`.
const PY_ROUTE_DECORATOR_RE =
  /^[ \t]*@([A-Za-z_][\w.]*)\.(get|post|put|patch|delete|head|options|route|api_route|websocket)\s*\(\s*(?:path\s*=\s*)?(['"])([^'"\n]*)\3/gm;

const PY_DEF_RE = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;

// Auth expressed through a dependency, a security scheme or a guard
// decorator, read over the decorator stack + the signature.
const PY_AUTH_RE = new RegExp(
  [
    // Depends(get_current_user) / Depends(require_active_subscription) /
    // Depends(verify_token) / Depends(auth.authenticate) / Security(...)
    '\\bDepends\\s*\\(\\s*(?:[\\w.]*\\.)?(?:get_current_\\w*|current_\\w*|require\\w*|verify\\w*|validate\\w*|\\w*auth\\w*|\\w*user\\w*|\\w*admin\\w*|\\w*jwt\\w*|\\w*token\\w*|\\w*session\\w*|\\w*permission\\w*|\\w*login\\w*|\\w*api_?key\\w*|\\w*security\\w*|\\w*scope\\w*|\\w*role\\w*|\\w*principal\\w*|\\w*identity\\w*|has_\\w+|check_\\w+|ensure_\\w+|is_\\w+)\\b',
    '\\bSecurity\\s*\\(',
    // Flask / Quart / Sanic style guard decorators.
    '@(?:[\\w.]+\\.)?(?:login_required|jwt_required|auth_required|requires_auth|authenticated|permission_required|roles_required|roles_accepted|admin_required|require_\\w+|requires_\\w+|verify_\\w+|token_required|api_key_required|protected|authorize[d]?|auth)\\b',
  ].join('|'),
);

// Auth the HANDLER enforces itself: a 401/403, a session/user read, a token
// verification, an API-key or signature comparison.
const PY_BODY_AUTH_RE =
  /\b(?:current_user|get_jwt_identity|verify_jwt_in_request|request\.user|request\.state\.user|g\.user|session\s*\[|login_required|HTTPException\s*\([^)]*40[13]|status_code\s*=\s*40[13]\b|HTTP_40[13]_|abort\s*\(\s*40[13]\b|Unauthorized|Forbidden|PermissionDenied|verify_token|decode_token|verify_signature|hmac\.compare_digest|compare_digest|api_key|x-api-key|Authorization|Bearer)\b/i;

const { stripPythonStringsAndComments } = require('./source-strip');

const SUPPRESS_RE = /#\s*(?:auth-public|no-auth)\b/;

// The handler DECLARES itself public: `async def ask_daven_public(...)`,
// `def public_contact(...)`, or a docstring that opens with "Public ..." or
// says "no login" / "no auth" / "unauthenticated" / "anonymous". A route
// that is public on purpose and says so is not a missing check.
const PUBLIC_NAME_RE = /public|anonymous|unauthenticated/i;
const PUBLIC_DOCSTRING_RE = /^\s*public\b|\b(?:no|without)\s+(?:login|auth(?:entication)?)\b|\bunauthenticated\b|\banonymous\b/i;
// Anywhere in the docstring, only the explicit form: "No authentication
// required." (DavenRoe support.py `/waitlist`, `/articles`). Not a bare
// "without authentication", which also opens "without authentication it 401s".
const PUBLIC_ANYWHERE_RE = /\b(?:no|without)\s+(?:login|auth(?:entication)?)\s+(?:is\s+)?(?:required|needed)\b|\(\s*no\s+(?:login|auth)\s*\)/i;
// The first triple-quoted block that opens a line of the body. Not anchored
// at the body's start: a signature split over several lines (`q: str =
// Query(...),` one per line) sits in the body text ahead of the docstring.
const DOCSTRING_RE = /(?:^|\n)[ \t]*(?:"""|''')([\s\S]*?)(?:"""|'''|$)/;

// A handler that serves files — the SPA fallback `GET /{path:path}` returning
// index.html, `send_from_directory(...)` — is a static file server, public
// by construction.
const STATIC_SERVER_RE = /\b(?:FileResponse|send_from_directory|send_file|StaticFiles)\s*\(|\bindex\.html\b/;

function isPythonRouteFile(content) {
  if (typeof content !== 'string' || !PY_FRAMEWORK_IMPORT_RE.test(content)) return false;
  PY_ROUTE_DECORATOR_RE.lastIndex = 0;
  const hit = PY_ROUTE_DECORATOR_RE.test(content);
  PY_ROUTE_DECORATOR_RE.lastIndex = 0;
  return hit;
}

// Parens are balanced on the MASKED text — strings and comments blanked,
// offsets kept (src/core/source-strip.js, the one stripper; doctrine #4) —
// and the argument text is sliced from the raw source at the same offsets.
let lastText = null;
let lastMask = null;
function maskOf(text) {
  if (text !== lastText) { lastText = text; lastMask = stripPythonStringsAndComments(text); }
  return lastMask;
}

/** Balanced `(...)` starting at the first `(` at or after `from`. */
function balancedParens(text, from) {
  const code = maskOf(text);
  const open = code.indexOf('(', from);
  if (open === -1) return { text: '', end: -1 };
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return { text: text.slice(open + 1, i), end: i + 1 };
  }
  return { text: text.slice(open + 1), end: text.length };
}

/** The `prefix="/x"` of the first APIRouter / Blueprint in the file, or ''. */
function routerPrefix(content) {
  const m = content.match(/\b(?:APIRouter|Blueprint)\s*\(([\s\S]{0,400}?)\)\s*$/m)
    || content.match(/\b(?:APIRouter|Blueprint)\s*\(([\s\S]{0,400}?)\)/);
  if (!m) return '';
  const p = m[1].match(/\b(?:url_)?prefix\s*=\s*(['"])([^'"]*)\1/);
  return p ? p[2] : '';
}

/**
 * Router-level protection inside the file: `APIRouter(dependencies=[Depends(
 * get_current_user)])`, or a `@bp.before_request` guard that reads the user /
 * aborts 401.
 */
function pythonRouterProtected(content) {
  const routerCtor = content.match(/\b(?:APIRouter|Blueprint)\s*\(/);
  if (routerCtor) {
    const args = balancedParens(content, routerCtor.index).text;
    if (/\bdependencies\s*=/.test(args) && PY_AUTH_RE.test(args)) return true;
  }
  const lines = content.split(/\r?\n/);
  const guardLine = lines.findIndex((l) => /^[ \t]*@[\w.]+\.before_request\b/.test(l));
  if (guardLine !== -1) {
    for (let i = guardLine + 1; i < Math.min(lines.length, guardLine + 10); i++) {
      if (PY_DEF_RE.test(lines[i])) return PY_BODY_AUTH_RE.test(functionBody(lines, i));
    }
  }
  return false;
}

/** Lines of the function whose `def` sits on `defLine` (0-indexed). */
// `from` is the first line after the signature: a parameter list closed by
// `):` at the def's own indent must not end the body before it starts.
function functionBody(lines, defLine, cap = 400, from = defLine + 1) {
  const defIndent = (lines[defLine].match(/^[ \t]*/) || [''])[0].length;
  const out = [];
  for (let i = from; i < lines.length && out.length < cap; i++) {
    const line = lines[i];
    if (line.trim() === '') { out.push(line); continue; }
    const indent = (line.match(/^[ \t]*/) || [''])[0].length;
    if (indent <= defIndent) break;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Every route registered in `content`.
 * @returns {Array<{method:string, route:string, line:number, protectedBy:string|null, suppressed:boolean}>}
 */
function findPythonRoutes(content) {
  const routes = [];
  if (!isPythonRouteFile(content)) return routes;
  const lines = content.split(/\r?\n/);
  const prefix = routerPrefix(content);
  const routerGuarded = pythonRouterProtected(content);

  PY_ROUTE_DECORATOR_RE.lastIndex = 0;
  let m;
  while ((m = PY_ROUTE_DECORATOR_RE.exec(content)) !== null) {
    const [, , verb, , rawPath] = m;
    const decoLine = content.slice(0, m.index).split(/\r?\n/).length - 1; // 0-indexed
    // A decorator quoted in a docstring is not a registration: the line
    // must not be inside a triple-quoted block opened earlier.
    const tripleQuotesBefore = (content.slice(0, m.index).match(/"""|'''/g) || []).length;
    if (tripleQuotesBefore % 2 === 1) continue;

    // The decorator call itself (may span lines) + every decorator after it,
    // up to the def.
    const { text: decoArgs, end: decoEnd } = balancedParens(content, m.index);
    let defLine = -1;
    const afterDeco = content.slice(0, decoEnd).split(/\r?\n/).length - 1;
    for (let i = afterDeco; i < Math.min(lines.length, afterDeco + 30); i++) {
      if (PY_DEF_RE.test(lines[i])) { defLine = i; break; }
    }
    if (defLine === -1) continue;
    const decoStack = lines.slice(decoLine, defLine).join('\n');
    // The parameter list may span lines (`user: User = Depends(...)` on its
    // own line); read it from the def onward, parens balanced.
    const defText = lines.slice(defLine, defLine + 40).join('\n');
    const sig = balancedParens(defText, defText.indexOf('def'));
    const signature = sig.text;
    const sigLines = sig.end === -1 ? 0 : defText.slice(0, sig.end).split('\n').length - 1;
    const body = functionBody(lines, defLine, 400, defLine + sigLines + 1);

    let method = verb.toUpperCase();
    if (verb === 'route' || verb === 'api_route') {
      const methods = decoArgs.match(/\bmethods\s*=\s*[[(]([^\])]*)[\])]/);
      method = methods ? (methods[1].match(/['"](\w+)['"]/) || [null, 'GET'])[1].toUpperCase() : 'GET';
    }
    const route = `${prefix}${rawPath}`.replace(/\/{2,}/g, '/') || '/';

    const above = [];
    for (let i = decoLine - 1; i >= 0 && /^\s*#/.test(lines[i]); i--) above.push(lines[i]);
    const suppressed = SUPPRESS_RE.test(lines[decoLine]) || SUPPRESS_RE.test(above.join('\n'));

    const defName = (lines[defLine].match(PY_DEF_RE) || [])[2] || '';
    const docstring = (body.match(DOCSTRING_RE) || [])[1] || '';
    const firstSentence = docstring.trim().split(/\.\s|\n/)[0] || '';

    let protectedBy = null;
    if (routerGuarded) protectedBy = 'router';
    else if (PY_AUTH_RE.test(decoStack) || PY_AUTH_RE.test(signature)) protectedBy = 'dependency';
    else if (PY_BODY_AUTH_RE.test(body)) protectedBy = 'handler';
    else if (PUBLIC_NAME_RE.test(defName) || PUBLIC_DOCSTRING_RE.test(firstSentence) || PUBLIC_ANYWHERE_RE.test(docstring)) protectedBy = 'declared-public';
    else if (STATIC_SERVER_RE.test(body)) protectedBy = 'static-server';

    routes.push({ method, route, line: decoLine + 1, protectedBy, suppressed });
  }
  PY_ROUTE_DECORATOR_RE.lastIndex = 0;
  return routes;
}

/**
 * Routers protected at the APP level — `app.include_router(x.router,
 * dependencies=[Depends(get_current_user)])`, including the `**PAID`
 * kwargs-dict idiom (`PAID = {"dependencies": [Depends(...)]}`). Returns the
 * module STEMS (`transactions` for `transactions.router`, or the module a
 * bare `router` alias was imported from) so a route file is matched by its
 * basename.
 *
 * @param {Array<{content:string}>} pyFiles
 * @returns {Set<string>}
 */
function appLevelProtectedRouters(pyFiles) {
  const stems = new Set();
  for (const { content } of pyFiles) {
    if (typeof content !== 'string' || !content.includes('include_router')) continue;
    // Auth kwargs dicts: PAID = {"dependencies": [Depends(require_x)]}
    const authKwargs = new Set();
    const dictRe = /\b([A-Za-z_]\w*)\s*=\s*\{([^}]*)\}/g;
    let d;
    while ((d = dictRe.exec(content)) !== null) {
      if (/['"]dependencies['"]/.test(d[2]) && PY_AUTH_RE.test(d[2])) authKwargs.add(d[1]);
    }
    const incRe = /\.include_router\s*\(/g;
    let m;
    while ((m = incRe.exec(content)) !== null) {
      const args = balancedParens(content, m.index).text;
      const guarded = (/\bdependencies\s*=/.test(args) && PY_AUTH_RE.test(args))
        || [...args.matchAll(/\*\*([A-Za-z_]\w*)/g)].some((k) => authKwargs.has(k[1]));
      if (!guarded) continue;
      const first = args.split(',')[0].trim();
      const dotted = first.match(/^([\w.]+)\.router$/);
      if (dotted) { stems.add(dotted[1].split('.').pop()); continue; }
      if (/^[A-Za-z_]\w*$/.test(first)) {
        const fromImport = content.match(new RegExp(`from\\s+([\\w.]+)\\s+import\\s+(?:[^\\n]*\\brouter\\s+as\\s+${first}\\b|${first}\\b)`));
        if (fromImport) stems.add(fromImport[1].split('.').pop());
      }
    }
  }
  return stems;
}

module.exports = {
  PY_FRAMEWORK_IMPORT_RE,
  PY_ROUTE_DECORATOR_RE,
  PY_AUTH_RE,
  PY_BODY_AUTH_RE,
  isPythonRouteFile,
  findPythonRoutes,
  pythonRouterProtected,
  appLevelProtectedRouters,
};
