// GitHub-backed posture/workout tracker. Stores markdown in a private repo via the GitHub
// Contents API (no separate Worker - GitHub's API is directly callable). The executor
// (Nemotron) calls these tools; the files live in the repo, viewable on github.com / Obsidian.
//
// Repo layout (under the configured repo):
//   posture/summary.md         - the /20 region x date scores table
//   posture/weekly/<date>.md   - that week's exercise suggestions
//
// Owner + repo come from env vars; the token is a secret.

import type { Env } from "./types";

const GH_API = "https://api.github.com";
const SUMMARY_PATH = "Posture/Summary.md";
const WEEKLY_DIR = "Posture/weekly";
const CYCLE_PATH = "Health/CycleLog.md";

const CYCLE_HEADER =
  "| Date | Cycle Day | Phase | Flow | Energy | Mood | Symptoms | TCM Pattern | Nutrition Focus |\n" +
  "|------|:---------:|:-----:|:----:|:------:|:----:|----------|-------------|-----------------|";

// Free-text cells must not break the table: strip pipes/newlines.
const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "/").replace(/\s*\n\s*/g, " ").trim() || "-";

// Region columns are scored /20 (higher = better, 20 = ideal); Total is /100, computed.
const HEADER =
  "| Date | Cranio | Shoulder | Thoraco | Pelvic | Lower | Total | Diagnosis | Top focus |\n" +
  "|------|:------:|:--------:|:-------:|:------:|:-----:|:-----:|-----------|-----------|";

export const POSTURE_TOOLS = [
  {
    name: "log_posture",
    description:
      "Log a posture assessment to posture/summary.md on GitHub. Each of the five regions is " +
      "scored out of 20 (higher = better, 20 = ideal); the Total (/100) is computed automatically. " +
      "Adds a new dated row at the TOP of the table (newest first).",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Assessment date, e.g. '2026-06-15'. Defaults to today if omitted." },
        cranio_cervical: { type: "integer", minimum: 0, maximum: 20, description: "Cranio-cervical score /20" },
        shoulder_girdle: { type: "integer", minimum: 0, maximum: 20, description: "Shoulder girdle score /20" },
        thoracolumbar: { type: "integer", minimum: 0, maximum: 20, description: "Thoracolumbar score /20" },
        pelvic_hip: { type: "integer", minimum: 0, maximum: 20, description: "Pelvic & hip score /20" },
        lower_extremity: { type: "integer", minimum: 0, maximum: 20, description: "Lower extremity score /20" },
        diagnosis: { type: "string", description: "Short overall posture diagnosis / key findings" },
        top_focus: { type: "string", description: "The single top thing to work on" },
      },
      required: ["cranio_cervical", "shoulder_girdle", "thoracolumbar", "pelvic_hip", "lower_extremity"],
    },
  },
  {
    name: "get_posture",
    description: "Read recent posture scores from posture/summary.md so you can show the trend over time.",
    input_schema: {
      type: "object" as const,
      properties: { limit: { type: "integer", description: "How many recent rows to return (default 10)" } },
      required: [],
    },
  },
];

export const WORKOUT_TOOLS = [
  {
    name: "add_weekly_plan",
    description:
      "Write that week's exercise suggestions to posture/weekly/<week>.md on GitHub (overwrites if it exists). " +
      "Use after reviewing the posture analysis to prescribe exercises for the week.",
    input_schema: {
      type: "object" as const,
      properties: {
        week: { type: "string", description: "Week start date, e.g. '2026-06-15'. Defaults to today if omitted." },
        focus: { type: "string", description: "One-line focus for the week, e.g. 'open chest, strengthen mid-back'" },
        exercises: {
          type: "array",
          items: { type: "string" },
          description: "Exercise lines, e.g. ['Wall slides 3x10', 'Chin tucks 3x12']",
        },
      },
      required: ["exercises"],
    },
  },
  {
    name: "get_weekly_plan",
    description: "Read a weekly exercise plan from posture/weekly. Returns the latest week if no date is given.",
    input_schema: {
      type: "object" as const,
      properties: { week: { type: "string", description: "Week date, e.g. '2026-06-15'. Omit for the latest." } },
      required: [],
    },
  },
];

