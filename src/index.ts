import type { Env } from "./types";
import { makeBot, sessionKey, sendPlaceholder, sendText } from "./bot";
import { AREAS, DEFAULT_AREA, areaList } from "./router";

// The Durable Object class must be exported from the entry module so the runtime
// can find it (matches class_name in wrangler.toml).
export { AgentDO } from "./agent";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    const text = (msg.text ?? msg.caption ?? "").trim();
    const photo = msg.photo?.[msg.photo.length - 1]; // largest rendition

    // ---- Commands (fast, handled in the Worker — no model call) ----
    if (text.startsWith("/")) {
      const [cmd, arg] = text.split(/\s+/, 2);

      if (cmd === "/start" || cmd === "/help") {
        const current = (await stub.getArea(key)) ?? DEFAULT_AREA;
        await sendText(
          bot,
          chatId,
          `Hi! Each conversation uses model(s) based on its area.\n\n` +
            `Current area: ${current}\n\nSet it with /model <area>:\n${areaList()}\n\n` +
            `Identity: /soul, /agents (view, or set by adding text).\n` +
            `Memory: /remember <fact>, /memory (view), /forget (clear).\n` +
            `/reset clears this conversation's history.`,
          threadId,
        );
        return new Response("ok");
      }

      if (cmd === "/reset") {
        await stub.clearHistory(key);
        await sendText(bot, chatId, "Conversation cleared.", threadId);
        return new Response("ok");
      }

      if (cmd === "/model") {
        const current = (await stub.getArea(key)) ?? DEFAULT_AREA;
        if (!arg || !AREAS[arg]) {
          await sendText(bot, chatId, `Current area: ${current}\n\nChoose one:\n${areaList()}`, threadId);
        } else {
          await stub.setArea(key, arg);
          await sendText(bot, chatId, `Area set to ${arg} — ${AREAS[arg].label}.`, threadId);
        }
        return new Response("ok");
      }

      if (cmd === "/soul" || cmd === "/agents") {
        const name = cmd === "/soul" ? "soul" : "agents";
        const body = text.slice(cmd.length).trim();
        if (!body) {
          const cur = (await stub.loadDoc(name, key)).trim();
          await sendText(
            bot,
            chatId,
            cur ? `${cmd}:\n${cur}` : `${cmd} is empty. Set it with: ${cmd} <text>`,
            threadId,
          );
        } else if (body === "clear") {
          await stub.clearDoc(name, key);
          await sendText(bot, chatId, `${cmd} cleared.`, threadId);
        } else {
          await stub.saveDoc(name, body, key);
          await sendText(bot, chatId, `${cmd} updated.`, threadId);
        }
        return new Response("ok");
      }

      if (cmd === "/remember") {
        const fact = text.slice(cmd.length).trim();
        if (!fact) {
          await sendText(bot, chatId, "Usage: /remember <something to remember>", threadId);
        } else {
          await stub.appendDoc("memory", fact, key);
          await sendText(bot, chatId, `Got it — I'll remember:\n• ${fact}`, threadId);
        }
        return new Response("ok");
      }

      if (cmd === "/memory") {
        const mem = (await stub.loadDoc("memory", key)).trim();
        await sendText(
          bot,
          chatId,
          mem ? `Here's what I remember:\n${mem}` : "No saved memory yet. Use /remember <fact>.",
          threadId,
        );
        return new Response("ok");
      }

      if (cmd === "/forget") {
        await stub.clearDoc("memory", key);
        await sendText(bot, chatId, "Cleared all saved memory.", threadId);
        return new Response("ok");
      }
      // Unknown command: fall through and treat as a normal message.
    }

    if (!text && !photo) return new Response("ok");

    // ---- Normal message: ack FAST, hand the slow work to the agent DO ----
    const placeholder = await sendPlaceholder(bot, chatId, threadId);
    ctx.waitUntil(
      stub.handleMessage({
        chatId,
        threadId,
        placeholderId: placeholder.message_id,
        sessionKey: key,
        text,
        photoFileId: photo?.file_id,
      }),
    );

    return new Response("ok");
  },
};

interface TgUpdate {
  update_id: number;
  message?: {
    text?: string;
    caption?: string;
    photo?: { file_id: string }[];
    chat: { id: number };
    from?: { id: number };
    message_thread_id?: number;
  };
}