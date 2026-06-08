import type { Env, GenerateInput } from "./types";

type VendorKind = "anthropic" | "google" | "openai" | "workers-ai";

interface Vendor {
  kind: VendorKind;
  baseURL?: string; // for openai-compatible vendors
  keyEnv?: string; // name of the Env secret holding the key (e.g. "OPENAI_API_KEY")
  tokenParam?: "max_tokens" | "max_completion_tokens"; // openai-compatible token field
}

// Look up a secret by name — so adding a vendor never means widening a type union.
function getKey(env: Env, name?: string): string {
  if (!name) return "";
  return (env as unknown as Record<string, string>)[name] ?? "";
}

// Add a model vendor here. Most non-Anthropic/Google APIs are OpenAI-compatible,
// so a new one is usually a single line: base URL + which secret holds the key.
export const VENDORS: Record<string, Vendor> = {
  anthropic: { kind: "anthropic", keyEnv: "ANTHROPIC_API_KEY" },
  gemini: { kind: "google", keyEnv: "GEMINI_API_KEY" },
  workersai: { kind: "workers-ai" }, // env.AI binding; Kimi 2.6 runs here, no key

  // ADDING A MODEL:
  //  • Same vendor, different model  -> just change the model string in router.ts.
  //  • New OpenAI-compatible API (xAI, OpenAI, Kimi-cloud, DeepSeek, OpenRouter, …)
  //    -> add ONE line here, add the key field to Env in types.ts, then
  //       `wrangler secret put <KEY>`. No new code — they all share callOpenAICompatible.
  //    (Reasoning models like Grok need tokenParam: "max_completion_tokens".)
  // Examples:
  // xai:    { kind: "openai", baseURL: "https://api.x.ai/v1",       keyEnv: "XAI_API_KEY", tokenParam: "max_completion_tokens" },
  // openai: { kind: "openai", baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
};

export async function generate(input: GenerateInput, env: Env): Promise<string> {
  const vendor = VENDORS[input.target.vendor];
  if (!vendor) throw new Error(`Unknown vendor: ${input.target.vendor}`);
  switch (vendor.kind) {
    case "anthropic":
      return callAnthropic(input, env);
    case "google":
      return callGemini(input, env);
    case "openai":
      return callOpenAICompatible(input, env, vendor);
    case "workers-ai":
      return callWorkersAI(input, env);
  }
}

// ----------------------------- Anthropic (Claude) -----------------------------
type CacheControl = { type: "ephemeral" };
type ClaudeBlock =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
      cache_control?: CacheControl;
    };
interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeBlock[];
}

async function callAnthropic(input: GenerateInput, env: Env): Promise<string> {
  const messages: ClaudeMessage[] = input.history.map((m) => ({ role: m.role, content: m.content }));
  if (input.image) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: input.userText || "(image)" },
        {
          type: "image",
          source: { type: "base64", media_type: input.image.mimeType, data: input.image.dataB64 },
        },
      ],
    });
  } else {
    messages.push({ role: "user", content: input.userText });
  }

  // Prompt caching: the system block is already cached; also cache the conversation
  // prefix (the part that grows) by putting a breakpoint on the last message. Repeat
  // turns within ~5 min reuse the cached prefix at ~90% cheaper input. Note: this cuts
  // cost, not size — the tokens are still sent (shrinking that is compaction, later).
  const last = messages[messages.length - 1];
  const blocks: ClaudeBlock[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  last.content = blocks;

  const body: Record<string, unknown> = {
    model: input.target.model,
    max_tokens: input.target.maxTokens,
    // The system prompt is the stable prefix, so mark it cacheable. Caching only kicks
    // in once the prefix is large enough (e.g. once the memory doc is injected here).
    system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
    messages,
  };
  if (input.target.thinking) {
    const budget = Math.max(1024, Math.min(input.target.maxTokens - 1024, 8000));
    body.thinking = { type: "enabled", budget_tokens: budget };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (
    (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim() ||
    "(no response)"
  );
}

// ----------------------------- Google (Gemini) -----------------------------
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

async function callGemini(input: GenerateInput, env: Env): Promise<string> {
  const contents: GeminiContent[] = input.history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const userParts: GeminiPart[] = [{ text: input.userText || "(image)" }];
  if (input.image) {
    userParts.push({ inline_data: { mime_type: input.image.mimeType, data: input.image.dataB64 } });
  }
  contents.push({ role: "user", parts: userParts });

  const res = await fetch(`${GEMINI_URL}/${input.target.model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: input.system }] },
      contents,
      generationConfig: { maxOutputTokens: input.target.maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("").trim() || "(no response)";
}

// ------------------- OpenAI-compatible (ChatGPT, Kimi, DeepSeek, …) -------------------
type OAIContent =
  | string
  | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
interface OAIMessage {
  role: string;
  content: OAIContent;
}

async function callOpenAICompatible(input: GenerateInput, env: Env, vendor: Vendor): Promise<string> {
  const key = getKey(env, vendor.keyEnv);
  const messages: OAIMessage[] = [
    { role: "system", content: input.system },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
  ];
  if (input.image) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: input.userText || "(image)" },
        {
          type: "image_url",
          image_url: { url: `data:${input.image.mimeType};base64,${input.image.dataB64}` },
        },
      ],
    });
  } else {
    messages.push({ role: "user", content: input.userText });
  }

  const tokenField = vendor.tokenParam ?? "max_tokens";
  const body: Record<string, unknown> = { model: input.target.model, messages };
  body[tokenField] = input.target.maxTokens;
  const res = await fetch(`${vendor.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${input.target.vendor} ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() || "(no response)";
}

// ----------------------------- Workers AI (free) -----------------------------
async function callWorkersAI(input: GenerateInput, env: Env): Promise<string> {
  // Small free models: text only here, and weak at complex tasks — best for quick/cheap replies.
  const messages = [
    { role: "system", content: input.system },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: input.userText || "(image not supported on this model)" },
  ];
  const ai = env.AI as unknown as {
    run: (model: string, inputs: Record<string, unknown>) => Promise<unknown>;
  };
  const out = await ai.run(input.target.model, {
    messages,
    max_tokens: input.target.maxTokens,
    // Kimi K2.6 reasons by default and can spend the whole token budget thinking,
    // leaving the answer empty. Turn thinking off so it replies directly. (Other
    // Workers AI models ignore this unknown param.)
    chat_template_kwargs: { thinking: false },
  });
  const text = extractWorkersAIText(out);
  if (!text) {
    // Log the raw shape so we can see where this model put its answer (in `wrangler tail`).
    console.error("workersai empty output:", JSON.stringify(out)?.slice(0, 800));
    return "(no response)";
  }
  return text;
}

// Workers AI models return different shapes: legacy { response }, OpenAI-style
// { choices: [{ message: { content } }] }, and reasoning models add a reasoning field.
function extractWorkersAIText(out: unknown): string {
  if (typeof out === "string") return out.trim();
  if (!out || typeof out !== "object") return "";
  const o = out as {
    response?: string;
    reasoning?: string;
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
  };
  const msg = o.choices?.[0]?.message;
  return (o.response ?? msg?.content ?? o.reasoning ?? msg?.reasoning_content ?? "").trim();
}