export const CYCLE_TOOLS = [
  {
    name: "log_cycle",
    description:
      "Log a health/cycle entry to Health/CycleLog.md on GitHub. Captures cycle phase, flow, " +
      "symptoms, energy/mood, and the TCM pattern + nutrition focus. Adds a dated row at the TOP " +
      "(newest first); re-logging the same date replaces that day's row.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Entry date, e.g. '2026-06-16'. Defaults to today." },
        cycle_day: { type: "string", description: "Cycle day the user states, e.g. 'Day 14' (free text)" },
        phase: { type: "string", description: "menstrual | follicular | ovulatory | luteal" },
        flow: { type: "string", description: "Flow level / none, e.g. 'light', 'heavy', '-'" },
        energy: { type: "integer", minimum: 0, maximum: 10, description: "Energy /10" },
        mood: { type: "integer", minimum: 0, maximum: 10, description: "Mood /10" },
        symptoms: { type: "string", description: "Key physical symptoms, short, e.g. 'cramps, bloating, poor sleep'" },
        tcm_pattern: { type: "string", description: "TCM read, e.g. 'blood deficiency, cold uterus'" },
        nutrition_focus: { type: "string", description: "Recommended food focus, e.g. 'warming foods, ginger, bone broth'" },
      },
      required: ["phase"],
    },
  },
  {
    name: "get_cycle",
    description: "Read recent health/cycle entries from Health/CycleLog.md to show the trend over time.",
    input_schema: {
      type: "object" as const,
      properties: { limit: { type: "integer", description: "How many recent rows to return (default 10)" } },
      required: [],
    },
  },
];

