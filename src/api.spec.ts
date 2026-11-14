import { beforeEach, describe, expect, it } from "vitest";
import { WaypointApi } from "./api.ts";
import { Tokens } from "./auth.ts";
import { OPEN_PATHS, OPEN_WORDS, OVERVIEW } from "./contract.ts";
import type { HistoryEntry, TaskView } from "./domain.ts";
import { FakeStore } from "./fake-store.ts";
import type { Label } from "./labels.ts";
import type { Comment } from "./store.ts";
import { readFileSync } from "node:fs";

let store: FakeStore;
let api: WaypointApi;
let admin: string;
let worker: string;

beforeEach(() => {
  store = new FakeStore();
  const tokens = new Tokens(store.db, "from-env");
  admin = tokens.create("person", true);
  worker = tokens.create("fleet", false);
  api = new WaypointApi(store, tokens, { about: { version: "1.2.3", commit: "c".repeat(40) } });
});

const call = async (method: string, path: string, body?: unknown, { token = admin, actor }: { token?: string; actor?: string } = {}) => {
  const res = await api.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(actor && { "x-actor": actor }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as Record<string, unknown>) };
};

const create = async (input: object, options?: { token?: string; actor?: string }) => {
  const res = await call("POST", "/tasks", input, options);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body!.task as TaskView;
};

const update = (id: string, input: object, options?: { token?: string; actor?: string }) => call("PATCH", `/tasks/${id}`, input, options);
const get = async (id: string) => (await call("GET", `/tasks/${id}`)).body!.task as TaskView;

describe("auth", () => {
  it("answers the paths the docs name as open without a token, and nothing else", async () => {
    const health = await api.fetch(new Request("http://local/health"));
    expect(await health.json()).toEqual({ ok: true, version: "1.2.3", commit: "c".repeat(40) });
    for (const path of OPEN_PATHS) {
      expect((await api.fetch(new Request(`http://local${path === "/ui/" ? "/ui/app.js" : path}`))).status, path).toBe(200);
    }
    for (const [method, path] of [["GET", "/tasks"], ["GET", "/tasks/12345678"], ["GET", "/labels"], ["GET", "/labels/x"], ["POST", "/mcp"]] as const) {
      expect(await call(method, path, undefined, { token: "wp_nobody" }), path).toEqual({ status: 401, body: { code: "UnauthorizedException", message: expect.any(String) } });
    }
    for (const path of OPEN_PATHS) expect(OPEN_WORDS).toContain(path === "/ui/" ? "`/ui/…`" : `\`${path}\``);
    expect(OVERVIEW).toContain(OPEN_WORDS);
    expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toContain(OPEN_WORDS);
  });

  it("records a write as its x-actor, else its token's name, and the environment's admin token's that names no one as null", async () => {
    const env = await create({ title: "by the environment's admin token" }, { token: "from-env" });
    const a = await create({ title: "by person" });
    const b = await create({ title: "by fleet" }, { token: worker });
    const c = await create({ title: "by agent-3" }, { token: worker, actor: "agent-3" });
    const actors = await Promise.all([env, a, b, c].map(async (task) => ((await call("GET", `/tasks/${task.id}/history`)).body!.entries as HistoryEntry[])[0]!.actor));
    expect(actors).toEqual([null, "person", "fleet", "agent-3"]);
  });
});

