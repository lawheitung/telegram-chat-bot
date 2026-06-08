import { DurableObject } from "cloudflare:workers";
import type { Env, ChatMessage } from "./types";
import { makeBot, downloadImageB64, sendReply, buildSystem, MAX_TURNS } from "./bot";
import { AREAS, DEFAULT_AREA, resolveTarget } from "./router";
import { generate } from "./providers";

// Everything the agent needs to handle one message. Plain data — sent over RPC.
export interface HandlePayload {
  chatId: number;
  threadId?: number;
  placeholderId: number;
  sessionKey: string;
  text: string;
  photoFileId?: string;
}

// The three editable "files" the system prompt is built from: soul (identity),
// agents (rules), memory (facts). soul is global; agents and memory are per-thread
// so each topic can be a distinct agent with its own rules and remembered facts.
export type DocName = "soul" | "agents" | "memory";

// The stateful agent. A single "default" instance handles every message, and ALL
// state — conversation history, per-conversation area, and the soul/agents/memory
// docs — lives in this DO's own SQLite-backed storage (this.ctx.storage). History,
// area, agents, and memory are keyed per conversation (sessionKey); soul is global.
// The Worker reaches these via RPC, so the bot owns its state in one place.
export class AgentDO extends DurableObject<Env> {
  // ----------------------------- conversation history -----------------------------
  private async getHistory(key: string): Promise<ChatMessage[]> {
    return (await this.ctx.storage.get<ChatMessage[]>(`history:${key}`)) ?? [];
  }

  private async saveTurn(key: string, userText: string, assistantText: string): Promise<void> {
    const history = await this.getHistory(key);
    history.push(
      { role: "user", content: userText },
      { role: "assistant", content: assistantText },
    );
    // Keep only the last MAX_TURNS exchanges (a user+assistant pair each).
    await this.ctx.storage.put(`history:${key}`, history.slice(-MAX_TURNS * 2));
  }

  async clearHistory(key: string): Promise<void> {
    await this.ctx.storage.delete(`history:${key}`);
  }

  // ----------------------------- area selection -----------------------------
  async getArea(key: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`area:${key}`)) ?? null;
  }

  async setArea(key: string, area: string): Promise<void> {
    await this.ctx.storage.put(`area:${key}`, area);
  }

  // ----------------------------- editable docs -----------------------------
  // soul is global; agents and memory are scoped per thread via sessionKey.
  private docKey(name: DocName, sessionKey?: string): string {
    if (name === "soul") return "doc:soul";
    return `doc:${name}:${sessionKey ?? "global"}`;
  }

  async loadDoc(name: DocName, sessionKey?: string): Promise<string> {
    const scoped = await this.ctx.storage.get<string>(this.docKey(name, sessionKey));
    if (scoped !== undefined) return scoped;
    // One-time migration: if an old global key exists, promote it to the scoped key.
    if (name !== "soul" && sessionKey) {
      const legacy = await this.ctx.storage.get<string>(`doc:${name}`);
      if (legacy) {
        await this.ctx.storage.put(this.docKey(name, sessionKey), legacy);
        await this.ctx.storage.delete(`doc:${name}`);
        return legacy;
      }
    }
    return "";
  }

  async saveDoc(name: DocName, text: string, sessionKey?: string): Promise<void> {
    await this.ctx.storage.put(this.docKey(name, sessionKey), text);
  }

  async appendDoc(name: DocName, line: string, sessionKey?: string): Promise<void> {
    const current = (await this.loadDoc(name, sessionKey)).trim();
    await this.saveDoc(name, current ? `${current}\n- ${line}` : `- ${line}`, sessionKey);
  }

  async clearDoc(name: DocName, sessionKey?: string): Promise<void> {
    await this.ctx.storage.delete(this.docKey(name, sessionKey));
  }

  // ----------------------------- the message handler -----------------------------
  async handleMessage(p: HandlePayload): Promise<void> {
    const env = this.env;
    const bot = makeBot(env.BOT_TOKEN);
    try {
      // Pick the area: explicit selection wins; an image with no selection -> "image".
      let areaId = (await this.getArea(p.sessionKey)) ?? (p.photoFileId ? "image" : DEFAULT_AREA);
      if (!AREAS[areaId]) areaId = DEFAULT_AREA;
      const area = AREAS[areaId];

      const image = p.photoFileId
        ? await downloadImageB64(bot, env.BOT_TOKEN, p.photoFileId)
        : undefined;
      const target = resolveTarget(area, !!image);
      const history = await this.getHistory(p.sessionKey);
      const [soul, agents, memory] = await Promise.all([
        this.loadDoc("soul"),
        this.loadDoc("agents", p.sessionKey),
        this.loadDoc("memory", p.sessionKey),
      ]);

      const reply = await generate(
        {
          system: buildSystem(area.system, { soul, agents, memory }),
          target,
          history,
          userText: p.text,
          image,
        },
        env,
      );

      await sendReply(bot, p.chatId, p.placeholderId, reply, p.threadId);
      await this.saveTurn(p.sessionKey, p.text || "(image)", reply);
    } catch (err) {
      console.error("agent handleMessage failed", err);
      await sendReply(
        bot,
        p.chatId,
        p.placeholderId,
        `⚠️ Error: ${(err as Error).message}`,
        p.threadId,
      );
    }
  }
}