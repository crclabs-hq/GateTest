/**
 * HN reply assistant — draft queue store.
 *
 * Persists drafts to disk as JSON so a long-running watcher process
 * can hand off to a separate review surface (CLI now, dashboard later)
 * without losing state on restart.
 *
 * Layout:
 *   <queueDir>/
 *     state.json           ← seen comment IDs + last poll timestamp
 *     drafts/
 *       <commentId>.json   ← one file per drafted reply, with state field
 *
 * State machine for each draft:
 *   pending  → freshly drafted, awaiting review
 *   approved → human OK'd it (may or may not be posted yet)
 *   posted   → human marked as posted
 *   skipped  → human chose not to reply
 *
 * Pure logic over an injectable fs. Tests use an in-memory fs.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const STATE_FILE = "state.json";
const DRAFTS_DIR = "drafts";
const VALID_STATES = new Set(["pending", "approved", "posted", "skipped"]);

function ensureDir(dir, _fs) {
  if (!_fs.existsSync(dir)) _fs.mkdirSync(dir, { recursive: true });
}

function loadState({ queueDir, _fs = fs }) {
  const p = path.join(queueDir, STATE_FILE);
  if (!_fs.existsSync(p)) {
    return { seenCommentIds: [], lastPollUnix: null, storyId: null };
  }
  try {
    return JSON.parse(_fs.readFileSync(p, "utf8"));
  } catch {
    return { seenCommentIds: [], lastPollUnix: null, storyId: null };
  }
}

function saveState({ queueDir, state, _fs = fs }) {
  ensureDir(queueDir, _fs);
  _fs.writeFileSync(path.join(queueDir, STATE_FILE), JSON.stringify(state, null, 2));
}

function draftPath({ queueDir, commentId }) {
  return path.join(queueDir, DRAFTS_DIR, `${commentId}.json`);
}

function saveDraft({ queueDir, draftRecord, _fs = fs }) {
  if (!draftRecord || !draftRecord.comment || !draftRecord.comment.id) {
    throw new TypeError("saveDraft: draftRecord.comment.id required");
  }
  if (draftRecord.state && !VALID_STATES.has(draftRecord.state)) {
    throw new TypeError(`saveDraft: invalid state ${draftRecord.state}`);
  }
  const dir = path.join(queueDir, DRAFTS_DIR);
  ensureDir(dir, _fs);
  const rec = {
    state: "pending",
    draftedAt: new Date().toISOString(),
    ...draftRecord,
  };
  _fs.writeFileSync(draftPath({ queueDir, commentId: rec.comment.id }), JSON.stringify(rec, null, 2));
  return rec;
}

function loadDraft({ queueDir, commentId, _fs = fs }) {
  const p = draftPath({ queueDir, commentId });
  if (!_fs.existsSync(p)) return null;
  try {
    return JSON.parse(_fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function setDraftState({ queueDir, commentId, state, _fs = fs }) {
  if (!VALID_STATES.has(state)) {
    throw new TypeError(`setDraftState: invalid state ${state}`);
  }
  const rec = loadDraft({ queueDir, commentId, _fs });
  if (!rec) return null;
  rec.state = state;
  rec.stateUpdatedAt = new Date().toISOString();
  _fs.writeFileSync(draftPath({ queueDir, commentId }), JSON.stringify(rec, null, 2));
  return rec;
}

function listDrafts({ queueDir, stateFilter, _fs = fs }) {
  const dir = path.join(queueDir, DRAFTS_DIR);
  if (!_fs.existsSync(dir)) return [];
  const entries = _fs.readdirSync(dir);
  const out = [];
  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(_fs.readFileSync(path.join(dir, e), "utf8"));
      if (stateFilter && rec.state !== stateFilter) continue;
      out.push(rec);
    } catch { /* skip malformed */ }
  }
  // Oldest-first by drafted timestamp
  out.sort((a, b) => new Date(a.draftedAt) - new Date(b.draftedAt));
  return out;
}

module.exports = {
  loadState,
  saveState,
  saveDraft,
  loadDraft,
  setDraftState,
  listDrafts,
  draftPath,
  VALID_STATES,
  STATE_FILE,
  DRAFTS_DIR,
};
