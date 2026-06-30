import { DurableObject } from "cloudflare:workers";
import type { Env, ChatMessage, ModelTarget } from "./types";
import { makeBot, downloadImageB64, downloadFileText, isTextMime, isImageMime, sendReply, buildSystem, MAX_TURNS } from "./bot";
import { MODELS, DEFAULT_MODEL, EXECUTORS, TEMPLATES, BASE_SYSTEM, VISION_FALLBACK } from "./router";
import { generate } from "./providers";

// Everything the agent needs to handle one message. Plain data — sent over RPC.
export interface HandlePayload {
  chatId: number;
  threadId?: number;
  placeholderId: number;
  sessionKey: string;
  text: string;
  photoFileId?: string;
  documentFileId?: string;
  documentMimeType?: string;
  documentFileName?: string;
  areaOverride?: string; // force a specific area (e.g. /do → the backend executor)
}

// Editable docs that make up the system prompt.
// Global: soul, user, tools
// Per-thread: agents, memory, heartbeat, local_tools
export type DocName = "soul" | "user" | "agents" | "tools" | "memory" | "heartbeat" | "local_tools";

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

  // Extract key facts from a history chunk and append them to the memory doc.
  // Uses Haiku for speed/cost. Returns the extracted text, or "" if nothing found.
  private async extractAndSaveMemory(history: ChatMessage[], sessionKey: string): Promise<string> {
    if (history.length === 0) return "";
    const target: ModelTarget = { vendor: "anthropic", model: "claude-haiku-4-5-20251001", maxTokens: 1024 };
    let extracted = "";
    try {
      extracted = await generate(
        {
          system: "You are a memory extraction assistant. Identify and preserve important facts.",
          target,
          history,
          userText: "Extract key facts, user preferences, and decisions from this conversation for long-term memory. Use bullet points starting with '- '. If nothing is worth saving, reply with exactly: nothing",
        },
        this.env,
      );
    } catch (err) {
      console.error("memory extraction failed", err);
      return "";
    }
    if (!extracted.trim() || extracted.trim().toLowerCase() === "nothing") return "";
    const current = (await this.loadDoc("memory", sessionKey)).trim();
    const block = extracted.trim();
    await this.saveDoc("memory", current ? `${current}\n\n${block}` : block, sessionKey);
    return block;
  }

  private async saveTurn(key: string, userText: string, assistantText: string): Promise<void> {
    const history = await this.getHistory(key);
    history.push(
      { role: "user", content: userText },
      { role: "assistant", content: assistantText },
    );
    // Auto-compact: before dropping old messages, silently extract facts from them.
    if (history.length > MAX_TURNS * 2) {
      const dropping = history.slice(0, history.length - MAX_TURNS * 2);
      await this.extractAndSaveMemory(dropping, key);
    }
    await this.ctx.storage.put(`history:${key}`, history.slice(-MAX_TURNS * 2));
  }

  async clearHistory(key: string): Promise<void> {
    await this.ctx.storage.delete(`history:${key}`);
  }

  // Manual compact: extract from full history, keep last 3 pairs for continuity.
  async compact(sessionKey: string): Promise<string> {
    const history = await this.getHistory(sessionKey);
    if (history.length < 2) return "";
    const extracted = await this.extractAndSaveMemory(history, sessionKey);
    await this.ctx.storage.put(`history:${sessionKey}`, history.slice(-6));
    return extracted;
  }

  // ----------------------------- per-thread model + tools + inject -----------------------------
  // A thread = an agent (persona + memory). The model (brain) and tools (capabilities) are
  // independent, switchable per-thread settings.
  async getModel(key: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`model:${key}`)) ?? null;
  }
  async setModel(key: string, model: string): Promise<void> {
    await this.ctx.storage.put(`model:${key}`, model);
  }

  async getTools(key: string): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(`tools:${key}`)) ?? [];
  }
  async setTools(key: string, tools: string[]): Promise<void> {
    await this.ctx.storage.put(`tools:${key}`, tools);
  }

  async getInject(key: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`inject:${key}`)) ?? null;
  }

  // Seed a thread into a kind of agent: persona doc + starting model + tools + inject.
  async applyTemplate(key: string, templateId: string): Promise<string> {
    const t = TEMPLATES[templateId];
    if (!t) return `Unknown agent template: ${templateId}. Options: ${Object.keys(TEMPLATES).join(", ")}.`;
    await this.saveDoc("agents", t.persona, key);
    await this.setModel(key, t.model);
    await this.setTools(key, t.tools);
    if (t.inject) await this.ctx.storage.put(`inject:${key}`, t.inject);
    else await this.ctx.storage.delete(`inject:${key}`);
    const tools = t.tools.length ? t.tools.join(", ") : "none";
    return `This thread is now the “${t.label}” agent — model ${t.model}, tools: ${tools}. Persona set. Swap the brain anytime with /model.`;
  }

  // Per-thread reasoning level (overrides the area's defaultLevel). Stored
  // separately from the area so /model <name> and /model <name> <level> compose.
  async getEffort(key: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`effort:${key}`)) ?? null;
  }

  async setEffort(key: string, effort: string): Promise<void> {
    await this.ctx.storage.put(`effort:${key}`, effort);
  }

  async clearEffort(key: string): Promise<void> {
    await this.ctx.storage.delete(`effort:${key}`);
  }

  // ----------------------------- editable docs -----------------------------
  // soul is global; agents and memory are scoped per thread via sessionKey.
  private docKey(name: DocName, sessionKey?: string): string {
    if (name === "soul" || name === "user" || name === "tools") return `doc:${name}`;
    return `doc:${name}:${sessionKey ?? "global"}`;
  }

  async loadDoc(name: DocName, sessionKey?: string): Promise<string> {
    const scoped = await this.ctx.storage.get<string>(this.docKey(name, sessionKey));
    if (scoped !== undefined) return scoped;
    // One-time migration: if an old global key exists, promote it to the scoped key.
    if (name !== "soul" && name !== "user" && name !== "tools" && sessionKey) {
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

  // ----------------------------- named agents -----------------------------
  async setAgentName(threadKey: string, name: string, chatId?: number, threadId?: number): Promise<void> {
    await this.ctx.storage.put(`agent:name:${threadKey}`, name);
    if (chatId !== undefined) {
      await this.ctx.storage.put(`agent:location:${name}`, `${chatId}:${threadId ?? ""}`);
    }
  }

  async getAgentName(threadKey: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`agent:name:${threadKey}`)) ?? null;
  }

  async clearAgentName(threadKey: string): Promise<void> {
    const name = await this.getAgentName(threadKey);
    await this.ctx.storage.delete(`agent:name:${threadKey}`);
    if (name) await this.ctx.storage.delete(`agent:location:${name}`);
  }

  async getAgentLocation(name: string): Promise<{ chatId: number; threadId?: number } | null> {
    const raw = await this.ctx.storage.get<string>(`agent:location:${name}`);
    if (!raw) return null;
    const [chatIdStr, threadIdStr] = raw.split(":");
    return { chatId: Number(chatIdStr), threadId: threadIdStr ? Number(threadIdStr) : undefined };
  }

  // True if any thread is bound to this agent name. Independent of whether a
  // location was stored, so it stays correct for agents created any way.
  async agentExists(name: string): Promise<boolean> {
    const map = await this.ctx.storage.list<string>({ prefix: "agent:name:" });
    for (const v of map.values()) {
      if (v === name) return true;
    }
    return false;
  }

  async listAgents(): Promise<Array<{ name: string; threadKey: string; chatId?: number; threadId?: number }>> {
    const map = await this.ctx.storage.list<string>({ prefix: "agent:name:" });
    const result: Array<{ name: string; threadKey: string; chatId?: number; threadId?: number }> = [];
    for (const [k, v] of map) {
      const threadKey = k.slice("agent:name:".length);
      const loc = await this.getAgentLocation(v);
      result.push({ threadKey, name: v, chatId: loc?.chatId, threadId: loc?.threadId });
    }
    return result;
  }

  async resolveSessionKey(threadKey: string): Promise<string> {
    const name = await this.getAgentName(threadKey);
    return name ? `agent:${name}` : threadKey;
  }

  // Returns the last assistant message in a session's history, or null if none.
  async getLastAssistantMessage(sessionKey: string): Promise<string | null> {
    const history = await this.getHistory(sessionKey);
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "assistant") return history[i].content;
    }
    return null;
  }

  // ----------------------------- health thread (DO-backed, markdown) -----------------------------
  // Three layers, all model-neutral markdown stored in the DO (fast local reads, no GitHub):
  //  • baseline   — uploaded health history (set via /baseline)        → injected
  //  • summary    — trend table + running synthesis (updated by /checkin) → injected
  //  • dx:<date>  — full per-consultation notes (saved by /diagnosis)   → latest injected
  async setHealthBaseline(key: string, text: string): Promise<void> {
    await this.ctx.storage.put(`health:baseline:${key}`, text);
  }
  async getHealthBaseline(key: string): Promise<string> {
    return (await this.ctx.storage.get<string>(`health:baseline:${key}`)) ?? "";
  }
  async getHealthSummary(key: string): Promise<string> {
    return (await this.ctx.storage.get<string>(`health:summary:${key}`)) ?? "";
  }
  async getLatestDiagnosis(key: string): Promise<string> {
    const map = await this.ctx.storage.list<string>({ prefix: `health:dx:${key}:` });
    let latestK = "";
    let latestV = "";
    for (const [k, v] of map) {
      if (k > latestK) {
        latestK = k;
        latestV = v;
      }
    }
    return latestV;
  }

  // /diagnosis — save the last assistant message as a dated full consultation note.
  async saveDiagnosis(key: string): Promise<string> {
    const last = await this.getLastAssistantMessage(key);
    if (!last) return "Nothing to save — have a consultation first, then /diagnosis.";
    const date = new Date().toISOString().slice(0, 10);
    await this.ctx.storage.put(`health:dx:${key}:${date}`, `# Consultation ${date}\n\n${last}`);
    return `Saved full diagnosis note for ${date}.`;
  }

  // /checkin — turn the latest consultation into a trend row + refreshed synthesis (summary doc).
  // A cheap Haiku pass extracts the structured row; the DO persists the rebuilt markdown.
  async healthCheckin(key: string): Promise<string> {
    const last = await this.getLastAssistantMessage(key);
    if (!last) return "Nothing to log — have a consultation first, then /checkin.";
    const date = new Date().toISOString().slice(0, 10);
    const prev = await this.getHealthSummary(key);
    const sys = [
      "You maintain a health/cycle log. From the consultation below, output EXACTLY two parts and nothing else:",
      `ROW: | ${date} | <cycle day> | <phase> | <flow> | <energy 0-10> | <mood 0-10> | <tongue> | <symptoms> | <TCM pattern> | <nutrition focus> |`,
      "SYNTHESIS:",
      "<2-4 sentences capturing her STANDING patterns over time, updated with this entry>",
      "Use '-' for any cell you lack. Keep each cell short with no '|' inside it.",
    ].join("\n");
    const userText = `Existing summary (for synthesis continuity):\n${prev || "(none yet)"}\n\nLatest consultation:\n${last}`;
    let out: string;
    try {
      out = await generate(
        { system: sys, target: { vendor: "anthropic", model: "claude-haiku-4-5", maxTokens: 1024 }, history: [], userText },
        this.env,
      );
    } catch (e) {
      return `Check-in failed: ${(e as Error).message}`;
    }
    const rowM = out.match(/ROW:\s*(\|.*\|)/);
    if (!rowM) return "Couldn't extract a check-in row — add a bit more detail, then /checkin.";
    const row = rowM[1].trim();
    const synM = out.match(/SYNTHESIS:\s*([\s\S]*)$/);
    const synthesis = (synM ? synM[1] : "").trim();

    const HEADER =
      "| Date | Cycle day | Phase | Flow | Energy | Mood | Tongue | Symptoms | TCM pattern | Nutrition focus |\n" +
      "|------|:---------:|:-----:|:----:|:------:|:----:|--------|----------|-------------|-----------------|";
    const isSep = (l: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l);
    const firstCell = (l: string) => l.trim().replace(/^\|/, "").split("|")[0].trim();
    const oldRows = prev
      .split("\n")
      .filter((l) => l.trim().startsWith("|") && !isSep(l) && firstCell(l) !== "Date" && firstCell(l) !== date);
    const doc =
      `# Health summary (updated ${date})\n\n## Standing patterns\n${synthesis || "(building…)"}\n\n## Trend\n${HEADER}\n${row}\n${oldRows.join("\n")}`.trimEnd() +
      "\n";
    await this.ctx.storage.put(`health:summary:${key}`, doc);
    return `Logged check-in for ${date}.`;
  }

  // ----------------------------- the message handler -----------------------------
  async handleMessage(p: HandlePayload): Promise<void> {
    const env = this.env;
    const bot = makeBot(env.BOT_TOKEN);
    try {
      const hasImage = !!p.photoFileId || !!(p.documentFileId && p.documentMimeType && isImageMime(p.documentMimeType));

      const photoImage = p.photoFileId
        ? await downloadImageB64(bot, env.BOT_TOKEN, p.photoFileId)
        : undefined;

      let userText = p.text;
      let historyLabel = p.text || "(image)";
      let docImage: { mimeType: string; dataB64: string } | undefined;

      if (p.documentFileId) {
        if (p.documentMimeType && isImageMime(p.documentMimeType)) {
          docImage = await downloadImageB64(bot, env.BOT_TOKEN, p.documentFileId);
          historyLabel = p.text || `(image: ${p.documentFileName ?? p.documentMimeType})`;
        } else if (p.documentMimeType && isTextMime(p.documentMimeType)) {
          const fileContent = await downloadFileText(bot, env.BOT_TOKEN, p.documentFileId);
          const header = p.documentFileName ? `[File: ${p.documentFileName}]\n` : "[File]\n";
          userText = userText
            ? `${userText}\n\n${header}\`\`\`\n${fileContent}\n\`\`\``
            : `${header}\`\`\`\n${fileContent}\n\`\`\``;
          historyLabel = p.text || `(file: ${p.documentFileName ?? p.documentMimeType})`;
        } else {
          userText = userText
            ? `${userText}\n\n[Unsupported file type: ${p.documentMimeType ?? "unknown"} — only text-based files and images can be read]`
            : `[Unsupported file type: ${p.documentMimeType ?? "unknown"} — only text-based files and images can be read]`;
          historyLabel = p.text || "(unsupported file)";
        }
      }

      const image = photoImage ?? docImage;

      // Action-command backends (/do /log /plan): stateless executors, fixed model + tools.
      if (p.areaOverride && EXECUTORS[p.areaOverride]) {
        const ex = EXECUTORS[p.areaOverride];
        const exReply = await generate(
          { system: ex.system, target: { vendor: ex.vendor, model: ex.model, maxTokens: ex.maxTokens, tools: ex.tools }, history: [], userText },
          env,
        );
        await sendReply(bot, p.chatId, p.placeholderId, exReply, p.threadId);
        return; // stateless — nothing saved
      }

      // Conversational thread = an agent: persona (docs) + a per-thread model + per-thread tools.
      const modelId = (await this.getModel(p.sessionKey)) ?? DEFAULT_MODEL;
      const m = MODELS[modelId] ?? MODELS[DEFAULT_MODEL];

      const history = await this.getHistory(p.sessionKey);
      const [soul, user, tools, agents, memory, heartbeat, local_tools] = await Promise.all([
        this.loadDoc("soul"),
        this.loadDoc("user"),
        this.loadDoc("tools"),
        this.loadDoc("agents", p.sessionKey),
        this.loadDoc("memory", p.sessionKey),
        this.loadDoc("heartbeat", p.sessionKey),
        this.loadDoc("local_tools", p.sessionKey),
      ]);
      let system = buildSystem(BASE_SYSTEM, { soul, user, agents, tools, memory, heartbeat, local_tools });

      // Memory injection (set by the health template via /agent use health).
      if ((await this.getInject(p.sessionKey)) === "health") {
        const [baseline, summary, latestDx] = await Promise.all([
          this.getHealthBaseline(p.sessionKey),
          this.getHealthSummary(p.sessionKey),
          this.getLatestDiagnosis(p.sessionKey),
        ]);
        const add: string[] = [];
        if (baseline.trim()) add.push(`# Health baseline\n${baseline.trim()}`);
        if (summary.trim()) add.push(summary.trim());
        if (latestDx.trim()) add.push(`# Most recent consultation\n${latestDx.trim()}`);
        if (add.length) system = `${system}\n\n${add.join("\n\n")}`;
      }

      // Target = brain + attached tools + reasoning level. If the brain can't see images,
      // route this turn to the vision fallback (Gemini) instead.
      let target: ModelTarget;
      if (image && !m.vision) {
        target = { ...VISION_FALLBACK };
      } else {
        target = { vendor: m.vendor, model: m.model, maxTokens: m.maxTokens };
        const attached = await this.getTools(p.sessionKey);
        if (attached.length && m.supportsTools) target.tools = attached;
        if (m.levels) {
          const level = (await this.getEffort(p.sessionKey)) ?? m.defaultLevel;
          if (level) target.effort = level as ModelTarget["effort"];
        }
      }

      const reply = await generate({ system, target, history, userText, image }, env);

      // --- Gemini-eyes pipeline (disabled for now; flip back by restoring this branch) ---
      // Two-stage, by turn: Gemini analyzes the image (its reply is what you see, saved to
      // history), then a text follow-up lets the thread's model reason over it.
      // let reply: string;
      // if (image) {
      //   reply = await generate(
      //     {
      //       system: `You are the vision component of an assistant. Analyze the image in precise detail for the task below — describe what you observe that is relevant. Do not give advice or a plan; the user will follow up and the assistant handles that.\n\n--- Task ---\n${system}`,
      //       target: { vendor: "gemini", model: "gemini-3.5-flash", maxTokens: 8192 },
      //       history: [],
      //       userText: userText || "Analyze this image for the task above.",
      //       image,
      //     },
      //     env,
      //   );
      // } else {
      //   const base = resolveTarget(area, false);
      //   const level = (await this.getEffort(p.sessionKey)) ?? area.defaultLevel;
      //   const target = level ? { ...base, effort: level as ModelTarget["effort"] } : base;
      //   reply = await generate({ system, target, history, userText }, env);
      // }

      await sendReply(bot, p.chatId, p.placeholderId, reply, p.threadId);
      await this.saveTurn(p.sessionKey, historyLabel, reply);
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