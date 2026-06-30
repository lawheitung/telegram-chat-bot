import type { Env, EffortLevel } from "./types";
import { makeBot, sessionKey, sendPlaceholder, sendText, sendReply, downloadFileText, isTextMime } from "./bot";
import { MODELS, DEFAULT_MODEL, modelList, TEMPLATES, TOOL_BUNDLE_NAMES } from "./router";
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
        const current = (await stub.getModel(effectiveKey)) ?? DEFAULT_MODEL;
        const curLevel = await stub.getEffort(effectiveKey);
        const agentName = await stub.getAgentName(key);
        await sendText(
          bot,
          chatId,
          `👋 **How this bot works**\n` +
            `Each thread (Telegram topic) is its own agent — its own model, behavior, and memory. To set one up:\n\n` +
            `**1. Start a thread & name it**\n` +
            `In Telegram, create a new topic and give it a name (e.g. "journal") — that name is your agent. Claim it so the config survives deletion: \`/agent set journal\`. Also \`/agent list\`, \`/agent unset\`.\n\n` +
            `**2. Pick a model + reasoning level**\n` +
            `\`/model <name> [level]\` — e.g. \`/model opus high\`. Swap anytime.\n${modelList(current)}\n\n` +
            `**3. Give it behavior (its "skill")**\n` +
            `\`/persona <text>\` — how this agent should act/think.  \`/soul <text>\` — identity shared by all agents.  \`/edit\` — visual editor (soul, persona, memory, tools…).\n\n` +
            `**4. Memory**\n` +
            `\`/remember <fact>\` · \`/memory\` (view) · \`/forget\` (clear) · \`/compact\` (fold history into memory).\n\n` +
            `**5. Tools**\n` +
            `\`/tools add <name>\` / \`/tools remove <name>\` / \`/tools\` (list). Bundles: ${TOOL_BUNDLE_NAMES.join(", ")}. (Tools run on Claude or Kimi, not GPT/Gemini.)\n\n` +
            `**Or apply a ready-made agent:** \`/agent use <health|meal|admin>\` — sets persona, model, and tools in one go.\n\n` +
            `**6. Hand off between agents**\n` +
            `\`/send <name>\` — send this thread's last reply to another named agent; the reply comes back here.\n\n` +
            `Now: ${agentName ? `agent **${agentName}**, ` : ""}${current}${curLevel ? ` (${curLevel})` : ""}.  \`/reset\` clears this thread's history.`,
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
        const parts = text.split(/\s+/);
        const name = parts[1];
        const level = parts[2];
        const curModel = (await stub.getModel(effectiveKey)) ?? DEFAULT_MODEL;
        if (!name || !MODELS[name]) {
          const curLevel = await stub.getEffort(effectiveKey);
          await sendText(
            bot,
            chatId,
            `Current model: ${curModel}${curLevel ? ` (${curLevel})` : ""}\n\n${modelList(curModel)}`,
            threadId,
          );
          return new Response("ok");
        }
        const m = MODELS[name];
        if (level) {
          if (!m.levels?.includes(level as EffortLevel)) {
            const avail = m.levels ? m.levels.join("/") : "none (this model has no reasoning levels)";
            await sendText(bot, chatId, `"${name}" doesn't support level "${level}". Available: ${avail}.`, threadId);
            return new Response("ok");
          }
          await stub.setModel(effectiveKey, name);
          await stub.setEffort(effectiveKey, level);
          await sendText(bot, chatId, `Model set to ${name} (${level}) — ${m.label}. Persona, tools, and memory unchanged.`, threadId);
        } else {
          await stub.setModel(effectiveKey, name);
          await stub.clearEffort(effectiveKey);
          const def = m.defaultLevel ? ` (${m.defaultLevel})` : "";
          await sendText(bot, chatId, `Model set to ${name}${def} — ${m.label}. Persona, tools, and memory unchanged.`, threadId);
        }
        return new Response("ok");
      }

      if (cmd === "/tools") {
        const parts = text.split(/\s+/);
        const sub = (parts[1] ?? "").toLowerCase();
        const bundle = parts[2];
        const cur = await stub.getTools(effectiveKey);
        const modelId = (await stub.getModel(effectiveKey)) ?? DEFAULT_MODEL;
        const supportsTools = !!MODELS[modelId]?.supportsTools;
        if (sub === "add" || sub === "remove") {
          if (!bundle || !TOOL_BUNDLE_NAMES.includes(bundle)) {
            await sendText(bot, chatId, `Unknown tool "${bundle ?? ""}". Available: ${TOOL_BUNDLE_NAMES.join(", ")}.`, threadId);
            return new Response("ok");
          }
          const next = sub === "add" ? [...new Set([...cur, bundle])] : cur.filter((t) => t !== bundle);
          await stub.setTools(effectiveKey, next);
          const warn = next.length && !supportsTools ? `\n⚠️ Current model (${modelId}) can't run tools — switch to a Claude model or kimi (/model haiku).` : "";
          await sendText(bot, chatId, `Tools: ${next.length ? next.join(", ") : "none"}.${warn}`, threadId);
        } else {
          const warn = cur.length && !supportsTools ? `\n⚠️ Current model (${modelId}) can't run tools.` : "";
          await sendText(
            bot,
            chatId,
            `Attached tools: ${cur.length ? cur.join(", ") : "none"}.${warn}\n\nAvailable: ${TOOL_BUNDLE_NAMES.join(", ")}\nUse: /tools add <name> · /tools remove <name>`,
            threadId,
          );
        }
        return new Response("ok");
      }

      if (cmd === "/soul" || cmd === "/persona") {
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
            await stub.setAgentName(key, name, chatId, threadId);
            await sendText(bot, chatId, `Agent set to "${name}". This thread now uses agent:${name} for all config.`, threadId);
          }
        } else if (sub === "unset") {
          await stub.clearAgentName(key);
          await sendText(bot, chatId, "Agent name removed — thread uses its own config again.", threadId);
        } else if (sub === "use") {
          if (!name) {
            await sendText(bot, chatId, `Usage: /agent use <name>. Options: ${Object.keys(TEMPLATES).join(", ")}.`, threadId);
          } else {
            const msg = await stub.applyTemplate(effectiveKey, name);
            await sendText(bot, chatId, msg, threadId);
          }
        } else if (sub === "list") {
          const agents = await stub.listAgents();
          if (agents.length === 0) {
            await sendText(bot, chatId, "No named agents yet. Use /agent set <name> in a thread.", threadId);
          } else {
            const lines = await Promise.all(agents.map(async (a) => {
              const model = (await stub.getModel(`agent:${a.name}`)) ?? "default";
              const tgId = String(Math.abs(a.chatId ?? 0)).replace(/^100/, "");
              const link = (a.chatId && a.threadId)
                ? ` — t.me/c/${tgId}/${a.threadId}`
                : "";
              return `• ${a.name} [${model}]${link}`;
            }));
            await sendText(bot, chatId, `Named agents:\n${lines.join("\n")}`, threadId);
          }
        } else {
          await sendText(
            bot, chatId,
            "/agent set <name> — name this thread\n/agent use <health|meal|admin> — apply a ready-made agent (persona+model+tools)\n/agent unset — remove name\n/agent list — list named agents",
            threadId,
          );
        }
        return new Response("ok");
      }

      // Action commands: run input through a fixed area once, reply here, leave the thread's model/history untouched.
      const action = ACTIONS[cmd];
      if (action) {
        let input = text.slice(cmd.length).trim();
        if (!input && action.fallbackLast) input = (await stub.getLastAssistantMessage(effectiveKey)) ?? "";
        const hasImg = !!photo || !!(document?.mime_type?.startsWith("image/"));
        if (!input && !hasImg) {
          await sendText(bot, chatId, action.emptyMsg, threadId);
          return new Response("ok");
        }
        const placeholder = await sendPlaceholder(bot, chatId, threadId);
        ctx.waitUntil(
          stub.handleMessage({
            chatId,
            threadId,
            placeholderId: placeholder.message_id,
            sessionKey: effectiveKey,
            text: input,
            photoFileId: photo?.file_id,
            documentFileId: document?.file_id,
            documentMimeType: document?.mime_type,
            documentFileName: document?.file_name,
            areaOverride: action.area,
          }),
        );
        return new Response("ok");
      }

      if (cmd === "/send") {
        if (!arg) {
          await sendText(bot, chatId, "Usage: /send <agent-name>\n\nSends the last assistant message in this thread to the named agent. The reply comes back here.", threadId);
          return new Response("ok");
        }
        if (!(await stub.agentExists(arg))) {
          await sendText(bot, chatId, `No agent named "${arg}" found. Use /agent list to see available agents.`, threadId);
          return new Response("ok");
        }
        const lastMsg = await stub.getLastAssistantMessage(effectiveKey);
        if (!lastMsg) {
          await sendText(bot, chatId, "Nothing to send — no assistant message in this thread yet.", threadId);
          return new Response("ok");
        }
        const placeholder = await sendPlaceholder(bot, chatId, threadId);
        ctx.waitUntil(
          stub.handleMessage({
            chatId,
            threadId,
            placeholderId: placeholder.message_id,
            sessionKey: `agent:${arg}`,
            text: lastMsg,
          }),
        );
        return new Response("ok");
      }

      if (cmd === "/baseline") {
        const placeholder = await sendPlaceholder(bot, chatId, threadId);
        ctx.waitUntil(
          (async () => {
            try {
              let content = "";
              if (document?.file_id && document.mime_type && isTextMime(document.mime_type)) {
                content = await downloadFileText(bot, env.BOT_TOKEN, document.file_id);
              } else {
                content = text.slice(cmd.length).trim();
              }
              if (!content) {
                await sendReply(bot, chatId, placeholder.message_id, "Attach your health history as a .md/.txt with /baseline (or paste text after the command).", threadId);
                return;
              }
              await stub.setHealthBaseline(effectiveKey, content);
              await sendReply(bot, chatId, placeholder.message_id, `Baseline saved (${content.length} chars). I'll factor it into every consult here.`, threadId);
            } catch (e) {
              await sendReply(bot, chatId, placeholder.message_id, `⚠️ Baseline failed: ${(e as Error).message}`, threadId);
            }
          })(),
        );
        return new Response("ok");
      }

      if (cmd === "/checkin") {
        const placeholder = await sendPlaceholder(bot, chatId, threadId);
        ctx.waitUntil(
          stub.healthCheckin(effectiveKey)
            .then((msg) => sendReply(bot, chatId, placeholder.message_id, msg, threadId))
            .catch((e) => sendReply(bot, chatId, placeholder.message_id, `⚠️ Check-in failed: ${(e as Error).message}`, threadId)),
        );
        return new Response("ok");
      }

      if (cmd === "/diagnosis") {
        const placeholder = await sendPlaceholder(bot, chatId, threadId);
        ctx.waitUntil(
          stub.saveDiagnosis(effectiveKey)
            .then((msg) => sendReply(bot, chatId, placeholder.message_id, msg, threadId))
            .catch((e) => sendReply(bot, chatId, placeholder.message_id, `⚠️ Save failed: ${(e as Error).message}`, threadId)),
        );
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

// One-shot action commands: <command> → run input through a fixed area, reply in-thread,
// without changing the thread's model. Add a new action = one line here + one BOT_COMMANDS entry.
const ACTIONS: Record<string, { area: string; fallbackLast?: boolean; emptyMsg: string }> = {
  "/do": { area: "do", fallbackLast: true, emptyMsg: "Nothing to do — no plan or reply in this thread yet." },
  "/log": { area: "log", fallbackLast: true, emptyMsg: "Nothing to log — send/produce posture scores or a plan first." },
  "/plan": { area: "plan", fallbackLast: true, emptyMsg: "Nothing to plan - produce a weekly exercise list first." },
};

const BOT_COMMANDS = [
  { command: "help",    description: "Show available commands and current settings" },
  { command: "model",   description: "Set this thread's model (brain): /model <name> [level]" },
  { command: "tools",   description: "Attach/detach tools: /tools [add|remove <name>]" },
  { command: "send",    description: "Hand off last reply to a named agent: /send <name>" },
  { command: "do",      description: "Execute to Todoist: /do [instruction] (or applies the last plan)" },
  { command: "log",     description: "Log posture scores to GitHub (after a posture analysis)" },
  { command: "plan",    description: "Save the week's exercise/workout plan to GitHub" },
  { command: "baseline", description: "Set your health baseline (attach health_history.md)" },
  { command: "checkin",  description: "Log a quick health/cycle check-in (trend + summary)" },
  { command: "diagnosis",description: "Save the full consultation note (archive)" },
  { command: "edit",    description: "Open the mini app editor (soul, agents, memory, tools…)" },
  { command: "agent",   description: "Name a thread / apply an agent: set | use <health|meal|admin> | list" },
  { command: "persona", description: "View/set this thread's behavior (how it acts/thinks)" },
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