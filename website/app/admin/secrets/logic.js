/**
 * /admin/secrets — pure logic for the infra-secrets panel.
 *
 * Everything the panel DECIDES lives here (grouping, state/liveness marks,
 * error-code copy, apply copy, the step-up retry, the reveal timer, the
 * value generator) so `node --test` can assert it without a browser or a
 * TS loader. The React component only renders what these return.
 *
 * Plain CommonJS on purpose, same reason as app/legal/_facts.js: importable
 * by the Next page AND require()-able by node:test.
 *
 * Design rule (owner, 2026-09-30): a clean white system with no red, orange
 * or yellow. Severity is carried by ink, weight and shape — so the marks
 * below name a SHAPE and an INK ("accent" | "ink" | "muted"), never a hue.
 *
 * Values rule: nothing in this file ever receives, returns or formats a
 * secret value, except `generateSecretValue` (which creates one for the
 * owner's own input field) and `scheduleRevealClear` (which only ever calls
 * the caller's clear function).
 */

/** How long a revealed value stays in state before it is cleared. */
const REVEAL_MS = 30 * 1000;

/** Tier order in the table, and the heading each one gets. */
const TIERS = ['required', 'important', 'optional', 'custom'];
const TIER_LABELS = {
  required: 'Required',
  important: 'Important',
  optional: 'Optional',
  custom: 'Custom',
};

/** Env-var shaped names only: UPPER_SNAKE_CASE, starting with a letter. */
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const NAME_MAX = 128;

/**
 * @param {string} name
 * @returns {string | null} a plain-language reason, or null when valid
 */
function nameProblem(name) {
  if (typeof name !== 'string' || name.length === 0) return 'Enter a name.';
  if (name.length > NAME_MAX) return `Names are at most ${NAME_MAX} characters.`;
  if (!NAME_RE.test(name)) return 'Use UPPER_SNAKE_CASE: capital letters, digits and underscores, starting with a letter.';
  return null;
}

/**
 * Group items by tier in the fixed order Required, Important, Optional,
 * Custom. Unknown tiers fall into Custom. Empty tiers are omitted. Names are
 * sorted within a tier so the table is stable between reloads.
 *
 * @template {{ name: string, tier: string }} T
 * @param {readonly T[]} items
 * @returns {{ tier: string, label: string, items: T[] }[]}
 */
