/**
 * Sitemap ping — the older but still-supported pathway for nudging
 * search engines to re-fetch our sitemap.xml.
 *
 * Status (as of 2026-05):
 *   - Google: deprecated the sitemap-ping endpoint in 2023. Their
 *     recommendation is to declare the sitemap in robots.txt and let
 *     crawlers discover updates on their own cadence. We respect that.
 *   - Bing: still accepts pings at https://www.bing.com/ping?sitemap=
 *   - Yandex: still accepts pings at https://webmaster.yandex.com/ping
 *
 * The green-system principle: only ping our OWN sitemap, no spam, no
 * faking host headers, no submitting other people's sitemaps.
 */

"use strict";

const SITEMAP_URL = "https://gatetest.ai/sitemap.xml";

/**
 * Per-engine ping URL builder. Each engine takes the sitemap URL as a
 * query parameter on a GET endpoint.
 */
const ENGINES = {
  bing: (sitemapUrl) => `https://www.bing.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
  yandex: (sitemapUrl) => `https://webmaster.yandex.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
};

/**
 * Ping one engine with our sitemap URL.
 *
 * @param {object} args
 * @param {keyof ENGINES} args.engine
 * @param {string} [args.sitemapUrl]
 * @param {function} [args._fetch]
 * @returns {Promise<{ engine: string, ok: boolean, status: number|null, error?: string }>}
 */
async function pingEngine({ engine, sitemapUrl = SITEMAP_URL, _fetch }) {
  const builder = ENGINES[engine];
  if (!builder) {
    return { engine, ok: false, status: null, error: `unknown-engine: ${engine}` };
  }
  const fetchImpl = _fetch || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) throw new Error("pingEngine: no fetch available; pass _fetch for tests");
  const url = builder(sitemapUrl);
  try {
    const res = await fetchImpl(url, { method: "GET" });
    return {
      engine,
      ok: !!res && res.status >= 200 && res.status < 300,
      status: res ? res.status : null,
    };
  } catch (err) {
    return {
      engine,
      ok: false,
      status: null,
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Ping every supported engine in parallel. Returns per-engine results.
 *
 * @param {object} args
 * @param {string} [args.sitemapUrl]
 * @param {function} [args._fetch]
 * @returns {Promise<Array<{ engine: string, ok: boolean, status: number|null, error?: string }>>}
 */
async function pingAllEngines({ sitemapUrl = SITEMAP_URL, _fetch } = {}) {
  const engines = Object.keys(ENGINES);
  return Promise.all(engines.map((engine) => pingEngine({ engine, sitemapUrl, _fetch })));
}

module.exports = {
  pingEngine,
  pingAllEngines,
  ENGINES,
  SITEMAP_URL,
};
