/**
 * OpenAI client — thin fetch wrapper around Chat Completions.
 *
 * Same shape as the Anthropic call in `/api/scan/fix/route.ts`: no SDK,
 * direct HTTPS POST, short request timeout, classified errors. Bound to
 * `OPENAI_API_KEY`.
 *
 * Cost note: this is invoked only from `runConsensus()` (Nuclear tier
 * opt-in via `consensus: true`). Quick / Full / Scan+Fix never call OpenAI.
 */

// Types are internal — multi-agent-consensus.ts imports the functions and
// gets the shapes via inference. Promote to export if a second consumer
// needs them.
interface OpenAiCallOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  timeoutMs?: number;
}

interface OpenAiResponse {
  status: number;
  ok: boolean;
  text: string;
  usage: { promptTokens: number; completionTokens: number };
  rawError?: string;
}

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 45_000;

export function isOpenAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function openAiCall(opts: OpenAiCallOptions): Promise<OpenAiResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      status: 0,
      text: "",
      usage: { promptTokens: 0, completionTokens: 0 },
      rawError: "OPENAI_API_KEY not configured",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const payload = {
    model: opts.model,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    max_tokens: opts.maxTokens,
    temperature: 0.2,
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        connection: "close",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      keepalive: false,
    });

    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        text: "",
        usage: { promptTokens: 0, completionTokens: 0 },
        rawError: text.slice(0, 500),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: res.status,
        text: "",
        usage: { promptTokens: 0, completionTokens: 0 },
        rawError: "non-JSON OpenAI response",
      };
    }
    return extract(parsed, res.status);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: "",
      usage: { promptTokens: 0, completionTokens: 0 },
      rawError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

interface ChatChoice {
  message?: { content?: string };
}
interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

function extract(raw: unknown, status: number): OpenAiResponse {
  const r = raw as { choices?: ChatChoice[]; usage?: ChatUsage };
  const content = r?.choices?.[0]?.message?.content ?? "";
  const usage = r?.usage ?? {};
  return {
    ok: true,
    status,
    text: String(content),
    usage: {
      promptTokens: Number(usage.prompt_tokens ?? 0),
      completionTokens: Number(usage.completion_tokens ?? 0),
    },
  };
}
