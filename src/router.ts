import type { ModelTarget, EffortLevel } from "./types";

export interface AreaConfig {
  id: string;
  label: string;
  system: string;
  text: ModelTarget; // used for text turns
  image?: ModelTarget; // override when an image is attached
  levels?: EffortLevel[]; // selectable reasoning levels for this area (omit = none)
  defaultLevel?: EffortLevel; // level used when the user hasn't picked one
  hidden?: boolean; // omit from the /model menu (internal executor areas)
  stateless?: boolean; // skip history + docs + memory; treat each call as one-shot
  injectHealth?: boolean; // prepend the DO health baseline + summary + latest consult
}

// Shared system prompt for the tool-executor areas (admin chat + /do backend).
const EXECUTOR_SYSTEM = [
  "You are the user's personal admin executor with access to Todoist (tasks) and Housework (chores) tools. Carry out the user's request by calling the tools, then reply with a short confirmation of what you did.",
  "",
  "IMPORTANT: To answer ANY question about tasks or chores, you MUST call the tools first (get_tasks / list_chores). Never answer from memory and never say you can't access — always call the tool.",
  "",
  "Data model — the user uses Todoist's hierarchy as projects:",
  "- Top-level tasks (no parent_id) act as PROJECTS, e.g. 'Create telegram assistant bot'.",
  "- Subtasks (with a parent_id) are the STEPS inside a project.",
  "- A standalone top-level task is just a simple task, e.g. 'Mop the floor'.",
  "",
  "Rules:",
  "- To add a step to a project: first get_tasks to find the parent task's id, then add_task with that parent_id.",
  "- Never guess task ids — look them up with get_tasks first.",
  "- Use complete_task to check things off (not delete_task).",
  "- Priority: 1=normal, 2=medium, 3=high, 4=urgent. Due dates take natural language ('tomorrow', 'every weekday 9am').",
  "- Keep replies brief.",
].join("\n");

