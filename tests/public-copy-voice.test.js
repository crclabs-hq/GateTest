// =============================================================================
// PUBLIC COPY SPEAKS LIKE AN OPERATOR — no slogans, metaphors or unbacked
// adjectives on any page a customer reads. The rules live in docs/VOICE.md.
// =============================================================================
// Craig, 2026-09-22: "we look like a joke saying [the old hero] … we need to
// talk like DevOps operators and full stack developers, we need to gain their
// trust." The hero, footer, meta title, enterprise and quickstart pages, the
// sibling-product taglines and two compare pages were rewritten the same day.
// This guard keeps the banned phrases from creeping back with the next
// landing page.
//
// Scope: every rendered source under website/app/ except
//   - admin/ and api/ (not customer-facing)
//   - legal/ (wording is the lawyer's, not marketing)
//   - scans/page.tsx, changelog data, blog-catalog.ts (dated records —
//     VOICE.md rule 10: never rewrite what was true when written)
// Code comments are stripped before matching, so a comment explaining why a
// phrase was removed does not fail the guard.
// =============================================================================
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'website', 'app');

const SKIP_DIRS = new Set(['admin', 'api', 'legal', 'node_modules']);
const SKIP_FILES = new Set([
  path.join(APP, 'scans', 'page.tsx'),
  path.join(APP, 'blog', 'blog-catalog.ts'),
]);
const EXT = new Set(['.tsx', '.ts', '.js', '.jsx']);

/** Phrase → why it is banned (kept next to the regex so the failure explains itself). */
const BANNED = [
  [/cry wolf/i, 'metaphor — say "fails only on new findings"'],
  [/while you sleep/i, 'slogan — say what runs and when'],
  [/keeps? (it|your code) honest/i, 'slogan — say what the gate checks'],
  [/self-healing ci/i, 'slogan — "the fix workflow in your CI"'],
  [/zero hype/i, 'saying it is hype'],
  [/surrendering control|unlock (ai )?velocity/i, 'executive-speak — name the controls'],
  [/\bpristine\b/i, 'adjective — nothing is measured as pristine'],
  [/with receipts/i, 'metaphor — "a record per run"'],
  [/\bai-native\b|\bedge-first\b|\bzero[- ]ops\b/i, 'unbacked positioning adjective'],
  [/brutally honest/i, 'adjective — say "explicit about limits"'],
  [/hiring managers/i, 'pressure copy'],
  [/\bcinematic\b|\bstunning\b|\bseamless(ly)?\b|\beffortless(ly)?\b/i, 'unbacked adjective'],
  [/enterprise-grade|world-class|best-in-class/i, 'unbacked superlative'],
  [/\bkills? (sonarqube|snyk|semgrep|codeql)\b/i, 'chest-beating — the compare pages carry the measurements'],
  [/\binstantly\b/i, 'unmeasured — say when it happens ("when checkout completes")'],
  [/smarter alternative|complete qa platform|developers are moving on|zero ceremony/i, 'headline puffery — say what differs'],
];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\"'`])\/\/[^\n]*/g, '$1');
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (EXT.has(path.extname(entry.name)) && !SKIP_FILES.has(full)) {
      yield full;
    }
  }
}

describe('public copy — operator voice (docs/VOICE.md)', () => {
  it('no banned slogan, metaphor or unbacked adjective on any customer-facing page', () => {
    const hits = [];
    for (const file of walk(APP)) {
      const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const [re, why] of BANNED) {
          const m = line.match(re);
          if (m) hits.push(`${path.relative(ROOT, file)}:${i + 1}: "${m[0]}" — ${why}`);
        }
      });
    }
    assert.deepStrictEqual(hits, [], `banned phrases in public copy:\n${hits.join('\n')}`);
  });

  it('the guard itself is not vacuous', () => {
    assert.ok(BANNED.some(([re]) => re.test('The gate that doesn\'t cry wolf.')));
    assert.ok(BANNED.some(([re]) => re.test('AI-native. Edge-first. Zero ops.')));
    assert.strictEqual(stripComments('x // pristine\n/* stunning */ y'), 'x \n y');
  });
});
