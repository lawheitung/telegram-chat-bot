import type { ModelTarget } from "./types";

export interface AreaConfig {
  id: string;
  label: string;
  system: string;
  text: ModelTarget; // used for text turns
  image?: ModelTarget; // override when an image is attached
}

// Each area maps a kind of work to model(s). Assign one per Telegram topic with
// /model <id>. `text` handles normal turns; `image` (optional) overrides when a
// photo is attached.
//
// SWAPPING MODELS: change a `model` string (same vendor), or point a target at a
// different vendor from VENDORS in providers.ts. No other code changes.
export const AREAS: Record<string, AreaConfig> = {
  default: {
    id: "default",
    label: "General (Claude)",
    system: "You are a helpful personal assistant.",
    text: { vendor: "anthropic", model: "claude-sonnet-4-6", maxTokens: 4096 },
  },
  think: {
    id: "think",
    label: "Deep thinking (Claude Opus)",
    system: "Reason carefully and rigorously, then give a clear, well-structured answer.",
    text: { vendor: "anthropic", model: "claude-opus-4-8", thinking: true, maxTokens: 12000 },
  },
  cv: {
    id: "cv",
    label: "CV / vision work (Claude)",
    system: "You are a computer-vision expert. Analyze images precisely and technically.",
    text: { vendor: "anthropic", model: "claude-sonnet-4-6", maxTokens: 3000 },
    image: { vendor: "anthropic", model: "claude-sonnet-4-6", maxTokens: 3000 },
  },
  image: {
    id: "image",
    label: "Images (Gemini)",
    system: "You analyze and describe images accurately.",
    text: { vendor: "gemini", model: "gemini-3.5-flash", maxTokens: 2048 },
  },
  kimi: {
    id: "kimi",
    label: "Kimi 2.6 (Workers AI, free)",
    system: "You are a concise, helpful assistant.",
    text: { vendor: "workersai", model: "@cf/moonshotai/kimi-k2.6", maxTokens: 8192 },
    // Kimi on the Workers AI binding is text-only here, so route photos to Gemini.
    image: { vendor: "gemini", model: "gemini-3.5-flash", maxTokens: 2048 },
  },
  schedule: {
    id: "schedule",
    label: "Scheduling (Todoist)",
    system: "You are a concise scheduling assistant.",
    text: { vendor: "anthropic", model: "claude-haiku-4-5-20251001", maxTokens: 1024 },
    // TODO: add Todoist tools in the planner step.
  },
};

export const DEFAULT_AREA = "kimi";

export function resolveTarget(area: AreaConfig, hasImage: boolean): ModelTarget {
  return hasImage && area.image ? area.image : area.text;
}

export function areaList(): string {
  return Object.values(AREAS)
    .map((a) => {
      const img = a.image ? `, image=${a.image.vendor}:${a.image.model}` : "";
      return `• ${a.id} — ${a.label} [${a.text.vendor}:${a.text.model}${img}]`;
    })
    .join("\n");
}