describe("tasks", () => {
  it("create, get by short id, update and delete, each answered in its wrapper", async () => {
    const task = await create({ title: "Ship it", description: "now", labels: [], assignee: "agent-1" });
    expect(task).toMatchObject({ title: "Ship it", status: "backlog", ready: true, assignee: "agent-1", shortId: task.id.slice(0, 8) });
    expect((await get(task.shortId)).id).toBe(task.id);
    const updated = await update(task.shortId, { title: "Ship it now" });
    expect(updated).toMatchObject({ status: 200, body: { task: { title: "Ship it now" } } });
    expect(await call("DELETE", `/tasks/${task.id}`)).toEqual({ status: 204, body: null });
    expect((await call("GET", `/tasks/${task.id}`)).body).toMatchObject({ code: "ResourceNotFoundException" });
  });

  it("refuses a move past an open dependency with ConflictException naming it", async () => {
    const first = await create({ title: "first" });
    const second = await create({ title: "second", dependsOn: [first.shortId] });
    expect(second).toMatchObject({ ready: false, blockedBy: [first.id] });
    expect(await update(second.id, { status: "in_progress" })).toEqual({
      status: 409,
      body: { code: "ConflictException", message: `${second.shortId} is blocked by ${first.shortId}: close it first`, blockedBy: [first.id] },
    });
    await update(first.id, { status: "done" });
    expect((await update(second.id, { status: "in_progress" })).status).toBe(200);
  });

  it("refuses done with an unmet criterion or an open subtask, naming them in a sentence that agrees in number", async () => {
    const task = await create({ title: "t", criteria: [{ text: "works" }, { text: "fast" }], subtasks: [{ title: "step" }] });
    expect((await update(task.id, { status: "done" })).body).toEqual({
      code: "ConflictException",
      message: "the task can't be done while criteria c1, c2 are unmet",
      unmetCriteria: ["c1", "c2"],
    });
    await update(task.id, { criteria: [{ id: "c1", met: true }, { id: "c2" }] });
    expect((await update(task.id, { status: "done" })).body).toMatchObject({ message: "the task can't be done while criterion c2 is unmet", unmetCriteria: ["c2"] });
    await update(task.id, { criteria: [{ id: "c1" }, { id: "c2", met: true }] });
    expect((await update(task.id, { status: "done" })).body).toEqual({
      code: "ConflictException",
      message: "the task can't be done while subtask s1 is open",
      openSubtasks: ["s1"],
    });
  });

  it("refuses to delete a task another depends on", async () => {
    const first = await create({ title: "first" });
    const second = await create({ title: "second", dependsOn: [first.id] });
    expect((await call("DELETE", `/tasks/${first.id}`)).body).toEqual({
      code: "ConflictException",
      message: `${second.shortId} depends on ${first.shortId}: remove the dependency first`,
    });
    const third = await create({ title: "third", dependsOn: [first.id] });
    expect((await call("DELETE", `/tasks/${first.id}`)).body).toMatchObject({ message: `${second.shortId}, ${third.shortId} depend on ${first.shortId}: remove the dependency first` });
  });

  it("answers a malformed request with ValidationException, in plain words naming the field", async () => {
    const refused = async (method: string, path: string, body: unknown) => {
      const { status, body: answer } = await call(method, path, body);
      expect(status).toBe(400);
      expect(answer).toEqual({ code: "ValidationException", message: expect.any(String) });
      expect(answer!.message).not.toMatch(/Invalid input|nonoptional|expected/);
      return answer!.message;
    };
    const task = await create({ title: "t" });
    expect(await refused("POST", "/tasks", { description: "no title" })).toBe("title is required");
    expect(await refused("POST", "/tasks", { title: "" })).toBe("title can't be empty");
    expect(await refused("POST", "/tasks", { title: 5 })).toBe("title must be text");
    expect(await refused("POST", "/tasks", { title: "x".repeat(201) })).toBe("title can be at most 200 characters");
    expect(await refused("POST", "/tasks", { title: "t", status: "nope" })).toBe("status must be one of backlog, in_progress, review, done, cancelled");
    expect(await refused("POST", "/tasks", { title: "t", subtasks: [{ dependsOn: "s1" }] })).toBe("subtasks[0].dependsOn must be a list");
    expect(await refused("PATCH", `/tasks/${task.id}`, {})).toBe("no fields given");
    expect(await refused("POST", "/labels", { name: "x", color: "red" })).toBe("color must be #rrggbb");
    expect(await refused("GET", "/tasks?maxResults=0", undefined)).toBe("maxResults must be at least 1");
  });

  it("sets who verifies a task and when on create and update, clears it with null, and refuses any other value", async () => {
    expect((await create({ title: "unsaid" })).verification).toBeNull();
    const task = await create({ title: "checked", verification: { by: "person", when: "before_release" } });
    expect(task.verification).toEqual({ by: "person", when: "before_release" });
    expect((await update(task.id, { verification: { by: "agent", when: "after_release" } })).body!.task).toMatchObject({ verification: { by: "agent", when: "after_release" } });
    expect((await update(task.id, { title: "renamed" })).body!.task).toMatchObject({ verification: { by: "agent", when: "after_release" } });
    expect((await update(task.id, { verification: null })).body!.task).toMatchObject({ verification: null });
    for (const verification of [{ by: "robot", when: "before_release" }, { by: "person" }, { by: "person", when: "after_release", extra: 1 }]) {
      expect((await update(task.id, { verification })).status, JSON.stringify(verification)).toBe(400);
    }
    const history = (await call("GET", `/tasks/${task.id}/history`)).body!.entries as HistoryEntry[];
    expect(history.flatMap((entry) => entry.changes.filter((change) => change.field === "verification").map((change) => change.to))).toEqual([
      { by: "person", when: "before_release" },
      { by: "agent", when: "after_release" },
      null,
    ]);
  });

  it("returns what the first create made when its clientToken is sent again", async () => {
    const first = await create({ title: "once", clientToken: "abc" });
    const again = await create({ title: "once", clientToken: "abc" });
    expect(again.id).toBe(first.id);
    expect(((await call("GET", "/tasks")).body!.tasks as TaskView[]).length).toBe(1);
  });

  it("keeps both of two criteria marked met at once by different callers", async () => {
    const task = await create({ title: "t", criteria: [{ text: "a" }, { text: "b" }] });
    const { read, release } = store.holdNextRead();
    const slow = update(task.id, { criteria: [{ id: "c1", met: true }, { id: "c2" }] }, { actor: "one" });
    await read;
    expect((await update(task.id, { criteria: [{ id: "c1" }, { id: "c2", met: true }] }, { actor: "two" })).status).toBe(200);
    release();
    expect((await slow).status).toBe(200);
    expect((await get(task.id)).criteria.map((c) => [c.id, c.met, c.metBy])).toEqual([
      ["c1", true, "one"],
      ["c2", true, "two"],
    ]);
  });

  it("gives up with ConflictException when other writes keep landing first", async () => {
    const task = await create({ title: "t" });
    store.forcedVersion = Number.NaN;
    expect((await update(task.id, { title: "never" })).body).toMatchObject({ code: "ConflictException", message: expect.stringContaining("retry") });
  });
});

