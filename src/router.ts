import type { ModelTarget, EffortLevel } from "./types";

// ============================================================================
// The new model: a THREAD is an agent (persona + memory). On top of it you pick
// a MODEL (brain) with /model and attach TOOLS with /tools — both per-thread,
// switchable anytime. TEMPLATES seed a thread into a kind of agent; EXECUTORS are
// the stateless backends for the /do /log /plan action commands.
// ============================================================================

// ----------------------------- MODELS (brains) -----------------------------
export interface ModelDef {
  id: string;
  label: string;
  vendor: string;
  model: string;
  maxTokens: number;
  levels?: EffortLevel[]; // selectable reasoning levels (omit = none)
  defaultLevel?: EffortLevel;
  supportsTools?: boolean; // can run a tool loop (Anthropic + Workers AI only)
  vision?: boolean; // can read images directly
}

export const MODELS: Record<string, ModelDef> = {
  kimi: { id: "kimi", label: "Kimi 2.6 (Workers AI, free)", vendor: "workersai", model: "@cf/moonshotai/kimi-k2.6", maxTokens: 8192, supportsTools: true },
  haiku: { id: "haiku", label: "Claude Haiku 4.5 (cheap, tools)", vendor: "anthropic", model: "claude-haiku-4-5", maxTokens: 4096, supportsTools: true, vision: true },
  sonnet: { id: "sonnet", label: "Claude Sonnet 4.6", vendor: "anthropic", model: "claude-sonnet-4-6", maxTokens: 4096, levels: ["low", "medium", "high", "max"], defaultLevel: "low", supportsTools: true, vision: true },
  opus: { id: "opus", label: "Claude Opus 4.8", vendor: "anthropic", model: "claude-opus-4-8", maxTokens: 12000, levels: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "high", supportsTools: true, vision: true },
  gemini: { id: "gemini", label: "Gemini 3.5 Flash", vendor: "gemini", model: "gemini-3.5-flash", maxTokens: 4096, levels: ["low", "medium", "high"], defaultLevel: "medium", vision: true },
  gpt: { id: "gpt", label: "GPT-5.5 (OpenAI)", vendor: "openai", model: "gpt-5.5", maxTokens: 4096, vision: true },
  "gpt-mini": { id: "gpt-mini", label: "GPT-5.4-mini (OpenAI, cheap)", vendor: "openai", model: "gpt-5.4-mini", maxTokens: 4096, vision: true },
};

export const DEFAULT_MODEL = "kimi";

// When the chosen model can't see images (Kimi), route that turn here instead.
export const VISION_FALLBACK: ModelTarget = { vendor: "gemini", model: "gemini-3.5-flash", maxTokens: 4096 };

// Base persona when a thread hasn't set its own (the persona doc layers on top).
export const BASE_SYSTEM = "You are a helpful personal assistant.";

// ----------------------------- TOOL BUNDLES (attachable) -----------------------------
// Names map to bundles in providers.ts. Attach/detach per thread with /tools.
// NOTE: tools only run on models with supportsTools (Claude + Workers AI).
export const TOOL_BUNDLE_NAMES = ["todoist", "housework", "posture", "workout", "food"];

// Shared executor persona (admin chat + /do backend).
const EXECUTOR_SYSTEM = [
  "You are the user's personal admin executor with access to Todoist (tasks) and Housework (chores) tools. Carry out the request by calling the tools, then reply with a short confirmation.",
  "IMPORTANT: To answer ANY question about tasks or chores you MUST call the tools first (get_tasks / list_chores). Never answer from memory or say you can't access — always call the tool.",
  "Data model: top-level Todoist tasks (no parent_id) act as PROJECTS; subtasks (with parent_id) are the steps. To add a step, get_tasks to find the parent id, then add_task with that parent_id. Never guess ids. Use complete_task to check off (not delete). Priority 1-4; due dates take natural language. Keep replies brief.",
].join("\n");

// ----------------------------- TEMPLATES (agents) -----------------------------
// Seed a thread into a kind of agent: writes the persona doc + sets a starting model
// + attaches tools (+ optional memory injection). Apply with /agent use <id>.
// Afterwards, swap the model and tools freely.
export interface TemplateDef {
  id: string;
  label: string;
  persona: string;
  model: string;
  tools: string[];
  inject?: "health";
}

