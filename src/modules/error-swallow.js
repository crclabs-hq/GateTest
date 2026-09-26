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
 * `.cts`. HARNESS code — tests (`*.test.*`, `*.spec.*`, `tests/`,
 * `__tests__/`, `spec/`) and benchmarks (`bench/`, `benchmarks/`,
 * `perf/`, and the compounds `HARNESS_DIR_RE` in
 * `src/core/scan-scope.js` recognises) — is scanned at reduced
 * severity. A silent catch in a test or a benchmark is usually the
 * point of the measurement, not a defect: zod's
 * `packages/zod/src/v3/benchmarks/` times the throw path 22 times and
 * used to be told 22 times that it had erased an error. This is the
 * module's own long-standing test-path calibration, applied to the
 * other kind of harness; it is SCOPE, and the finding still reports.
 *
 * Rules:
 *
 *   error:   truly bare empty `catch (err) { }` block — no code, no
 *            comment                                          (prod)
 *            warning in a test/benchmark harness, and warning when the
 *            failure is GUARDED: the try block exits on success and
 *            code follows the catch, or the try only assigns a target
 *            the following code then tests. In a parsing library
 *            `try { ... } catch {}` is usually "that shape did not
 *            parse, fall through" — see `src/core/guarded-catch.js`
 *            for the discriminator and its control pairs. Since
 *            2026-09-14 also warning when the attempt is DOCUMENTED
 *            (a comment above the try, on its first line, or after
 *            the catch), OPT-IN (under `if (opts.ignoreErrors)`),
 *            NESTED (inside a try whose own catch is empty — that
 *            outer catch is the finding), an OBSERVER (the whole body
 *            of an anonymous async function that only awaits), or a
 *            RESULT-RETURN (the try returns on success, a `return`
 *            follows the catch). Measured on sindresorhus/got: six
 *            deliberate `catch {}` in `source/core/` were blocking.
 *            (rule: `error-swallow:empty-catch:<rel>:<line>`)
 *   warning: catch block that contains ONLY comments — a comment
 *            documents intent, it doesn't handle the error. Still a
 *            surfaced finding, not a blocking one: this codebase's own
 *            documented idiom is a commented catch explaining WHY it's
 *            safe, and the module's own fix advice blesses that pattern.
 *            (rule: `error-swallow:empty-catch:<rel>:<line>`)
 *   warning: catch block (or `.catch()` handler) that calls a logger —
 *            `console.*`, `log.*` or `logger.*`, any method — and does
 *            not re-throw: visible in logs but invisible to callers.
 *            Not blocking (issue #633, 2026-09-22): Tallrig's sample of
 *            134 findings on their monorepo showed 12/20 were the fail-
 *            soft-and-log idiom used ON PURPOSE (bootstrap-admin.ts:100
 *            warns then continues by design) at BLOCKING severity — a
 *            logged swallow is a real code smell but a materially
 *            different risk than one with NO trace at all, which is
 *            `error-swallow:empty-catch` / `catch-noop` and still blocks.
 *            (rule: `error-swallow:log-and-eat:<rel>:<line>`)
 *   error:   `.catch(() => {})` / `.catch(() => null)` /
 *            `.catch(() => undefined)` / `.catch(() => false)` on a Promise
 *            chain — swallows the reason. `.catch(noop)` where
 *            `noop = () => {}` is also caught. Warning when the rejection
 *            is GUARDED — see `_catchNoopGuard`: the promise is held in a
 *            reference the file awaits / returns elsewhere (the noop only
 *            marks it handled), the next statement is a `throw` (the
 *            function is already failing with the primary cause), or the
 *            call is teardown (`close()` / `end()` / `destroy()`, or any
 *            call inside a `finally` or a teardown function). Since
 *            2026-09-26 also warning when the RETURNED SENTINEL is read by
 *            the caller — see `_consumedSentinelGuard`: `?? DEFAULT` / `||
 *            fallback` in the same statement, a direct `if (`/`return`
 *            operand, or an assigned target checked in a condition, nullish
 *            chain, `return`, or call argument within the next few lines
 *            (issue #769 — `const u = await load().catch(() => null); if
 *            (!u) return 404;` is the checked-return idiom, not a swallow).
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
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');
const { HARNESS_DIR_RE } = require('../core/scan-scope');
const { classifyEmptyCatch, enclosingContext, isTeardownName } = require('../core/guarded-catch');

// Directory excludes beyond what `BaseModule._collectFiles` already skips
// (node_modules, .git, dist, build, coverage, .next, out, …). The old
// private walk (removed under KI #104) also skipped these.
const EXTRA_EXCLUDES = ['.terraform'];

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

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

// Every deciding regex runs on the MASKED line (BaseModule._maskedLines:
// string, regex and comment content blanked, offsets preserved). The raw
// line is read only for the `// error-ok` marker, which IS a comment, and
// for the event name inside `process.on('…')`'s quotes.

// The `.catch(noop)` shapes are matched on the masked line — so a quoted or
// commented example cannot fire them — and then confirmed on the raw text at
// the same span. The confirmation keeps one thing deliberately as it was:
// `.catch(() => { /* best-effort */ })`, an arrow whose body is only a
// comment, reads as `{ }` once masked and has never been reported (the raw
// regex cannot see past the comment). Reporting it is a rule decision — four
// new blocking findings on this repo alone — not a stripper migration.
// The shape is matched on the masked line (a quoted example cannot fire);
// whether the arrow body is bare or comment-only is read from the raw span:
// `.catch(() => { /* best-effort */ })` masks to `{ }` and had never fired
// because the old raw-line regex could not see past the comment — the
// module's own doc claimed it did. It reports at warning, like a
// comment-only `catch {}`: a comment documents intent, it does not handle
// the error.
function noopCatchAt(code, line, re) {
  const m = code.match(re);
  if (!m) return null;
  m.commentOnly = !re.test(line.slice(m.index, m.index + m[0].length));
  return m;
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
    // Shared walk from BaseModule — honours --diff/--pr scoping (KI #104).
    const files = this._collectFiles(projectRoot, [...SOURCE_EXTS], EXTRA_EXCLUDES);

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

  // Returns true if the current line or the previous line carries a
  // `// error-ok` or `// gatetest-fire-and-forget` suppressor comment,
  // meaning the developer has documented that this specific swallow is
  // intentional.
  _isSuppressed(lines, lineIdx) {
    const line = lines[lineIdx] || '';
    const prev = lineIdx > 0 ? lines[lineIdx - 1] : '';
    const re = /\b(?:error-ok|gatetest-fire-and-forget)\b/;
    if (re.test(line) || re.test(prev)) return true;
    // A multi-line `catch {` whose FIRST body line is the marker comment:
    //
    //   } catch {
    //     // error-ok — partial snapshot is still useful for the dashboard
    //   }
    //
    // is the natural place to write the reason, and the self-scan of
    // 2026-09-13 found the rule reading only the catch line and the one
    // above it, so the documented swallow was reported anyway. Only a
    // line that OPENS the block qualifies, and only its first body line.
    if (/\bcatch\b[^{]*\{\s*$/.test(line)) {
      const next = lines[lineIdx + 1] || '';
      return re.test(next);
    }
    return false;
  }

  // Returns true when the `.catch(...)` on the current line is part of
  // a `void expression` statement — the explicit, idiomatic JS pattern
  // (also ESLint's `no-floating-promises` recommendation) for
  // intentional fire-and-forget. We walk back up to 2 lines looking
  // for a `void ` at statement start, stopping at a prior statement
  // boundary so we don't accidentally accept an unrelated `void` above.
  _isVoidFireAndForget(masked, lineIdx) {
    for (let j = lineIdx; j >= Math.max(0, lineIdx - 2); j -= 1) {
      const trimmed = (masked[j] || '').trim();
      if (/^void\s+[\w$(]/.test(trimmed)) return true;
      // Hit a prior statement boundary — stop walking back. The
      // current line itself is allowed to end with `;` (the chain
      // we're checking).
      if (j !== lineIdx && /;\s*$/.test(trimmed)) return false;
    }
    return false;
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }

    const rel = repoRelative(projectRoot, file);
    const relPosix = rel.replace(/\\/g, '/');
    // A benchmark is the same KIND of code as a test: a harness, not something
    // that ships. `HARNESS_DIR_RE` is the engine's single definition of that
    // (src/core/scan-scope.js) — this module used to know only about tests, so
    // zod's `packages/zod/src/v3/benchmarks/` measured the throw path 22 times
    // and was told 22 times that it had erased an error.
    const isHarness = this._isTestPath(relPosix) || HARNESS_DIR_RE.test(relPosix);
    const lines = content.split(/\r?\n/);
    // Masked copy (string, regex and comment CONTENT blanked, offsets
    // preserved): every pattern below matches on it, and the structural
    // analysis in guarded-catch reads it. Built once per file. Found by
    // self-scan 2026-09-04: the doc comment at the top of guarded-catch.js
    // shows `try { await db.commit(); } catch {}` as the example of a genuine
    // swallow, and this module reported it — twice, at ERROR.
    const masked = this._maskedLines(content);
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];      // raw: only what lives inside quotes
      const code = masked[i] || ''; // masked: every pattern match
      if (!code.trim()) continue;

      // 1. Empty catch block — `catch (err) {}` or `catch {}` on one
      //    line, OR `catch (err) {` followed immediately by `}`.
      const catchOnLine = code.match(/\bcatch\s*(?:\(([^)]*)\))?\s*\{/);
      if (catchOnLine && !this._isSuppressed(lines, i)) {
        const block = this._collectBlockBody(masked, lines, i, catchOnLine.index);
        // `body` is the raw text between the braces; `code` the same text with
        // comments and strings blanked — a comment-only catch is one whose
        // body is not empty but whose code is.
        const isBareEmpty = block.closed && block.body === '';
        const isCommentOnly = block.closed && !isBareEmpty && block.code === '';
        if (isBareEmpty || isCommentOnly) {
          // Is the failure observable by the code around the catch? A
          // fallthrough alternative, or a target the next statement tests, is
          // a handled branch rather than a swallow. Only worth asking about a
          // bare empty catch that would otherwise block.
          // `lines` (raw) goes along for the DOCUMENTED judgement: the mask
          // has blanked every comment, and a comment is exactly what it reads.
          const guard = (isBareEmpty && !isHarness)
            ? classifyEmptyCatch(masked, i, catchOnLine.index, lines)
            : { guarded: false };
          issues += this._flag(
            result,
            `error-swallow:empty-catch:${rel}:${i + 1}`,
            this._emptyCatchDetails({ rel, line: i + 1, isHarness, isBareEmpty, guard }),
          );
        } else if (block.closed && this._isLogAndEat(block.code)) {
          // WARNING, not blocking (issue #633): a logger call is evidence the
          // author chose fail-soft-and-log on purpose, a materially
          // different risk than a catch with no trace at all. That's still
          // `empty-catch`/`catch-noop` above, unchanged at `error`.
          issues += this._flag(result, `error-swallow:log-and-eat:${rel}:${i + 1}`, {
            severity: isHarness ? 'info' : 'warning',
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
      const catchNoop = noopCatchAt(code, line, /\.catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+)?\s*=>\s*(?:\{\s*\}|null|undefined|false|void\s+0)\s*\)/);
      if (catchNoop && !this._isSuppressed(lines, i) && !this._isVoidFireAndForget(masked, i)) {
        // The sentinel idiom (issue #769): a catch that RETURNS a value
        // (null/undefined/false — never a bare `{}` noop, which returns
        // nothing meaningful) is not a swallow if the caller actually reads
        // that value. Checked before the older stored-reference/rethrow/
        // cleanup guards so a consumed sentinel is never mis-labelled as one
        // of those shapes.
        const returnsSentinel = /=>\s*(?:null|undefined|false|void\s+0)\s*\)$/.test(catchNoop[0]);
        const sentinelGuard = (!isHarness && returnsSentinel) ? this._consumedSentinelGuard(masked, i, catchNoop) : { guarded: false };
        const guard = isHarness
          ? { guarded: false }
          : (sentinelGuard.guarded ? sentinelGuard : this._catchNoopGuard(masked, i, catchNoop));
        issues += this._flag(result, `error-swallow:catch-noop:${rel}:${i + 1}`, this._catchNoopDetails({
          rel,
          line: i + 1,
          isHarness,
          guard,
          commentOnly: catchNoop.commentOnly,
          what: catchNoop.commentOnly ? 'has `.catch(() => { /* comment */ })` — a comment documents intent, it does not handle the error' : 'has `.catch(() => {})` or equivalent',
          suggestion: 'Replace with `.catch((err) => log.error({ err }, "context"))` and either rethrow or surface a typed error. If this is intentional fire-and-forget, use `void promise` (the JS idiom) or add `// gatetest-fire-and-forget` on the line above.',
        }));
      }
      // `.catch(noop)` / `.catch(ignore)` / `.catch(() => { /* ignore */ })`
      // — same void-prefix suppression applies.
      const catchNamedNoop = noopCatchAt(code, line, /\.catch\s*\(\s*(?:noop|ignore|swallow|_)\s*\)/);
      if (catchNamedNoop && !this._isSuppressed(lines, i) && !this._isVoidFireAndForget(masked, i)) {
        const guard = isHarness ? { guarded: false } : this._catchNoopGuard(masked, i, catchNamedNoop);
        issues += this._flag(result, `error-swallow:catch-noop:${rel}:${i + 1}`, this._catchNoopDetails({
          rel,
          line: i + 1,
          isHarness,
          guard,
          what: 'passes a known noop (`noop`/`ignore`/`swallow`/`_`) to `.catch()`',
          suggestion: 'Give the handler a real body, or use `void promise` for fire-and-forget, or add `// gatetest-fire-and-forget`.',
        }));
      }

      // 2c. `.catch((e) => { logger.warn(e); })` — a ONE-LINE arrow body that
      // is only logger calls (the same `_isLogAndEat` test the try/catch
      // rule uses). Deliberately narrow: `[^{}]*` does not cross a nested
      // brace, so a multi-line or non-trivial handler body falls through
      // unclaimed rather than being misread. This is `log-and-eat`, not
      // `catch-noop` — the rejection IS visible, just not to the caller —
      // so it shares that rule's WARNING severity (issue #633).
      if (!catchNoop && !catchNamedNoop && !this._isSuppressed(lines, i) && !this._isVoidFireAndForget(masked, i)) {
        const catchLoggerOnly = code.match(/\.catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*\{([^{}]*)\}\s*\)/);
        if (catchLoggerOnly && this._isLogAndEat(catchLoggerOnly[1])) {
          issues += this._flag(result, `error-swallow:log-and-eat:${rel}:${i + 1}`, {
            severity: isHarness ? 'info' : 'warning',
            file: rel,
            line: i + 1,
            message: `${rel}:${i + 1} \`.catch()\` handler only logs and does not re-throw — visible in logs but invisible to callers, breaks downstream error handling`,
            suggestion: 'Either re-throw after logging or surface a typed error to the caller. If this is intentional fire-and-forget, use `void promise` or add `// gatetest-fire-and-forget`.',
          });
        }
      }

      // 3. Global silent handlers — the call shape on the masked line, the
      //    event name from inside the quotes on the raw one.
      const handlerOpen = code.match(/process\.on\s*\(\s*['"`]/);
      const globalHandler = handlerOpen
        && line.slice(handlerOpen.index + handlerOpen[0].length).match(/^(uncaughtException|unhandledRejection)['"`]/);
      if (globalHandler && !this._isSuppressed(lines, i)) {
        // Look at next ~8 lines for a throw/exit/log-with-rethrow
        const windowText = masked.slice(i, Math.min(masked.length, i + 10)).join('\n');
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

      // 4. Node-callback `(err, ...) => { ... }` / `function (err, ...) { }`
      //    that doesn't branch on err. The classic `function` form is how
      //    every legacy Mongo/Redis/fs API takes its callback — the
      //    arrow-only regex missed all of them (2026-08-18 audit residue).
      //    Conservative: only flag if the callback BODY never mentions
      //    `err`, scanning to the brace-balanced end of the callback (the
      //    old fixed 5-line window false-fired on bodies that handle the
      //    error on line 6+). We look ONLY after the opening brace to
      //    avoid counting the param itself.
      const nodeCb = code.match(/\(\s*(err|error)\s*,\s*[^)]+\)\s*=>\s*\{/)
        || code.match(/function\s*(?:[A-Za-z_$][\w$]*\s*)?\(\s*(err|error)\s*,\s*[^)]+\)\s*\{/);
      if (nodeCb && !this._isSuppressed(lines, i)) {
        const errName = nodeCb[1];
        // Body starts right after the `{` on this line; scan until the
        // callback's braces balance (capped at 60 lines for pathological
        // files — a longer body that still never says `err` has earned it).
        const braceOffset = code.indexOf('{', nodeCb.index + nodeCb[0].length - 1);
        const sameLineBody = braceOffset >= 0 ? code.slice(braceOffset + 1) : '';
        const bodyLines = [sameLineBody];
        let depth = 1;
        for (const ch of sameLineBody) {
          if (ch === '{') depth += 1;
          else if (ch === '}') depth -= 1;
        }
        for (let k = i + 1; k < Math.min(masked.length, i + 61) && depth > 0; k += 1) {
          bodyLines.push(masked[k]);
          for (const ch of masked[k]) {
            if (ch === '{') depth += 1;
            else if (ch === '}') { depth -= 1; if (depth === 0) break; }
          }
        }
        const bodyWindow = bodyLines.join('\n');
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
      if (!isHarness) {
        const flt = code.match(/^(\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\s*\(/);
        if (flt && !this._isSuppressed(lines, i)) {
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
            const afterOpen = code.slice(flt.index + flt[0].length).trimStart();
            if (!afterOpen.startsWith('{')) continue;
          }
          if (PROMISE_METHOD_HINTS.includes(method.toLowerCase())) {
            // Prefix check — is the statement preceded by await/return/void/= ?
            const before = code.slice(0, flt.index + indent.length);
            const head = code.slice(flt.index + indent.length);
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

  /**
   * Issue #769 (AlecRae cross-test, GT-17): `.catch(() => null)` /
   * `.catch(() => undefined)` / `.catch(() => false)` return a SENTINEL —
   * unlike a bare `.catch(() => {})`, the resolved value carries information
   * ("this failed"). When the caller actually reads that value, the pattern
   * is the documented idiom (`const u = await load().catch(() => null); if
   * (!u) return 404;`), not a swallow — 69 of AlecRae's 600 blocking findings
   * were exactly this. Three shapes, checked on the masked text:
   *
   *   same-statement   the call is immediately followed, in the same
   *                     statement, by `?? DEFAULT` or `|| fallback` — the
   *                     nullish/logical operator IS the read.
   *                     `const v = (await get().catch(() => undefined)) ??
   *                     DEFAULT;`
   *   direct-operand    nothing is assigned; the call is itself the
   *                     condition of an `if (`/`if (!` or the expression of
   *                     a `return` — the value is consumed on the spot.
   *   assignment        `const/let/var NAME = …catch(...)`, and NAME is read
   *                     in a condition, a nullish/logical chain, a `return`,
   *                     or passed as a call argument within the next few
   *                     lines. `const u = await load().catch(() => null); if
   *                     (!u) return res.status(404).end();`
   *
   * A sentinel assigned but never read again (`const r = await
   * fetch().catch(() => null); res.json({ ok: true });`) matches none of
   * these and keeps blocking — the value was thrown away, not consumed.
   */
  _consumedSentinelGuard(masked, lineIdx, match) {
    const mline = masked[lineIdx] || '';
    const before = mline.slice(0, match.index);
    const rest = mline.slice(match.index + match[0].length);

    // same-statement: `) ?? DEFAULT` / `) || fallback` right after the call
    // closes (any wrapping parens from `(await x.catch(...))` close first).
    if (/^\s*\)*\s*(?:\?\?|\|\|)\s*\S/.test(rest)) {
      return { guarded: true, shape: 'consumed-sentinel', context: 'the following `??`/`||`' };
    }

    // direct-operand: nothing assigned — the call itself is the `if (`
    // condition or the `return` expression.
    const directOperand = /^\s*(?:if\s*\(\s*!?\s*|return\s+)(?:await\s+)?$/.test(before);
    if (directOperand) {
      const restTrim = rest.replace(/^\)*/, '');
      if (/^\s*(?:\)\s*\{|;|\?\?|\|\||$)/.test(restTrim)) {
        const isIf = /^\s*if\b/.test(before);
        return { guarded: true, shape: 'consumed-sentinel', context: isIf ? 'the `if` condition' : 'the `return` expression' };
      }
    }

    // assignment: `const/let/var NAME = …` — scan the rest of this
    // statement plus the next few lines for a read of NAME, so the finding
    // can cite the exact consumer line.
    const asg = before.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (asg) {
      const name = asg[1];
      const n = `(?<![\\w$.])${name}(?![\\w$])`;
      const condRe = new RegExp(`\\bif\\s*\\(\\s*!?\\s*${n}\\b`);
      const nullishRe = new RegExp(`${n}\\s*(?:\\?\\.)?\\s*(?:\\?\\?|\\|\\|)`);
      const returnRe = new RegExp(`\\breturn\\b[^;]*\\b${name}\\b`);
      const argRe = new RegExp(`\\([^()]*\\b${name}\\b[^()]*\\)`);
      const destructureDefaultRe = new RegExp(`=\\s*${n}\\s*[,}\\)]`);
      const consumes = (text) => condRe.test(text) || nullishRe.test(text) || returnRe.test(text)
        || argRe.test(text) || destructureDefaultRe.test(text);
      if (consumes(rest)) {
        return { guarded: true, shape: 'consumed-sentinel', context: name, consumerLine: lineIdx + 1 };
      }
      for (let k = lineIdx + 1; k < Math.min(masked.length, lineIdx + 7); k += 1) {
        if (consumes(masked[k] || '')) {
          return { guarded: true, shape: 'consumed-sentinel', context: name, consumerLine: k + 1 };
        }
      }
    }

    return { guarded: false };
  }

  /**
   * Is the rejection a `.catch(noop)` drops still observable, or already
   * subsumed? Measured 2026-09-05 on nest, trpc and prisma — 30 blocking
   * `catch-noop` findings, 25 of them one of three shapes. Text analysis on
   * the masked file; the answer is a downgrade, never a suppression.
   *
   *   stored-reference  the receiver is a bare reference (`this.connectionPromise`,
   *                     `connectPromise?`) that the file `await`s / `return`s /
   *                     `.then`s elsewhere. `.catch()` returns a NEW promise; the
   *                     stored one still rejects for whoever awaits it, so the
   *                     noop handler only marks the rejection as observed. nest
   *                     `client-redis.ts:129`: `this.connectionPromise =
   *                     Promise.reject(...); this.connectionPromise.catch(() => {})`
   *                     with `return this.connectionPromise` in `connect()`.
   *   rethrow           the next statement is a `throw`. prisma
   *                     `supabase-runtime.ts:72`: `await conn.destroy(err).catch(()
   *                     => undefined); throw err;` — the function is already
   *                     failing with the primary cause.
   *   cleanup           the callee is a teardown verb, or the call sits inside a
   *                     `finally` / a teardown function (`isTeardownName`). prisma
   *                     `control.ts:39` `await this.client.end().catch(() => {})`
   *                     inside `close()`; trpc `wsClient.ts:76` `this.close().catch(()
   *                     => null)` from an inactivity timer.
   *
   * A `const p = db.commit(); p.catch(() => {})` whose `p` is never read again
   * is NOT a stored reference — nothing awaits it — and keeps blocking; so does
   * `db.commit().catch(() => {})` anywhere but a `finally` or a teardown.
   */
  _catchNoopGuard(masked, lineIdx, match) {
    const mline = masked[lineIdx] || '';
    const before = mline.slice(0, match.index);
    const rest = mline.slice(match.index + match[0].length);

    // rethrow: statement ends here and the next code line throws.
    if (/^\s*;?\s*$/.test(rest)) {
      for (let k = lineIdx + 1; k < Math.min(masked.length, lineIdx + 4); k += 1) {
        const next = masked[k] || '';
        if (!next.trim()) continue;
        if (/^\s*throw\b/.test(next)) return { guarded: true, shape: 'rethrow' };
        break;
      }
    }

    // cleanup: `x.close().catch(...)` / `destroyPool(...).catch(...)`.
    const callee = this._calleeBefore(before);
    if (callee && isTeardownName(callee)) return { guarded: true, shape: 'cleanup', context: `${callee}()` };
    const context = enclosingContext(masked, lineIdx, match.index);
    if (context.finally) return { guarded: true, shape: 'cleanup', context: 'finally' };
    if (context.teardown) return { guarded: true, shape: 'cleanup', context: `${context.fn}()` };

    // stored reference, observed elsewhere in the file.
    const ref = before.match(/(?:^|[^\w$.)\]])([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*\??$/);
    if (ref && !/^(?:this|self|window|globalThis|Promise)$/.test(ref[1])) {
      const name = ref[1].replace(/\?\./g, '.');
      const n = `(?<![\\w$.])${name.replace(/[.$]/g, '\\$&')}(?![\\w$])`;
      const elsewhere = masked.filter((_, k) => k !== lineIdx).join('\n');
      const observed = new RegExp(`\\b(?:await|return|yield)\\s+${n}|${n}\\s*!?\\s*\\??\\.then\\s*\\(`).test(elsewhere);
      if (observed) return { guarded: true, shape: 'stored-reference', context: name };
    }
    return { guarded: false };
  }

  /** `await this.client.end()` → `end`; `ownedDispose?.()` → `ownedDispose`; a bare reference → null. */
  _calleeBefore(before) {
    const t = before.trimEnd();
    if (!t.endsWith(')')) return null;
    let depth = 0;
    let p = t.length - 1;
    for (; p >= 0; p -= 1) {
      if (t[p] === ')') depth += 1;
      else if (t[p] === '(') { depth -= 1; if (depth === 0) break; }
    }
    if (p <= 0) return null;
    const m = t.slice(0, p).match(/([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*$/);
    return m ? m[1] : null;
  }

  _catchNoopDetails({ rel, line, isHarness, guard, commentOnly, what, suggestion }) {
    const at = `${rel}:${line}`;
    if (guard && guard.guarded) {
      const why = {
        'stored-reference': `the promise is held in \`${guard.context}\`, which this file awaits or returns elsewhere — the noop handler only marks the rejection as observed`,
        rethrow: 'the next statement is a `throw`, so the function is already failing with its primary cause',
        cleanup: `this is teardown (${guard.context}) — the resource is being discarded and a failure to discard it has no consumer`,
        'consumed-sentinel': guard.consumerLine
          ? `the returned sentinel is read at line ${guard.consumerLine} (\`${guard.context}\`) — the checked-return idiom, not a swallow`
          : `the returned sentinel is read by ${guard.context} in the same statement — the checked-return idiom, not a swallow`,
      }[guard.shape];
      return {
        severity: 'warning',
        file: rel,
        line,
        guarded: guard.shape,
        message: `${at} ${what}, but the rejection is not lost — ${why}`,
        suggestion: 'Not blocking. If the rejection carries information (a teardown that leaks, a connect that never succeeds), log it inside the handler instead of discarding it.',
      };
    }
    return {
      severity: isHarness || commentOnly ? 'warning' : 'error',
      file: rel,
      line,
      message: `${at} ${what} — Promise rejection is silently dropped`,
      suggestion,
    };
  }

  /**
   * The finding for an empty / comment-only catch, at the severity its
   * evidence supports.
   *
   *   error    a bare `catch {}` in shipped code whose failure nothing
   *            downstream can observe — the real swallow
   *   warning  a comment-only catch (a comment documents intent, it does not
   *            handle the error), a catch in a test/benchmark harness, or a
   *            GUARDED ATTEMPT: the try's success path exits and code follows,
   *            or the try only assigns a target the next statement tests
   *
   * A guarded attempt is downgraded, never dropped. "The repo went quiet" is
   * not evidence that a rule got smarter, so the finding stays on the report
   * with the reason it is not blocking written into it.
   */
  _emptyCatchDetails({ rel, line, isHarness, isBareEmpty, guard }) {
    const at = `${rel}:${line}`;
    if (!isBareEmpty) {
      return {
        severity: 'warning',
        file: rel,
        line,
        message: `${at} catch block contains only comments — a comment documents intent but does not handle the error`,
        suggestion: 'A comment alone doesn\'t handle the error — if it\'s genuinely safe to ignore, keep the comment AND add a log call so the swallow is visible in production.',
      };
    }
    if (guard && guard.guarded) {
      const docWhere = { before: 'right above the try', inside: 'on the first line of the try', after: 'after the catch' }[guard.where];
      const why = {
        fallthrough: 'the try block exits on success, so the code after the catch IS the failure path',
        'checked-target': `the try block only sets \`${guard.target}\`, which the code after the catch then tests`,
        rethrow: 'the code after the catch throws, so the function is already failing with its primary cause',
        cleanup: guard.context === 'finally'
          ? 'the catch is inside a `finally` block, where a thrown cleanup error would replace the primary result'
          : `the catch is inside \`${guard.context}()\`, a teardown — the resource is being discarded`,
        documented: `a comment ${docWhere} (line ${guard.commentLine}) explains the attempt — the same standing as a comment-only catch`,
        'opt-in': `the catch sits under \`if (${guard.flag})\` — silence the caller switched on by name`,
        nested: `the catch is inside a try whose own catch (line ${guard.outerLine}) is empty — the failure is erased one level up regardless, and that outer catch is the finding`,
        observer: 'the try/catch is the whole body of an anonymous async function that only awaits — a rejection observer marking the promise handled, the same standing as `.catch(noop)` on a promise held elsewhere',
        'result-return': 'the try block returns on its success paths and the code after the catch returns its own value — the caller receives the outcome',
      }[guard.shape];
      return {
        severity: 'warning',
        file: rel,
        line,
        guarded: guard.shape,
        message: `${at} has an empty catch block, but the failure is handled by the surrounding control flow — ${why}`,
        suggestion: 'Not blocking: this reads as an attempted operation with a fallback path, not a swallowed error. Confirm the fallback covers every failure (a bare `catch` also swallows programmer errors such as TypeError); one comment naming the fallback makes that explicit.',
      };
    }
    return {
      severity: isHarness ? 'warning' : 'error',
      file: rel,
      line,
      message: `${at} has an empty catch block — any error thrown in the try is erased`,
      suggestion: 'At minimum log the error with context; preferably rethrow or handle it. If the error is genuinely expected and benign, comment WHY.',
    };
  }

  // Best-effort block-body extractor. Starting at `masked[lineIdx]` with
  // `{` at or after `hintIdx`, walk forward counting braces on the MASKED
  // text (a brace inside a string or a comment is not a brace) and return
  // the text between the outermost braces twice — `body` raw, `code` masked
  // — plus whether the block was closed.
  _collectBlockBody(masked, lines, lineIdx, hintIdx) {
    const braceIdx = (masked[lineIdx] || '').indexOf('{', hintIdx);
    if (braceIdx === -1) return { body: '', code: '', closed: false };

    let depth = 1;
    let body = '';
    let code = '';
    const done = (closed) => ({ body: body.trim(), code: code.trim(), closed });
    const walkLine = (j, from) => {
      const m = masked[j] || '';
      const r = lines[j] || '';
      for (let k = from; k < m.length; k += 1) {
        const ch = m[k];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) return true;
        }
        body += r[k];
        code += ch;
      }
      return false;
    };
    if (walkLine(lineIdx, braceIdx + 1)) return done(true);
    for (let j = lineIdx + 1; j < lines.length && j < lineIdx + 40; j += 1) {
      body += '\n';
      code += '\n';
      if (walkLine(j, 0)) return done(true);
    }
    return done(false);
  }

  // True if the catch body only contains `console.*` calls (or a
  // comment) and no throw / reject / return with an error.
  _isLogAndEat(body) {
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    if (lines.length === 0) return false;
    // Must not throw or reject or return an error value
    if (/\bthrow\b/.test(body)) return false;
    if (/\breject\s*\(/.test(body)) return false;
    if (/\breturn\s+.*\berr(?:or)?\b/.test(body)) return false;
    if (/\bnext\s*\(\s*\w+/.test(body)) return false; // Express-style next(err)
    // A catch that ends the process is the opposite of a swallow: nothing
    // downstream runs to be misled. `console.error(...); process.exit(2)`
    // is the standard CLI shape and was reported as log-and-eat until
    // 2026-09-05 (bin/gatetest.js verify-report).
    if (/\bprocess\.(?:exit\s*\(|exitCode\s*=)/.test(body)) return false;
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