function headers(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "telegram-claude-bot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function contentsUrl(env: Env, path: string): string {
  return `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
}

const isSep = (l: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l);
const today = () => new Date().toISOString().slice(0, 10);

async function readFile(env: Env, path: string): Promise<{ content: string; sha: string | null }> {
  const res = await fetch(contentsUrl(env, path), { headers: headers(env) });
  if (res.status === 404) return { content: "", sha: null };
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: string; sha: string };
  const binary = atob(data.content.replace(/\n/g, ""));
  const content = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  return { content, sha: data.sha };
}

async function writeFile(env: Env, path: string, content: string, sha: string | null, message: string): Promise<void> {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const res = await fetch(contentsUrl(env, path), {
    method: "PUT",
    headers: { ...headers(env), "content-type": "application/json" },
    body: JSON.stringify({ message, content: btoa(binary), ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
}

async function listDir(env: Env, dir: string): Promise<string[]> {
  const res = await fetch(contentsUrl(env, dir), { headers: headers(env) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as Array<{ name: string; type: string }>;
  return data.filter((e) => e.type === "file" && e.name.endsWith(".md")).map((e) => e.name);
}

// Read the recent cycle-log rows (header + separator + newest `limit` rows) for injecting
// into the health agent's prompt. Returns "" if empty/unavailable — never throws.
export async function getRecentCycleLog(env: Env, limit = 15): Promise<string> {
  try {
    const { content } = await readFile(env, CYCLE_PATH);
    if (!content.trim()) return "";
    const rows = content.split("\n").filter((l) => l.trim().startsWith("|"));
    return rows.slice(0, limit + 2).join("\n");
  } catch {
    return "";
  }
}

export async function callGithubTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
): Promise<string> {
  try {
    if (name === "log_posture") {
      const a = args as Record<string, number | string>;
      const date = (a.date as string) || today();
      const vals = [a.cranio_cervical, a.shoulder_girdle, a.thoracolumbar, a.pelvic_hip, a.lower_extremity].map(Number);
      if (vals.some((v) => Number.isNaN(v))) return "Error: all five region scores are required (0-20).";
      const total = vals.reduce((s, v) => s + v, 0);
      const row = `| ${date} | ${vals[0]} | ${vals[1]} | ${vals[2]} | ${vals[3]} | ${vals[4]} | ${total} | ${cell(a.diagnosis)} | ${cell(a.top_focus)} |`;

      const { content, sha } = await readFile(env, SUMMARY_PATH);
      let next: string;
      if (!content.trim()) {
        next = `# Posture progress\n\nRegions scored /20 (higher = better, 20 = ideal). Total /100.\n\n${HEADER}\n${row}\n`;
      } else {
        const firstCell = (l: string) => l.trim().replace(/^\|/, "").split("|")[0].trim();
        // Drop ALL existing rows for this date (self-heals duplicates), then insert at top.
        const lines = content.split("\n").filter((l) => !(l.trim().startsWith("|") && !isSep(l) && firstCell(l) === date));
        const sepIdx = lines.findIndex((l, i) => i > 0 && isSep(l) && lines[i - 1].includes("|"));
        if (sepIdx >= 0) {
          lines.splice(sepIdx + 1, 0, row);
          next = lines.join("\n");
        } else {
          next = `${content.replace(/\n+$/, "")}\n\n${HEADER}\n${row}\n`;
        }
      }
      await writeFile(env, SUMMARY_PATH, next, sha, `posture: ${date} (${total}/100)`);
      return `Logged ${date}: total ${total}/100 - cranio ${vals[0]}, shoulder ${vals[1]}, thoraco ${vals[2]}, pelvic ${vals[3]}, lower ${vals[4]}.`;
    }

    if (name === "get_posture") {
      const { content } = await readFile(env, SUMMARY_PATH);
      if (!content.trim()) return "No posture entries logged yet.";
      const limit = Number((args as Record<string, unknown>).limit ?? 10);
      const tableRows = content.split("\n").filter((l) => l.trim().startsWith("|"));
      return tableRows.slice(0, limit + 2).join("\n") || "No entries.";
    }

    if (name === "log_cycle") {
      const a = args as Record<string, unknown>;
      const date = (a.date as string) || today();
      const row = `| ${date} | ${cell(a.cycle_day)} | ${cell(a.phase)} | ${cell(a.flow)} | ${cell(a.energy)} | ${cell(a.mood)} | ${cell(a.symptoms)} | ${cell(a.tcm_pattern)} | ${cell(a.nutrition_focus)} |`;

      const { content, sha } = await readFile(env, CYCLE_PATH);
      let next: string;
      if (!content.trim()) {
        next = `# Cycle & health log\n\nTCM-informed cycle tracking. Energy/Mood are /10.\n\n${CYCLE_HEADER}\n${row}\n`;
      } else {
        const firstCell = (l: string) => l.trim().replace(/^\|/, "").split("|")[0].trim();
        const lines = content.split("\n").filter((l) => !(l.trim().startsWith("|") && !isSep(l) && firstCell(l) === date));
        const sepIdx = lines.findIndex((l, i) => i > 0 && isSep(l) && lines[i - 1].includes("|"));
        if (sepIdx >= 0) {
          lines.splice(sepIdx + 1, 0, row);
          next = lines.join("\n");
        } else {
          next = `${content.replace(/\n+$/, "")}\n\n${CYCLE_HEADER}\n${row}\n`;
        }
      }
      await writeFile(env, CYCLE_PATH, next, sha, `cycle: ${date} (${cell(a.phase)})`);
      return `Logged cycle entry for ${date}: ${cell(a.phase)} phase.`;
    }

    if (name === "get_cycle") {
      const { content } = await readFile(env, CYCLE_PATH);
      if (!content.trim()) return "No cycle entries logged yet.";
      const limit = Number((args as Record<string, unknown>).limit ?? 10);
      const tableRows = content.split("\n").filter((l) => l.trim().startsWith("|"));
      return tableRows.slice(0, limit + 2).join("\n") || "No entries.";
    }

    if (name === "add_weekly_plan") {
      const a = args as Record<string, unknown>;
      const week = (a.week as string) || today();
      const focus = (a.focus as string) || "";
      const exercises = Array.isArray(a.exercises) ? (a.exercises as string[]) : [];
      if (exercises.length === 0) return "Error: at least one exercise is required.";
      const body =
        `# Week of ${week}\n\n` +
        (focus ? `**Focus:** ${focus}\n\n` : "") +
        `## Exercises\n` +
        exercises.map((e) => `- ${e}`).join("\n") +
        "\n";
      const path = `${WEEKLY_DIR}/${week}.md`;
      const { sha } = await readFile(env, path);
      await writeFile(env, path, body, sha, `weekly plan: ${week}`);
      return `Saved weekly plan for ${week} (${exercises.length} exercises).`;
    }

    if (name === "get_weekly_plan") {
      const week = (args as Record<string, unknown>).week as string | undefined;
      let path: string;
      if (week) {
        path = `${WEEKLY_DIR}/${week}.md`;
      } else {
        const files = await listDir(env, WEEKLY_DIR);
        if (files.length === 0) return "No weekly plans yet.";
        const latest = files.sort().reverse()[0];
        path = `${WEEKLY_DIR}/${latest}`;
      }
      const { content } = await readFile(env, path);
      return content.trim() || "No plan found for that week.";
    }

    return `Unknown tool: ${name}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
