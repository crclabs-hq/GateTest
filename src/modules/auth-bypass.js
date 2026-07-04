/**
 * Auth Bypass Detector — finds routes that are missing authentication.
 *
 * Scans Express / Next.js App Router / Fastify route handlers for HTTP
 * endpoints that never call an auth middleware or check a session/token.
 *
 * Detection strategy:
 *   1. Collect all route-defining files.
 *   2. For each handler function body, check for at least one auth signal.
 *   3. Flag handlers with no auth signal at all (unless the file or route
 *      is explicitly marked public).
 *
 * Auth signals recognised:
 *   - Middleware names: isAuthenticated, requireAuth, withAuth, authenticate,
 *     verifyToken, checkAuth, authMiddleware, protect, ensureLoggedIn,
 *     isLoggedIn, requireLogin, verifySession, validateToken, jwtAuth,
 *     isAdmin, requireRole, hasPermission
 *   - Session / JWT reads: req.session, req.user, req.auth,
 *     getServerSession, getSession, auth(), currentUser(), verifyJwt
 *   - Clerk / NextAuth / Supabase: clerkMiddleware, withClerkMiddleware,
 *     getAuth, useAuth, createServerComponentClient, createRouteHandlerClient
 *
 * Public-route suppression: comment `// auth-public` or `// no-auth` on
 * the handler line suppresses the warning. Files named `public/`, `health`,
 * `webhook`, or `callback` are skipped entirely.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');

// ─── auth signal patterns ──────────────────────────────────────────────────

const AUTH_MIDDLEWARE = [
  'isAuthenticated', 'requireAuth', 'withAuth', 'authenticate',
  'verifyToken', 'checkAuth', 'authMiddleware', 'protect', 'ensureLoggedIn',
  'isLoggedIn', 'requireLogin', 'verifySession', 'validateToken', 'jwtAuth',
  'isAdmin', 'requireRole', 'hasPermission', 'authorize', 'authorized',
  'mustBeLoggedIn', 'requireUser', 'withSession', 'sessionRequired',
  'clerkMiddleware', 'withClerkMiddleware', 'requireAuthentication',
];

const AUTH_READS = [
  'req\\.session', 'req\\.user', 'req\\.auth', 'request\\.user',
  'getServerSession', 'getSession\\(', 'currentUser\\(', 'verifyJwt',
  'getAuth\\(', 'auth\\(\\)', 'useAuth\\(', 'createServerComponentClient',
  'createRouteHandlerClient', 'createClient\\(', 'supabaseClient',
  'jwt\\.verify', 'jsonwebtoken', 'Bearer ', 'Authorization',
  'headers\\.authorization', 'headers\\.get\\([\'"]authorization',
  'context\\.user', 'ctx\\.user', 'ctx\\.state\\.user',
];

const AUTH_SIGNAL_RE = new RegExp(
  [
    ...AUTH_MIDDLEWARE.map(m => `\\b${m}\\b`),
    ...AUTH_READS,
  ].join('|')
);

// ─── route detection patterns ──────────────────────────────────────────────

// Express: app.get/post/put/patch/delete/all
const EXPRESS_ROUTE_RE = /(?:app|router)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`,]+)['"`]/g;

// Next.js App Router: exported async function GET/POST/PUT/PATCH/DELETE
const NEXTJS_EXPORT_RE = /^export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|ALL)\s*\(/gm;

// Fastify: fastify.get/post etc.
const FASTIFY_ROUTE_RE = /fastify\s*\.\s*(get|post|put|patch|delete|route)\s*\(\s*['"`]([^'"`,]+)['"`]/g;

// Hono: app.get/post etc.
const HONO_ROUTE_RE = /(?:app|router|hono)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`,]+)['"`]/g;

// Koa Router
const KOA_ROUTE_RE = /router\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`,]+)['"`]/g;

// ─── helpers ───────────────────────────────────────────────────────────────

const PUBLIC_ROUTE_KEYWORDS = [
  '/health', '/healthz', '/ping', '/status', '/metrics',
  '/webhook', '/callback', '/oauth', '/auth/callback',
  '/public/', '/static/', '/assets/', '/favicon',
  '/login', '/signup', '/register', '/logout',
  '/verify-email', '/reset-password', '/forgot-password',
];

function isPublicRoute(routePath) {
  return PUBLIC_ROUTE_KEYWORDS.some(kw => routePath.toLowerCase().includes(kw));
}

function isPublicFile(relPath) {
  const lower = relPath.toLowerCase();
  return (
    lower.includes('public/') ||
    lower.includes('/health') ||
    lower.includes('/webhook') ||
    lower.includes('/callback') ||
    lower.includes('/auth/') ||
    lower.includes('middleware') ||
    lower.includes('login') ||
    lower.includes('logout') ||
    lower.includes('signup') ||
    lower.includes('register') ||
    lower.includes('test') ||
    lower.includes('spec') ||
    lower.includes('.test.') ||
    lower.includes('.spec.')
  );
}

function extractHandlerBody(content, matchIndex) {
  // Walk forward from the match to find the handler function body
  let depth = 0;
  let start = -1;
  for (let i = matchIndex; i < content.length; i++) {
    if (content[i] === '{') {
      if (start === -1) start = i;
      depth++;
    } else if (content[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return content.slice(start, i + 1);
      }
    }
  }
  // Fallback: return 300 chars after the match
  return content.slice(matchIndex, matchIndex + 300);
}

// ─── module ────────────────────────────────────────────────────────────────

class AuthBypassDetector extends BaseModule {
  constructor() {
    super('authBypass', 'Auth Bypass Detector — routes missing authentication');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const extensions  = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];
    const files = this._collectFiles(projectRoot, extensions);

    let routeFiles  = 0;
    let unprotected = 0;

    for (const file of files) {
      const rel = path.relative(projectRoot, file);
      if (isPublicFile(rel)) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      // Skip files with no route definitions
      const hasRoutes = (
        EXPRESS_ROUTE_RE.test(content) ||
        NEXTJS_EXPORT_RE.test(content) ||
        FASTIFY_ROUTE_RE.test(content) ||
        HONO_ROUTE_RE.test(content) ||
        KOA_ROUTE_RE.test(content)
      );

      // Reset lastIndex after test()
      EXPRESS_ROUTE_RE.lastIndex  = 0;
      NEXTJS_EXPORT_RE.lastIndex  = 0;
      FASTIFY_ROUTE_RE.lastIndex  = 0;
      HONO_ROUTE_RE.lastIndex     = 0;
      KOA_ROUTE_RE.lastIndex      = 0;

      if (!hasRoutes) continue;
      routeFiles++;

      const lines = content.split('\n');
      const issues = this._findUnauthenticatedRoutes(file, rel, content, lines);

      if (issues.length === 0) continue;
      unprotected += issues.length;

      // Group all unprotected routes in this file into ONE finding to avoid
      // 252-finding spam when a whole router file lacks auth middleware.
      const routeList = issues
        .slice(0, 10)
        .map((i) => `\`${i.method.toUpperCase()} ${i.route}\` (line ${i.line})`)
        .join(', ');
      const extra = issues.length > 10 ? ` + ${issues.length - 10} more` : '';
      result.addCheck(`auth-bypass:${rel}`, false, {
        severity: 'error',
        message: `${issues.length} unprotected route${issues.length !== 1 ? 's' : ''} in \`${rel}\`: ${routeList}${extra}`,
        file: rel,
        line: issues[0].line,
        details: issues.map((i) => ({ method: i.method.toUpperCase(), route: i.route, line: i.line })),
        fix: `Add authentication middleware at the router level (e.g. \`router.use(requireAuth)\`) or add \`getServerSession()\` / \`req.user\` checks to each handler. Mark intentionally public routes with \`// auth-public\`.`,
        autoFix: makeAutoFix(
          file,
          'auth-bypass',
          `${issues.length} routes in ${rel} have no authentication check`,
          issues[0].line,
          `Add requireAuth middleware or session check to routes in ${rel}`
        ),
      });
    }

    if (routeFiles === 0) {
      result.addCheck('auth-bypass:no-routes', true, {
        severity: 'info',
        message: 'No route files found — auth bypass check skipped',
      });
      return;
    }

    if (unprotected === 0) {
      result.addCheck('auth-bypass:all-protected', true, {
        severity: 'info',
        message: `All ${routeFiles} route file(s) have authentication`,
      });
    }
  }

  _findUnauthenticatedRoutes(file, rel, content, lines) {
    const issues = [];

    // Check Next.js App Router exports first (method-level granularity)
    if (file.includes('/api/') || file.endsWith('route.ts') || file.endsWith('route.js')) {
      let m;
      NEXTJS_EXPORT_RE.lastIndex = 0;
      while ((m = NEXTJS_EXPORT_RE.exec(content)) !== null) {
        const method = m[1];
        const matchIdx = m.index;
        const lineNo   = content.slice(0, matchIdx).split('\n').length;
        const lineText = lines[lineNo - 1] || '';

        if (lineText.includes('// auth-public') || lineText.includes('// no-auth')) continue;

        // Check previous 5 lines for suppression
        const context5 = lines.slice(Math.max(0, lineNo - 6), lineNo).join('\n');
        if (context5.includes('// auth-public') || context5.includes('// no-auth')) continue;

        const body = extractHandlerBody(content, matchIdx);
        if (AUTH_SIGNAL_RE.test(body)) continue;

        // Derive route from file path
        const routePath = rel
          .replace(/\\/g, '/')
          .replace(/^app/, '')
          .replace(/\/route\.(ts|js|tsx|jsx)$/, '')
          .replace(/\/\(.*?\)/g, '') // remove Next.js route groups
          || '/';

        if (isPublicRoute(routePath)) continue;

        issues.push({ method, route: routePath, line: lineNo });
      }
      NEXTJS_EXPORT_RE.lastIndex = 0;
      return issues;
    }

    // Express / Fastify / Hono / Koa pattern
    const routePatterns = [
      { re: EXPRESS_ROUTE_RE,  framework: 'express' },
      { re: FASTIFY_ROUTE_RE,  framework: 'fastify' },
      { re: HONO_ROUTE_RE,     framework: 'hono' },
      { re: KOA_ROUTE_RE,      framework: 'koa' },
    ];

    for (const { re } of routePatterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(content)) !== null) {
        const [, method, routePath] = m;
        if (isPublicRoute(routePath)) continue;

        const matchIdx = m.index;
        const lineNo   = content.slice(0, matchIdx).split('\n').length;
        const lineText = lines[lineNo - 1] || '';

        if (lineText.includes('// auth-public') || lineText.includes('// no-auth')) continue;

        const body = extractHandlerBody(content, matchIdx);
        if (AUTH_SIGNAL_RE.test(body)) continue;

        issues.push({ method, route: routePath, line: lineNo });
      }
      re.lastIndex = 0;
    }

    return issues;
  }
}

module.exports = AuthBypassDetector;
