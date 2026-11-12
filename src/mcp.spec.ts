import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { WaypointApi } from "./api.ts";
import { Tokens } from "./auth.ts";
import type { HistoryEntry, TaskView } from "./domain.ts";
import { FakeStore } from "./fake-store.ts";
import { mcpDocument, renderMcp, renderMcpHtml } from "./mcp-doc.ts";
import { MCP_DOC, MCP_FILE, MCP_PAGE, openApiDocument } from "./spec.ts";

let api: WaypointApi;
let admin: string;
let fleet: string;

beforeEach(() => {
  const store = new FakeStore();
  const tokens = new Tokens(store.db);
  admin = tokens.create("person", true);
  fleet = tokens.create("fleet", false);
  api = new WaypointApi(store, tokens);
});

const rpc = (token: string, method: string, params: unknown, actor?: string) =>
  api.fetch(
    new Request("http://local/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(actor && { "x-actor": actor }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );

/** A tool's answer: its JSON, and whether it is an error. */
const use = async (token: string, name: string, args: unknown, actor?: string) => {
  const res = await rpc(token, "tools/call", { name, arguments: args }, actor);
  expect(res.status).toBe(200);
  const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const text = result.content[0]!.text;
  return { isError: result.isError === true, text, json: <T>() => JSON.parse(text) as T };
};

describe("the MCP server", () => {
  it("takes the API's tokens, and none other", async () => {
    expect((await rpc("wp_nobody", "tools/list", {})).status).toBe(401);
  });

  it("does what the API does, recorded under the caller", async () => {
    const { task: first } = (await use(admin, "create_task", { title: "first" })).json<{ task: TaskView }>();
    const { task } = (await use(fleet, "create_task", { title: "second", dependsOn: [first.shortId], subtasks: [{ title: "step" }] }, "agent-7")).json<{ task: TaskView }>();
    const refused = await use(fleet, "update_task", { taskId: task.shortId, status: "in_progress" }, "agent-7");
    expect(refused.isError).toBe(true);
    expect(refused.json()).toMatchObject({ code: "ConflictException", blockedBy: [first.id] });
    await use(admin, "update_task", { taskId: first.id, status: "done" });
    expect((await use(fleet, "list_tasks", { ready: true })).json<{ tasks: TaskView[] }>().tasks.map((each) => each.title)).toEqual(["second"]);
    await use(fleet, "create_comment", { taskId: task.id, body: "on it" }, "agent-7");
    expect((await use(admin, "list_comments", { taskId: task.id })).json<{ comments: { author: string }[] }>().comments).toEqual([expect.objectContaining({ author: "agent-7" })]);
    const { entries } = (await use(admin, "list_task_history", { taskId: task.id })).json<{ entries: HistoryEntry[] }>();
    expect(entries.map((entry) => entry.actor)).toEqual(["agent-7"]);
  });

  it("has one tool per API operation but GetHealth, named the same in snake_case", async () => {
    const { paths } = await openApiDocument();
    const snake = (id: string) => id.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    const operations = Object.values(paths).flatMap((methods) => Object.values(methods).map((op) => snake(op.operationId))).filter((name) => name !== "get_health");
    expect((await mcpDocument()).tools.map((tool) => tool.name).sort()).toEqual(operations.sort());
  });
});

describe("mcp.json, docs/MCP.md and docs/mcp.html", () => {
  it("match what the server serves", async () => {
    const served = await mcpDocument();
    expect(JSON.parse(readFileSync(MCP_FILE, "utf8"))).toEqual(served);
    expect(readFileSync(MCP_DOC, "utf8")).toBe(renderMcp(served));
    expect(readFileSync(MCP_PAGE, "utf8")).toBe(renderMcpHtml(served));
  });
});