describe("ListTasks", () => {
  it("filters by status, readiness, label and assignee, and leaves cancelled tasks out unless asked", async () => {
    const { body } = await call("POST", "/labels", { name: "ui" });
    const ui = (body!.label as Label).id;
    const open = await create({ title: "open", labels: ["UI"], assignee: "agent-1" });
    const blocked = await create({ title: "blocked", dependsOn: [open.id] });
    const gone = await create({ title: "gone", status: "cancelled" });
    const titles = async (query: string) => ((await call("GET", `/tasks${query}`)).body!.tasks as TaskView[]).map((task) => task.title);
    expect(await titles("")).toEqual(["open", "blocked"]);
    expect(await titles("?includeCancelled=true")).toEqual(["open", "blocked", "gone"]);
    expect(await titles("?status=cancelled")).toEqual(["gone"]);
    expect(await titles("?ready=true")).toEqual(["open"]);
    expect(await titles(`?label=${ui}`)).toEqual(["open"]);
    expect(await titles("?assignee=none")).toEqual(["blocked"]);
    expect(await titles("?label=nothing")).toEqual([]);
    expect([blocked.id, gone.id]).toHaveLength(2);
  });

  it("finds the tasks that depend on a task, and those whose title or description holds some text, with the other filters", async () => {
    const base = await create({ title: "Base", description: "Lays the ground." });
    await create({ title: "Roof", description: "Goes on the GROUND floor walls.", dependsOn: [base.id] });
    await create({ title: "Garden", dependsOn: [base.id], status: "cancelled" });
    await create({ title: "Ground survey" });
    const titles = async (query: string) => ((await call("GET", `/tasks${query}`)).body!.tasks as TaskView[]).map((task) => task.title);
    expect(await titles(`?dependsOn=${base.id}`)).toEqual(["Roof"]);
    expect(await titles(`?dependsOn=${base.shortId}&includeCancelled=true`)).toEqual(["Roof", "Garden"]);
    expect(await titles("?dependsOn=00000000-0000-0000-0000-000000000000")).toEqual([]);
    expect(await titles("?q=ground")).toEqual(["Base", "Roof", "Ground survey"]);
    expect(await titles(`?q=ground&dependsOn=${base.id}`)).toEqual(["Roof"]);
    expect(await titles("?q=ground&ready=false")).toEqual(["Roof"]);
    expect(await titles("?q=nowhere")).toEqual([]);
  });

  it("pages with maxResults and nextToken, and refuses a token it didn't give", async () => {
    for (const title of ["a", "b", "c"]) await create({ title });
    const first = await call("GET", "/tasks?maxResults=2");
    expect((first.body!.tasks as TaskView[]).map((task) => task.title)).toEqual(["a", "b"]);
    const second = await call("GET", `/tasks?maxResults=2&nextToken=${first.body!.nextToken}`);
    expect(second.body).toMatchObject({ tasks: [{ title: "c" }], nextToken: null });
    expect((await call("GET", "/tasks?nextToken=bogus")).body).toMatchObject({ code: "ValidationException" });
  });
});

