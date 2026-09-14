/**
 * Webhook Payload Validator — catches unvalidated incoming webhook payloads.
 *
 * Webhook handlers that accept `req.body` without parsing/validating the
 * shape are vulnerable to:
 *   - Type confusion (body.amount is a string not a number → billing drift).
 *   - Missing fields causing silent undefined → downstream NaN / null writes.
 *   - Prototype pollution if the body is used in object spread.
 *   - Injection if body fields flow to database queries.
 *
 * Detection:
 *   1. Find webhook route handlers (POST routes at /webhook*, /events*, /hook*,
 *      or any route file in a webhooks/ directory).
 *   2. Check if the handler validates req.body before use.
 *   3. Flag handlers that access req.body.* properties directly without a
 *      prior schema.parse() / schema.safeParse() / Joi.validate() / ajv.validate()
 *      call.
 *
 * Validation signals recognised:
 *   - Zod: .parse(req.body) / .safeParse(req.body) / .parseAsync(req.body)
 *   - Joi: schema.validate(req.body) / Joi.object().validate(req.body)
 *   - Yup: schema.validate(req.body) / schema.validateSync(req.body)
 *   - ajv: ajv.validate(schema, req.body) / validate(req.body)
 *   - Manual: typeof req.body.X === / req.body.X !== undefined
 *   - Stripe/GitHub sig: stripe.webhooks.constructEvent / crypto.createHmac
 */

'use strict';

const fs   = require('fs');
const { repoRelative } = require('../core/repo-path');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');
const { ROUTE_OBJECTS, hasMutatingHandler } = require('../core/route-grammar');

// ─── patterns ─────────────────────────────────────────────────────────────

// A webhook route is a POST whose PATH says so. The registering object
// comes from the shared route grammar (src/core/route-grammar.js): until
// 2026-09-05 only `app|router|fastify|server` were known, so a Hono, Koa,
// Elysia or `api.post('/webhooks/stripe', …)` handler, and every NestJS
// `@Post('webhook')`, was never a webhook to this module (KI #106).
const WEBHOOK_PATH_WORDS = String.raw`(?:webhook|event|hook|notify|callback|push|pull|receive|ipn)`;
const WEBHOOK_ROUTE_RE = new RegExp(
  String.raw`\b${ROUTE_OBJECTS}\s*\.\s*post\s*\(\s*['"\x60]([^'"\x60,]*${WEBHOOK_PATH_WORDS}[^'"\x60,]*)['"\x60]`, 'gi',
);
const WEBHOOK_DECORATOR_RE = new RegExp(
  String.raw`@Post\s*\(\s*['"\x60]([^'"\x60]*${WEBHOOK_PATH_WORDS}[^'"\x60]*)['"\x60]\s*\)`, 'gi',
);

