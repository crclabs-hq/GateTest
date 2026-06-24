/**
 * HN reply assistant — drafter.
 *
 * Composes a Claude prompt that takes:
 *   - the new HN comment (text, author, parent context)
 *   - voice examples (Craig's past HN comments)
 *   - product knowledge (the Show HN body, pricing, honest limitations)
 *
 * and produces a draft reply.
 *
 * The draft is ALWAYS prefixed with `[DRAFT — REVIEW BEFORE POSTING]`
 * so it cannot accidentally be pasted unedited.
 *
 * The drafter does NOT call Claude when `_anthropicCall` is injected
 * (tests). In production it invokes the Anthropic SDK with the
 * approved model (claude-sonnet-4-6 per Bible v1.43).
 */

"use strict";

const DRAFT_BANNER = "[DRAFT — REVIEW BEFORE POSTING]";
const MAX_VOICE_EXAMPLES = 8;
const MAX_VOICE_CHARS_PER_EXAMPLE = 600;

/**
 * Compose the system prompt from voice examples + product knowledge.
 */
function composeSystemPrompt({ voiceExamples = [], productContext = {} } = {}) {
  const examples = voiceExamples
    .slice(0, MAX_VOICE_EXAMPLES)
    .map((e, i) => `[Example ${i + 1}] ${(e.text || "").slice(0, MAX_VOICE_CHARS_PER_EXAMPLE)}`)
    .join("\n\n");

  const pc = {
    productName: productContext.productName || "GateTest",
    tagline: productContext.tagline ||
      "Most code-quality tools tell you what's broken. We open the pull request that fixes it.",
    moduleCount: productContext.moduleCount || 110,
    tiers: productContext.tiers || [
      { name: "Quick", price: "$29", modules: "4" },
      { name: "Full", price: "$99", modules: "all 110, scan-only" },
      { name: "Scan + Fix", price: "$199", modules: "auto-fix PR + pair-review" },
      { name: "Forensic Scan", price: "$399", modules: "per-finding Claude diagnosis + attack-chain correlation + CISO report" },
    ],
    honestLimitations: productContext.honestLimitations || [
      "We don't beat CodeQL on deep multi-hop taint analysis. We win on breadth, speed, and the auto-fix.",
      "Mutation testing + chaos pass ship via GitHub Action only, not the website Forensic scan.",
      "We don't claim 'most reliable scanner' yet. We've built the continuous reliability framework; the track record starts now.",
      "Pen test tier is parked for attorney review on RoE/ToS/insurance.",
    ],
  };

  return [
    "You are drafting Hacker News comment replies for Craig (HN username: McCracken49), founder of GateTest.",
    "",
    "Match Craig's voice from these examples. Do not invent facts. Be specific, concrete, honest. Acknowledge limitations openly when relevant.",
    "",
    "Style rules:",
    "- Direct, no marketing speak. HN punishes hype.",
    "- Concrete numbers when claiming things (110 modules, $99/scan, etc.)",
    "- Concede points the commenter has right — never argue for the sake of arguing.",
    "- If the commenter raises a feature we don't have yet, say so and add it to the public roadmap.",
    "- If they ask about a competitor we honestly lose to (CodeQL on deep taint), say so.",
    "- Length: ~80-250 words for substantive comments. Shorter for thanks / one-liner replies.",
    "- No emojis. No '!' overuse. No 'great question'. No 'feel free to'.",
    "- End with a question or specific offer when it invites further engagement.",
    "",
    `Product context — ${pc.productName}:`,
    `- Tagline: ${pc.tagline}`,
    `- ${pc.moduleCount} modules, one config, one bill`,
    `- Tiers: ${pc.tiers.map((t) => `${t.name} ${t.price} (${t.modules})`).join(" / ")}`,
    "- Free CLI (MIT), not yet on npm: npx github:crclabs-hq/GateTest --suite quick",
    "",
    "Honest limitations (raise these proactively when relevant — don't hide them):",
    ...pc.honestLimitations.map((l) => `- ${l}`),
    "",
    "Craig's voice — recent HN comments:",
    "",
    examples || "(no examples yet — match the style rules above)",
  ].join("\n");
}

/**
 * Compose the user prompt for a single new HN comment.
 */
function composeUserPrompt({ comment }) {
  const parentChunk = comment.parentText
    ? `Parent comment by ${comment.parentAuthor || "anon"} (the message this is replying to):\n"""\n${comment.parentText.slice(0, 800)}\n"""\n\n`
    : "";
  return [
    "A new HN reply landed on the Show HN thread. Draft Craig's response.",
    "",
    parentChunk,
    `New comment by ${comment.author || "anon"} (HN id ${comment.id}):`,
    '"""',
    (comment.text || "").slice(0, 2000),
    '"""',
    "",
    "Draft Craig's reply. Plain text, no markdown, no banner — the system will add the banner.",
  ].join("\n");
}

/**
 * Draft a reply to a single new comment.
 *
 * @param {object} args
 * @param {object} args.comment              new comment from the watcher
 * @param {Array<object>} [args.voiceExamples]
 * @param {object} [args.productContext]
 * @param {function} [args._anthropicCall]   injectable Claude caller for tests
 * @returns {Promise<{ draft: string, model: string, comment: object }>}
 */
async function draftReply({
  comment,
  voiceExamples = [],
  productContext = {},
  _anthropicCall,
}) {
  if (!comment || !comment.id || !comment.text) {
    throw new TypeError("draftReply: comment.id + comment.text required");
  }
  const systemPrompt = composeSystemPrompt({ voiceExamples, productContext });
  const userPrompt = composeUserPrompt({ comment });

  const caller = _anthropicCall || defaultAnthropicCall;
  const { text, model } = await caller({ systemPrompt, userPrompt });

  // ALWAYS prefix with the review banner. No exception. No override.
  const draft = `${DRAFT_BANNER}\n\n${text.trim()}`;

  return {
    draft,
    model,
    comment: {
      id: comment.id,
      author: comment.author,
      textSnippet: (comment.text || "").slice(0, 200),
    },
  };
}

/**
 * Default Anthropic caller — direct HTTPS call to api.anthropic.com.
 *
 * Uses the same pattern as the rest of the codebase (try-fix.js,
 * fix-context-enricher.js) — direct fetch, no SDK dependency. Keeps
 * the bundle small and avoids requiring an npm install in the
 * production deploy.
 *
 * Throws if no API key set so tests don't accidentally hit the API.
 */
async function defaultAnthropicCall({ systemPrompt, userPrompt }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY not set — pass _anthropicCall in tests or set the env var");
  }
  const fetchFn = typeof globalThis.fetch === "function" ? globalThis.fetch : null;
  if (!fetchFn) throw new Error("no fetch available in runtime");
  const model = "claude-sonnet-4-6";

  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": key,
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    let errBody = "";
    try { errBody = await res.text(); } catch { /* ignore */ }
    throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 200)}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Anthropic API returned unparseable JSON");
  }
  if (!data || !Array.isArray(data.content)) {
    throw new Error("Anthropic API response missing content array");
  }
  const text = data.content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
  return { text, model };
}

module.exports = {
  draftReply,
  composeSystemPrompt,
  composeUserPrompt,
  defaultAnthropicCall,
  DRAFT_BANNER,
  MAX_VOICE_EXAMPLES,
};
