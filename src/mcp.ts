import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "@hono/zod-openapi";
import { DraftSchema, PatchSchema, Status, State, TagDraftSchema, TagPatchSchema, Type } from "./schema.ts";

export const INSTRUCTIONS = `waypoint tracks work as epics, stories and tasks. An epic has no parent, every story has an epic, every task has a story.

- A parent's status is derived from its open children: move the children, never the parent.
- Dependencies are between siblings only. An item moves to in_progress, review or done only once blockedBy is empty.
- Close an item (update_item with state closed and a closedReason) rather than delete it.
- Say what you did on an item with add_work_log; talk to people about it with add_comment.
- Every tool takes an id as the full id or a prefix of at least 8 characters, such as its shortId.`;

/** Sends one API request, as the MCP request's caller, and gives its status and JSON. */
export type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

const Ref = z.string().min(8).describe("The item's id, or a prefix of it at least 8 characters long, such as its shortId.");

const query = (params: Record<string, string | boolean | undefined>) => {
  const set = Object.entries(params).filter((entry): entry is [string, string | boolean] => entry[1] !== undefined);
  return set.length ? `?${new URLSearchParams(set.map(([key, value]): [string, string] => [key, String(value)]))}` : "";
};

const at = (id: string) => encodeURIComponent(id);

/**
 * The MCP server for one request. Each tool is one API request made with the
 * caller's own token and `claimed-by`, so it is refused, recorded and answered
 * exactly as that request would be: an API error comes back as the tool's error.
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
      { title, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: name === "delete_item" } },
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
    "list_items",
    "List items",
    "Items matching every filter given, as GET /items. With no filter, every item, open and closed.",
    {
      status: Status.optional(),
      state: State.optional().describe("`open` for only what still needs looking at."),
      type: Type.optional(),
      parent: Ref.optional().describe("Only the children of this item."),
      heldBy: z.string().optional().describe("Only items held by this name."),
      tag: z.string().optional().describe("Only items carrying this tag, by id or value."),
      queued: z.boolean().optional().describe("true: only queued items, in queue order."),
    },
    ({ queued, ...filters }) => ["GET", `/items${query({ ...filters, queued })}`],
    true,
  );

  tool("get_item", "Get an item", "One item, with its derived status, blockedBy and children, as GET /items/{id}.", { id: Ref }, ({ id }) => ["GET", `/items/${at(id)}`], true);

  tool(
    "create_item",
    "Create an item",
    "Creates an epic, story or task, as POST /items. A story needs an epic as parent, a task a story; an epic has none.",
    DraftSchema.omit({ tags: true }).shape,
    (draft) => ["POST", "/items", draft],
  );

  tool(
    "update_item",
    "Update an item",
    "Changes the fields given in `changes`, as PATCH /items/{id}: status, title, body, criteria, parent, dependencies, queued; close it with state closed and a closedReason.",
    { id: Ref, changes: PatchSchema },
    ({ id, changes }) => ["PATCH", `/items/${at(id)}`, changes],
  );

  tool("delete_item", "Delete an item", "Deletes an item no other item names, as DELETE /items/{id}. Prefer closing it.", { id: Ref }, ({ id }) => ["DELETE", `/items/${at(id)}`]);

  tool("item_history", "An item's history", "Every write to the item and beneath it, oldest first, as GET /items/{id}/history.", { id: Ref }, ({ id }) => ["GET", `/items/${at(id)}/history`], true);

  tool("list_comments", "An item's comments", "What people and agents said about the item, oldest first, as GET /items/{id}/comments.", { id: Ref }, ({ id }) => ["GET", `/items/${at(id)}/comments`], true);

  tool(
    "add_comment",
    "Comment on an item",
    "Adds a comment to the item, as POST /items/{id}/comments.",
    { id: Ref, body: z.string().min(1).describe("Markdown.") },
    ({ id, body }) => ["POST", `/items/${at(id)}/comments`, { body }],
  );

  tool("list_work_log", "An item's work log", "What was done on the item, oldest first, as GET /items/{id}/work-log.", { id: Ref }, ({ id }) => ["GET", `/items/${at(id)}/work-log`], true);

  tool(
    "add_work_log",
    "Log work on an item",
    "Records what was done on the item, with links to what it made, as POST /items/{id}/work-log.",
    { id: Ref, body: z.string().min(1).describe("Markdown."), links: z.array(z.string().url()).optional() },
    ({ id, body, links }) => ["POST", `/items/${at(id)}/work-log`, { body, links: links ?? [] }],
  );

  tool(
    "tick_criterion",
    "Tick a criterion",
    "Marks one of the item's acceptance criteria met, by its id (c1, c2, …) or its exact text when no other reads the same, as POST /items/{id}/met.",
    { id: Ref, criterion: z.string().min(1).describe("The criterion's id, as `c2`, or its text when unique.") },
    ({ id, criterion }) => ["POST", `/items/${at(id)}/met`, { criterion }],
  );

  tool(
    "untick_criterion",
    "Untick a criterion",
    "Marks one of the item's acceptance criteria not met, by its id or its unique text, as DELETE /items/{id}/met.",
    { id: Ref, criterion: z.string().min(1).describe("The criterion's id, as `c2`, or its text when unique.") },
    ({ id, criterion }) => ["DELETE", `/items/${at(id)}/met`, { criterion }],
  );

  tool("list_tags", "List tags", "Every tag: its value, colour and description, as GET /tags.", {}, () => ["GET", "/tags"], true);

  tool("create_tag", "Create a tag", "Adds a tag to the shared list, as POST /tags.", TagDraftSchema.shape, (draft) => ["POST", "/tags", draft]);

  tool(
    "update_tag",
    "Update a tag",
    "Changes a tag's value, colour or description, as PATCH /tags/{id}.",
    { id: z.string().describe("The tag's id."), changes: TagPatchSchema },
    ({ id, changes }) => ["PATCH", `/tags/${at(id)}`, changes],
  );

  tool(
    "tag_item",
    "Tag an item",
    "Puts a tag, by id or value, on the item and everything beneath it, as POST /items/{id}/tags.",
    { id: Ref, tag: z.string().min(1) },
    ({ id, tag }) => ["POST", `/items/${at(id)}/tags`, { tag }],
  );

  tool(
    "untag_item",
    "Untag an item",
    "Takes a tag, by id or value, off the item and everything beneath it, as DELETE /items/{id}/tags/{tag}.",
    { id: Ref, tag: z.string().min(1) },
    ({ id, tag }) => ["DELETE", `/items/${at(id)}/tags/${at(tag)}`],
  );

  tool("get_queue", "The queue", "What the queue is running, what waits in it and why, and its running limit, as GET /queue.", {}, () => ["GET", "/queue"], true);

  tool(
    "start_item",
    "Start an agent on an item",
    "Asks the configured worker-service for an agent on the item, as POST /items/{id}/assignment; refused when none is configured.",
    { id: Ref },
    ({ id }) => ["POST", `/items/${at(id)}/assignment`],
  );

  return server;
}
