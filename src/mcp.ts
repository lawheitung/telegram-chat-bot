// Todoist tool definitions (for Claude's tool list) and executor.
// Calls the Todoist worker directly via RPC Service Binding — no HTTP, no auth needed.

import type { TodoistRpc } from "./types";

export const TODOIST_TOOLS = [
  {
    name: "get_tasks",
    description:
      "List tasks. mode='flat' returns a plain array; mode='tree' nests subtasks under their parent. " +
      "Top-level tasks act as projects. Optionally narrow by parent_id, label, or Todoist filter query " +
      "(e.g. 'today', 'overdue', '@work & p1'). When 'filter' is set it takes precedence.",
    input_schema: {
      type: "object" as const,
      properties: {
        mode: { type: "string", enum: ["flat", "tree"] },
        parent_id: { type: "string", description: "Return only direct children of this task ID" },
        label: { type: "string" },
        filter: { type: "string", description: "Todoist filter query, e.g. 'today', 'overdue'" },
      },
      required: ["mode"],
    },
  },
  {
    name: "add_task",
    description: "Create a task or subtask. Pass parent_id to nest it; omit for a top-level task.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: { type: "string" },
        description: { type: "string" },
        parent_id: { type: "string" },
        due_string: { type: "string", description: "e.g. 'tomorrow', 'next Monday'" },
        priority: { type: "integer", minimum: 1, maximum: 4, description: "1=normal … 4=urgent" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["content"],
    },
  },
  {
    name: "update_task",
    description: "Edit an existing task. Only pass fields to change.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" },
        content: { type: "string" },
        description: { type: "string" },
        due_string: { type: ["string", "null"], description: "null clears the due date" },
        priority: { type: "integer", minimum: 1, maximum: 4 },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["task_id"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as complete.",
    input_schema: {
      type: "object" as const,
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "delete_task",
    description: "Permanently delete a task and all its subtasks.",
    input_schema: {
      type: "object" as const,
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "move_task",
    description: "Move a task under a different parent, or promote to top-level (new_parent_id=null).",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" },
        new_parent_id: { type: ["string", "null"] },
      },
      required: ["task_id", "new_parent_id"],
    },
  },
];

export async function callTodoistTool(
  name: string,
  args: Record<string, unknown>,
  todoist: TodoistRpc,
): Promise<string> {
  try {
    switch (name) {
      case "get_tasks":
        return JSON.stringify(await todoist.getTasks(args as Parameters<TodoistRpc["getTasks"]>[0]), null, 2);
      case "add_task":
        return JSON.stringify(await todoist.addTask(args as Parameters<TodoistRpc["addTask"]>[0]), null, 2);
      case "update_task": {
        const { task_id, ...params } = args as { task_id: string } & Parameters<TodoistRpc["updateTask"]>[1];
        return JSON.stringify(await todoist.updateTask(task_id, params), null, 2);
      }
      case "complete_task":
        await todoist.completeTask(args.task_id as string);
        return `Task ${args.task_id} marked complete.`;
      case "delete_task":
        await todoist.deleteTask(args.task_id as string);
        return `Task ${args.task_id} deleted.`;
      case "move_task":
        await todoist.moveTask(args.task_id as string, (args.new_parent_id as string | null) ?? null);
        return `Task ${args.task_id} moved.`;
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
