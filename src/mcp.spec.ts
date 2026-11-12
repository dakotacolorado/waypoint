import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkTrackerApi } from "./api.ts";
import { Tokens } from "./auth.ts";
import type { HistoryEntry, WorkItemView } from "./domain.ts";
import { FakeStore } from "./fake-store.ts";
import { mcpDocument, renderMcp, renderMcpHtml } from "./mcp-doc.ts";
import { MCP_DOC, MCP_FILE, MCP_PAGE } from "./spec.ts";

let api: WorkTrackerApi;
let admin: string;
let worker: string;

beforeEach(() => {
  const store = new FakeStore();
  const tokens = new Tokens(store.db);
  admin = tokens.create("person", true);
  worker = tokens.create("agents", false);
  api = new WorkTrackerApi(store, tokens);
});

const rpc = async (token: string, method: string, params: unknown, claimedBy?: string) =>
  api.fetch(
    new Request("http://local/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(claimedBy && { "claimed-by": claimedBy }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );

/** A tool's answer: its JSON, and whether it is an error. */
const use = async (token: string, name: string, args: unknown, claimedBy?: string) => {
  const res = await rpc(token, "tools/call", { name, arguments: args }, claimedBy);
  expect(res.status).toBe(200);
  const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const text = result.content[0]!.text;
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as unknown };
};

describe("the MCP server", () => {
  it("takes the API's tokens, and none other", async () => {
    expect((await rpc("wp_nobody", "tools/list", {})).status).toBe(401);
  });

  it("creates, moves and reads items as the API does, recorded under the caller", async () => {
    const epic = (await use(admin, "create_item", { type: "epic", title: "E" })).json() as WorkItemView;
    const story = (await use(worker, "create_item", { type: "story", title: "S", parent: epic.shortId }, "agent-7")).json() as WorkItemView;
    expect((await use(worker, "update_item", { id: story.shortId, changes: { status: "in_progress" } }, "agent-7")).isError).toBe(false);
    expect(((await use(admin, "get_item", { id: epic.id })).json() as WorkItemView).status).toBe("in_progress");
    const { entries } = (await use(admin, "item_history", { id: story.id })).json() as { entries: HistoryEntry[] };
    expect(entries.map((entry) => entry.claimedBy)).toEqual(["agent-7", "agent-7"]);
    await use(worker, "add_work_log", { id: story.shortId, body: "did it", links: ["https://example.com/pr/1"] });
    const log = (await use(admin, "list_work_log", { id: story.shortId })).json() as { entries: { author: string; links: string[] }[] };
    expect(log.entries).toEqual([expect.objectContaining({ author: "agents", links: ["https://example.com/pr/1"] })]);
    const listed = (await use(admin, "list_items", { parent: epic.shortId, state: "open" })).json() as { items: WorkItemView[] };
    expect(listed.items.map((item) => item.title)).toEqual(["S"]);
  });

  it("answers a refusal as the tool's error, in the API's words", async () => {
    const orphan = await use(admin, "create_item", { type: "story", title: "no epic" });
    expect(orphan.isError).toBe(true);
    expect(orphan.text).toContain("needs an epic");
    const epic = (await use(admin, "create_item", { type: "epic", title: "E" })).json() as WorkItemView;
    await use(admin, "create_item", { type: "story", title: "S", parent: epic.id });
    const signOff = await use(worker, "update_item", { id: epic.id, changes: { state: "closed", closedReason: "completed" } });
    expect(signOff.isError).toBe(true);
  });

  it("has a tool for every API operation but health, the skill, one tag by id, deleting a tag and the person's queue limit", async () => {
    const { paths } = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as { paths: Record<string, Record<string, unknown>> };
    const operations = Object.entries(paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`));
    const { tools } = await mcpDocument();
    const said = tools.map((tool) => tool.description ?? "").join("\n");
    const without = operations.filter((op) => !["GET /health", "GET /skill", "PATCH /queue", "DELETE /tags/{id}", "GET /tags/{id}"].includes(op)).filter((op) => !said.includes(op));
    expect(without).toEqual([]);
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
