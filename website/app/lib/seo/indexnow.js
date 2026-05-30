/**
 * IndexNow — instant URL submission protocol.
 *
 * IndexNow (https://www.indexnow.org) is a standardised protocol backed
 * by Microsoft Bing, Yandex, Seznam, and Naver. One push notifies all
 * participating engines that a URL was created / updated / deleted.
 *
 * Why it's green (not black-hat):
 *   - You can only push URLs from your own host
 *   - You verify ownership by hosting a key file at /<key>.txt
 *   - There's a daily quota; bursts get throttled
 *   - The protocol is designed to REPLACE constant crawling, not add
 *     to it — better for the open web
 *
 * Google does NOT support IndexNow. Google's recommendation is to keep
 * the sitemap fresh and let the standard sitemap-ping pathway work.
 * See google-sitemap-ping.js for that surface.
 *
 * Boss-Rule respect: this module READS our own sitemap and sends URL
 * notifications. It does NOT call Google / Bing search APIs that
 * require accounts, OAuth, or paid quota.
 */

"use strict";

const crypto = require("crypto");

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/IndexNow";
const HOST = "gatetest.ai";
const MAX_URLS_PER_BATCH = 10_000; // IndexNow protocol limit
const SOFT_RATE_LIMIT = 1_000;     // honour per-batch quota courtesy

/**
 * Generate a stable IndexNow key. Each origin needs ONE key, hosted at
 * https://<host>/<key>.txt with the same key as content. Re-use the
 * same key across all submissions for that origin.
 *
 * @returns {string} 32-char hex key
 */
function generateIndexNowKey() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Validate an IndexNow key against the protocol's shape constraints
 * (8-128 chars, alphanumeric + hyphens).
 *
 * @param {string} key
 * @returns {boolean}
 */
function isValidKey(key) {
  if (!key || typeof key !== "string") return false;
  if (key.length < 8 || key.length > 128) return false;
  return /^[a-zA-Z0-9-]+$/.test(key);
}

/**
 * Validate that every URL belongs to our host. IndexNow rejects
 * mixed-host batches. Returns split lists so the caller sees which were
 * dropped and why.
 *
 * @param {string[]} urls
 * @returns {{ valid: string[], rejected: Array<{ url: string, reason: string }> }}
 */
function partitionByOriginValid(urls) {
  const valid = [];
  const rejected = [];
  for (const url of urls) {
    if (!url || typeof url !== "string") {
      rejected.push({ url: String(url), reason: "not-a-string" });
      continue;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      rejected.push({ url, reason: "malformed-url" });
      continue;
    }
    if (parsed.host !== HOST) {
      rejected.push({ url, reason: `host-mismatch (got ${parsed.host}, want ${HOST})` });
      continue;
    }
    if (parsed.protocol !== "https:") {
      rejected.push({ url, reason: "must-be-https" });
      continue;
    }
    valid.push(url);
  }
  return { valid, rejected };
}

/**
 * Submit a batch of URLs to IndexNow. Honours the protocol's
 * MAX_URLS_PER_BATCH cap by splitting into chunks.
 *
 * @param {object} args
 * @param {string[]} args.urls
 * @param {string} args.key                IndexNow key (same one hosted at the key file)
 * @param {string} [args.host=gatetest.ai]
 * @param {function} [args._fetch]
 * @returns {Promise<{
 *   submitted: number,
 *   rejected: Array<{ url: string, reason: string }>,
 *   batches: Array<{ count: number, status: number, ok: boolean, error?: string }>,
 * }>}
 */
async function submitUrls({ urls, key, host = HOST, _fetch }) {
  if (!Array.isArray(urls)) {
    throw new TypeError("submitUrls: urls must be an array");
  }
  if (!isValidKey(key)) {
    throw new TypeError("submitUrls: invalid IndexNow key (must be 8-128 chars alphanumeric/hyphen)");
  }
  const fetchImpl = _fetch || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) throw new Error("submitUrls: no fetch available; pass _fetch for tests");

  const { valid, rejected } = partitionByOriginValid(urls);
  if (valid.length === 0) {
    return { submitted: 0, rejected, batches: [] };
  }

  // Soft rate-limit batches to SOFT_RATE_LIMIT URLs each — well under the
  // 10k protocol cap but still very efficient.
  const batches = [];
  for (let i = 0; i < valid.length; i += SOFT_RATE_LIMIT) {
    batches.push(valid.slice(i, i + SOFT_RATE_LIMIT));
  }

  const batchResults = [];
  let submittedTotal = 0;
  for (const batch of batches) {
    const body = {
      host,
      key,
      keyLocation: `https://${host}/${key}.txt`,
      urlList: batch,
    };
    try {
      const res = await fetchImpl(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
      const ok = !!res && res.status >= 200 && res.status < 300;
      batchResults.push({ count: batch.length, status: res ? res.status : null, ok });
      if (ok) submittedTotal += batch.length;
    } catch (err) {
      batchResults.push({
        count: batch.length,
        status: null,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  return { submitted: submittedTotal, rejected, batches: batchResults };
}

module.exports = {
  generateIndexNowKey,
  isValidKey,
  partitionByOriginValid,
  submitUrls,
  INDEXNOW_ENDPOINT,
  HOST,
  MAX_URLS_PER_BATCH,
  SOFT_RATE_LIMIT,
};
