import type { Env, GenerateInput } from "./types";
import { TODOIST_TOOLS, callTodoistTool } from "./mcp";
import { HOUSEWORK_TOOLS, callHouseworkTool } from "./housework";
import { POSTURE_TOOLS, WORKOUT_TOOLS, callGithubTool } from "./github";
import { FOOD_TOOLS, callFoodTool } from "./food";

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
  openai: { kind: "openai", baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", tokenParam: "max_completion_tokens" },

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
  // Tool areas (e.g. the meal agent) run the Anthropic tool_use loop instead.
  if (input.target.tools?.length) return callAnthropicWithTools(input, env);

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
  // Reasoning level → effort. low = thinking off (fast); medium+ = adaptive thinking.
  // (budget_tokens is gone on Opus 4.7/4.8 — adaptive is the only on-mode.) Effort is
  // only sent when set, since it errors on Haiku (used for memory extraction).
  const effort = input.target.effort;
  if (effort && effort !== "low") {
    body.thinking = { type: "adaptive" };
  }
  if (effort) {
    body.output_config = { effort };
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
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  };
  const u = data.usage;
  console.log(`[cache] in=${u?.input_tokens} write=${u?.cache_creation_input_tokens} read=${u?.cache_read_input_tokens}`);
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

  const generationConfig: Record<string, unknown> = { maxOutputTokens: input.target.maxTokens };
  // Reasoning level → thinkingLevel (Gemini 3.x caps at "high").
  if (input.target.effort) {
    const level = input.target.effort === "xhigh" || input.target.effort === "max" ? "high" : input.target.effort;
    generationConfig.thinkingConfig = { thinkingLevel: level };
  }

  const res = await fetch(`${GEMINI_URL}/${input.target.model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: input.system }] },
      contents,
      generationConfig,
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
  // Executor areas declare tool bundles (e.g. ["todoist","housework"] or ["github"]) and run a loop.
  if (input.target.tools?.length) {
    return callWorkersAIWithTools(input, env);
  }
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

// ------------------- Workers AI tool loop (Nemotron + Todoist MCP) -------------------
// Nemotron 3 Super supports OpenAI-style function calling. We hand it the MCP's tools,
// and whenever it asks to call one we run it against the Todoist MCP and feed the
// result back, looping until it produces a plain text answer.
// /do applies a whole plan (project → subtasks → sub-subtasks), one add_task per step,
// so a real decomposition needs many steps. Still a backstop against runaway loops.
const MAX_TOOL_STEPS = 25;

// Tool bundles an executor area can request via target.tools. Scoping per area keeps the
// wrong tools off the table (so /log can't accidentally create a Todoist task).
type ToolDef = { name: string; description: string; input_schema: unknown };
const TOOL_BUNDLES: Record<
  string,
  { defs: ReadonlyArray<ToolDef>; run: (name: string, args: Record<string, unknown>, env: Env) => Promise<string> }
> = {
  todoist: { defs: TODOIST_TOOLS, run: (n, a, env) => callTodoistTool(n, a, env.TODOIST) },
  housework: { defs: HOUSEWORK_TOOLS, run: (n, a, env) => callHouseworkTool(n, a, env.HOUSEWORK) },
  posture: { defs: POSTURE_TOOLS, run: (n, a, env) => callGithubTool(n, a, env) },
  workout: { defs: WORKOUT_TOOLS, run: (n, a, env) => callGithubTool(n, a, env) },
  food: { defs: FOOD_TOOLS, run: (n, a, env) => callFoodTool(n, a, env) },
};

// Anthropic tool_use loop — the reliable, capable counterpart to the Workers AI loop.
// Used by tool areas on Claude (e.g. the meal agent on Haiku). Send tools; while the reply
// has tool_use blocks, run them and feed back tool_result, looping until it returns text.
async function callAnthropicWithTools(input: GenerateInput, env: Env): Promise<string> {
  const bundles = (input.target.tools ?? []).map((n) => TOOL_BUNDLES[n]).filter(Boolean);
  const tools = bundles
    .flatMap((b) => b.defs)
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

  const messages: Array<Record<string, unknown>> = [
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: input.userText || "(no text)" },
  ];
  const effort = input.target.effort;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const body: Record<string, unknown> = {
      model: input.target.model,
      max_tokens: input.target.maxTokens,
      system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
      messages,
      tools,
    };
    if (effort && effort !== "low") body.thinking = { type: "adaptive" };
    if (effort) body.output_config = { effort };

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
    const data = (await res.json()) as { content?: Array<Record<string, unknown>> };
    const content = data.content ?? [];
    const toolUses = content.filter((b) => b.type === "tool_use");
    console.log(`[mealtool] step=${step} called=[${toolUses.map((t) => t.name).join(",")}]`);

    if (toolUses.length === 0) {
      return (
        content
          .filter((b) => b.type === "text")
          .map((b) => (b.text as string) ?? "")
          .join("")
          .trim() || "(no response)"
      );
    }

    messages.push({ role: "assistant", content });
    const results = [];
    for (const tu of toolUses) {
      const bundle = bundles.find((b) => b.defs.some((d) => d.name === tu.name));
      const out = bundle
        ? await bundle.run(tu.name as string, (tu.input ?? {}) as Record<string, unknown>, env)
        : `Unknown tool: ${tu.name}`;
      console.log(`[mealtool] ${tu.name}(${JSON.stringify(tu.input ?? {}).slice(0, 150)}) -> ${String(out).slice(0, 150)}`);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }
  return "⚠️ Stopped after too many tool steps — please narrow the request.";
}

interface NormToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function safeParseArgs(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return {};
}

// Workers AI returns tool calls in one of two shapes depending on the model: the native
// binding shape ({ tool_calls: [{ name, arguments }] }) or the OpenAI chat-completion
// shape ({ choices: [{ message: { tool_calls: [{ id, function: { name, arguments } }] } }] }).
function extractToolCalls(out: any): NormToolCall[] {
  const fromOpenAI = out?.choices?.[0]?.message?.tool_calls;
  const raw = Array.isArray(out?.tool_calls) ? out.tool_calls : fromOpenAI;
  if (!Array.isArray(raw)) return [];
  return raw.map((c: any, i: number) => ({
    id: c?.id ?? `call_${i}`,
    name: c?.function?.name ?? c?.name ?? "",
    arguments: safeParseArgs(c?.function?.arguments ?? c?.arguments),
  }));
}

function extractContent(out: any): string {
  if (typeof out === "string") return out;
  return (out?.choices?.[0]?.message?.content ?? out?.response ?? "").trim();
}

// Workers AI's tool-schema validator is stricter than JSON Schema: it rejects union
// "type" arrays like ["string", "null"]. Flatten each to its first non-null type.
function sanitizeSchema(node: any): any {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === "type" && Array.isArray(v) ? (v.find((t) => t !== "null") ?? "string") : sanitizeSchema(v);
    }
    return out;
  }
  return node;
}

async function callWorkersAIWithTools(input: GenerateInput, env: Env): Promise<string> {
  // Only the bundles this area requested — keeps unrelated tools off the table.
  const bundles = (input.target.tools ?? []).map((n) => TOOL_BUNDLES[n]).filter(Boolean);
  const tools = bundles
    .flatMap((b) => b.defs)
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: sanitizeSchema(t.input_schema),
      },
    }));

  // NVIDIA Nemotron only tool-calls reliably with reasoning disabled — toggled by the literal
  // phrase "detailed thinking off" in the system prompt. In thinking-on (default) it reasons
  // its way into a chat reply and returns tool_calls:[]. (Verified via raw-out logging.)
  const isNemotron = input.target.model.toLowerCase().includes("nemotron");
  const systemContent = isNemotron ? `detailed thinking off\n\n${input.system}` : input.system;

  const messages: Record<string, unknown>[] = [
    { role: "system", content: systemContent },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: input.userText || "(no text)" },
  ];

  const ai = env.AI as unknown as {
    run: (model: string, inputs: Record<string, unknown>) => Promise<unknown>;
  };

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const out = await ai.run(input.target.model, {
      messages,
      tools,
      tool_choice: "auto",
      // OpenAI-schema models use max_completion_tokens (max_tokens deprecated). Reasoning
      // shares this budget, so router.ts gives headroom.
      max_completion_tokens: input.target.maxTokens,
      // Kimi reasons by default and can spend the whole budget thinking (empty tool calls);
      // turn it off. Other models ignore this unknown param.
      chat_template_kwargs: { thinking: false },
    });

    const calls = extractToolCalls(out);
    if (calls.length === 0) {
      return extractWorkersAIText(out) || "(no response)";
    }

    // Record the assistant's tool-call turn in OpenAI format, then append each result.
    messages.push({
      role: "assistant",
      content: extractContent(out),
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    });

    for (const call of calls) {
      const bundle = bundles.find((b) => b.defs.some((d) => d.name === call.name));
      const content = bundle
        ? await bundle.run(call.name, call.arguments, env)
        : `Unknown tool: ${call.name}`;
      messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content });
    }
  }

  return "⚠️ Stopped after too many tool steps — please try a simpler request.";
}