// Each area maps a kind of work to model(s). Assign one per Telegram topic with
// /model <id>. `text` handles normal turns; `image` (optional) overrides when a
// photo is attached.
//
// SWAPPING MODELS: change a `model` string (same vendor), or point a target at a
// different vendor from VENDORS in providers.ts. No other code changes.
export const AREAS: Record<string, AreaConfig> = {
  sonnet: {
    id: "sonnet",
    label: "Claude Sonnet",
    system: "You are a helpful personal assistant.",
    text: { vendor: "anthropic", model: "claude-sonnet-4-6", maxTokens: 4096 },
    levels: ["low", "medium", "high", "max"],
    defaultLevel: "low",
  },
  opus: {
    id: "opus",
    label: "Claude Opus",
    system: "Reason carefully and rigorously, then give a clear, well-structured answer.",
    text: { vendor: "anthropic", model: "claude-opus-4-8", maxTokens: 12000 },
    levels: ["low", "medium", "high", "xhigh", "max"],
    defaultLevel: "high",
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    system: "You are a helpful assistant.",
    text: { vendor: "gemini", model: "gemini-3.5-flash", maxTokens: 4096 },
    image: { vendor: "gemini", model: "gemini-3.5-flash", maxTokens: 4096 },
    levels: ["low", "medium", "high"],
    defaultLevel: "medium",
  },
  gpt: {
    id: "gpt",
    label: "ChatGPT 5.5 (OpenAI flagship)",
    system: "You are a helpful assistant.",
    text: { vendor: "openai", model: "gpt-5.5", maxTokens: 4096 },
    image: { vendor: "openai", model: "gpt-5.5", maxTokens: 4096 },
  },
  "gpt-mini": {
    id: "gpt-mini",
    label: "ChatGPT 5.4-mini (OpenAI, cheap)",
    system: "You are a helpful assistant.",
    text: { vendor: "openai", model: "gpt-5.4-mini", maxTokens: 4096 },
    image: { vendor: "openai", model: "gpt-5.4-mini", maxTokens: 4096 },
  },
  health: {
    id: "health",
    label: "Health · TCM · Cycle (Sonnet)",
    system: [
      "You are the user's personal Traditional Chinese Medicine practitioner, nutritionist, and cycle-sync expert, in an ongoing relationship — you understand HER body over time, not one-off answers.",
      "You may be given her health baseline, a running summary (standing patterns + recent trend), and her most recent full consultation. Always reason from these and reference recurring patterns rather than treating each message in isolation.",
      "If no baseline is present yet, run a PROGRESSIVE intake interview: ask a few key questions at a time (TCM 'Ten Questions' style — sleep, digestion, temperature, appetite/thirst, energy, menstruation, emotions, pain), deepening over several exchanges rather than one long form. Mention she can upload her health history with /baseline.",
      "Interpret symptoms through a TCM lens (qi/blood, yin/yang, warming/cooling, organ systems) and map to her cycle phase. When she shares a tongue / face / hair photo, read it as part of the diagnosis.",
      "Give practical nutrition / food-therapy guidance for her current phase + symptoms, plus lifestyle notes. Be conversational: ask a sharpening follow-up rather than dumping generic advice.",
      "Recording: /checkin saves a quick structured trend entry; /diagnosis archives your full consultation note. When she logs, make sure your latest message clearly states cycle day, phase, flow, energy/mood, tongue, symptoms, your TCM pattern, and nutrition focus.",
      "TCM and nutrition are complementary, not a substitute for medical care. For severe, persistent, or red-flag symptoms, recommend seeing a doctor/gynaecologist.",
    ].join("\n"),
    // Sonnet: careful health calibration + the large stable prompt caches well. Vision for tongue/food photos.
    text: { vendor: "anthropic", model: "claude-sonnet-4-6", maxTokens: 4096 },
    image: { vendor: "anthropic", model: "claude-sonnet-4-6", maxTokens: 4096 },
    levels: ["low", "medium", "high", "max"],
    defaultLevel: "medium",
    injectHealth: true,
  },
  kimi: {
    id: "kimi",
    label: "Kimi 2.6 (Workers AI, free)",
    system: "You are a concise, helpful assistant.",
    text: { vendor: "workersai", model: "@cf/moonshotai/kimi-k2.6", maxTokens: 8192 },
    // Kimi on the Workers AI binding is text-only here, so route photos to Gemini.
    image: { vendor: "gemini", model: "gemini-3.5-flash", maxTokens: 2048 },
  },
  admin: {
    id: "admin",
    label: "Admin (Todoist + Housework)",
    system: EXECUTOR_SYSTEM,
    // Foreground admin chat on Nemotron — tool-calls reliably thanks to the global
    // "detailed thinking off" injection in callWorkersAIWithTools (model-name based).
    text: { vendor: "workersai", model: "@cf/nvidia/nemotron-3-120b-a12b", maxTokens: 8192, tools: ["todoist", "housework"] },
  },
  // Hidden backend executor for /do — applies a plan via tools, stateless, no chat.
  // Nemotron: needs "detailed thinking off" (injected in providers.ts) to emit tool calls —
  // in thinking-on mode it reasons instead of calling. MoE → cheap; tuned for agentic tool use.
  do: {
    id: "do",
    label: "Executor (backend, /do)",
    system: EXECUTOR_SYSTEM,
    text: { vendor: "workersai", model: "@cf/nvidia/nemotron-3-120b-a12b", maxTokens: 8192, tools: ["todoist", "housework"] },
    hidden: true,
    stateless: true,
  },
  // Hidden stateless executor for /log: posture/workout notes to GitHub. GitHub tools ONLY,
  // so it can't mis-route to Todoist. Its own prompt maps scores to log_posture, exercises to add_weekly_plan.
  log: {
    id: "log",
    label: "Posture log (GitHub)",
    system: [
      "You log posture assessments to the user's notes via the log_posture tool, then reply with a short confirmation.",
      "Map the five region scores (cranio-cervical, shoulder girdle, thoracolumbar, pelvic/hip, lower extremity) to log_posture; each region is /20 and the total is computed. Also pass a short 'diagnosis' (key findings) and 'top_focus' (the single thing to work on) if present.",
      "Call log_posture EXACTLY ONCE, then confirm briefly - do NOT call it again.",
    ].join("\n"),
    text: { vendor: "workersai", model: "@cf/nvidia/nemotron-3-120b-a12b", maxTokens: 8192, tools: ["posture"] },
    hidden: true,
    stateless: true,
  },
  // /plan: weekly exercise/workout suggestions (add_weekly_plan only).
  plan: {
    id: "plan",
    label: "Weekly plan (GitHub)",
    system: [
      "You save the week's exercise/workout suggestions to the user's notes via the add_weekly_plan tool, then reply with a short confirmation.",
      "Pass the week's focus (one line) and the list of exercises to add_weekly_plan.",
      "Call add_weekly_plan EXACTLY ONCE, then confirm briefly - do NOT call it again.",
    ].join("\n"),
    text: { vendor: "workersai", model: "@cf/nvidia/nemotron-3-120b-a12b", maxTokens: 8192, tools: ["workout"] },
    hidden: true,
    stateless: true,
  },
};

export const DEFAULT_AREA = "kimi";

export function resolveTarget(area: AreaConfig, hasImage: boolean): ModelTarget {
  return hasImage && area.image ? area.image : area.text;
}

// Renders the selectable areas as a model menu, with reasoning levels in brackets.
// Pass the current area id to mark it.
export function areaList(current?: string): string {
  const lines = Object.values(AREAS).filter((a) => !a.hidden).map((a) => {
    const here = a.id === current ? "✓ " : "";
    const levels = a.levels ? `  [${a.levels.join("/")}]` : "";
    const note = a.id === "admin" ? "  · Todoist + Housework" : "";
    return `${here}${a.id} — ${a.text.model}${levels}${note}`;
  });
  return (
    lines.join("\n") +
    "\n\nLevels: low = no thinking (fast) · medium/high/max = deeper reasoning, slower." +
    "\nSet with /model <name> [level] — e.g. /model opus high"
  );
}