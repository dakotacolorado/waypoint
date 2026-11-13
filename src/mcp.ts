import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "@hono/zod-openapi";
import { SUMMARY } from "./banner.ts";
import { LabelFieldsInput, Status, TaskFieldsInput } from "./schema.ts";

export const INSTRUCTIONS = `waypoint: ${SUMMARY}

- status is backlog, in_progress, review, done or cancelled; done and cancelled are the closed statuses.
- A task depends on the tasks in its dependsOn, and is blocked by those still open (blockedBy). It is ready when it is in backlog and every task it depends on is closed.
- A task can move to in_progress, review or done once every task it depends on is closed, and to done once every criterion is met and every subtask is closed. Subtasks follow the same rule among themselves.
- In update_task, criteria and subtasks are whole lists matched by id; a field left out of an entry keeps its value. To mark one criterion met, send met: true on that entry only.
- A task ID may be given as its shortId.`;

/** Sends one API request as the MCP request's caller, and gives its status and JSON. */
export type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

const TaskId = z.string().min(8).describe("The task's ID, or a prefix of it at least 8 characters long, such as its shortId.");
const LabelId = z.string().min(1).describe("The label's ID or name.");
const Paging = {
  maxResults: z.number().int().min(1).max(500).optional().describe("The most results to return. Default 100."),
  nextToken: z.string().optional().describe("The nextToken from the previous page."),
};
const ClientToken = z.string().min(1).max(64).optional().describe("A unique string; retrying with it returns what the first request created.");

const query = (params: Record<string, string | number | undefined>) => {
  const set = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  return set.length ? `?${new URLSearchParams(set.map(([key, value]): [string, string] => [key, String(value)]))}` : "";
};
const at = encodeURIComponent;

/**
 * The MCP server for one request. Each tool is one API operation, named the
 * same in snake_case, made with the caller's own token and `x-actor`, so it
 * is refused and recorded exactly as that request would be; an API error is
 * the tool's error.
 */
export function mcpServer(version: string, call: Call): McpServer {
  const server = new McpServer({ name: "waypoint", version }, { instructions: INSTRUCTIONS });

  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    inputSchema: Shape,
    request: (input: z.infer<z.ZodObject<Shape>>) => [method: string, path: string, body?: unknown],
    readOnly = false,
  ) => {
    server.registerTool(
      name,
      { title, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: name.startsWith("delete_") } },
      // The SDK types a tool's input by its own zod; these are the API's schemas, which it validates the same.
      (async (input: z.infer<z.ZodObject<Shape>>) => {
        const [method, path, body] = request(input);
        const res = await call(method, path, body);
        const text = res.body === null ? `${res.status}` : JSON.stringify(res.body, null, 2);
        return { content: [{ type: "text" as const, text }], ...(res.status >= 400 && { isError: true }) };
      }) as never,
    );
  };

  tool(
    "list_tasks",
    "List tasks",
    "Returns tasks matching every filter given, oldest first. Cancelled tasks are left out unless status is cancelled or includeCancelled is true.",
    {
      status: Status.optional().describe("Only tasks with this status."),
      ready: z.boolean().optional().describe("true for only tasks that can be started now."),
      label: z.string().optional().describe("Only tasks with this label, by ID or name."),
      assignee: z.string().optional().describe("Only tasks assigned to this; none for unassigned tasks."),
      includeCancelled: z.boolean().optional(),
      ...Paging,
    },
    ({ ready, includeCancelled, ...rest }) => ["GET", `/tasks${query({ ...rest, ready: ready?.toString(), includeCancelled: includeCancelled?.toString() })}`],
    true,
  );

  tool(
    "create_task",
    "Create a task",
    "Creates a task in backlog, unless status says otherwise.",
    { ...TaskFieldsInput.required({ title: true }).shape, clientToken: ClientToken },
    (input) => ["POST", "/tasks", input],
  );

  tool("get_task", "Get a task", "Returns a task.", { taskId: TaskId }, ({ taskId }) => ["GET", `/tasks/${at(taskId)}`], true);

  tool(
    "update_task",
    "Update a task",
    "Changes the fields given. Cancelling a task cancels its open subtasks.",
    { taskId: TaskId, ...TaskFieldsInput.shape },
    ({ taskId, ...fields }) => ["PATCH", `/tasks/${at(taskId)}`, fields],
  );

  tool(
    "delete_task",
    "Delete a task",
    "Deletes a task no other task depends on. To close a task instead, set its status to cancelled.",
    { taskId: TaskId },
    ({ taskId }) => ["DELETE", `/tasks/${at(taskId)}`],
  );

  tool(
    "list_task_history",
    "List a task's history",
    "Returns every write to the task, oldest first.",
    { taskId: TaskId, ...Paging },
    ({ taskId, ...paging }) => ["GET", `/tasks/${at(taskId)}/history${query(paging)}`],
    true,
  );

  tool(
    "list_comments",
    "List comments",
    "Returns a task's comments, oldest first.",
    { taskId: TaskId, ...Paging },
    ({ taskId, ...paging }) => ["GET", `/tasks/${at(taskId)}/comments${query(paging)}`],
    true,
  );

  tool(
    "create_comment",
    "Create a comment",
    "Adds a comment to a task. A comment changes none of the task's fields.",
    { taskId: TaskId, body: z.string().min(1).max(20_000).describe("The comment, in Markdown."), clientToken: ClientToken },
    ({ taskId, ...comment }) => ["POST", `/tasks/${at(taskId)}/comments`, comment],
  );

  tool("list_labels", "List labels", "Returns labels by name.", { ...Paging }, (paging) => ["GET", `/labels${query(paging)}`], true);

  tool(
    "create_label",
    "Create a label",
    "Creates a label.",
    { ...LabelFieldsInput.required({ name: true }).shape, clientToken: ClientToken },
    (input) => ["POST", "/labels", input],
  );

  tool("get_label", "Get a label", "Returns a label.", { labelId: LabelId }, ({ labelId }) => ["GET", `/labels/${at(labelId)}`], true);

  tool(
    "update_label",
    "Update a label",
    "Changes the fields given.",
    { labelId: LabelId, ...LabelFieldsInput.shape },
    ({ labelId, ...fields }) => ["PATCH", `/labels/${at(labelId)}`, fields],
  );

  tool(
    "delete_label",
    "Delete a label",
    "Deletes a label and removes it from every task that has it.",
    { labelId: LabelId },
    ({ labelId }) => ["DELETE", `/labels/${at(labelId)}`],
  );

  return server;
}