// The payload being read, in the frameworks the grammar covers: Express /
// Koa `req.body.x`, Fastify `request.body.x`, Koa `ctx.request.body`, Next
// App Router / Hono / Elysia `await req.json()` / `await c.req.json()`.
const BODY_ACCESS_RE   = /\b(?:req|request)\s*\.\s*body\s*\.\s*[a-zA-Z_$]|\bctx\s*\.\s*request\s*\.\s*body\b|\bawait\s+(?:req|request|c\s*\.\s*req)\s*\.\s*json\s*\(/;

const VALIDATION_SIGNALS = [
  // Zod / Valibot / any schema library with a parse: `schema.parse(req.body)`,
  // `.safeParse(await req.json())`, `v.parse(Schema, body)`
  /\.(?:parse|safeParse|parseAsync|safeParseAsync)\s*\(\s*(?:await\s+)?(?:req|request|body|payload|json|data|c\s*\.\s*req)/,
  /\bv\s*\.\s*(?:parse|safeParse)\s*\(/,
  // Fastify route schema — the framework validates before the handler runs
  /\bschema\s*:\s*\{[^}]*\bbody\s*:/,
  // NestJS: a typed `@Body()` DTO goes through the ValidationPipe
  /@Body\s*\(\s*\)\s*[a-zA-Z_$][\w$]*\s*:\s*[A-Z][\w$]*/,
  // TypeBox / ajv compiled validators
  /\bValue\s*\.\s*(?:Check|Decode)\s*\(/,
  // Joi
  /\.validate\s*\(\s*(?:req|request)\s*\.\s*body/,
  // Yup
  /\.validateSync\s*\(\s*(?:req|request)\s*\.\s*body/,
  // ajv
  /validate\s*\(\s*(?:schema|[a-zA-Z]+Schema)\s*,\s*(?:req|request)\s*\.\s*body/,
  // Manual type checks
  /typeof\s+(?:req|request)\s*\.\s*body/,
  // Stripe signature verification (proves the payload is authentic)
  /stripe\s*\.\s*webhooks\s*\.\s*constructEvent/,
  /webhook(?:s)?\s*\.\s*constructEvent/,
  // GitHub / generic HMAC signature
  /crypto\s*\.\s*createHmac/,
  /x-hub-signature|x-stripe-signature|x-github-event/i,
  // Svix / Clerk webhook verification
  /svix|wh\.verify|webhook\.verify/i,
];

// ─── module ────────────────────────────────────────────────────────────────


/**
 * Is `name` a whole path SEGMENT of `rel`? `rel.includes('node_modules')`
 * is a substring test — it also matches a directory merely CONTAINING the
 * word. Same mistake as `.includes('.git')` matching `.github`.
 */
function hasSegment(rel, name) {
  return typeof rel === 'string' && rel.split(/[\\/]+/).includes(name);
}

class WebhookPayloadValidator extends BaseModule {
  constructor() {
    super('webhookPayload', 'Webhook Payload Validator — catches webhook handlers that use req.body without validation');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const extensions  = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];
    const files       = this._collectFiles(projectRoot, extensions);

    let webhookHandlers = 0;
    let unvalidated     = 0;

    for (const file of files) {
      const rel = repoRelative(projectRoot, file);
      if (hasSegment(rel, 'node_modules') || hasSegment(rel, '.next') || this._isTestPath(rel)) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      // A file that IS a webhook handler by its path — a `webhooks/` or
      // `events/` directory, or `webhook` in the basename. `includes('/hook')`
      // used to match `src/hooks/useAuth.ts` (React hooks) and read the whole
      // file as one handler body (2026-09-05); a bare hooks/ dir is not a
      // webhook unless the file actually defines a POST handler.
      const relUnix = rel.replace(/\\/g, '/').toLowerCase();
      const isWebhookFile = (
        /(?:^|\/)(?:webhooks?|events)\//.test(relUnix) ||
        /webhook[^/]*$/.test(relUnix) ||
        (/(?:^|\/)hooks?\//.test(relUnix) && hasMutatingHandler(content))
      );

      // Extract handler bodies for webhook routes
      const handlerBodies = isWebhookFile
        ? [{ body: content, route: rel, line: 1 }]
        : this._extractWebhookHandlers(content);

      for (const { body, route, line } of handlerBodies) {
        webhookHandlers++;

        // Check if body is accessed
        if (!BODY_ACCESS_RE.test(body)) continue;

        // Check for validation signal
        const validated = VALIDATION_SIGNALS.some(re => re.test(body));
        if (validated) continue;

        unvalidated++;
        result.addCheck(`webhook-payload:unvalidated:${rel}:${route || 'handler'}`, false, {
          severity: 'error',
          message: `Webhook handler at \`${rel}:${line}\` accesses \`req.body.*\` without schema validation`,
          file: rel,
          line,
          fix: `Add Zod validation: \`const payload = PayloadSchema.safeParse(req.body); if (!payload.success) return res.status(400).json({ error: 'Invalid payload' });\``,
          autoFix: makeAutoFix(
            file,
            'webhook-payload:unvalidated',
            `Webhook handler accesses req.body without schema validation`,
            line,
            `Add Zod schema validation: const schema = z.object({...}); const payload = schema.safeParse(req.body); if (!payload.success) return 400`
          ),
        });
      }
    }

    if (webhookHandlers === 0) {
      result.addCheck('webhook-payload:no-webhooks', true, {
        severity: 'info',
        message: 'No webhook handlers detected',
      });
      return;
    }

    if (unvalidated === 0) {
      result.addCheck('webhook-payload:all-validated', true, {
        severity: 'info',
        message: `All ${webhookHandlers} webhook handler(s) validate their payload`,
      });
    }
  }

  _extractWebhookHandlers(content) {
    const handlers = [];
    for (const re of [WEBHOOK_ROUTE_RE, WEBHOOK_DECORATOR_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(content)) !== null) {
        const route   = m[1];
        const lineNo  = content.slice(0, m.index).split(/\r?\n/).length;
        // For a decorator the body is the method that follows; its
        // signature (`@Body() dto: CreateDto`) is part of what we judge.
        const body    = re === WEBHOOK_DECORATOR_RE
          ? content.slice(m.index, m.index + 200) + this._extractFunctionBody(content, m.index + m[0].length)
          : this._extractFunctionBody(content, m.index);
        handlers.push({ body, route, line: lineNo });
      }
      re.lastIndex = 0;
    }
    return handlers;
  }

  _extractFunctionBody(content, startIdx) {
    let depth = 0;
    let start = -1;
    for (let i = startIdx; i < Math.min(startIdx + 3000, content.length); i++) {
      if (content[i] === '{') {
        if (start === -1) start = i;
        depth++;
      } else if (content[i] === '}') {
        depth--;
        if (depth === 0 && start !== -1) return content.slice(start, i + 1);
      }
    }
    return content.slice(startIdx, startIdx + 500);
  }
}

module.exports = WebhookPayloadValidator;
