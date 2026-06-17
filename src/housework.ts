// Housework tool definitions (for Claude's tool list) and executor.
// Calls the housework-tracker worker directly via RPC Service Binding.

import type { HouseworkRpc } from "./types";

export const HOUSEWORK_TOOLS = [
  {
    name: "list_chores",
    description: "List all chores and their rules (how often they should be done).",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "add_chore",
    description:
      "Add a new chore. rule='homeDays' triggers after N days spent at home; " +
      "'homeHours' after N cumulative home hours; 'schedule' after N calendar days. " +
      "homeDays/homeHours require threshold; schedule requires intervalDays.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Short unique identifier, e.g. 'vacuum'" },
        name: { type: "string", description: "Display name, e.g. 'Vacuum living room'" },
        rule: { type: "string", enum: ["homeDays", "homeHours", "schedule"] },
        threshold: { type: "number", description: "For homeDays/homeHours: trigger after this many days/hours at home" },
        intervalDays: { type: "number", description: "For schedule: trigger every N calendar days" },
      },
      required: ["id", "name", "rule"],
    },
  },
  {
    name: "edit_chore",
    description:
      "Update an existing chore. Only pass fields to change. " +
      "IMPORTANT: if you change 'rule', you must also pass the matching field for the NEW rule: " +
      "'threshold' (positive number) for homeDays or homeHours; " +
      "'intervalDays' (positive number) for schedule. " +
      "The old rule's field is cleared automatically — do not pass both.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Chore ID to edit" },
        name: { type: "string" },
        rule: { type: "string", enum: ["homeDays", "homeHours", "schedule"] },
        threshold: { type: "number", description: "Required when rule is homeDays or homeHours" },
        intervalDays: { type: "number", description: "Required when rule is schedule" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_chore",
    description: "Permanently remove a chore.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Chore ID to delete" },
      },
      required: ["id"],
    },
  },
];

export async function callHouseworkTool(
  name: string,
  args: Record<string, unknown>,
  housework: HouseworkRpc,
): Promise<string> {
  try {
    switch (name) {
      case "list_chores":
        return JSON.stringify(await housework.listChores(), null, 2);
      case "add_chore": {
        const { id, ...data } = args as { id: string } & Parameters<HouseworkRpc["addChore"]>[1];
        return JSON.stringify(await housework.addChore(id, data), null, 2);
      }
      case "edit_chore": {
        const { id, ...changes } = args as { id: string } & Parameters<HouseworkRpc["editChore"]>[1];
        return JSON.stringify(await housework.editChore(id, changes), null, 2);
      }
      case "delete_chore":
        await housework.deleteChore(args.id as string);
        return `Chore '${args.id}' deleted.`;
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
