import type { Env } from "./types";
import { makeBot, sessionKey, sendPlaceholder, sendText, sendReply } from "./bot";
import { AREAS, DEFAULT_AREA, areaList } from "./router";
import { miniAppHtml, handleMiniAppApi, encodeSession } from "./miniapp";

// The Durable Object class must be exported from the entry module so the runtime
// can find it (matches class_name in wrangler.toml).
export { AgentDO } from "./agent";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ---- Setup: register webhook + sync commands (GET /setup?secret=...) ----
    if (request.method === "GET" && url.pathname === "/setup") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const bot = makeBot(env.BOT_TOKEN);
      const webhookUrl = `${url.origin}/`;
      await bot.api.setWebhook(webhookUrl, {
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"],
      });
      await bot.api.setMyCommands(BOT_COMMANDS);
      return new Response(
        `✅ Setup complete\nWebhook: ${webhookUrl}\nCommands: ${BOT_COMMANDS.length} registered`,
        { headers: { "Content-Type": "text/plain" } },
      );
    }

    // ---- Mini app: serve HTML and API ----
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(miniAppHtml(), {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      });
    }
    if (url.pathname === "/api/docs") {
      const stub = env.AGENT.get(env.AGENT.idFromName("default"));
      return handleMiniAppApi(request, env, stub);
    }

    if (request.method !== "POST") return new Response("ok"); // health check

    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const update = (await request.json()) as TgUpdate;
    const msg = update.message;
    if (!msg || !msg.from) return new Response("ok");

    // Access control: only allow-listed user IDs.
    const allowed = env.ALLOWED_USER_IDS.split(",").map((s) => s.trim());
    if (!allowed.includes(String(msg.from.id))) return new Response("ok");

    const bot = makeBot(env.BOT_TOKEN);
    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    const key = sessionKey(chatId, threadId);

    // A single "default" agent instance owns all state (history, area, docs) in its
    // own SQLite storage. Commands below read/write that state via RPC on this stub.
    const stub = env.AGENT.get(env.AGENT.idFromName("default"));

    // If this thread has a named agent, use agent:{name} as the effective session key.
    // This means all docs/area/history are stored under the agent name, surviving thread deletion.
    const effectiveKey = await stub.resolveSessionKey(key);

    const text = (msg.text ?? msg.caption ?? "").trim();
    const photo = msg.photo?.[msg.photo.length - 1]; // largest rendition
    const document = msg.document;

    // ---- Commands (fast, handled in the Worker — no model call) ----
    if (text.startsWith("/")) {
      const [cmd, arg] = text.split(/\s+/, 2);

      if (cmd === "/start" || cmd === "/help") {
        const current = (await stub.getArea(effectiveKey)) ?? DEFAULT_AREA;
        const agentName = await stub.getAgentName(key);
        await sendText(
          bot,
          chatId,
          `Hi! Each conversation uses model(s) based on its area.\n\n` +
            (agentName ? `Agent: ${agentName}\n` : "") +
            `Current area: ${current}\n\nSet it with /model <area>:\n${areaList()}\n\n` +
            `Identity: /soul, /agents (view, or set by adding text).\n` +
            `Memory: /remember <fact>, /memory (view), /forget (clear).\n` +
            `/agent set <name> — assign a named agent to this thread.\n` +
            `/reset clears this conversation's history.`,
          threadId,
        );
        return new Response("ok");
      }

      if (cmd === "/reset") {
        await stub.clearHistory(effectiveKey);
        await sendText(bot, chatId, "Conversation cleared.", threadId);
        return new Response("ok");
      }

      if (cmd === "/model") {
        const current = (await stub.getArea(effectiveKey)) ?? DEFAULT_AREA;
        if (!arg || !AREAS[arg]) {
          await sendText(bot, chatId, `Current area: ${current}\n\nChoose one:\n${areaList()}`, threadId);
        } else {
          await stub.setArea(effectiveKey, arg);
          await sendText(bot, chatId, `Area set to ${arg} — ${AREAS[arg].label}.`, threadId);
        }
        return new Response("ok");
      }

      if (cmd === "/soul" || cmd === "/agents") {
        const name = cmd === "/soul" ? "soul" : "agents";
        const body = text.slice(cmd.length).trim();
        if (!body) {
          const cur = (await stub.loadDoc(name, effectiveKey)).trim();
          await sendText(
            bot,
            chatId,
            cur ? `${cmd}:\n${cur}` : `${cmd} is empty. Set it with: ${cmd} <text>`,
            threadId,
          );
        } else if (body === "clear") {
          await stub.clearDoc(name, effectiveKey);
          await sendText(bot, chatId, `${cmd} cleared.`, threadId);
        } else {
          await stub.saveDoc(name, body, effectiveKey);
          await sendText(bot, chatId, `${cmd} updated.`, threadId);
        }
        return new Response("ok");
      }

      if (cmd === "/remember") {
        const fact = text.slice(cmd.length).trim();
        if (!fact) {
          await sendText(bot, chatId, "Usage: /remember <something to remember>", threadId);
        } else {
          await stub.appendDoc("memory", fact, effectiveKey);
          await sendText(bot, chatId, `Got it — I'll remember:\n• ${fact}`, threadId);
        }
        return new Response("ok");
      }

      if (cmd === "/memory") {
        const mem = (await stub.loadDoc("memory", effectiveKey)).trim();
        await sendText(
          bot,
          chatId,
          mem ? `Here's what I remember:\n${mem}` : "No saved memory yet. Use /remember <fact>.",
          threadId,
        );
        return new Response("ok");
      }

      if (cmd === "/forget") {
        await stub.clearDoc("memory", effectiveKey);
        await sendText(bot, chatId, "Cleared all saved memory.", threadId);
        return new Response("ok");
      }

      if (cmd === "/compact") {
        const placeholder = await sendPlaceholder(bot, chatId, threadId);
        ctx.waitUntil(
          stub.compact(effectiveKey)
            .then(async (extracted) => {
              const msg = extracted
                ? `✅ Compacted. Saved to memory:\n\n${extracted}`
                : "Nothing to compact — history is short or contained no new facts.";
              await sendReply(bot, chatId, placeholder.message_id, msg, threadId);
            })
            .catch(async (err) => {
              await sendReply(bot, chatId, placeholder.message_id, `⚠️ Compact failed: ${(err as Error).message}`, threadId);
            }),
        );
        return new Response("ok");
      }

      if (cmd === "/agent") {
        const parts = text.split(/\s+/);
        const sub = parts[1] ?? "";
        const name = parts[2] ?? "";
        if (sub === "set") {
          if (!name) {
            await sendText(bot, chatId, "Usage: /agent set <name>", threadId);
          } else if (!/^[a-z0-9_-]+$/i.test(name)) {
            await sendText(bot, chatId, "Agent name must be letters, digits, hyphens or underscores.", threadId);
          } else {
            await stub.setAgentName(key, name);
            await sendText(bot, chatId, `Agent set to "${name}". This thread now uses agent:${name} for all config.`, threadId);
          }
        } else if (sub === "unset") {
          await stub.clearAgentName(key);
          await sendText(bot, chatId, "Agent name removed — thread uses its own config again.", threadId);
        } else if (sub === "list") {
          const agents = await stub.listAgents();
          if (agents.length === 0) {
            await sendText(bot, chatId, "No named agents yet. Use /agent set <name> in a thread.", threadId);
          } else {
            const lines = agents.map((a) => `• ${a.name}  →  ${a.threadKey}`).join("\n");
            await sendText(bot, chatId, `Named agents:\n${lines}`, threadId);
          }
        } else {
          await sendText(
            bot, chatId,
            "/agent set <name> — assign named agent to this thread\n/agent unset — remove name\n/agent list — list all named agents",
            threadId,
          );
        }
        return new Response("ok");
      }

      if (cmd === "/edit") {
        const workerUrl = new URL(request.url).origin;
        const startParam = encodeSession(effectiveKey);
        const miniAppUrl = `${workerUrl}?startapp=${startParam}`;
        const agentName = await stub.getAgentName(key);
        await bot.api.sendMessage(chatId, `Open the editor${agentName ? ` for agent: ${agentName}` : ""}:`, {
          ...(threadId ? { message_thread_id: threadId } : {}),
          reply_markup: {
            inline_keyboard: [[{ text: "✏️ Open Editor", web_app: { url: miniAppUrl } }]],
          },
        });
        return new Response("ok");
      }
      // Unknown command: fall through and treat as a normal message.
    }

    if (!text && !photo && !document) return new Response("ok");

    // ---- Normal message: ack FAST, hand the slow work to the agent DO ----
    const placeholder = await sendPlaceholder(bot, chatId, threadId);
    ctx.waitUntil(
      stub.handleMessage({
        chatId,
        threadId,
        placeholderId: placeholder.message_id,
        sessionKey: effectiveKey,
        text,
        photoFileId: photo?.file_id,
        documentFileId: document?.file_id,
        documentMimeType: document?.mime_type,
        documentFileName: document?.file_name,
      }),
    );

    return new Response("ok");
  },
};

const BOT_COMMANDS = [
  { command: "help",    description: "Show available commands and current settings" },
  { command: "model",   description: "View or set the model area for this thread" },
  { command: "edit",    description: "Open the mini app editor (soul, agents, memory, tools…)" },
  { command: "agent",   description: "Manage named agents: set <name> | unset | list" },
  { command: "compact", description: "Extract key facts from history into memory, then clear history" },
  { command: "reset",   description: "Clear this conversation's history" },
  { command: "remember",description: "Save a fact to memory: /remember <fact>" },
  { command: "memory",  description: "View saved memory for this thread" },
  { command: "forget",  description: "Clear all saved memory for this thread" },
];

interface TgUpdate {
  update_id: number;
  message?: {
    text?: string;
    caption?: string;
    photo?: { file_id: string }[];
    document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
    chat: { id: number };
    from?: { id: number };
    message_thread_id?: number;
  };
}