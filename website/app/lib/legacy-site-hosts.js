'use strict';

/**
 * Former public hosts that must keep answering forever, as a permanent
 * redirect to the canonical origin with the path kept (website/next.config.ts).
 *
 * gatetest.ai was the domain until 2026-07-30, then dropped into registry
 * redemption and went NXDOMAIN. Craig re-registered it at name.com on
 * 2026-10-02 (expires 2028-10-02). Customers' READMEs still embed badge URLs
 * on it that we can never edit — a dead host breaks every one of those
 * images, and a host someone else owns serves images inside our customers'
 * repos.
 *
 * Deliberately NOT in site-url.js: that file decides where telemetry and
 * links go and may name only the canonical host (tests/telemetry-host-guard).
 * This list is read by the redirect config alone — nothing may link to,
 * send to, or upload to these hosts. Bare hosts, not URLs.
 */
const LEGACY_SITE_HOSTS = Object.freeze(['gatetest.ai']);

module.exports = { LEGACY_SITE_HOSTS };
