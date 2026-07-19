/**
 * Error Swallow Module — silent catches, floating promises, unchecked
 * async errors.
 *
 * The single most common production bug we see across every
 * codebase is error swallowing. `try { ... } catch {}` in a webhook
 * handler. `.catch(() => {})` after a Stripe call. A missing `await`
 * on `db.commit()`. An `if (err) return;` in a Node callback that
 * drops the error on the floor. Each one looks harmless in code
 * review — each one deletes an alert that would have caught a bug
 * before it hit the customer.
 *
 * ESLint's `no-empty` catches a fraction of this (only literal empty
 * `catch` blocks). It misses:
 *   - catch blocks that only log and return
 *   - `.catch(() => {})` / `.catch(() => null)` on promise chains
 *   - missing `await` on a function call whose return type is a
 *     Promise (fire-and-forget)
 *   - Node-callback `(err, data) => { ... data }` that never
 *     branches on `err`
 *   - `process.on('uncaughtException', () => {})` / `unhandledRejection`
 *     handlers that swallow
 *
 * We cover all six families.
 *
 * Discovery: `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`,
 * `.cts`. Tests (`*.test.*`, `*.spec.*`, under `tests/`, `__tests__/`,
 * `spec/`) are scanned at reduced severity — a silent catch in a test
 * is usually intentional (testing the unhappy path).
 *
 * Rules:
 *
 *   error:   truly bare empty `catch (err) { }` block — no code, no
 *            comment                                          (prod)
 *            warning in tests
 *            (rule: `error-swallow:empty-catch:<rel>:<line>`)
 *   warning: catch block that contains ONLY comments — a comment
 *            documents intent, it doesn't handle the error. Still a
 *            surfaced finding, not a blocking one: this codebase's own
 *            documented idiom is a commented catch explaining WHY it's
 *            safe, and the module's own fix advice blesses that pattern.
 *            (rule: `error-swallow:empty-catch:<rel>:<line>`)
 *   error:   catch block that only calls `console.log`/`console.warn`
 *            and does not re-throw — visible in logs but breaks
 *            downstream callers
 *            (rule: `error-swallow:log-and-eat:<rel>:<line>`)
 *   error:   `.catch(() => {})` / `.catch(() => null)` /
 *            `.catch(() => undefined)` on a Promise chain — swallows
 *            the reason. `.catch(noop)` where `noop = () => {}` is
 *            also caught.
 *            (rule: `error-swallow:catch-noop:<rel>:<line>`)
 *   warning: `process.on('uncaughtException', ...)` /
 *            `'unhandledRejection'` handler that doesn't re-throw or
 *            call `process.exit`
 *            (rule: `error-swallow:global-silent-handler:<rel>:<line>`)
 *   warning: Node-callback `(err, ...) => {` that references `err`
 *            neither in a conditional nor a throw — error never
 *            surfaces
 *            (rule: `error-swallow:callback-err-ignored:<rel>:<line>`)
 *   warning: statement-level call to a function whose name strongly
 *            suggests a Promise (`.save()`, `.commit()`, `.then()`,
 *            `.fetch()`, `.send()`, `await*`) with NO `await` and NO
 *            `.then(` / `.catch(` — fire-and-forget
 *            (rule: `error-swallow:floating-promise:<rel>:<line>`)
 *
 * TODO(gluecron): Once Gluecron runs first-party CI and ships its own
 * SDK, extend floating-promise detection to the Gluecron API client
 * (every `gluecron.call.*` returns a Promise).
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i;

// Function names whose invocation returns a Promise commonly enough
// that calling without await/then/catch is a smell. Deliberately
// narrow — we'd rather miss cases than shout false positives.
const PROMISE_METHOD_HINTS = [
  'save', 'commit', 'rollback', 'update', 'insert', 'delete',
  'query', 'exec', 'send', 'publish', 'fetch',
  'capture', 'confirm', 'charge', 'refund', 'cancel',
  'flush', 'sync', 'upload', 'download',
];
// NOTE: `.write()` is deliberately NOT a promise hint. Node's Writable.write()
// and http.ClientRequest.write() return a BOOLEAN (the backpressure signal),
// never an awaitable promise — on ANY receiver (out.write, req.write,
// sink.write, a bare stream variable). Including it flagged every stream write
// as an "unhandled promise", a false-positive flood on any repo that touches
// http/streams (42 FPs on our own codebase). The receiver allowlist below
// can't enumerate every stream variable name, so the fix is to not treat
// `.write()` as promise-returning at all. (Removed 2026-07-11.)

// Receivers whose `.send()` / `.delete()` / `.write()` / `.update()` etc.
// are SYNC by convention and would produce a flood of false positives if
// flagged. Express response object (`res.send()`), Express router
// (`app.delete('/foo', ...)`), Koa context (`ctx.body = ...`), Fastify
// reply (`reply.send()`), Hapi response toolkit (`h.response()`), Node
// stream (`stream.write()` returns boolean), Buffer/string builders.
//
// When the receiver chain matches one of these names (top-level), skip
// the floating-promise check entirely. Better to miss a genuine smell on
// `res.send()` than to produce a 200-finding noise wall on every
// Express app.
const SYNC_RECEIVER_NAMES = new Set([
  'res', 'response', 'reply', 'ctx', 'context', 'h',
  'app', 'router', 'route', 'server', 'next',
  'console', 'logger', 'log',
  'stream', 'socket', 'ws', 'process', 'stdout', 'stderr', 'stdin',
  'buffer', 'buf',
  'xhr', 'xmlhttprequest',
  // `this` / `self` are typically the route handler / response object in
  // Express-style code. Better to miss a real DB-call-on-this than flood
  // every middleware with FPs.
  'this', 'self',
]);

function receiverTopLevel(receiverExpr) {
  // For `a.b.c` return `a`. For `this.foo` return `this`.
  const dot = receiverExpr.indexOf('.');
  return dot === -1 ? receiverExpr : receiverExpr.slice(0, dot);
}

// String-aware "inside a string literal" guard (copied in spirit from
// flaky-tests.js — kept local to avoid cross-module coupling).
function isInString(line, idx) {
  let inS = false; let inD = false; let inT = false;
  for (let i = 0; i < idx && i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\') { i += 1; continue; }
    if (!inD && !inT && ch === '\'') inS = !inS;
    else if (!inS && !inT && ch === '"') inD = !inD;
    else if (!inS && !inD && ch === '`') inT = !inT;
  }
  return inS || inD || inT;
}

class ErrorSwallowModule extends BaseModule {
  constructor() {
    super(
      'errorSwallow',
      'Error Swallow — empty catch, .catch(noop), callback-err ignored, floating promises, global silent handlers',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('error-swallow:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('error-swallow:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s)`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('error-swallow:summary', true, {
      severity: 'info',
      message: `Error-swallow scan: ${files.length} file(s), ${issues} issue(s)`,
    });
  }

  _findFiles(projectRoot) {
    const out = [];
    const walk = (dir, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SOURCE_EXTS.has(ext)) out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  // Returns true if the current line or the previous line carries a
  // `// error-ok` or `// gatetest-fire-and-forget` suppressor comment,
  // meaning the developer has documented that this specific swallow is
  // intentional.
  _isSuppressed(lines, lineIdx) {
    const line = lines[lineIdx] || '';
    const prev = lineIdx > 0 ? lines[lineIdx - 1] : '';
    const re = /\b(?:error-ok|gatetest-fire-and-forget)\b/;
    return re.test(line) || re.test(prev);
  }

  // Returns true when the `.catch(...)` on the current line is part of
  // a `void expression` statement — the explicit, idiomatic JS pattern
  // (also ESLint's `no-floating-promises` recommendation) for
  // intentional fire-and-forget. We walk back up to 2 lines looking
  // for a `void ` at statement start, stopping at a prior statement
  // boundary so we don't accidentally accept an unrelated `void` above.
  _isVoidFireAndForget(lines, lineIdx) {
    for (let j = lineIdx; j >= Math.max(0, lineIdx - 2); j -= 1) {
      const trimmed = (lines[j] || '').trim();
      if (/^void\s+[\w$(]/.test(trimmed)) return true;
      // Hit a prior statement boundary — stop walking back. The
      // current line itself is allowed to end with `;` (the chain
      // we're checking).
      if (j !== lineIdx && /;\s*$/.test(trimmed)) return false;
    }
    return false;
  }

  // Strips `//` line comments and `/* */` block comments from a catch
  // body so a comment-only catch (`catch (err) { // nothing to do here }`)
  // is treated as empty — comments document intent, they don't handle
  // the error. `isInString` keeps us from truncating a line at a `//`
  // that's actually inside a string literal in the catch body.
  _stripComments(body) {
    const withoutBlocks = body.replace(/\/\*[\s\S]*?\*\//g, '');
    return withoutBlocks
      .split('\n')
      .map((l) => {
        const idx = l.indexOf('//');
        if (idx === -1 || isInString(l, idx)) return l;
        return l.slice(0, idx);
      })
      .join('\n')
      .trim();
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }

    const rel = path.relative(projectRoot, file);
    const isTest = TEST_PATH_RE.test(rel.replace(/\\/g, '/'));
    const lines = content.split('\n');
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      // 1. Empty catch block — `catch (err) {}` or `catch {}` on one
      //    line, OR `catch (err) {` followed immediately by `}`.
      const catchOnLine = line.match(/\bcatch\s*(?:\(([^)]*)\))?\s*\{/);
      if (catchOnLine && !isInString(line, catchOnLine.index) && !this._isSuppressed(lines, i)) {
        const bodyText = this._collectBlockBody(lines, i, catchOnLine.index);
        const rawBody = bodyText.closed ? bodyText.body.trim() : bodyText.body;
        const effectiveBody = bodyText.closed ? this._stripComments(bodyText.body) : bodyText.body;
        const isBareEmpty = bodyText.closed && rawBody === '';
        const isCommentOnly = bodyText.closed && !isBareEmpty && effectiveBody === '';
        if (isBareEmpty || isCommentOnly) {
          issues += this._flag(result, `error-swallow:empty-catch:${rel}:${i + 1}`, {
            severity: isTest ? 'warning' : (isBareEmpty ? 'error' : 'warning'),
            file: rel,
            line: i + 1,
            message: isBareEmpty
              ? `${rel}:${i + 1} has an empty catch block — any error thrown in the try is erased`
              : `${rel}:${i + 1} catch block contains only comments — a comment documents intent but does not handle the error`,
            suggestion: isBareEmpty
              ? 'At minimum log the error with context; preferably rethrow or handle it. If the error is genuinely expected and benign, comment WHY.'
              : 'A comment alone doesn\'t handle the error — if it\'s genuinely safe to ignore, keep the comment AND add a log call so the swallow is visible in production.',
          });
        } else if (bodyText.closed && this._isLogAndEat(bodyText.body)) {
          issues += this._flag(result, `error-swallow:log-and-eat:${rel}:${i + 1}`, {
            severity: isTest ? 'info' : 'error',
            file: rel,
            line: i + 1,
            message: `${rel}:${i + 1} catch block only logs and does not re-throw — visible in logs but invisible to callers, breaks downstream error handling`,
            suggestion: 'Either re-throw after logging, call `next(err)` in Express, or convert to a typed Result. Don\'t pretend the operation succeeded.',
          });
        }
      }

      // 2. `.catch(() => {})` / `.catch(() => null)` / `.catch(noop)`
      // Suppressed when the chain is part of a `void expression`
      // statement — the idiomatic JS fire-and-forget pattern.
      const catchNoop = line.match(/\.catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+)?\s*=>\s*(?:\{\s*\}|null|undefined|void\s+0)\s*\)/);
      if (catchNoop && !isInString(line, catchNoop.index) && !this._isSuppressed(lines, i) && !this._isVoidFireAndForget(lines, i)) {
        issues += this._flag(result, `error-swallow:catch-noop:${rel}:${i + 1}`, {
          severity: isTest ? 'warning' : 'error',
          file: rel,
          line: i + 1,
          message: `${rel}:${i + 1} has \`.catch(() => {})\` or equivalent — Promise rejection is silently dropped`,
          suggestion: 'Replace with `.catch((err) => log.error({ err }, "context"))` and either rethrow or surface a typed error. If this is intentional fire-and-forget, use `void promise` (the JS idiom) or add `// gatetest-fire-and-forget` on the line above.',
        });
      }
      // `.catch(noop)` / `.catch(ignore)` / `.catch(() => { /* ignore */ })`
      // — same void-prefix suppression applies.
      const catchNamedNoop = line.match(/\.catch\s*\(\s*(?:noop|ignore|swallow|_)\s*\)/);
      if (catchNamedNoop && !isInString(line, catchNamedNoop.index) && !this._isSuppressed(lines, i) && !this._isVoidFireAndForget(lines, i)) {
        issues += this._flag(result, `error-swallow:catch-noop:${rel}:${i + 1}`, {
          severity: isTest ? 'warning' : 'error',
          file: rel,
          line: i + 1,
          message: `${rel}:${i + 1} passes a known noop (\`noop\`/\`ignore\`/\`swallow\`/\`_\`) to \`.catch()\``,
          suggestion: 'Give the handler a real body, or use `void promise` for fire-and-forget, or add `// gatetest-fire-and-forget`.',
        });
      }

      // 3. Global silent handlers
      const globalHandler = line.match(/process\.on\s*\(\s*['"`](uncaughtException|unhandledRejection)['"`]/);
      if (globalHandler && !isInString(line, globalHandler.index) && !this._isSuppressed(lines, i)) {
        // Look at next ~8 lines for a throw/exit/log-with-rethrow
        const windowText = lines.slice(i, Math.min(lines.length, i + 10)).join('\n');
        const hasExit = /\bprocess\.exit\s*\(/.test(windowText);
        const hasThrow = /\bthrow\b/.test(windowText);
        if (!hasExit && !hasThrow) {
          issues += this._flag(result, `error-swallow:global-silent-handler:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            event: globalHandler[1],
            message: `${rel}:${i + 1} attaches a \`process.on('${globalHandler[1]}', ...)\` handler that doesn't re-throw or exit — crashes become silent`,
            suggestion: 'Log with structured context, then `process.exit(1)` or rethrow. A silent `uncaughtException` handler turns every crash into data corruption.',
          });
        }
      }

      // 4. Node-callback `(err, ...) => { ... }` that doesn't branch
      //    on err. Conservative: only flag if the callback body in the
      //    next ~5 lines doesn't mention `err` — we look ONLY after
      //    the opening brace to avoid counting the param itself.
      const nodeCb = line.match(/\(\s*(err|error)\s*,\s*[^)]+\)\s*=>\s*\{/);
      if (nodeCb && !isInString(line, nodeCb.index) && !this._isSuppressed(lines, i)) {
        const errName = nodeCb[1];
        // Body starts right after the `{` on this line.
        const braceOffset = line.indexOf('{', nodeCb.index + nodeCb[0].length - 1);
        const sameLineBody = braceOffset >= 0 ? line.slice(braceOffset + 1) : '';
        const followingLines = lines.slice(i + 1, Math.min(lines.length, i + 6)).join('\n');
        const bodyWindow = `${sameLineBody}\n${followingLines}`;
        const mentionsErr = new RegExp(`\\b${errName}\\b`).test(bodyWindow);
        if (!mentionsErr) {
          issues += this._flag(result, `error-swallow:callback-err-ignored:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            message: `${rel}:${i + 1} Node-style callback \`(${errName}, ...)\` never references \`${errName}\` — every error is dropped`,
            suggestion: `Branch on \`if (${errName}) { /* handle or rethrow */ }\` or, better, promisify the API.`,
          });
        }
      }

      // 5. Floating promise heuristic — statement-level call to a
      //    known promise-returning method, NOT preceded by `await`,
      //    `return`, `void`, `=` etc., and NOT followed on the same
      //    line by `.then(` or `.catch(`. Deliberately narrow.
      if (!isTest) {
        const flt = line.match(/^(\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\s*\(/);
        if (flt && !isInString(line, flt.index) && !this._isSuppressed(lines, i)) {
          const indent = flt[1];
          const receiver = flt[2];
          const method = flt[3];
          const topLevel = receiverTopLevel(receiver).toLowerCase();
          // Skip well-known sync receivers (res.send, app.delete, ctx.body,
          // stream.write, logger.send, etc.) — these would produce a flood
          // of false positives on any Express / Koa / Fastify / Hapi app.
          if (SYNC_RECEIVER_NAMES.has(topLevel)) continue;
          // Collection/cookie .delete() guard: Map/Set/WeakMap.delete(key) and
          // cookieStore.delete(name) return a boolean/void, not a promise, and
          // take a BARE KEY. An ORM delete (prisma.user.delete({where:{id}}))
          // takes an OBJECT LITERAL. So only treat `.delete(` as promise-ish
          // when its first argument opens with `{`. Kills the Map/Set/cookie
          // false-positive class without losing real floating DB deletes.
          if (method.toLowerCase() === 'delete') {
            const afterOpen = line.slice(flt.index + flt[0].length).trimStart();
            if (!afterOpen.startsWith('{')) continue;
          }
          if (PROMISE_METHOD_HINTS.includes(method.toLowerCase())) {
            // Prefix check — is the statement preceded by await/return/void/= ?
            const before = line.slice(0, flt.index + indent.length);
            const head = line.slice(flt.index + indent.length);
            const prevNonWs = before.trim();
            const looksAwaited = /\b(?:await|return|void|yield)\s*$/.test(prevNonWs)
              || /[=!?([,]\s*$/.test(prevNonWs);
            const chained = /\.(?:then|catch|finally)\s*\(/.test(head);
            if (!looksAwaited && !chained) {
              issues += this._flag(result, `error-swallow:floating-promise:${rel}:${i + 1}`, {
                severity: 'warning',
                file: rel,
                line: i + 1,
                method,
                message: `${rel}:${i + 1} calls \`.${method}()\` without \`await\` / \`.then(...)\` / \`.catch(...)\` — a rejection here becomes an unhandled promise rejection`,
                suggestion: `Add \`await\` if this is inside an async function, or chain \`.catch()\` to handle the rejection.`,
              });
            }
          }
        }
      }
    }

    return issues;
  }

  // Best-effort block-body extractor. Starting at `lines[lineIdx]`
  // with `{` at `openIdx` on that line, walk forward counting braces
  // (string-aware) and return the concatenated body (excluding the
  // outermost braces) plus whether the block was closed.
  _collectBlockBody(lines, lineIdx, hintIdx) {
    const startLine = lines[lineIdx];
    const braceIdx = startLine.indexOf('{', hintIdx);
    if (braceIdx === -1) return { body: '', closed: false };

    let depth = 1;
    let body = '';
    let firstLineRemainder = startLine.slice(braceIdx + 1);
    const walkLine = (text) => {
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '{') { depth += 1; body += ch; }
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) return { closed: true, rest: text.slice(i + 1) };
          body += ch;
        }
        else body += ch;
      }
      return { closed: false, rest: '' };
    };
    // Process first-line remainder
    const first = walkLine(firstLineRemainder);
    if (first.closed) return { body: body.trim(), closed: true };

    body += '\n';
    for (let j = lineIdx + 1; j < lines.length && j < lineIdx + 40; j += 1) {
      const res = walkLine(lines[j]);
      if (res.closed) return { body: body.trim(), closed: true };
      body += '\n';
    }
    return { body: body.trim(), closed: false };
  }

  // True if the catch body only contains `console.*` calls (or a
  // comment) and no throw / reject / return with an error.
  _isLogAndEat(body) {
    const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    if (lines.length === 0) return false;
    // Must not throw or reject or return an error value
    if (/\bthrow\b/.test(body)) return false;
    if (/\breject\s*\(/.test(body)) return false;
    if (/\breturn\s+.*\berr(?:or)?\b/.test(body)) return false;
    if (/\bnext\s*\(\s*\w+/.test(body)) return false; // Express-style next(err)
    // Every non-empty line must look like a log call
    return lines.every((l) => /^console\.(?:log|warn|error|info|debug)\s*\(/.test(l)
      || /^(?:log|logger)\.(?:log|warn|error|info|debug)\s*\(/.test(l));
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = ErrorSwallowModule;
