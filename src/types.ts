// All shared types live here.

import type { Task } from "../../todoist-mcp/src/todoist.js";

export type { Task };

// RPC interface for the Todoist service binding.
export interface TodoistRpc {
  getTasks(opts: { mode: "flat" | "tree"; parent_id?: string; label?: string; filter?: string }): Promise<Task[]>;
  addTask(params: { content: string; description?: string; parent_id?: string; due_string?: string; priority?: number; labels?: string[] }): Promise<Task>;
  updateTask(taskId: string, params: { content?: string; description?: string; due_string?: string | null; priority?: number; labels?: string[] }): Promise<Task>;
  completeTask(taskId: string): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  moveTask(taskId: string, newParentId: string | null): Promise<void>;
}

export interface Chore {
  name: string;
  rule: "homeDays" | "homeHours" | "schedule";
  threshold?: number;
  intervalDays?: number;
  markerAtLastDone?: number;
  lastCompleted?: string | null;
}

export interface HouseworkRpc {
  listChores(): Promise<Record<string, Chore>>;
  addChore(id: string, data: Omit<Chore, "markerAtLastDone" | "lastCompleted">): Promise<Chore>;
  editChore(id: string, changes: Partial<Omit<Chore, "markerAtLastDone" | "lastCompleted">>): Promise<Chore>;
  deleteChore(id: string): Promise<void>;
}

export interface Env {
    // Secrets (wrangler secret put ...)
    BOT_TOKEN: string;
    ANTHROPIC_API_KEY: string;
    GEMINI_API_KEY: string;
    OPENAI_API_KEY: string;
    WEBHOOK_SECRET: string;

    // Plain var (wrangler.toml [vars])
    ALLOWED_USER_IDS: string;
    GITHUB_OWNER: string; // e.g. "lawheitung"
    GITHUB_REPO: string; // e.g. "personalnotes"

    // Secret (wrangler secret put GITHUB_TOKEN) — fine-grained PAT, Contents: read/write
    GITHUB_TOKEN: string;

    // Bindings
    AI: Ai; // Workers AI (free models, no key)
    FOODDB: D1Database; // grocery/food catalog queried by the meal agent
    AGENT: DurableObjectNamespace<import("./agent").AgentDO>;
    TODOIST: TodoistRpc; // Todoist service binding — RPC, same isolate
    HOUSEWORK: HouseworkRpc; // Housework tracker service binding — RPC, same isolate
  }
  
  export type Role = "user" | "assistant";
  
  export interface ChatMessage {
    role: Role;
    content: string;
  }
  
  // Reasoning level. low = thinking off (fast); medium+ = adaptive thinking at that depth.
  // Maps to Anthropic output_config.effort and Gemini thinkingConfig.thinkingLevel.
  export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

  // Which model to call for a given turn.
  export interface ModelTarget {
    vendor: string; // key into VENDORS (providers.ts)
    model: string;
    effort?: EffortLevel; // reasoning level; injected per-thread at request time
    maxTokens: number;
    tools?: string[]; // tool bundles this turn gets, e.g. ["todoist","housework"] or ["github"]
  }
  
  export interface GenerateInput {
    system: string;
    target: ModelTarget;
    history: ChatMessage[];
    userText: string;
    image?: { mimeType: string; dataB64: string };
  }