export const TEMPLATES: Record<string, TemplateDef> = {
  health: {
    id: "health",
    label: "Health · TCM · Cycle",
    model: "sonnet",
    tools: [],
    inject: "health",
    persona: [
      "You are the user's personal Traditional Chinese Medicine practitioner, nutritionist, and cycle-sync expert, in an ongoing relationship — you understand HER body over time, not one-off answers.",
      "You may be given her health baseline, a running summary (standing patterns + recent trend), and her most recent full consultation. Always reason from these and reference recurring patterns.",
      "If no baseline is present yet, run a PROGRESSIVE intake interview (TCM 'Ten Questions' style — sleep, digestion, temperature, appetite/thirst, energy, menstruation, emotions, pain), deepening over several exchanges. Mention she can upload her health history with /baseline.",
      "Interpret symptoms through a TCM lens (qi/blood, yin/yang, warming/cooling, organ systems) and map to her cycle phase. Read tongue/face/hair photos as part of the diagnosis.",
      "Give practical nutrition / food-therapy guidance for her current phase + symptoms, plus lifestyle notes. Be conversational; ask a sharpening follow-up rather than dumping generic advice.",
      "Recording: /checkin saves a quick structured trend entry; /diagnosis archives your full consultation note.",
      "TCM and nutrition are complementary, not a substitute for medical care. For severe or red-flag symptoms, recommend seeing a doctor/gynaecologist.",
    ].join("\n"),
  },
  meal: {
    id: "meal",
    label: "Meal planner (food DB)",
    model: "haiku",
    tools: ["food"],
    persona: [
      "You are the user's meal-planning assistant. You compose meals and grocery picks from products she can ACTUALLY buy, using the search_food tool over her grocery catalog (name, brand, pack, price, macros, nutrigrade, stock).",
      "Use search_food to find real products — it returns the top 5 matches. If results are ambiguous or too broad, ASK her to clarify (price range, pack size, brand, dietary constraint) rather than guessing.",
      "Compose practical meals with real prices and rough macros; prefer in-stock items and note the cost. Query again as needed to round out a meal. Be conversational and concise.",
    ].join("\n"),
  },
  admin: {
    id: "admin",
    label: "Admin (Todoist + Housework)",
    model: "kimi",
    tools: ["todoist", "housework"],
    persona: EXECUTOR_SYSTEM,
  },
};

// ----------------------------- EXECUTORS (action-command backends) -----------------------------
// Stateless backends for /do /log /plan. Fixed model + tools + system. Not user-pickable.
export interface ExecutorDef {
  system: string;
  vendor: string;
  model: string;
  maxTokens: number;
  tools: string[];
}

const NEMOTRON = "@cf/nvidia/nemotron-3-120b-a12b";

export const EXECUTORS: Record<string, ExecutorDef> = {
  do: { system: EXECUTOR_SYSTEM, vendor: "workersai", model: NEMOTRON, maxTokens: 8192, tools: ["todoist", "housework"] },
  log: {
    system: [
      "You log posture assessments via the log_posture tool, then reply with a short confirmation.",
      "Map the five region scores (cranio-cervical, shoulder girdle, thoracolumbar, pelvic/hip, lower extremity) to log_posture; each is /20 and the total is computed. Also pass a short 'diagnosis' and 'top_focus' if present.",
      "Call log_posture EXACTLY ONCE, then confirm briefly - do NOT call it again.",
    ].join("\n"),
    vendor: "workersai", model: NEMOTRON, maxTokens: 8192, tools: ["posture"],
  },
  plan: {
    system: [
      "You save the week's exercise/workout suggestions via the add_weekly_plan tool, then reply with a short confirmation.",
      "Pass the week's focus (one line) and the list of exercises to add_weekly_plan.",
      "Call add_weekly_plan EXACTLY ONCE, then confirm briefly - do NOT call it again.",
    ].join("\n"),
    vendor: "workersai", model: NEMOTRON, maxTokens: 8192, tools: ["workout"],
  },
};

// ----------------------------- menus -----------------------------
export function modelList(current?: string): string {
  const lines = Object.values(MODELS).map((m) => {
    const here = m.id === current ? "✓ " : "";
    const lv = m.levels ? `  [${m.levels.join("/")}]` : "";
    const tools = m.supportsTools ? "" : "  · no tools";
    return `${here}${m.id} — ${m.label}${lv}${tools}`;
  });
  return (
    lines.join("\n") +
    "\n\nSet the brain with /model <name> [level] (e.g. /model opus high)." +
    "\nAttach capabilities with /tools. Become a specialised agent with /agent use <health|meal|admin>."
  );
}