function groupByTier(items) {
  /** @type {Record<string, T[]>} */
  const buckets = { required: [], important: [], optional: [], custom: [] };
  for (const item of items || []) {
    const tier = TIERS.includes(item.tier) ? item.tier : 'custom';
    buckets[tier].push(item);
  }
  return TIERS.filter((t) => buckets[t].length > 0).map((t) => ({
    tier: t,
    label: TIER_LABELS[t],
    items: buckets[t].slice().sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/**
 * The mark for a row's state. `shape` is what the CSS draws; `ink` is which
 * token colours it; `strong` is semibold text. No hue carries meaning.
 *
 * @param {string} state
 * @returns {{ shape: 'dot' | 'ring', ink: 'accent' | 'ink' | 'muted', label: string, strong: boolean }}
 */
function stateMark(state) {
  switch (state) {
    case 'set':
      return { shape: 'dot', ink: 'accent', label: 'Set', strong: false };
    case 'missing':
      return { shape: 'dot', ink: 'ink', label: 'Missing', strong: true };
    case 'placeholder':
      return { shape: 'ring', ink: 'muted', label: 'Placeholder', strong: false };
    default:
      return { shape: 'ring', ink: 'muted', label: 'Unknown', strong: false };
  }
}

/**
 * @param {string} liveness
 * @returns {{ ink: 'accent' | 'ink' | 'muted', label: string, strong: boolean }}
 */
function livenessMark(liveness) {
  switch (liveness) {
    case 'alive':
      return { ink: 'accent', label: 'Alive', strong: false };
    case 'dead':
      return { ink: 'ink', label: 'Dead', strong: true };
    case 'cannot-tell':
      return { ink: 'muted', label: 'Cannot tell', strong: false };
    case 'unchecked':
    default:
      return { ink: 'muted', label: 'Unchecked', strong: false };
  }
}

/** @param {string} source */
function sourceLabel(source) {
  switch (source) {
    case 'store':
      return 'Store';
    case 'env':
      return 'Env file';
    case 'both':
      return 'Store + env file';
    case 'none':
    default:
      return 'Nowhere';
  }
}

/** @param {string | undefined} winner */
function shadowCopy(winner) {
  const w = winner === 'store' ? 'store' : winner === 'env' ? 'env file' : winner || 'other';
  return `Shadowed: the ${w} value wins at runtime`;
}

/**
 * The first 8 hex characters of a fingerprint, or '' when the server sent
 * something that is not hex (defence: a non-hex string here could be a value
 * that leaked into the wrong field, and it must never be rendered).
 *
 * @param {string | undefined | null} fp
 */
function shortFingerprint(fp) {
  if (typeof fp !== 'string') return '';
  const s = fp.trim().toLowerCase();
  if (!/^[0-9a-f]{8,}$/.test(s)) return '';
  return s.slice(0, 8);
}

/**
 * "just now", "3 min ago", "2 h ago", "5 d ago". Relative to `now` (ms).
 *
 * @param {string | undefined | null} iso
 * @param {number} [now]
 */
function relativeTime(iso, now) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, (now === undefined ? Date.now() : now) - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/**
 * HH:MM in local time, 24-hour — for "fresh until HH:MM".
 *
 * @param {string | number | undefined | null} when
 */
function clockTime(when) {
  if (when === undefined || when === null || when === '') return '';
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Liveness plus how old it is, because the column is a cached answer: only
 * Verify asks the vendor.
 *
 * @param {string} liveness
 * @param {string | undefined} lastVerifiedAt
 * @param {number} [now]
 */
function livenessDetail(liveness, lastVerifiedAt, now) {
  if (liveness === 'unchecked' || !lastVerifiedAt) return 'never checked';
  const rel = relativeTime(lastVerifiedAt, now);
  return rel ? `checked ${rel}` : '';
}

/** Plain-language copy for every error code the contract names. */
const ERROR_COPY = {
  invalid_name: 'That name is not allowed. Use UPPER_SNAKE_CASE: capital letters, digits and underscores, starting with a letter.',
  value_empty: 'The value is empty. Type or generate a value before saving.',
  value_too_long: 'The value is too long for the store.',
  value_invalid_chars: 'The value contains characters the env file cannot hold (for example a line break). Remove them and try again.',
  step_up_required: 'This action needs your admin password again.',
  reserved_name: 'That name is reserved. It is set in the box env file only and cannot be changed here.',
  store_unavailable: 'The secrets store is not available: the master key is not configured on the server. See docs/ops/secrets-panel.md.',
  bad_password: 'That password is not correct.',
  throttled: 'Too many attempts. Wait a minute and try again.',
  unauthorized: 'Not signed in as admin. Sign in at /admin first.',
  not_found: 'That secret no longer exists. The list has been refreshed.',
  network: 'Could not reach the server. Check the connection and try again.',
};

/**
 * @param {string | undefined | null} code
 * @param {number} [status]
 */
function errorCopy(code, status) {
  if (code && Object.prototype.hasOwnProperty.call(ERROR_COPY, code)) return ERROR_COPY[code];
  if (status === 401) return ERROR_COPY.unauthorized;
  if (status === 403) return ERROR_COPY.step_up_required;
  if (status === 404) return ERROR_COPY.not_found;
  if (status === 429) return ERROR_COPY.throttled;
  if (status === 503) return ERROR_COPY.store_unavailable;
  if (status && status >= 500) return `The server could not finish that (HTTP ${status}). Nothing was shown or logged.`;
  return 'Something went wrong. Try again.';
}

/**
 * The header's apply line. `pending` is the NORMAL "the store changed and the
 * env file has not been rewritten yet" state (listing reason `out_of_sync`):
 * neutral, answered by an Apply action, never worded as a failure.
 *
 * @param {{ lastAppliedAt?: string | null, applied?: boolean, reason?: string } | undefined} s
 * @param {number} [now]
 * @returns {{ ok: boolean, pending: boolean, text: string }}
 */
function applyStateCopy(s, now) {
  if (!s) return { ok: false, pending: false, text: 'Not applied yet' };
  const last = s.lastAppliedAt ? relativeTime(s.lastAppliedAt, now) || s.lastAppliedAt : '';
  if (s.applied === false && s.reason === 'out_of_sync') {
    return { ok: false, pending: true, text: last ? `Changes not applied yet (last applied ${last})` : 'Changes not applied yet' };
  }
  if (s.applied === false && s.reason) return { ok: false, pending: false, text: `Could not write the env file: ${applyReasonCopy(s.reason)}` };
  if (s.lastAppliedAt) return { ok: true, pending: false, text: `Last applied ${last}` };
  return { ok: false, pending: false, text: 'Not applied yet' };
}

/** @param {string} reason */
function applyReasonCopy(reason) {
  switch (reason) {
    case 'target-missing':
    case 'target_missing':
      return 'the env file does not exist on this host';
    case 'unchanged':
      return 'the env file already matched, so nothing needed writing';
    case 'store_unavailable':
      return 'the store is not available';
    case 'would_drop_keys':
      return 'the env file holds names the store no longer has, and Apply never removes a name without asking';
    case 'out_of_sync':
      return 'the store changed since the env file was last written';
    case 'readback_mismatch':
      return 'the file read back differently from what was written, so the previous file was kept';
    case 'permission_denied':
    case 'EACCES':
      return 'the service cannot write the env file (permission denied)';
    default:
      return reason;
  }
}

/**
 * What to say after a set / delete / apply finished, about the env file.
 *
 * @param {{ applied?: boolean, reason?: string } | undefined} apply
 * @returns {{ ok: boolean, text: string }}
 */
function applyResultCopy(apply) {
  if (!apply) return { ok: false, text: 'Saved to the store. The env file was not reported on; use Apply to service.' };
  if (apply.applied) return { ok: true, text: 'Applied — the service restarts automatically when the env file changes.' };
  return {
    ok: false,
    text: `Saved to the store, but the env file was not written: ${apply.reason ? applyReasonCopy(apply.reason) : 'no reason given'}.`,
  };
}

/**
 * The names an apply answer is waiting on the owner to confirm removing:
 * `would_drop_keys` means the env file holds names the store no longer has,
 * and the server removes them only when a retry lists them in `allowRemoving`.
 * Any other answer (applied, or a different reason) returns [].
 *
 * @param {{ applied?: boolean, reason?: string, dropped?: unknown } | undefined} r
 * @returns {string[]}
 */
function namesToDrop(r) {
  if (!r || r.applied || r.reason !== 'would_drop_keys' || !Array.isArray(r.dropped)) return [];
  return r.dropped.filter((n) => typeof n === 'string' && n.length > 0);
}

/**
 * The audit drawer's chain line. Intact ONLY when the server said so
 * explicitly; a missing or malformed `chain` is "cannot tell", never intact.
 * `brokenAt` is the 0-based index of the first bad row, oldest first.
 *
 * @param {{ ok?: unknown, count?: unknown, brokenAt?: unknown } | null | undefined} chain
 * @returns {{ state: 'intact' | 'broken' | 'unknown', shape: 'dot' | 'ring', ink: 'accent' | 'ink' | 'muted', strong: boolean, text: string }}
 */
function chainStatus(chain) {
  if (chain && typeof chain === 'object' && chain.ok === true) {
    const n = Number.isInteger(chain.count) ? chain.count : null;
    const text = n === null ? 'Chain intact' : `Chain intact across all ${n} entr${n === 1 ? 'y' : 'ies'}`;
    return { state: 'intact', shape: 'dot', ink: 'accent', strong: false, text };
  }
  if (chain && typeof chain === 'object' && chain.ok === false) {
    const at = Number.isInteger(chain.brokenAt) && chain.brokenAt >= 0 ? chain.brokenAt + 1 : null;
    const text = at === null ? 'Chain broken (the server did not say where)' : `Chain broken at entry ${at}, counting from the oldest`;
    return { state: 'broken', shape: 'dot', ink: 'ink', strong: true, text };
  }
  return { state: 'unknown', shape: 'ring', ink: 'muted', strong: false, text: 'Chain: cannot tell (the server did not report it)' };
}

const LIVENESS_OUTCOMES = ['alive', 'dead', 'cannot-tell', 'unchecked'];

/**
 * How an audit row's outcome is inked. A verify row's outcome is the vendor's
 * liveness answer, not a success-or-failure, so it takes the same mark as the
 * table's Liveness column; any other row is ok (accent) or a failure (ink,
 * semibold).
 *
 * @param {{ action?: string, outcome?: string } | undefined} entry
 * @returns {{ ink: 'accent' | 'ink' | 'muted', strong: boolean, label: string }}
 */
function auditOutcomeMark(entry) {
  const outcome = entry && typeof entry.outcome === 'string' ? entry.outcome : '';
  if (entry && entry.action === 'verify' && LIVENESS_OUTCOMES.includes(outcome)) {
    const m = livenessMark(outcome);
    return { ink: m.ink, strong: m.strong, label: m.label };
  }
  if (outcome === 'ok' || outcome === 'success') return { ink: 'accent', strong: false, label: outcome };
  return { ink: 'ink', strong: true, label: outcome || 'unknown' };
}

/**
 * Shorten a long string (an IPv6 address, a forwarded-for chain) by cutting
 * the MIDDLE, so both the network prefix and the host end stay readable.
 *
 * @param {string | null | undefined} s
 * @param {number} [max]  longest result, ellipsis included (default 20, at least 5)
 */
function middleTruncate(s, max) {
  if (typeof s !== 'string') return '';
  const limit = Math.max(5, Math.floor(max === undefined ? 20 : max));
  if (s.length <= limit) return s;
  const keep = limit - 1;
  return `${s.slice(0, Math.ceil(keep / 2))}…${s.slice(s.length - Math.floor(keep / 2))}`;
}

/**
 * PUT may return `warnings`, e.g. `same_value_as:OTHER_NAME`.
 *
 * @param {string} w
 */
function warningCopy(w) {
  if (typeof w !== 'string') return '';
  const m = /^same_value_as:(.+)$/.exec(w);
  if (m) return `This value is also stored as ${m[1]}.`;
  return w;
}

/**
 * Run `action`; if it fails with `step_up_required`, ask for the password
 * via `requestStepUp` (resolves true once the step-up succeeded, false if the
 * owner cancelled) and retry the action ONCE. A second step-up failure, or
 * any other error, is thrown to the caller.
 *
 * @template T
 * @param {() => Promise<T>} action
 * @param {() => Promise<boolean>} requestStepUp
 * @returns {Promise<T>}
 */
async function runWithStepUp(action, requestStepUp) {
  try {
    return await action();
  } catch (err) {
    if (!err || err.code !== 'step_up_required') throw err;
    const ok = await requestStepUp();
    if (!ok) throw err;
    return action();
  }
}

/**
 * Schedule the reveal clear. Returns a cancel function. The caller's
 * `clear` is invoked exactly once, after `ms` (default 30 s), unless
 * cancelled first.
 *
 * @param {() => void} clear
 * @param {number} [ms]
 * @returns {() => void}
 */
function scheduleRevealClear(clear, ms) {
  let done = false;
  const id = setTimeout(() => {
    if (done) return;
    done = true;
    clear();
  }, ms === undefined ? REVEAL_MS : ms);
  return () => {
    done = true;
    clearTimeout(id);
  };
}

/** Delete is confirmed only by typing the exact name. */
function deleteConfirmed(typed, name) {
  return typeof typed === 'string' && typeof name === 'string' && name.length > 0 && typed === name;
}

/**
 * A strong random value for the owner's input field: `bytes` bytes (default
 * 48) from the platform CSPRNG, base64url without padding. Throws rather
 * than fall back to a weak source.
 *
 * @param {number} [bytes]
 */
function generateSecretValue(bytes) {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('no secure random source available');
  }
  const buf = new Uint8Array(bytes === undefined ? 48 : bytes);
  c.getRandomValues(buf);
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

module.exports = {
  REVEAL_MS,
  TIERS,
  TIER_LABELS,
  NAME_MAX,
  nameProblem,
  groupByTier,
  stateMark,
  livenessMark,
  livenessDetail,
  sourceLabel,
  shadowCopy,
  shortFingerprint,
  relativeTime,
  clockTime,
  errorCopy,
  applyStateCopy,
  applyReasonCopy,
  applyResultCopy,
  namesToDrop,
  chainStatus,
  auditOutcomeMark,
  middleTruncate,
  warningCopy,
  runWithStepUp,
  scheduleRevealClear,
  deleteConfirmed,
  generateSecretValue,
};
