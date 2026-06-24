'use strict';
/**
 * Mutation engine — canonical mutation operators for the mutationTesting
 * module. Extracted for independent unit-testing.
 *
 * Upgraded with:
 *  • Lexical Scope Quarantine — character-level state machine masks string
 *    literals, template literals, and comments before operator matching,
 *    preventing false mutations inside data / prompt strings.
 *  • Boilerplate guard — skips structural declarations (module.exports,
 *    type/interface/enum blocks, export-default objects, bare closing braces)
 *    that carry no mutable execution logic.
 */

const MUTATIONS = [
  // Conditional / equality mutations
  { name: 'negate-conditional',     pattern: /===\s/g,                replace: '!== ', desc: 'Negated conditional (=== → !==)' },
  { name: 'negate-conditional-eq',  pattern: /!==\s/g,                replace: '=== ', desc: 'Negated conditional (!== → ===)' },
  // Boundary mutations
  { name: 'boundary-lt',            pattern: /<\s/g,                  replace: '<= ',  desc: 'Boundary tightened (< → <=)' },
  { name: 'boundary-lte',           pattern: /<=\s/g,                 replace: '< ',   desc: 'Boundary loosened (<= → <)' },
  { name: 'boundary-gt',            pattern: />\s/g,                  replace: '>= ',  desc: 'Boundary tightened (> → >=)' },
  { name: 'boundary-gte',           pattern: />=\s/g,                 replace: '> ',   desc: 'Boundary loosened (>= → >)' },
  // Math operator swaps
  { name: 'math-add',               pattern: /\+(?!=)/g,              replace: '-',    desc: 'Math swap (+ → -)' },
  { name: 'math-sub',               pattern: /(?<!=)-(?!=)/g,         replace: '+',    desc: 'Math swap (- → +)' },
  // Return-value flips
  // Word-boundary anchors: `return true` should not match `return trueish`.
  { name: 'return-true',            pattern: /return true\b/g,        replace: 'return false', desc: 'Flipped return true' },
  { name: 'return-false',           pattern: /return false\b/g,       replace: 'return true',  desc: 'Flipped return false' },
  { name: 'remove-return',          pattern: /return\s+(?!;)/g,       replace: 'return void ', desc: 'Voided return value' },
  { name: 'empty-string',           pattern: /return ['"](.+?)['"]/g, replace: 'return ""',    desc: 'Emptied return string' },
  { name: 'zero-constant',          pattern: /return\s+(\d+)/g,       replace: 'return 0',     desc: 'Zeroed return constant' },
  { name: 'null-return',            pattern: /return\s+\{/g,          replace: 'return null && {', desc: 'Nulled return object' },
  { name: 'array-empty',            pattern: /return\s+\[/g,          replace: 'return [] && [', desc: 'Emptied return array' },
  // Increment / decrement
  { name: 'increment-swap',         pattern: /\+\+/g,                 replace: '--',   desc: 'Swapped ++ for --' },
  { name: 'decrement-swap',         pattern: /--/g,                   replace: '++',   desc: 'Swapped -- for ++' },
  // Logical operator swaps
  { name: 'and-to-or',              pattern: /&&/g,                   replace: '||',   desc: 'Swapped && for ||' },
  { name: 'or-to-and',              pattern: /\|\|/g,                 replace: '&&',   desc: 'Swapped || for &&' },
];

// ── Lexical state machine ─────────────────────────────────────────────────────

/**
 * Build a Set of character indices in `line` that reside inside a string
 * literal or comment context. `state` is mutated in-place so callers can
 * thread it across consecutive lines for multi-line template literals and
 * block comments.
 *
 * Handles: '' "" `` (including multi-line) // and /* block comments.
 *
 * @param {string} line
 * @param {{ inBlock: boolean, inBacktick: boolean }} state — mutated in-place
 * @returns {Set<number>}
 */
function _buildLineMask(line, state) {
  const masked = new Set();
  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    // Inside /* ... */ block comment
    if (state.inBlock) {
      masked.add(i);
      if (ch === '*' && line[i + 1] === '/') { masked.add(i + 1); i += 2; state.inBlock = false; }
      else i++;
      continue;
    }

    // Inside backtick template literal (may span lines)
    if (state.inBacktick) {
      masked.add(i);
      if (ch === '\\') { if (i + 1 < line.length) { masked.add(i + 1); } i += 2; }
      else { if (ch === '`') state.inBacktick = false; i++; }
      continue;
    }

    // Line comment: everything from here to end of line is masked
    if (ch === '/' && line[i + 1] === '/') {
      for (let j = i; j < line.length; j++) masked.add(j);
      break;
    }

    // Block comment opens on this line
    if (ch === '/' && line[i + 1] === '*') {
      masked.add(i); masked.add(i + 1); i += 2; state.inBlock = true;
      continue;
    }

    // Backtick template literal (may not close on this line)
    if (ch === '`') { masked.add(i); state.inBacktick = true; i++; continue; }

    // Single-quoted or double-quoted string (no line continuation)
    if (ch === "'" || ch === '"') {
      const q = ch;
      masked.add(i); i++;
      while (i < line.length) {
        masked.add(i);
        if (line[i] === '\\') { i++; if (i < line.length) { masked.add(i); i++; } }
        else if (line[i] === q) { i++; break; }
        else i++;
      }
      continue;
    }

    i++;
  }
  return masked;
}

/**
 * True if the half-open range [start, end) overlaps any masked position.
 */
function _inMasked(masked, start, end) {
  for (let i = start; i < end; i++) { if (masked.has(i)) return true; }
  return false;
}

// ── Boilerplate guard ─────────────────────────────────────────────────────────

/**
 * True for lines that are structural / declarative and carry no mutable
 * execution logic: module.exports assignments, exports.X = ... ,
 * TypeScript type/interface/enum headers, export-default object openers,
 * and bare closing-brace / closing-bracket lines.
 *
 * Mutating these produces syntactically broken output rather than a
 * meaningful test of business logic.
 */
function _isBoilerplateLine(line) {
  const t = line.trim();
  if (/^module\.exports\s*=/.test(t)) return true;
  if (/^exports\.[A-Za-z_$]/.test(t)) return true;
  if (/^(type|interface|enum)\s+[A-Z_$]/.test(t)) return true;
  if (/^export\s+default\s+\{/.test(t)) return true;
  if (/^[}\]];?\s*$/.test(t)) return true; // bare closing brace/bracket line
  return false;
}

// ── shouldSkipLine ────────────────────────────────────────────────────────────

/**
 * Determine whether a single line should be excluded from mutation.
 * Skips comment-only lines, import/require lines, and blank lines.
 */
function shouldSkipLine(line) {
  if (typeof line !== 'string') return true;
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('*')) return true;
  if (trimmed.startsWith('/*')) return true;
  if (trimmed.startsWith('#')) return true; // shell / python
  if (/\brequire\s*\(/.test(trimmed)) return true;
  if (/^\s*import\s/.test(line)) return true;
  if (/^\s*from\s/.test(line)) return true;
  return false;
}

// ── applyMutation ─────────────────────────────────────────────────────────────

/**
 * Apply a single mutation operator to a single line of source.
 * Returns null if the operator doesn't match, or if every match falls
 * entirely inside a masked (string/comment) region.
 *
 * `masked` is an optional pre-computed Set<number> from _buildLineMask.
 * When provided, matches that fall entirely inside masked positions are
 * suppressed — the operator is only applied to actual code characters.
 *
 * Important: we reset `pattern.lastIndex` because all operators use the
 * global flag (we'd otherwise get state leakage between calls).
 */
function applyMutation(line, mutation, masked) {
  if (typeof line !== 'string') return null;
  if (!mutation || !mutation.pattern || !mutation.replace) return null;
  if (shouldSkipLine(line)) return null;

  // Build a single-line mask if not pre-supplied by generateMutations.
  const lexMask = masked || _buildLineMask(line, { inBlock: false, inBacktick: false });

  mutation.pattern.lastIndex = 0;
  if (!mutation.pattern.test(line)) { mutation.pattern.lastIndex = 0; return null; }

  // Apply replacement — skip any match whose range overlaps a masked region.
  // The replace callback receives (match, ...groups, offset, wholeString)
  // so the offset is always args[args.length - 2] regardless of group count.
  mutation.pattern.lastIndex = 0;
  const mutated = line.replace(mutation.pattern, function () {
    const args = arguments;
    const match  = args[0];
    const offset = args[args.length - 2];
    // Suppress only if the match STARTS inside a masked region (string or comment).
    // Using start-position rather than any-overlap so that operators like
    // `empty-string` — which intentionally span into a string literal — still
    // fire when the `return` keyword itself is outside the string.
    if (lexMask.has(offset)) return match; // preserve original
    return mutation.replace;
  });
  mutation.pattern.lastIndex = 0;

  if (mutated === line) return null;
  return mutated;
}

// ── generateMutations ─────────────────────────────────────────────────────────

/**
 * For a given source string, return all mutation candidates as
 * { lineNumber, original, mutated, mutation }. Bounded by maxPerFile
 * (default 50) so callers aren't flooded.
 *
 * Cross-line lexical state (backtick template literals, block comments)
 * is threaded through _buildLineMask sequentially so multi-line strings
 * are correctly masked across the whole file.
 *
 * The boilerplate guard skips structural declarations (module.exports,
 * type/interface/enum, bare closing braces) at any brace depth.
 */
function generateMutations(source, opts = {}) {
  if (typeof source !== 'string') return [];
  const maxPerFile = opts.maxPerFile || 50;
  const lines = source.split('\n');
  const candidates = [];

  // Build cross-line lexical masks sequentially.
  // _buildLineMask mutates maskState in place, so .map() processes lines
  // in order — correct for multi-line backtick templates and block comments.
  const maskState = { inBlock: false, inBacktick: false };
  const lineMasks = lines.map(l => _buildLineMask(l, maskState));

  for (let i = 0; i < lines.length; i++) {
    if (candidates.length >= maxPerFile) break;
    const line = lines[i];
    if (shouldSkipLine(line)) continue;
    if (_isBoilerplateLine(line)) continue;

    const masked = lineMasks[i];

    for (const mutation of MUTATIONS) {
      if (candidates.length >= maxPerFile) break;
      const mutated = applyMutation(line, mutation, masked);
      if (mutated == null) continue;
      candidates.push({ lineNumber: i + 1, original: line, mutated, mutation });
      // Only first matching operator per line — keeps candidates diverse
      // and test runtime bounded.
      break;
    }
  }
  return candidates;
}

// ── applyCandidate ────────────────────────────────────────────────────────────

/**
 * Apply a single candidate to the full source string. Returns the mutated
 * source. Helper for callers that want to apply-then-test.
 */
function applyCandidate(source, candidate) {
  if (typeof source !== 'string') return source;
  if (!candidate) return source;
  const lines = source.split('\n');
  const idx = candidate.lineNumber - 1;
  if (idx < 0 || idx >= lines.length) return source;
  lines[idx] = candidate.mutated;
  return lines.join('\n');
}

module.exports = {
  MUTATIONS,
  shouldSkipLine,
  applyMutation,
  generateMutations,
  applyCandidate,
  // Exported for testing
  _buildLineMask,
  _isBoilerplateLine,
};
