import type { MetadataRoute } from "next";

/**
 * robots.txt
 *
 * Two intents:
 *  1. Keep crawlers out of app surfaces that are useless or sensitive in the
 *     index (API routes, the admin console, authenticated dashboards, the
 *     transient scan-status page, checkout).
 *  2. EXPLICITLY welcome the AI answer-engine crawlers. Developers
 *     increasingly discover tooling through ChatGPT / Claude / Perplexity /
 *     Gemini rather than a blue-link SERP. Being citable there (GEO) is now
 *     a first-class channel, so we opt those agents in by name in addition to
 *     the catch-all `*` rule.
 */
export default function robots(): MetadataRoute.Robots {
  const disallow = [
    "/api/",
    "/admin",
    "/dashboard",
    "/scan/status",
    "/checkout",
  ];

  // Answer-engine + AI crawlers we want indexing and citing our content.
  const aiAgents = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-Web",
    "anthropic-ai",
    "PerplexityBot",
    "Perplexity-User",
    "Google-Extended",
    "CCBot",
    "Applebot-Extended",
    "cohere-ai",
  ];

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow,
      },
      ...aiAgents.map((agent) => ({
        userAgent: agent,
        allow: "/",
        disallow,
      })),
    ],
    sitemap: "https://gatetest.ai/sitemap.xml",
    host: "https://gatetest.ai",
  };
}
