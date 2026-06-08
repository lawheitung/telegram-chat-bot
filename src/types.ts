// All shared types live here.

export interface Env {
    // Secrets (wrangler secret put ...)
    BOT_TOKEN: string;
    ANTHROPIC_API_KEY: string;
    GEMINI_API_KEY: string;
    WEBHOOK_SECRET: string;
  
    // Plain var (wrangler.toml [vars])
    ALLOWED_USER_IDS: string;
  
    // Bindings
    AI: Ai; // Workers AI (free models, no key)
    AGENT: DurableObjectNamespace<import("./agent").AgentDO>; // the stateful agent — owns all state in its SQLite storage
  }
  
  export type Role = "user" | "assistant";
  
  export interface ChatMessage {
    role: Role;
    content: string;
  }
  
  // Which model to call for a given turn.
  export interface ModelTarget {
    vendor: string; // key into VENDORS (providers.ts)
    model: string;
    thinking?: boolean;
    maxTokens: number;
  }
  
  export interface GenerateInput {
    system: string;
    target: ModelTarget;
    history: ChatMessage[];
    userText: string;
    image?: { mimeType: string; dataB64: string };
  }