describe("history and comments", () => {
  it("records each write's changes, oldest first, and keeps a deleted task's", async () => {
    const task = await create({ title: "x" });
    await update(task.id, { title: "y", status: "in_progress" });
    await call("DELETE", `/tasks/${task.id}`);
    const entries = (await call("GET", `/tasks/${task.id}/history`)).body!.entries as HistoryEntry[];
    expect(entries.map((entry) => entry.action)).toEqual(["created", "updated", "deleted"]);
    expect(entries[1]!.changes).toEqual([
      { field: "title", from: "x", to: "y" },
      { field: "status", from: "backlog", to: "in_progress" },
    ]);
  });

  it("adds comments without changing the task, once per clientToken", async () => {
    const task = await create({ title: "t" });
    const made = await call("POST", `/tasks/${task.shortId}/comments`, { body: "looks good", clientToken: "k" }, { token: worker, actor: "agent-2" });
    expect(made).toMatchObject({ status: 201, body: { comment: { author: "agent-2", body: "looks good", taskId: task.id } } });
    await call("POST", `/tasks/${task.id}/comments`, { body: "looks good", clientToken: "k" });
    const { comments } = (await call("GET", `/tasks/${task.id}/comments`)).body as { comments: Comment[] };
    expect(comments).toHaveLength(1);
    expect((await get(task.id)).updatedAt).toBe(task.updatedAt);
  });
});

describe("labels", () => {
  it("create, get by name, update and list by name, refusing a taken name", async () => {
    const made = (await call("POST", "/labels", { name: "backend", color: "#123456" })).body!.label as Label;
    expect(made).toMatchObject({ name: "backend", color: "#123456", description: "" });
    expect((await call("GET", "/labels/BACKEND")).body!.label).toEqual(made);
    await call("POST", "/labels", { name: "api" });
    expect((await call("POST", "/labels", { name: "Api" })).body).toMatchObject({ code: "ConflictException" });
    expect((await call("PATCH", `/labels/${made.id}`, { description: "server side" })).body!.label).toMatchObject({ description: "server side" });
    expect(((await call("GET", "/labels")).body!.labels as Label[]).map((label) => label.name)).toEqual(["api", "backend"]);
  });

  it("deleting one takes it off every task, recorded in each task's history", async () => {
    await call("POST", "/labels", { name: "ui" });
    const task = await create({ title: "t", labels: ["ui"] });
    expect(await call("DELETE", "/labels/ui")).toEqual({ status: 204, body: null });
    expect((await get(task.id)).labels).toEqual([]);
    const entries = (await call("GET", `/tasks/${task.id}/history`)).body!.entries as HistoryEntry[];
    expect(entries.at(-1)!.changes.map((change) => change.field)).toEqual(["labels"]);
  });

  it("refuses a task naming a label that doesn't exist", async () => {
    expect((await call("POST", "/tasks", { title: "t", labels: ["nope"] })).body).toMatchObject({ code: "ValidationException" });
  });
});

describe("pages", () => {
  it.each([
    ["/", "text/html", "<title>waypoint</title>"],
    ["/ui/app.js", "text/javascript", "function board"],
    ["/ui/banner.js", "text/javascript", "export const MARK_SVG"],
    ["/ui/mark.svg", "image/svg+xml", "<svg"],
    ["/docs/api", "text/html", "CreateTask"],
    ["/docs/mcp", "text/html", "create_task"],
    ["/openapi.json", "application/json", "ListTasks"],
    ["/mcp.json", "application/json", "list_tasks"],
  ])("serves %s without a token", async (path, type, says) => {
    const res = await api.fetch(new Request(`http://local${path}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
    expect(await res.text()).toContain(says);
  });
});
