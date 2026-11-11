import { singleToken, Tokens } from "./auth.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkTrackerApi } from "./api.ts";
import {
  Graph,
  PARENT_TYPE,
  type HistoryEntry,
  type Note,
  type Type,
  WorkItem,
  type WorkItemView,
} from "./domain.ts";
import { FakeStore } from "./fake-store.ts";
import type { Tag } from "./tags.ts";

const TOKEN = "test-token";
const token = singleToken(TOKEN);
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

let store: FakeStore;
let api: WorkTrackerApi;

beforeEach(() => {
  store = new FakeStore();
  api = new WorkTrackerApi(store, token);
});

const call = (path: string, init?: RequestInit) =>
  api.fetch(new Request(`http://local${path}`, init));

const send = (method: string, path: string, body: unknown) =>
  call(path, { method, headers, body: JSON.stringify(body) });

const post = async (draft: object): Promise<WorkItemView> => {
  const res = await send("POST", "/items", draft);
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json() as Promise<WorkItemView>;
};

/** Made on first use in each test and left out of `list`, so tests can skip naming a parent. */
let shelf: Partial<Record<Type, string>>;
beforeEach(() => (shelf = {}));

const shelfFor = async (type: Type): Promise<string | null> => {
  const needs = PARENT_TYPE[type];
  if (needs === null) return null;
  const parent = await shelfFor(needs);
  shelf[needs] ??= (await post({ title: `shelf ${needs}`, type: needs, parent })).id;
  return shelf[needs];
};

/** Files the item on the shelf when the draft names no parent. */
const create = async (draft: { type?: Type; parent?: string | null; [field: string]: unknown }) =>
  post("parent" in draft ? draft : { ...draft, parent: await shelfFor(draft.type ?? "task") });

const list = async (query = ""): Promise<WorkItemView[]> => {
  const res = await call(`/items${query}`, { headers });
  const { items } = (await res.json()) as { items: WorkItemView[] };
  const shelved = new Set(Object.values(shelf));
  return items.filter((item) => !shelved.has(item.id));
};

describe("auth", () => {
  it("leaves /health open but guards /items", async () => {
    expect((await call("/health")).status).toBe(200);
    expect((await call("/items")).status).toBe(401);
    expect((await call("/items", { headers: { Authorization: "Bearer x" } })).status).toBe(401);
  });

  it("records a caller's write under its token's name when it says no `claimed-by`, so only an admin's is the person's", async () => {
    const tokens = new Tokens(store.db);
    const worker = tokens.create("worker", false);
    const admin = tokens.create("person", true);
    const multi = new WorkTrackerApi(store, tokens);
    const as = (bearer: string, method: string, path: string, body?: unknown) =>
      multi.fetch(new Request(`http://local${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const epic = (await (await as(admin, "POST", "/items", { type: "epic", title: "E" })).json()) as WorkItemView;
    await as(admin, "POST", "/items", { type: "story", title: "S", parent: epic.id });
    expect((await as(worker, "PATCH", "/items/" + epic.id, { state: "closed", closedReason: "completed" })).status).toBe(403);
    expect((await as(worker, "PATCH", "/queue", { limit: 2 })).status).toBe(403);
    const signedOff = await as(admin, "PATCH", "/items/" + epic.id, { state: "closed", closedReason: "completed" });
    expect(signedOff.status).toBe(200);
    const { entries } = (await (await as(worker, "GET", `/items/${epic.id}/history`)).json()) as { entries: HistoryEntry[] };
    expect(entries.every((entry) => entry.claimedBy === null)).toBe(true);
    const story = (await (await as(worker, "POST", "/items", { type: "story", title: "T", parent: (await create({ type: "epic", title: "F" })).id })).json()) as WorkItemView;
    const [made] = ((await (await as(worker, "GET", `/items/${story.id}/history`)).json()) as { entries: HistoryEntry[] }).entries;
    expect(made!.claimedBy).toBe("worker");
    expect((await as("wp_nobody", "GET", "/items")).status).toBe(401);
  });

  it("serves its version and commit at /health", async () => {
    const about = new WorkTrackerApi(store, token, { about: { version: "1.2.3", commit: "c".repeat(40) } });
    expect(await (await about.fetch(new Request("http://local/health"))).json()).toEqual({ ok: true, version: "1.2.3", commit: "c".repeat(40) });
  });
});

describe("items", () => {
  it("defaults to an unblocked, childless task", async () => {
    const item = await create({ title: "First" });
    expect(item).toMatchObject({
      type: "task",
      status: "backlog",
      dependsOn: [],
      children: [],
      blockedBy: [],
      finishedEarly: false,
    });
    for (const gone of ["blocked", "derived"]) expect(item).not.toHaveProperty(gone);
  });

  it("accepts ready and no longer todo", async () => {
    expect((await create({ title: "R", status: "ready" })).status).toBe("ready");
    expect((await send("POST", "/items", { title: "T", status: "todo" })).status).toBe(400);
  });

  it("rejects a bad payload without storing it", async () => {
    expect((await send("POST", "/items", {})).status).toBe(400);
    expect((await call("/items", { method: "POST", headers, body: "{" })).status).toBe(400);
    expect((await send("POST", "/items", { title: "x", type: "saga" })).status).toBe(400);
    expect(store.items).toHaveLength(0);
  });

  it("patches only the fields supplied", async () => {
    const { id } = await create({ title: "Original", body: "keep me" });
    const res = await send("PATCH", `/items/${id}`, { status: "in_progress" });
    expect(await res.json()).toMatchObject({
      status: "in_progress",
      title: "Original",
      body: "keep me",
    });
  });

  it("filters by status, type and parent", async () => {
    const epic = await create({ title: "E", type: "epic" });
    const story = await create({ title: "S", type: "story", parent: epic.id });
    const t = await create({ title: "T", status: "review" });
    await create({ title: "U", status: "ready", dependsOn: [t.id] });

    expect((await list("?type=epic")).map((i) => i.title)).toEqual(["E"]);
    expect((await list("?status=review")).map((i) => i.title)).toEqual(["T"]);
    expect((await list(`?parent=${epic.id}`)).map((i) => i.title)).toEqual(["S"]);
  });

  it("404s an unknown id", async () => {
    expect((await call("/items/missing", { headers })).status).toBe(404);
    expect((await send("PATCH", "/items/missing", { title: "x" })).status).toBe(404);
  });
});

describe("hierarchy", () => {
  it("reports children on the parent", async () => {
    const epic = await create({ title: "E", type: "epic" });
    const story = await create({ title: "S", type: "story", parent: epic.id });

    const read = (await list()).find((item) => item.id === epic.id)!;
    expect(read.children).toEqual([story.id]);
  });

  it("refuses, storing nothing, a create or a move that skips a level", async () => {
    const epic = await create({ title: "E", type: "epic" });
    const story = await create({ title: "S", type: "story", parent: epic.id });
    const task = await create({ title: "T", parent: story.id });
    const refused = async (res: Response) => {
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };

    expect(await refused(await send("POST", "/items", { title: "x" }))).toBe(
      "a task needs a story as its parent",
    );
    expect(await refused(await send("POST", "/items", { title: "x", parent: epic.id }))).toBe(
      "a task needs a story as its parent, not an epic",
    );
    expect(await refused(await send("POST", "/items", { title: "x", type: "story" }))).toBe(
      "a story needs an epic as its parent",
    );
    expect(
      await refused(await send("POST", "/items", { title: "x", type: "epic", parent: task.id })),
    ).toBe("an epic has no parent");

    expect(await refused(await send("PATCH", `/items/${task.id}`, { parent: epic.id }))).toBe(
      "a task needs a story as its parent, not an epic",
    );
    expect(await refused(await send("PATCH", `/items/${story.id}`, { parent: null }))).toBe(
      "a story needs an epic as its parent",
    );
    expect(
      await refused(await send("PATCH", `/items/${story.id}`, { type: "epic", parent: null })),
    ).toBe("an epic cannot hold a task: a task needs a story as its parent");

    expect(store.items.map((i) => [i.type, i.parent])).toEqual([
      ["epic", null],
      ["story", epic.id],
      ["task", story.id],
    ]);
  });

  it("refuses a parent that does not exist", async () => {
    const res = await send("POST", "/items", {
      title: "x",
      parent: "00000000-0000-4000-8000-000000000000",
    });
    expect(res.status).toBe(400);
  });
});

describe("derived status", () => {
  const read = async (id: string) =>
    (await (await call(`/items/${id}`, { headers })).json()) as WorkItemView;
  const patch = (id: string, body: object) => send("PATCH", `/items/${id}`, body);

  it("pulls every ancestor forward when a task starts", async () => {
    const epic = await create({ title: "E", type: "epic" });
    const story = await create({ title: "S", type: "story", parent: epic.id });
    const task = await create({ title: "T", parent: story.id });
    expect((await read(epic.id)).status).toBe("backlog");

    await patch(task.id, { status: "in_progress" });
    expect((await read(story.id)).status).toBe("in_progress");
    expect((await read(epic.id)).status).toBe("in_progress");
    expect(store.items.find((i) => i.id === epic.id)!.status).toBe("backlog");
  });

  it("reads a finished parent done with no write to it", async () => {
    const epic = await create({ title: "E", type: "epic" });
    const story = await create({ title: "S", type: "story", parent: epic.id });
    const task = await create({ title: "T", parent: story.id, status: "in_progress" });
    await patch(task.id, { status: "done" });
    expect((await read(story.id)).status).toBe("done");
    expect((await read(epic.id)).status).toBe("done");
    expect(store.items.find((i) => i.id === epic.id)!.status).toBe("backlog");
  });

  it("reads a parent with finished and unstarted children as in progress", async () => {
    const story = await create({ title: "S", type: "story", status: "done" });
    const done = await create({ title: "T1", parent: story.id, status: "done" });
    await create({ title: "T2", parent: story.id, acceptanceCriteria: ["a"], status: "ready" });

    expect((await read(story.id)).status).toBe("in_progress");
    expect(await read(done.id)).toMatchObject({ status: "done", updatedAt: done.updatedAt });
  });

  it("re-derives both parents when a child moves, and the old one when it goes", async () => {
    const from = await create({ title: "A", type: "story" });
    const to = await create({ title: "B", type: "story" });
    await create({ title: "stays", parent: from.id, status: "done" });
    const moving = await create({ title: "T", parent: from.id, status: "in_progress" });
    expect((await read(from.id)).status).toBe("in_progress");

    await patch(moving.id, { parent: to.id });
    expect((await read(from.id)).status).toBe("done");
    expect((await read(to.id)).status).toBe("in_progress");

    await call(`/items/${moving.id}`, { method: "DELETE", headers });
    expect((await read(to.id)).status).toBe("backlog");
  });

  it("never changes a child when the parent is set", async () => {
    const story = await create({ title: "S", type: "story" });
    const task = await create({
      title: "T",
      parent: story.id,
      acceptanceCriteria: ["a"],
      status: "ready",
    });
    for (const status of ["backlog", "in_progress", "review", "done"]) {
      await patch(story.id, { status });
      expect(await read(task.id)).toEqual(task);
    }
  });

  it("lists and filters by the derived status", async () => {
    const story = await create({ title: "S", type: "story" });
    await create({ title: "T", parent: story.id, status: "in_progress" });
    expect((await list("?status=in_progress")).map((i) => i.title)).toEqual(["S", "T"]);
    expect((await list("?status=backlog")).map((i) => i.title)).toEqual([]);
  });
});

describe("done by itself", () => {
  const read = async (id: string) =>
    (await (await call(`/items/${id}`, { headers })).json()) as WorkItemView;
  const patch = (id: string, body: object) => send("PATCH", `/items/${id}`, body);
  const stored = (id: string) => store.items.find((i) => i.id === id)!.status;
  const finished = async () => {
    const epic = await create({ title: "E", type: "epic" });
    const story = await create({ title: "S", type: "story", parent: epic.id });
    const task = await create({ title: "T", parent: story.id, status: "done" });
    return { epic, story, task };
  };
  const statuses = async (...ids: string[]) => Promise.all(ids.map(async (id) => (await read(id)).status));

  it("reads in_progress or review again up the tree as soon as a child does, and done once it is again", async () => {
    const { epic, story, task } = await finished();
    await patch(task.id, { status: "in_progress" });
    expect(await statuses(story.id, epic.id)).toEqual(["in_progress", "in_progress"]);
    await patch(task.id, { status: "review" });
    expect(await statuses(story.id, epic.id)).toEqual(["review", "review"]);
    await patch(task.id, { status: "done" });
    expect(await statuses(story.id, epic.id)).toEqual(["done", "done"]);
  });

  it("leaves done where an unfinished child arrives, by create or move, and returns where it leaves", async () => {
    const { epic, story } = await finished();
    const added = await create({ title: "added", parent: story.id });
    expect(await statuses(story.id, epic.id)).toEqual(["in_progress", "in_progress"]);

    const other = await create({ title: "O", type: "story", parent: epic.id, status: "done" });
    await create({ title: "OT", parent: other.id, status: "done" });
    await patch(added.id, { parent: other.id });
    expect(await statuses(story.id, other.id, epic.id)).toEqual(["done", "in_progress", "in_progress"]);
    await call(`/items/${added.id}`, { method: "DELETE", headers });
    expect(await statuses(other.id, epic.id)).toEqual(["done", "done"]);
  });

  it("counts closed children as done, whatever their status", async () => {
    const { epic, story } = await finished();
    const dropped = await create({ title: "dropped", parent: story.id, status: "in_progress" });
    await patch(dropped.id, { state: "closed", closedReason: "not_planned" });
    expect(await statuses(story.id, epic.id)).toEqual(["done", "done"]);
    await patch(dropped.id, { state: "open" });
    expect(await statuses(story.id, epic.id)).toEqual(["in_progress", "in_progress"]);
  });

  it("takes a status written to a parent, done included, without refusing it or changing what it reads", async () => {
    const { epic, story, task } = await finished();
    await patch(task.id, { status: "in_progress" });
    const res = await patch(story.id, { status: "done" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkItemView).status).toBe("in_progress");
    expect(stored(story.id)).toBe("done");

    await patch(epic.id, { status: "backlog" });
    await patch(task.id, { status: "done" });
    expect(await statuses(story.id, epic.id)).toEqual(["done", "done"]);
  });

  it("reads a done leaf's stored done again once the children it gained are gone", async () => {
    const story = await create({ title: "S", type: "story", status: "done" });
    await patch(story.id, { title: "renamed" });
    expect((await read(story.id)).status).toBe("done");

    const other = await create({ title: "O", type: "story" });
    const moved = await create({ title: "T1", parent: story.id, status: "done" });
    const deleted = await create({ title: "T2", parent: story.id, status: "done" });
    await patch(moved.id, { parent: other.id });
    await call(`/items/${deleted.id}`, { method: "DELETE", headers });
    expect((await read(story.id)).status).toBe("done");
  });

  it("leaves a leaf that was never done as it was", async () => {
    const story = await create({ title: "S", type: "story", status: "review" });
    const task = await create({ title: "T", parent: story.id, status: "done" });
    await call(`/items/${task.id}`, { method: "DELETE", headers });
    expect((await read(story.id)).status).toBe("review");
  });

  it("leaves a leaf's own done alone", async () => {
    const story = await create({ title: "S", type: "story" });
    const done = await create({ title: "T1", parent: story.id, status: "done" });
    const leaf = await create({
      title: "T2",
      parent: story.id,
      acceptanceCriteria: ["a"],
      status: "done",
    });
    expect((await patch(leaf.id, { status: "ready" })).status).toBe(200);
    expect(stored(done.id)).toBe("done");
    expect((await patch(leaf.id, { status: "done" })).status).toBe(200);
    expect(stored(leaf.id)).toBe("done");
  });
});

describe("state", () => {
  const patch = (id: string, body: object) => send("PATCH", `/items/${id}`, body);

  it("closes from any status with a reason, and reopens at the same status", async () => {
    const { id } = await create({ title: "T", acceptanceCriteria: ["a"], status: "ready" });
    const closed = await patch(id, { state: "closed", closedReason: "not_planned" });
    expect(await closed.json()).toMatchObject({
      state: "closed",
      closedReason: "not_planned",
      status: "ready",
    });
    const reopened = await patch(id, { state: "open" });
    expect(await reopened.json()).toMatchObject({ state: "open", closedReason: null, status: "ready" });
  });

  it("requires a reason with closing, and only with closing", async () => {
    const { id } = await create({ title: "T" });
    expect((await patch(id, { state: "closed" })).status).toBe(400);
    expect((await patch(id, { closedReason: "completed" })).status).toBe(400);
    expect((await patch(id, { state: "open", closedReason: "completed" })).status).toBe(400);
    expect((await patch(id, { state: "closed", closedReason: "wontfix" })).status).toBe(400);
  });

  it("is open on create, whatever is sent", async () => {
    expect(await create({ title: "T", state: "closed" })).toMatchObject({ state: "open" });
  });

  it("lets an abandoned child stop blocking its parent", async () => {
    const story = await create({ title: "S", type: "story" });
    await create({ title: "done", parent: story.id, status: "done" });
    const dropped = await create({ title: "dropped", parent: story.id, status: "in_progress" });
    await patch(dropped.id, { state: "closed", closedReason: "not_planned" });
    const read = (await list()).find((item) => item.id === story.id)!;
    expect(read.status).toBe("done");
  });

  it("filters by state", async () => {
    await create({ title: "open" });
    const { id } = await create({ title: "closed", status: "done" });
    await patch(id, { state: "closed", closedReason: "completed" });
    expect((await list("?state=open")).map((i) => i.title)).toEqual(["open"]);
    expect((await list("?state=closed")).map((i) => i.title)).toEqual(["closed"]);
  });
});

describe("closing", () => {
  const patch = async (id: string, body: object) => {
    const res = await send("PATCH", `/items/${id}`, body);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as WorkItemView;
  };
  const stored = (id: string) => store.items.find((item) => item.id === id)!;

  it("closes everything still open beneath it, for the same reason, and leaves closed ones as they were", async () => {
    const epic = await create({ title: "E", type: "epic" });
    const story = await create({ title: "S", type: "story", parent: epic.id });
    const task = await create({ title: "T", parent: story.id });
    const dropped = await create({ title: "D", parent: story.id });
    await patch(dropped.id, { state: "closed", closedReason: "not_planned" });
    const closed = await patch(epic.id, { state: "closed", closedReason: "completed" });
    expect(closed).toMatchObject({ state: "closed", closedReason: "completed" });
    for (const id of [story.id, task.id]) {
      expect(stored(id)).toMatchObject({ state: "closed", closedReason: "completed", updatedAt: closed.updatedAt });
    }
    expect(stored(dropped.id)).toMatchObject({ state: "closed", closedReason: "not_planned" });
  });

  it("closes a leaf alone, and touches nothing above it", async () => {
    const story = await create({ title: "S", type: "story" });
    const task = await create({ title: "T", parent: story.id });
    await patch(task.id, { state: "closed", closedReason: "completed" });
    expect(stored(story.id).state).toBe("open");
  });

  it("reopens only the item, leaving a closed parent closed", async () => {
    const story = await create({ title: "S", type: "story" });
    const task = await create({ title: "T", parent: story.id });
    await patch(task.id, { state: "closed", closedReason: "not_planned" });
    await patch(story.id, { state: "closed", closedReason: "not_planned" });
    const before = stored(story.id);
    expect((await patch(task.id, { state: "open" })).state).toBe("open");
    expect(stored(story.id)).toEqual(before);
  });
});

describe("heldBy", () => {
  const as = (claimedBy: string) => ({ ...headers, "Claimed-By": claimedBy });
  const patch = async (id: string, body: object, by?: string) => {
    const res = await call(`/items/${id}`, {
      method: "PATCH",
      headers: by === undefined ? headers : as(by),
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as WorkItemView;
  };

  it("names who moved the item to in_progress until it leaves in_progress and review", async () => {
    const { id } = await create({ title: "T", status: "ready" });
    expect((await patch(id, { status: "in_progress" }, "agent-1")).heldBy).toBe("agent-1");
    expect((await patch(id, { title: "U" }, "agent-2")).heldBy).toBe("agent-1");
    expect((await patch(id, { status: "review" }, "agent-2")).heldBy).toBe("agent-1");
    expect((await patch(id, { status: "in_progress" }, "agent-2")).heldBy).toBe("agent-2");
    expect((await patch(id, { status: "done" }, "agent-2")).heldBy).toBeNull();
    expect((await patch(id, { status: "in_progress" })).heldBy).toBeNull();
  });

  it("filters by exact name, combined with the other filters", async () => {
    const mine = await create({ title: "mine", status: "ready" });
    const reviewed = await create({ title: "reviewed", status: "ready" });
    const theirs = await create({ title: "theirs", status: "ready" });
    await patch(mine.id, { status: "in_progress" }, "agent-1");
    await patch(reviewed.id, { status: "in_progress" }, "agent-1");
    await patch(reviewed.id, { status: "review" });
    await patch(theirs.id, { status: "in_progress" }, "agent-10");

    const titles = async (query: string) => (await list(query)).map((i) => i.title).sort();
    expect(await titles("?heldBy=agent-1")).toEqual(["mine", "reviewed"]);
    expect(await titles("?heldBy=agent-1&status=in_progress")).toEqual(["mine"]);
    await patch(mine.id, { state: "closed", closedReason: "not_planned" });
    expect(await titles("?heldBy=agent-1&state=open")).toEqual(["reviewed"]);
    expect(await titles("?heldBy=agent")).toEqual([]);
  });

  it("is null on a parent, whose status is derived", async () => {
    const story = await create({ title: "S", type: "story", status: "ready" });
    await patch(story.id, { status: "in_progress" }, "agent-1");
    await create({ title: "T", parent: story.id, status: "in_progress" });
    const [read] = await list(`?heldBy=agent-1`);
    expect(read).toBeUndefined();
    expect((await patch(story.id, { title: "S2" })).heldBy).toBeNull();
  });

  it("is not settable by a client", async () => {
    expect(await create({ title: "T", status: "in_progress", heldBy: "x" })).toMatchObject({
      heldBy: null,
    });
    const { id } = await create({ title: "T", status: "in_progress" });
    expect((await patch(id, { title: "U", heldBy: "x" })).heldBy).toBeNull();
    expect((await send("PATCH", `/items/${id}`, { heldBy: "x" })).status).toBe(400);
  });
});

describe("reviewedBy", () => {
  const patch = async (id: string, body: object, by = "approval-service") => {
    const res = await call(`/items/${id}`, {
      method: "PATCH",
      headers: { ...headers, "Claimed-By": by },
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as WorkItemView;
  };

  it("is null until written, and is written apart from who holds the item", async () => {
    const { id, reviewedBy } = await create({ title: "T", status: "ready" });
    expect(reviewedBy).toBeNull();
    await patch(id, { status: "in_progress" }, "agent-1");
    await patch(id, { status: "review" }, "agent-1");
    expect(await patch(id, { reviewedBy: "reviewer-1" })).toMatchObject({ heldBy: "agent-1", reviewedBy: "reviewer-1" });
  });

  it("is kept through a send-back, done and closing, and replaced by the next review", async () => {
    const { id } = await create({ title: "T", status: "review" });
    await patch(id, { reviewedBy: "reviewer-1" });
    expect((await patch(id, { status: "in_progress" }, "agent-1")).reviewedBy).toBe("reviewer-1");
    expect((await patch(id, { reviewedBy: "reviewer-2" })).reviewedBy).toBe("reviewer-2");
    expect((await patch(id, { status: "done", state: "closed", closedReason: "completed" })).reviewedBy).toBe("reviewer-2");
    expect((await patch(id, { reviewedBy: null })).reviewedBy).toBeNull();
  });

  it("records each reviewer in the item's history", async () => {
    const { id } = await create({ title: "T", status: "review" });
    await patch(id, { reviewedBy: "reviewer-1" });
    await patch(id, { reviewedBy: "reviewer-2" });
    const { entries } = (await (await call(`/items/${id}/history`, { headers })).json()) as { entries: { changes: unknown[] }[] };
    expect(entries.flatMap((e) => e.changes)).toEqual(
      expect.arrayContaining([
        { field: "reviewedBy", from: null, to: "reviewer-1" },
        { field: "reviewedBy", from: "reviewer-1", to: "reviewer-2" },
      ]),
    );
  });

  it("filters by exact name", async () => {
    const a = await create({ title: "a", status: "review" });
    await create({ title: "b", status: "review" });
    await patch(a.id, { reviewedBy: "reviewer-1" });
    expect((await list("?reviewedBy=reviewer-1")).map((i) => i.title)).toEqual(["a"]);
    expect(await list("?reviewedBy=reviewer")).toEqual([]);
  });

  it("refuses an empty name", async () => {
    const { id } = await create({ title: "T" });
    expect((await send("PATCH", `/items/${id}`, { reviewedBy: " " })).status).toBe(400);
  });
});

describe("queue", () => {
  const patch = (id: string, body: object) => send("PATCH", `/items/${id}`, body);
  const queue = async (id: string) => {
    // The queue is ordered by `queuedAt`, to the millisecond.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const res = await patch(id, { queued: true });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as WorkItemView;
  };
  const read = async (id: string) => (await (await call(`/items/${id}`, { headers })).json()) as WorkItemView;
  const titles = async () => (await list("?queued=true")).map((item) => item.title);

  it("queues a story or task in backlog or ready, each at its place in the order queued", async () => {
    const a = await create({ title: "a", status: "ready" });
    const b = await create({ title: "b", type: "story" });
    const c = await create({ title: "c" });
    expect(a).toMatchObject({ queuedAt: null, queuePosition: null });
    await queue(c.id);
    await queue(a.id);
    expect(await queue(b.id)).toMatchObject({ queuePosition: 3 });
    expect((await read(c.id)).queuePosition).toBe(1);
    expect(await titles()).toEqual(["c", "a", "b"]);
    expect((await list("?queued=false")).map((item) => item.title)).not.toContain("a");
  });

  it("keeps an item's place when it is queued again, and moves the rest up when one ahead is dequeued", async () => {
    const a = await create({ title: "a" });
    const b = await create({ title: "b" });
    const first = await queue(a.id);
    await queue(b.id);
    expect((await queue(a.id)).queuedAt).toBe(first.queuedAt);
    const res = await patch(a.id, { queued: false });
    expect(await res.json()).toMatchObject({ queuedAt: null, queuePosition: null });
    expect((await read(b.id)).queuePosition).toBe(1);
  });

  it("takes an item off the queue in the write that closes or starts it", async () => {
    const a = await create({ title: "a" });
    const b = await create({ title: "b" });
    const c = await create({ title: "c" });
    for (const { id } of [a, b, c]) await queue(id);
    expect(await (await patch(a.id, { state: "closed", closedReason: "not_planned" })).json()).toMatchObject({ queuedAt: null });
    expect(await (await patch(b.id, { status: "in_progress" })).json()).toMatchObject({ queuedAt: null });
    expect(await titles()).toEqual(["c"]);
    await patch(a.id, { state: "open" });
    await patch(b.id, { status: "ready" });
    expect(await titles()).toEqual(["c"]);
  });

  it("queues an epic like a story or task, by the status its children give it", async () => {
    const epic = await create({ title: "E", type: "epic", parent: null });
    expect((await queue(epic.id)).queuePosition).toBe(1);
    const story = await create({ title: "S", type: "story", parent: epic.id });
    await create({ title: "T", parent: story.id, status: "in_progress" });
    expect(await titles()).toEqual([]);
    expect((await patch(epic.id, { queued: true })).status).toBe(400);
  });

  it("refuses a closed item or a started one, naming why, and stores nothing", async () => {
    const closed = await create({ title: "closed" });
    await patch(closed.id, { state: "closed", closedReason: "completed" });
    const started = await create({ title: "started", status: "review" });
    const why = async (id: string, body: object = { queued: true }) => {
      const res = await patch(id, body);
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await why(closed.id)).toMatch(/closed item cannot be queued/);
    expect(await why(started.id)).toMatch(/at review cannot be queued/);
    const fresh = await create({ title: "fresh" });
    expect(await why(fresh.id, { queued: true, status: "in_progress" })).toMatch(/at in_progress/);
    expect(await titles()).toEqual([]);
  });

  it("refuses a story whose children read as started, and leaves one already queued out while they do", async () => {
    const story = await create({ title: "S", type: "story" });
    await queue(story.id);
    const task = await create({ title: "T", parent: story.id, status: "in_progress" });
    expect(await titles()).toEqual([]);
    expect((await patch(story.id, { queued: true })).status).toBe(400);
    await patch(task.id, { status: "ready" });
    expect(await titles()).toEqual(["S"]);
  });

  it("dequeues anything, queued or not", async () => {
    const epic = await create({ title: "E", type: "epic" });
    expect((await patch(epic.id, { queued: false })).status).toBe(200);
  });

  it("records queuing and dequeuing in the item's history", async () => {
    const { id } = await create({ title: "T" });
    const { queuedAt } = await queue(id);
    await patch(id, { queued: false });
    const { entries } = (await (await call(`/items/${id}/history`, { headers })).json()) as { entries: { changes: unknown[] }[] };
    expect(entries.flatMap((entry) => entry.changes)).toEqual(
      expect.arrayContaining([
        { field: "queuedAt", from: null, to: queuedAt },
        { field: "queuedAt", from: queuedAt, to: null },
      ]),
    );
  });
});

describe("dependencies", () => {
  it("blocks an item until every dependency is done, and names what holds it", async () => {
    const upstream = await create({ title: "up" });
    const item = await create({ title: "down", dependsOn: [upstream.id] });
    expect(item).toMatchObject({ blockedBy: [upstream.id] });

    await send("PATCH", `/items/${upstream.id}`, { status: "review" });
    const read = async () => (await list()).find((i) => i.id === item.id)!;
    expect(await read()).toMatchObject({ blockedBy: [upstream.id] });

    await send("PATCH", `/items/${upstream.id}`, { status: "done" });
    expect(await read()).toMatchObject({ blockedBy: [] });
  });

  for (const status of ["in_progress", "review", "done"] as const) {
    it(`refuses a move to ${status} with 409 while a dependency is not done, storing nothing`, async () => {
      const upstream = await create({ title: "up", status: "review" });
      const item = await create({ title: "down", status: "ready", dependsOn: [upstream.id] });

      const res = await send("PATCH", `/items/${item.id}`, { status });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: `cannot move to ${status} until every dependency is done or closed; still waiting on ${upstream.shortId} "up" (review)`,
        blockedBy: [upstream.id],
      });
      expect(store.items.find((i) => i.id === item.id)!.status).toBe("ready");
    });
  }

  it("refuses creating an item started ahead of its dependencies", async () => {
    const upstream = await create({ title: "up", type: "epic" });
    const res = await send("POST", "/items", { title: "down", type: "epic", status: "in_progress", dependsOn: [upstream.id] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ blockedBy: [upstream.id] });
  });

  it("lets the move through once every dependency is done or closed", async () => {
    const finished = await create({ title: "finished" });
    const abandoned = await create({ title: "abandoned" });
    const shipped = await create({ title: "shipped" });
    const item = await create({ title: "down", dependsOn: [finished.id, abandoned.id, shipped.id] });
    await send("PATCH", `/items/${finished.id}`, { status: "done" });
    await send("PATCH", `/items/${abandoned.id}`, { state: "closed", closedReason: "not_planned" });
    await send("PATCH", `/items/${shipped.id}`, { state: "closed", closedReason: "completed" });

    const res = await send("PATCH", `/items/${item.id}`, { status: "in_progress" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "in_progress", blockedBy: [] });
  });

  it("blocks an epic by its story's outside dependency, stored before the sibling rule, refusing its Start with 409 until that is done", async () => {
    const upstream = await create({ type: "epic", title: "up", parent: null });
    const epic = await create({ type: "epic", title: "outcome", parent: null });
    const story = await create({ type: "story", title: "piece", parent: epic.id });
    store.depend(story.id, [upstream.id]);
    const read = async () => (await list()).find((i) => i.id === epic.id)!;
    expect(await read()).toMatchObject({ blockedBy: [upstream.id] });

    const res = await send("PATCH", `/items/${epic.id}`, { status: "in_progress" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `cannot move to in_progress until every dependency is done or closed; still waiting on ${upstream.shortId} "up" (backlog)`,
      blockedBy: [upstream.id],
    });

    await send("PATCH", `/items/${upstream.id}`, { status: "done" });
    expect(await read()).toMatchObject({ blockedBy: [] });
    expect((await send("PATCH", `/items/${epic.id}`, { status: "in_progress" })).status).toBe(200);
    expect((await send("PATCH", `/items/${story.id}`, { status: "in_progress" })).status).toBe(200);
  });

  it("lets go of what depends on a dependency closed as not planned, until it is reopened", async () => {
    const upstream = await create({ title: "up" });
    const item = await create({ title: "down", dependsOn: [upstream.id] });

    await send("PATCH", `/items/${upstream.id}`, { state: "closed", closedReason: "not_planned" });
    const read = async () => (await list()).find((i) => i.id === item.id)!;
    expect(await read()).toMatchObject({ blockedBy: [] });

    await send("PATCH", `/items/${upstream.id}`, { state: "open" });
    expect(await read()).toMatchObject({ blockedBy: [upstream.id] });
  });

  describe("an epic's sign-off", () => {
    const as = (by: string, id: string, body: unknown) =>
      call(`/items/${id}`, { method: "PATCH", headers: { ...headers, "Claimed-By": by }, body: JSON.stringify(body) });
    const epicWithStory = async () => {
      const epic = await create({ type: "epic", title: "outcome", parent: null });
      const story = await create({ type: "story", title: "step", parent: epic.id });
      return { epic, story };
    };
    const stored = (id: string) => store.items.find((i) => i.id === id)!;

    it("refuses a worker closing an epic with children as completed, changing nothing", async () => {
      const { epic, story } = await epicWithStory();
      const res = await as("agent-7", epic.id, { state: "closed", closedReason: "completed" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining("only the person closes an epic") });
      expect(stored(epic.id).state).toBe("open");
      expect(stored(story.id).state).toBe("open");
    });

    it("lets the person close it, closing what is open beneath", async () => {
      const { epic, story } = await epicWithStory();
      expect((await send("PATCH", `/items/${epic.id}`, { state: "closed", closedReason: "completed" })).status).toBe(200);
      expect(stored(epic.id)).toMatchObject({ state: "closed", closedReason: "completed" });
      expect(stored(story.id)).toMatchObject({ state: "closed", closedReason: "completed" });
    });

    it("leaves a worker closing an epic not_planned, a childless epic, or a story", async () => {
      const { epic, story } = await epicWithStory();
      expect((await as("agent-7", story.id, { state: "closed", closedReason: "completed" })).status).toBe(200);
      expect((await as("agent-7", epic.id, { state: "closed", closedReason: "not_planned" })).status).toBe(200);
      const bare = await create({ type: "epic", title: "a ticket of its own", parent: null });
      expect((await as("reviewer-1", bare.id, { state: "closed", closedReason: "completed" })).status).toBe(200);
    });
  });

  describe("force", () => {
    const history = async (id: string) =>
      ((await (await call(`/items/${id}/history`, { headers })).json()) as { entries: HistoryEntry[] }).entries;

    it("lets the person move past an unfinished dependency, recording the override", async () => {
      const upstream = await create({ title: "up" });
      const item = await create({ title: "down", dependsOn: [upstream.id] });

      const res = await send("PATCH", `/items/${item.id}`, { status: "in_progress", force: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "in_progress", blockedBy: [upstream.id] });
      expect(store.items.find((i) => i.id === item.id)).not.toHaveProperty("force");
      expect((await history(item.id)).at(-1)).toMatchObject({
        claimedBy: null,
        overrode: [upstream.id],
        changes: [{ field: "status", from: "backlog", to: "in_progress" }],
      });
    });

    it("refuses a worker's force with 403, storing nothing", async () => {
      const upstream = await create({ title: "up" });
      const item = await create({ title: "down", dependsOn: [upstream.id] });

      const res = await call(`/items/${item.id}`, {
        method: "PATCH",
        headers: { ...headers, "Claimed-By": "agent-7" },
        body: JSON.stringify({ status: "in_progress", force: true }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining("only the person") });
      expect(store.items.find((i) => i.id === item.id)!.status).toBe("backlog");
    });

    it("records no override when nothing was in the way", async () => {
      const item = await create({ title: "free" });
      expect((await send("PATCH", `/items/${item.id}`, { status: "in_progress", force: true })).status).toBe(200);
      expect((await history(item.id)).at(-1)).toMatchObject({ overrode: [] });
    });
  });

  it("refuses a cycle with 400", async () => {
    const a = await create({ title: "A" });
    const b = await create({ title: "B", dependsOn: [a.id] });
    const res = await send("PATCH", `/items/${a.id}`, { dependsOn: [b.id] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("cycle") });
  });

  it("refuses depending on itself", async () => {
    const { id } = await create({ title: "A" });
    expect((await send("PATCH", `/items/${id}`, { dependsOn: [id] })).status).toBe(400);
  });

  describe("only between siblings", () => {
    const tree = async () => {
      const epic = await create({ type: "epic", title: "E" });
      const other = await create({ type: "epic", title: "Other" });
      const story = await create({ type: "story", title: "S", parent: epic.id });
      const sibling = await create({ type: "story", title: "Sibling", parent: epic.id });
      const cousin = await create({ type: "story", title: "Cousin", parent: other.id });
      return { epic, other, story, sibling, cousin };
    };
    const refusal = async (res: Response) => {
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };

    it("takes a dependency on an item of the same type and parent", async () => {
      const { epic, other, story, sibling } = await tree();
      expect((await create({ type: "story", title: "N", parent: epic.id, dependsOn: [sibling.id] })).dependsOn).toEqual([sibling.id]);
      expect((await send("PATCH", `/items/${story.id}`, { dependsOn: [sibling.id] })).status).toBe(200);
      expect((await send("PATCH", `/items/${epic.id}`, { dependsOn: [other.id] })).status).toBe(200);
    });

    it("refuses, by create or update and storing nothing, one on another parent or another type, naming it", async () => {
      const { epic, other, story, cousin } = await tree();
      const before = await list();
      for (const [res, named] of [
        [await send("POST", "/items", { type: "story", title: "N", parent: epic.id, dependsOn: [cousin.id] }), cousin],
        [await send("PATCH", `/items/${story.id}`, { dependsOn: [cousin.id] }), cousin],
        [await send("PATCH", `/items/${story.id}`, { dependsOn: [other.id] }), other],
        [await send("PATCH", `/items/${other.id}`, { dependsOn: [story.id] }), story],
      ] as const) {
        expect(await refusal(res)).toContain(`${named.shortId} ${named.type} "${named.title}"`);
      }
      expect(await list()).toEqual(before);
    });

    it("leaves a dependency stored before the rule alone, on an open or a closed item", async () => {
      const { story, cousin, sibling } = await tree();
      const closed = await create({ type: "story", title: "Done", parent: story.parent });
      await send("PATCH", `/items/${closed.id}`, { state: "closed", closedReason: "completed" });
      store.depend(story.id, [cousin.id]);
      store.depend(closed.id, [cousin.id]);
      expect((await send("PATCH", `/items/${story.id}`, { title: "renamed", dependsOn: [cousin.id, sibling.id] })).status).toBe(200);
      expect((await send("PATCH", `/items/${closed.id}`, { title: "renamed" })).status).toBe(200);
      expect((await send("PATCH", `/items/${closed.id}`, { state: "open" })).status).toBe(200);
    });

    it("refuses a move to another parent while the item has dependencies or open items depend on it, naming them", async () => {
      const { other, story, sibling } = await tree();
      await send("PATCH", `/items/${story.id}`, { dependsOn: [sibling.id] });
      expect(await refusal(await send("PATCH", `/items/${story.id}`, { parent: other.id }))).toMatch(
        new RegExp(`while it depends on ${sibling.shortId} story "Sibling"`),
      );
      expect(await refusal(await send("PATCH", `/items/${sibling.id}`, { parent: other.id }))).toMatch(
        new RegExp(`while ${story.shortId} story "S" depends on it`),
      );
      expect((await list()).find((i) => i.id === sibling.id)).toMatchObject({ parent: story.parent });

      await send("PATCH", `/items/${story.id}`, { state: "closed", closedReason: "not_planned" });
      expect((await send("PATCH", `/items/${sibling.id}`, { parent: other.id })).status).toBe(200);
      expect((await send("PATCH", `/items/${story.id}`, { parent: other.id, dependsOn: [] })).status).toBe(200);
    });
  });
});

describe("history", () => {
  const history = async (id: string) => {
    const res = await call(`/items/${id}/history`, { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { entries: HistoryEntry[] }).entries;
  };
  const as = (claimedBy: string) => ({ ...headers, "Claimed-By": claimedBy });

  it("records a create, an update and a delete, each naming its action", async () => {
    const { id } = await create({ title: "x", type: "epic" });
    await send("PATCH", `/items/${id}`, { title: "y" });
    await call(`/items/${id}`, { method: "DELETE", headers });
    expect((await history(id)).map((entry) => entry.action)).toEqual([
      "created",
      "updated",
      "deleted",
    ]);
  });

  it("says which fields an update changed, from what to what", async () => {
    const { id } = await create({ title: "x", acceptanceCriteria: ["a"] });
    await send("PATCH", `/items/${id}`, {
      title: "y",
      body: "",
      acceptanceCriteria: ["a", "b"],
      state: "closed",
      closedReason: "not_planned",
    });
    const [, updated] = await history(id);
    expect(updated!.changes).toEqual([
      { field: "title", from: "x", to: "y" },
      { field: "acceptanceCriteria", from: ["a"], to: ["a", "b"] },
      { field: "state", from: "open", to: "closed" },
      { field: "closedReason", from: null, to: "not_planned" },
    ]);
  });

  it("records the item as created from nothing and deleted to nothing", async () => {
    const { id } = await create({ title: "x", type: "epic" });
    await call(`/items/${id}`, { method: "DELETE", headers });
    const [created, deleted] = await history(id);
    expect(created!.changes).toContainEqual({ field: "title", from: null, to: "x" });
    expect(deleted!.changes).toContainEqual({ field: "title", from: "x", to: null });
  });

  it("carries when, and who the caller claimed to be, or null when it did not say", async () => {
    const res = await call("/items", {
      method: "POST",
      headers: as("agent-7"),
      body: JSON.stringify({ title: "x", type: "epic" }),
    });
    const { id, createdAt } = (await res.json()) as WorkItemView;
    await send("PATCH", `/items/${id}`, { title: "y" });

    const [created, updated] = await history(id);
    expect(created).toMatchObject({ item: id, at: createdAt, claimedBy: "agent-7" });
    expect(updated!.claimedBy).toBeNull();
  });

  it("keeps a deleted item's history, and 404s an id never written", async () => {
    const { id } = await create({ title: "x", type: "epic" });
    await call(`/items/${id}`, { method: "DELETE", headers: as("cleaner") });
    expect((await call(`/items/${id}`, { headers })).status).toBe(404);
    expect((await history(id)).at(-1)).toMatchObject({ action: "deleted", claimedBy: "cleaner" });

    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await call(`/items/${unknown}/history`, { headers })).status).toBe(404);
  });

  it("records nothing for a refused write or a delete of what is absent", async () => {
    const { id } = await create({ title: "x", type: "epic" });
    expect((await send("PATCH", `/items/${id}`, { dependsOn: [id] })).status).toBe(400);
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await call(`/items/${unknown}`, { method: "DELETE", headers })).status).toBe(204);

    expect(await history(id)).toHaveLength(1);
    expect((await call(`/items/${unknown}/history`, { headers })).status).toBe(404);
  });

  it("includes every write beneath an item, but none for its derived status", async () => {
    const epic = await create({ title: "E", type: "epic" });
    const story = await create({ title: "S", type: "story", parent: epic.id });
    const task = await create({ title: "T", parent: story.id, status: "done" });
    await send("PATCH", `/items/${story.id}`, { status: "done" });
    await send("PATCH", `/items/${task.id}`, { status: "in_progress" });

    const entries = await history(epic.id);
    expect(entries.map((entry) => [entry.item, entry.action])).toEqual([
      [epic.id, "created"],
      [story.id, "created"],
      [task.id, "created"],
      [story.id, "updated"],
      [task.id, "updated"],
    ]);
    expect(entries.at(-1)!.changes).toEqual([
      { field: "status", from: "done", to: "in_progress" },
    ]);
    expect((await history(story.id)).map((entry) => entry.item)).not.toContain(epic.id);
  });

  it("files a move under both the parent left and the parent joined", async () => {
    const from = await create({ title: "S1", type: "story" });
    const to = await create({ title: "S2", type: "story" });
    const task = await create({ title: "T", parent: from.id });
    await send("PATCH", `/items/${task.id}`, { parent: to.id });

    const move = { item: task.id, changes: [{ field: "parent", from: from.id, to: to.id }] };
    expect((await history(from.id)).at(-1)).toMatchObject(move);
    expect((await history(to.id)).at(-1)).toMatchObject(move);
  });

  it("offers no way to edit or remove an entry", async () => {
    const { id } = await create({ title: "x" });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await send(method, `/items/${id}/history`, { action: "deleted" });
      expect(res.status, method).toBe(404);
    }
    expect((await history(id)).map((entry) => entry.action)).toEqual(["created"]);
  });
});

describe("ticking acceptance criteria", () => {
  const patch = (id: string, body: object, by?: string) =>
    call(`/items/${id}`, { method: "PATCH", headers: by ? { ...headers, "claimed-by": by } : headers, body: JSON.stringify(body) });
  const read = async (id: string) => (await (await call(`/items/${id}`, { headers })).json()) as WorkItemView;

  it("starts with none met, and records who ticked each and when, keeping those already ticked", async () => {
    const item = await create({ title: "checked", acceptanceCriteria: ["builds", "tested", "shipped"] });
    expect(item.met).toEqual([]);

    expect((await patch(item.id, { met: ["tested"] }, "agent-1")).status).toBe(200);
    const once = await read(item.id);
    expect(once.met).toEqual([{ criterion: "tested", by: "agent-1", at: expect.any(String) }]);

    await patch(item.id, { met: ["shipped", "tested"] }, "agent-2");
    const twice = await read(item.id);
    // In the criteria's order, the first tick still its first ticker's.
    expect(twice.met.map((tick) => [tick.criterion, tick.by])).toEqual([
      ["tested", "agent-1"],
      ["shipped", "agent-2"],
    ]);
    expect(twice.met[0]!.at).toBe(once.met[0]!.at);

    await patch(item.id, { met: ["shipped"] });
    expect((await read(item.id)).met.map((tick) => tick.criterion)).toEqual(["shipped"]);
  });

  it("clears a tick when its criterion's text changes or the criterion goes, keeping the rest", async () => {
    const item = await create({ title: "edited", acceptanceCriteria: ["builds", "tested"] });
    await patch(item.id, { met: ["builds", "tested"] }, "agent-1");
    await patch(item.id, { acceptanceCriteria: ["builds cleanly", "tested"] });
    expect((await read(item.id)).met.map((tick) => tick.criterion)).toEqual(["tested"]);
    await patch(item.id, { acceptanceCriteria: ["builds cleanly"] });
    expect((await read(item.id)).met).toEqual([]);
  });

  it("takes new criteria and their ticks in one write", async () => {
    const item = await create({ title: "together" });
    await patch(item.id, { acceptanceCriteria: ["a", "b"], met: ["b"] });
    expect((await read(item.id)).met.map((tick) => tick.criterion)).toEqual(["b"]);
  });

  it("refuses a tick on a criterion the item does not have", async () => {
    const item = await create({ title: "strict", acceptanceCriteria: ["real"] });
    const res = await patch(item.id, { met: ["real", "imagined"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('"imagined"');
    expect((await read(item.id)).met).toEqual([]);
  });

  it("records each tick and untick in the history, as the criteria met", async () => {
    const item = await create({ title: "recorded", acceptanceCriteria: ["a", "b"] });
    await patch(item.id, { met: ["a"] }, "agent-1");
    await patch(item.id, { met: [] }, "agent-1");
    await patch(item.id, { acceptanceCriteria: ["a", "b"] });
    const { entries } = (await (await call(`/items/${item.id}/history`, { headers })).json()) as { entries: HistoryEntry[] };
    expect(entries.slice(1).map((entry) => entry.changes)).toEqual([
      [{ field: "met", from: [], to: ["a"] }],
      [{ field: "met", from: ["a"], to: [] }],
      [],
    ]);
  });
});

describe("ticking one criterion at a time", () => {
  const as = (by?: string) => (by ? { ...headers, "claimed-by": by } : headers);
  const tick = (id: string, criterion: string, by?: string) =>
    call(`/items/${id}/met`, { method: "POST", headers: as(by), body: JSON.stringify({ criterion }) });
  const untick = (id: string, criterion: string, by?: string) =>
    call(`/items/${id}/met`, { method: "DELETE", headers: as(by), body: JSON.stringify({ criterion }) });
  const read = async (id: string) => (await (await call(`/items/${id}`, { headers })).json()) as WorkItemView;
  const history = async (id: string) =>
    ((await (await call(`/items/${id}/history`, { headers })).json()) as { entries: HistoryEntry[] }).entries;

  it("ticks one criterion, recording who and when, by the item's short id, and answers with the item", async () => {
    const item = await create({ title: "checked", acceptanceCriteria: ["builds", "tested"] });
    const res = await tick(item.id.slice(0, 8), "tested", "agent-1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkItemView).met).toEqual([{ criterion: "tested", by: "agent-1", at: expect.any(String) }]);
    expect((await read(item.id)).met).toEqual([{ criterion: "tested", by: "agent-1", at: expect.any(String) }]);
  });

  it("keeps the other ticks, and their tickers, when ticking or unticking one", async () => {
    const item = await create({ title: "kept", acceptanceCriteria: ["a", "b", "c"] });
    await tick(item.id, "c", "agent-1");
    await tick(item.id, "a", "agent-2");
    expect((await read(item.id)).met.map((t) => [t.criterion, t.by])).toEqual([
      ["a", "agent-2"],
      ["c", "agent-1"],
    ]);
    expect((await untick(item.id, "a", "agent-3")).status).toBe(200);
    expect((await read(item.id)).met.map((t) => [t.criterion, t.by])).toEqual([["c", "agent-1"]]);
  });

  it("changes nothing and records nothing for a tick already met or an untick not met", async () => {
    const item = await create({ title: "idle", acceptanceCriteria: ["a", "b"] });
    await tick(item.id, "a", "agent-1");
    const first = (await read(item.id)).met;
    expect((await tick(item.id, "a", "agent-2")).status).toBe(200);
    expect((await untick(item.id, "b", "agent-2")).status).toBe(200);
    expect((await read(item.id)).met).toEqual(first);
    expect((await history(item.id)).length).toBe(2);
  });

  it("refuses a criterion the item does not have with 400 naming it, on tick and untick", async () => {
    const item = await create({ title: "strict", acceptanceCriteria: ["real"] });
    for (const send of [tick, untick]) {
      const res = await send(item.id, "imagined");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('"imagined"');
    }
    expect((await read(item.id)).met).toEqual([]);
    expect((await tick(item.id, "")).status).toBe(400);
  });

  it("404s an item that does not exist", async () => {
    expect((await tick("00000000-0000-4000-8000-000000000000", "a")).status).toBe(404);
  });

  it("records each tick and untick in the history as a met change, with its claimed-by", async () => {
    const item = await create({ title: "recorded", acceptanceCriteria: ["a", "b"] });
    await tick(item.id, "b", "agent-1");
    await tick(item.id, "a", "agent-1");
    await untick(item.id, "b", "agent-2");
    const entries = (await history(item.id)).slice(1);
    expect(entries.map((entry) => entry.changes)).toEqual([
      [{ field: "met", from: [], to: ["b"] }],
      [{ field: "met", from: ["b"], to: ["a", "b"] }],
      [{ field: "met", from: ["a", "b"], to: ["a"] }],
    ]);
    expect(entries.map((entry) => entry.claimedBy)).toEqual(["agent-1", "agent-1", "agent-2"]);
  });

  it("keeps both of two ticks of different criteria sent at once", async () => {
    const item = await create({ title: "raced", acceptanceCriteria: ["a", "b"] });
    const { read: held, release } = store.holdNextRead();
    const slow = tick(item.id, "a", "agent-1");
    await held;
    expect((await tick(item.id, "b", "agent-2")).status).toBe(200);
    release();
    expect((await slow).status).toBe(200);
    expect((await read(item.id)).met.map((t) => [t.criterion, t.by])).toEqual([
      ["a", "agent-1"],
      ["b", "agent-2"],
    ]);
  });
});

describe("comments and the work log", () => {
  const as = (who: string) => ({ ...headers, "claimed-by": who });
  const comment = (id: string, body: unknown, init: Record<string, string> = headers) =>
    call(`/items/${id}/comments`, { method: "POST", headers: init, body: JSON.stringify(body) });
  const log = (id: string, body: unknown, init: Record<string, string> = headers) =>
    call(`/items/${id}/work-log`, { method: "POST", headers: init, body: JSON.stringify(body) });
  const read = async (path: string) => {
    const res = await call(path, { headers });
    expect(res.status).toBe(200);
    return res.json();
  };

  it("adds a comment with its author and time, and lists the item's comments oldest first", async () => {
    const item = await create({ title: "talked about" });
    const first = await comment(item.id, { body: "**Why** this?" }, as("agent-1"));
    expect(first.status).toBe(201);
    const stored = await first.json();
    expect(stored).toEqual({ id: expect.any(String), item: item.id, author: "agent-1", at: expect.any(String), body: "**Why** this?" });
    await comment(item.id, { body: "Because." });

    const { comments } = (await read(`/items/${item.id}/comments`)) as { comments: { author: string | null; body: string }[] };
    expect(comments.map((each) => [each.author, each.body])).toEqual([
      ["agent-1", "**Why** this?"],
      [null, "Because."],
    ]);
  });

  it("records a work-log entry with its links, apart from the comments", async () => {
    const item = await create({ title: "worked on" });
    const res = await log(item.id, { body: "Opened the PR.", links: ["https://github.com/o/r/pull/9"] }, as("agent-2"));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ item: item.id, author: "agent-2", body: "Opened the PR.", links: ["https://github.com/o/r/pull/9"] });
    await comment(item.id, { body: "Nice." });

    const { entries } = (await read(`/items/${item.id}/work-log`)) as { entries: { body: string; links: string[] }[] };
    expect(entries.map((each) => [each.body, each.links])).toEqual([["Opened the PR.", ["https://github.com/o/r/pull/9"]]]);
    const { comments } = (await read(`/items/${item.id}/comments`)) as { comments: object[] };
    expect(comments).toHaveLength(1);
    expect(comments[0]).not.toHaveProperty("links");
    expect(comments[0]).not.toHaveProperty("kind");
  });

  it("leaves the item and its history as they were", async () => {
    const item = await create({ title: "quiet" });
    const version = store.version;
    await comment(item.id, { body: "a word" });
    await log(item.id, { body: "a step" });
    expect(store.version).toBe(version);
    expect(((await read(`/items/${item.id}/history`)) as { entries: object[] }).entries).toHaveLength(1);
    expect(((await read(`/items/${item.id}`)) as WorkItemView).updatedAt).toBe(item.updatedAt);
  });

  it("refuses an empty body, a link that is not http, and an item that does not exist", async () => {
    const item = await create({ title: "strict" });
    expect((await comment(item.id, { body: "   " })).status).toBe(400);
    expect((await log(item.id, { body: "x", links: ["javascript:alert(1)"] })).status).toBe(400);
    expect((await log(item.id, { body: "x", links: ["not a url"] })).status).toBe(400);
    const nowhere = "00000000-0000-4000-8000-000000000000";
    expect((await comment(nowhere, { body: "hello" })).status).toBe(404);
    expect((await log(nowhere, { body: "hello" })).status).toBe(404);
    expect((await call(`/items/${nowhere}/comments`, { headers })).status).toBe(404);
    expect((await call(`/items/${nowhere}/work-log`, { headers })).status).toBe(404);
    expect(((await read(`/items/${item.id}/comments`)) as { comments: object[] }).comments).toEqual([]);
  });

  it("needs the token", async () => {
    const item = await create({ title: "guarded" });
    expect((await call(`/items/${item.id}/comments`)).status).toBe(401);
    expect((await call(`/items/${item.id}/work-log`, { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("delete", () => {
  it("deletes, then 404s what is gone", async () => {
    const { id } = await create({ title: "x" });
    expect((await call(`/items/${id}`, { method: "DELETE", headers })).status).toBe(204);
    expect((await call(`/items/${id}`, { headers })).status).toBe(404);
  });

  it("409s while an item is still a parent or a dependency", async () => {
    const epic = await create({ title: "E", type: "epic" });
    await create({ title: "S", type: "story", parent: epic.id });
    expect((await call(`/items/${epic.id}`, { method: "DELETE", headers })).status).toBe(409);

    const upstream = await create({ title: "up" });
    await create({ title: "down", dependsOn: [upstream.id] });
    expect((await call(`/items/${upstream.id}`, { method: "DELETE", headers })).status).toBe(409);
  });
});

describe("racing writers", () => {
  const read = async (id: string) =>
    (await (await call(`/items/${id}`, { headers })).json()) as WorkItemView;
  const patch = (id: string, body: object) => send("PATCH", `/items/${id}`, body);
  const stored = (id: string) => store.items.find((i) => i.id === id);

  /** `slow` reads first, then `fast` reads and writes, then `slow` goes on to write. */
  type Write = () => Response | Promise<Response>;
  const race = async (slow: Write, fast: Write) => {
    const { read, release } = store.holdNextRead();
    const losing = slow();
    await read;
    const winner = await fast();
    release();
    return { winner, loser: await losing };
  };

  it("deletes nothing when the delete loses its check", async () => {
    const story = await create({ title: "S", type: "story" });
    const task = await create({ title: "T", parent: story.id, status: "done" });

    const { loser } = await race(
      () => call(`/items/${task.id}`, { method: "DELETE", headers }),
      () => send("POST", "/items", { title: "down", parent: story.id, dependsOn: [task.id] }),
    );
    expect(loser.status).toBe(409);
    expect(stored(task.id)).toBeDefined();
  });

  it("409s once every attempt has lost", async () => {
    const { id } = await create({ title: "x" });
    store.version = Number.NaN;
    const res = await patch(id, { title: "y" });
    expect(res.status).toBe(409);
    expect(stored(id)!.title).toBe("x");
  });
});

describe("tags", () => {
  const tag = async (draft: object) => {
    const res = await send("POST", "/tags", draft);
    expect(res.status, await res.clone().text()).toBe(201);
    return res.json() as Promise<Tag>;
  };
  const tags = async () => ((await (await call("/tags", { headers })).json()) as { tags: Tag[] }).tags;

  it("creates a tag, lists it and reads it back", async () => {
    const ui = await tag({ value: " ui ", color: "#3B82F6", description: "Pages and chips" });
    expect(ui).toMatchObject({ value: "ui", color: "#3B82F6", description: "Pages and chips" });
    expect(await tags()).toEqual([ui]);
    expect(await (await call(`/tags/${ui.id}`, { headers })).json()).toEqual(ui);
  });

  it("defaults the description to empty and lists by value", async () => {
    const b = await tag({ value: "b", color: "#000000" });
    const a = await tag({ value: "A", color: "#ffffff" });
    expect(b.description).toBe("");
    expect((await tags()).map((each) => each.id)).toEqual([a.id, b.id]);
  });

  it("patches only the fields sent", async () => {
    const ui = await tag({ value: "ui", color: "#3b82f6", description: "Pages" });
    const res = await send("PATCH", `/tags/${ui.id}`, { color: "#ef4444" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: ui.id, value: "ui", color: "#ef4444", description: "Pages" });
    expect((await tags())[0]!.color).toBe("#ef4444");
  });

  it("refuses a value another tag has in any case, on create and on patch, naming it", async () => {
    const ui = await tag({ value: "ui", color: "#3b82f6" });
    const other = await tag({ value: "api", color: "#3b82f6" });

    const created = await send("POST", "/tags", { value: "UI", color: "#000000" });
    expect(created.status).toBe(409);
    expect(await created.json()).toMatchObject({ error: expect.stringContaining('"ui"'), tag: ui.id });

    const patched = await send("PATCH", `/tags/${other.id}`, { value: "Ui" });
    expect(patched.status).toBe(409);
    expect(await patched.json()).toMatchObject({ tag: ui.id });
    expect((await tags()).map((each) => each.value)).toEqual(["api", "ui"]);
  });

  it("lets a tag keep its own value in another case", async () => {
    const ui = await tag({ value: "ui", color: "#3b82f6" });
    expect((await send("PATCH", `/tags/${ui.id}`, { value: "UI" })).status).toBe(200);
  });

  it.each([
    ["a colour that is not #rrggbb", { value: "ui", color: "blue" }],
    ["a short colour", { value: "ui", color: "#fff" }],
    ["an empty value", { value: "  ", color: "#ffffff" }],
    ["a value over 40 characters", { value: "x".repeat(41), color: "#ffffff" }],
    ["a description over 500 characters", { value: "ui", color: "#ffffff", description: "x".repeat(501) }],
  ])("refuses %s with 400", async (_, draft) => {
    expect((await send("POST", "/tags", draft)).status).toBe(400);
    expect(await tags()).toEqual([]);
  });

  it("refuses an empty or invalid patch with 400, and 404s a tag that does not exist", async () => {
    const ui = await tag({ value: "ui", color: "#3b82f6" });
    expect((await send("PATCH", `/tags/${ui.id}`, {})).status).toBe(400);
    expect((await send("PATCH", `/tags/${ui.id}`, { color: "red" })).status).toBe(400);
    const gone = "00000000-0000-4000-8000-000000000000";
    expect((await send("PATCH", `/tags/${gone}`, { color: "#000000" })).status).toBe(404);
    expect((await call(`/tags/${gone}`, { headers })).status).toBe(404);
  });

  it("deletes a tag with 204, and deleting it again changes nothing", async () => {
    const ui = await tag({ value: "ui", color: "#3b82f6" });
    expect((await call(`/tags/${ui.id}`, { method: "DELETE", headers })).status).toBe(204);
    expect(await tags()).toEqual([]);
    const version = store.version;
    expect((await call(`/tags/${ui.id}`, { method: "DELETE", headers })).status).toBe(204);
    expect(store.version).toBe(version);
  });

  it("bumps the graph version on every tag write", async () => {
    const ui = await tag({ value: "ui", color: "#3b82f6" });
    await send("PATCH", `/tags/${ui.id}`, { description: "x" });
    await call(`/tags/${ui.id}`, { method: "DELETE", headers });
    expect(store.version).toBe(3);
  });

  it("needs the token", async () => {
    expect((await call("/tags")).status).toBe(401);
    expect((await call("/tags", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call("/tags/00000000-0000-4000-8000-000000000000")).status).toBe(401);
  });
});

describe("an item's tags", () => {
  const tag = async (value: string) => {
    const res = await send("POST", "/tags", { value, color: "#3b82f6" });
    expect(res.status, await res.clone().text()).toBe(201);
    return res.json() as Promise<Tag>;
  };
  const add = (id: string, ref: string, by = "agent-1") =>
    call(`/items/${id}/tags`, { method: "POST", headers: { ...headers, "claimed-by": by }, body: JSON.stringify({ tag: ref }) });
  const drop = (id: string, ref: string) =>
    call(`/items/${id}/tags/${encodeURIComponent(ref)}`, { method: "DELETE", headers: { ...headers, "claimed-by": "agent-2" } });
  const view = async (res: Response) => {
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json() as Promise<WorkItemView>;
  };
  const history = async (id: string) =>
    ((await (await call(`/items/${id}/history`, { headers })).json()) as { entries: HistoryEntry[] }).entries;

  it("adds a tag by value in any case or by id, by its short id, and reads back the tag ids", async () => {
    const ui = await tag("ui");
    const api = await tag("api");
    const item = await create({ title: "T" });
    expect(item.tags).toEqual([]);

    expect((await view(await add(item.shortId, "UI"))).tags).toEqual([ui.id]);
    expect((await view(await add(item.id, api.id))).tags).toEqual([ui.id, api.id]);
    expect(((await (await call(`/items/${item.id}`, { headers })).json()) as WorkItemView).tags).toEqual([ui.id, api.id]);
  });

  it("removes a tag by value or by id", async () => {
    await tag("ui");
    const api = await tag("api");
    const item = await create({ title: "T" });
    await add(item.id, "ui");
    await add(item.id, "api");

    expect((await view(await drop(item.shortId, "Ui"))).tags).toEqual([api.id]);
    expect((await view(await drop(item.id, api.id))).tags).toEqual([]);
  });

  it("records each add and remove as a tags change, with its claimed-by", async () => {
    const ui = await tag("ui");
    const api = await tag("api");
    const item = await create({ title: "T" });
    await add(item.id, "ui");
    await add(item.id, "api");
    await drop(item.id, "ui");

    const entries = (await history(item.id)).slice(1);
    expect(entries.map(({ changes, claimedBy }) => ({ changes, claimedBy }))).toEqual([
      { changes: [{ field: "tags", from: [], to: [ui.id] }], claimedBy: "agent-1" },
      { changes: [{ field: "tags", from: [ui.id], to: [ui.id, api.id] }], claimedBy: "agent-1" },
      { changes: [{ field: "tags", from: [ui.id, api.id], to: [api.id] }], claimedBy: "agent-2" },
    ]);
  });

  it("adding a tag carried, or removing one not carried, answers 200 and records nothing", async () => {
    await tag("ui");
    const api = await tag("api");
    const item = await create({ title: "T" });
    await add(item.id, "ui");
    const before = (await history(item.id)).length;
    const version = store.version;

    expect((await view(await add(item.id, "UI"))).tags).toHaveLength(1);
    expect((await view(await drop(item.id, api.id))).tags).toHaveLength(1);
    expect((await view(await drop(item.id, "no-such-tag"))).tags).toHaveLength(1);
    expect(await history(item.id)).toHaveLength(before);
    expect(store.version).toBe(version);
  });

  it("refuses a tag that does not exist with 400 naming it", async () => {
    const item = await create({ title: "T" });
    const res = await add(item.id, "nope");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('"nope"');
  });

  it("refuses a 21st tag with 400", async () => {
    const item = await create({ title: "T" });
    for (let n = 0; n < 20; n++) {
      await tag(`t${n}`);
      expect((await add(item.id, `t${n}`)).status).toBe(200);
    }
    await tag("one-too-many");
    const res = await add(item.id, "one-too-many");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("at most 20");
    expect(store.items.find((each) => each.id === item.id)!.tags).toHaveLength(20);
  });

  it("404s an item that does not exist", async () => {
    await tag("ui");
    const gone = "00000000-0000-4000-8000-000000000000";
    expect((await add(gone, "ui")).status).toBe(404);
    expect((await drop(gone, "ui")).status).toBe(404);
  });

  it("does not take tags on create or patch", async () => {
    const ui = await tag("ui");
    const created = await send("POST", "/items", { title: "T", parent: await shelfFor("task"), tags: [ui.id] });
    expect(created.status).toBe(400);
    expect(((await created.json()) as { error: string }).error).toContain("POST and DELETE /items/{id}/tags");

    const item = await create({ title: "T" });
    expect((await send("PATCH", `/items/${item.id}`, { tags: [ui.id] })).status).toBe(400);
    expect((await send("PATCH", `/items/${item.id}`, { title: "U", tags: [] })).status).toBe(400);
    expect(store.items.find((each) => each.id === item.id)).toMatchObject({ title: "T", tags: [] });
  });

  it("keeps its tags through a patch", async () => {
    const ui = await tag("ui");
    const item = await create({ title: "T" });
    await add(item.id, "ui");
    expect((await view(await send("PATCH", `/items/${item.id}`, { title: "U" }))).tags).toEqual([ui.id]);
  });

  it("lists only the items carrying a tag, by value or id, combined with the other filters", async () => {
    const ui = await tag("ui");
    await tag("api");
    const open = await create({ title: "open" });
    const closed = await create({ title: "closed" });
    const other = await create({ title: "other" });
    await add(open.id, "ui");
    await add(closed.id, "ui");
    await add(other.id, "api");
    await send("PATCH", `/items/${closed.id}`, { state: "closed", closedReason: "completed" });

    const titles = async (query: string) => (await list(query)).map((each) => each.title).sort();
    expect(await titles("?tag=ui")).toEqual(["closed", "open"]);
    expect(await titles("?tag=UI&state=open")).toEqual(["open"]);
    expect(await titles(`?tag=${ui.id}&state=closed`)).toEqual(["closed"]);
    expect(await titles("?tag=nope")).toEqual([]);
  });

  it("refuses to delete a tag an item carries, naming them, and deletes it once none does", async () => {
    const ui = await tag("ui");
    const item = await create({ title: "T" });
    await add(item.id, "ui");
    await send("PATCH", `/items/${item.id}`, { state: "closed", closedReason: "not_planned" });

    const refused = await call(`/tags/${ui.id}`, { method: "DELETE", headers });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain(`1 item(s) carrying it: ${item.shortId}`);

    await drop(item.id, "ui");
    expect((await call(`/tags/${ui.id}`, { method: "DELETE", headers })).status).toBe(204);
  });

  describe("beneath an item", () => {
    const tree = async () => {
      const epic = await create({ title: "E", type: "epic" });
      const story = await create({ title: "S", type: "story", parent: epic.id });
      const done = await create({ title: "D", type: "story", parent: epic.id });
      const task = await create({ title: "T", type: "task", parent: story.id });
      await send("PATCH", `/items/${done.id}`, { state: "closed", closedReason: "completed" });
      return { epic, story, done, task };
    };
    const tagsOf = (id: string) => store.items.find((each) => each.id === id)!.tags;

    it("adds a tag to every item beneath, open or closed, in one write, saying how many it reached", async () => {
      const ui = await tag("ui");
      const { epic, story, done, task } = await tree();
      const version = store.version;
      const res = (await view(await add(epic.id, "ui"))) as WorkItemView & { reached: number };
      expect(res).toMatchObject({ tags: [ui.id], reached: 3 });
      expect(store.version).toBe(version + 1);
      for (const each of [story, done, task]) expect(tagsOf(each.id)).toEqual([ui.id]);
    });

    it("removes a tag from every item beneath", async () => {
      await tag("ui");
      const { epic, story, done, task } = await tree();
      await add(epic.id, "ui");
      const res = (await view(await drop(epic.id, "ui"))) as WorkItemView & { reached: number };
      expect(res).toMatchObject({ tags: [], reached: 3 });
      for (const each of [story, done, task]) expect(tagsOf(each.id)).toEqual([]);
    });

    it("removing a tag from one child leaves its parent and siblings carrying it", async () => {
      const ui = await tag("ui");
      const { epic, story, done, task } = await tree();
      await add(epic.id, "ui");
      expect(((await view(await drop(story.id, "ui"))) as WorkItemView & { reached: number }).reached).toBe(1);
      expect(tagsOf(epic.id)).toEqual([ui.id]);
      expect(tagsOf(done.id)).toEqual([ui.id]);
      expect(tagsOf(story.id)).toEqual([]);
      expect(tagsOf(task.id)).toEqual([]);
    });

    it("records a tags change in each item that changed, and none in one already carrying it", async () => {
      const ui = await tag("ui");
      const { epic, story, task } = await tree();
      await add(story.id, "ui");
      const before = await history(story.id);
      await add(epic.id, "ui");

      expect(await history(story.id)).toEqual(before);
      for (const each of [epic, task]) {
        const last = (await history(each.id)).filter((entry) => entry.item === each.id).at(-1)!;
        expect(last).toMatchObject({ item: each.id, claimedBy: "agent-1", changes: [{ field: "tags", from: [], to: [ui.id] }] });
      }
      // Its one tags change came from the story's write; the epic's found it already carrying the tag.
      const updates = (await history(task.id)).filter((entry) => entry.action === "updated");
      expect(updates).toHaveLength(1);
    });

    it("files each item's tags change under every item above it, on add and on remove", async () => {
      const ui = await tag("ui");
      const { epic, story, done, task } = await tree();
      const tagsChanges = async (under: string) =>
        (await history(under)).filter((entry) => entry.changes.some((change) => change.field === "tags") && entry.action === "updated");
      const items = async (under: string) => (await tagsChanges(under)).map((entry) => entry.item);

      await add(epic.id, "ui");
      expect((await items(epic.id)).sort()).toEqual([epic.id, story.id, done.id, task.id].sort());
      expect(await items(story.id)).toEqual([story.id, task.id]);
      expect(await items(task.id)).toEqual([task.id]);
      expect((await tagsChanges(epic.id)).find((entry) => entry.item === task.id)!.changes).toEqual([{ field: "tags", from: [], to: [ui.id] }]);

      await drop(epic.id, "ui");
      expect((await items(epic.id)).filter((id) => id !== epic.id)).toHaveLength(6);
      expect(await items(story.id)).toEqual([story.id, task.id, story.id, task.id]);
    });

    it("files a moved item's children's tags changes under the parent it moved to, not the one it left", async () => {
      await tag("ui");
      const tagged = await create({ title: "tagged", type: "epic" });
      await add(tagged.id, "ui");
      const { epic, story, task } = await tree();
      await send("PATCH", `/items/${story.id}`, { parent: tagged.id });
      const items = async (under: string) => (await history(under)).filter((entry) => entry.action === "updated").map((entry) => entry.item);
      expect(await items(tagged.id)).toContain(task.id);
      expect(await items(epic.id)).not.toContain(task.id);
      expect(await items(story.id)).toEqual([story.id, task.id]);
    });

    it("adds a tag a parent carries to the children that lack it", async () => {
      const ui = await tag("ui");
      const { epic, story } = await tree();
      await add(epic.id, "ui");
      await drop(story.id, "ui");
      const version = store.version;
      expect(((await view(await add(epic.id, "ui"))) as WorkItemView & { reached: number }).reached).toBe(2);
      expect(tagsOf(story.id)).toEqual([ui.id]);
      expect(store.version).toBe(version + 1);
    });

    it("refuses a write giving any item reached a 21st tag, naming it, and changes nothing", async () => {
      const { epic, story, task } = await tree();
      for (let n = 0; n < 20; n++) {
        await tag(`t${n}`);
        await add(task.id, `t${n}`);
      }
      await tag("one-too-many");
      const version = store.version;
      const res = await add(epic.id, "one-too-many");
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain("at most 20");
      expect(error).toContain(task.shortId);
      expect(error).not.toContain(story.shortId);
      expect(store.version).toBe(version);
      expect(tagsOf(epic.id)).toEqual([]);
    });

    it("gives an item made under a tagged parent the parent's tags", async () => {
      const ui = await tag("ui");
      const epic = await create({ title: "E", type: "epic" });
      await add(epic.id, "ui");
      const story = await create({ title: "S", type: "story", parent: epic.shortId });
      expect(story.tags).toEqual([ui.id]);
      expect((await history(story.id))[0]!.changes).toContainEqual({ field: "tags", from: null, to: [ui.id] });
    });

    it("gives an item moved under a tagged parent, and its children, the parent's tags besides their own", async () => {
      const ui = await tag("ui");
      const api = await tag("api");
      const tagged = await create({ title: "tagged", type: "epic" });
      await add(tagged.id, "ui");
      const { epic, story, task } = await tree();
      await add(task.id, "api");

      const moved = await view(await send("PATCH", `/items/${story.id}`, { parent: tagged.id }));
      expect(moved.tags).toEqual([ui.id]);
      expect(tagsOf(task.id)).toEqual([api.id, ui.id]);
      expect(tagsOf(epic.id)).toEqual([]);
      expect((await history(story.id)).filter((entry) => entry.item === story.id).at(-1)!.changes.map((change) => change.field).sort()).toEqual(["parent", "tags"]);
      expect((await history(task.id)).at(-1)).toMatchObject({ item: task.id, changes: [{ field: "tags", from: [api.id], to: [api.id, ui.id] }] });
    });

    it("leaves an item's tags as they were when it moves away from a tagged parent", async () => {
      const ui = await tag("ui");
      const { epic, story, task } = await tree();
      await add(epic.id, "ui");
      const other = await create({ title: "O", type: "epic" });
      expect((await view(await send("PATCH", `/items/${story.id}`, { parent: other.id }))).tags).toEqual([ui.id]);
      expect(tagsOf(task.id)).toEqual([ui.id]);
    });

    it("closes and tags an item beneath in one put when a move also closes", async () => {
      const ui = await tag("ui");
      const tagged = await create({ title: "tagged", type: "epic" });
      await add(tagged.id, "ui");
      const { story, task } = await tree();
      await view(await send("PATCH", `/items/${story.id}`, { parent: tagged.id, state: "closed", closedReason: "not_planned" }));
      expect(store.items.find((each) => each.id === task.id)).toMatchObject({ state: "closed", tags: [ui.id] });
      expect((await history(task.id)).at(-1)!.changes.map((change) => change.field).sort()).toEqual(["closedReason", "state", "tags"]);
    });

    it("refuses a move that would give any item a 21st tag, naming it, and changes nothing", async () => {
      const tagged = await create({ title: "tagged", type: "epic" });
      await tag("ui");
      await add(tagged.id, "ui");
      const { epic, story, task } = await tree();
      for (let n = 0; n < 20; n++) {
        await tag(`t${n}`);
        await add(task.id, `t${n}`);
      }
      const version = store.version;
      const res = await send("PATCH", `/items/${story.id}`, { parent: tagged.id });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(task.shortId);
      expect(store.version).toBe(version);
      expect(store.items.find((each) => each.id === story.id)!.parent).toBe(epic.id);
    });

    it("tags every item beneath an epic in one write, however many", async () => {
      const ui = await tag("ui");
      const epic = await create({ title: "E", type: "epic" });
      const stories = [];
      for (let n = 0; n < 50; n++) stories.push(await create({ title: `S${n}`, type: "story", parent: epic.id }));
      const res = await add(epic.id, "ui");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { reached: number }).reached).toBe(50);
      expect(stories.every((story) => tagsOf(story.id).includes(ui.id))).toBe(true);
    });
  });

  it("needs the token", async () => {
    const item = await create({ title: "T" });
    expect((await call(`/items/${item.id}/tags`, { method: "POST", body: '{"tag":"ui"}' })).status).toBe(401);
    expect((await call(`/items/${item.id}/tags/ui`, { method: "DELETE" })).status).toBe(401);
  });
});

describe("short ids", () => {
  /** Stored directly, so two ids can share a prefix as drawn ids never would. */
  const stored = (id: string, title: string) => {
    const shelved = WorkItem.create({ type: "epic", title, body: "", acceptanceCriteria: [], status: "backlog", parent: null, dependsOn: [] }, null, undefined, id);
    store.put(shelved);
  };
  const get = async (path: string) => {
    const res = await call(path, { headers });
    return { status: res.status, body: (await res.json()) as WorkItemView & { error?: string; matches?: string[] } };
  };

  it("reads back the shortest unique prefix, never under 8 characters", async () => {
    stored("abcdef01-0000-4000-8000-000000000001", "A");
    stored("abcdef01-2000-4000-8000-000000000002", "B");
    stored("12345678-0000-4000-8000-000000000003", "C");
    const items = (await list()).map((i) => [i.title, i.shortId]);
    expect(items.sort()).toEqual([["A", "abcdef01-0"], ["B", "abcdef01-2"], ["C", "12345678"]]);
  });

  it("opens an item at its short id, or any prefix of 8 or more, on every route", async () => {
    const { id, shortId } = await create({ title: "T" });
    expect(shortId).toBe(id.slice(0, 8));
    expect((await get(`/items/${shortId}`)).body.id).toBe(id);
    expect((await get(`/items/${id.slice(0, 12).toUpperCase()}`)).body.id).toBe(id);
    expect((await send("PATCH", `/items/${shortId}`, { title: "U" })).status).toBe(200);
    expect((await send("POST", `/items/${shortId}/comments`, { body: "hi" })).status).toBe(201);
    expect((await send("POST", `/items/${shortId}/work-log`, { body: "did" })).status).toBe(201);
    const comments = (await (await call(`/items/${shortId}/comments`, { headers })).json()) as { comments: Note[] };
    expect(comments.comments.map((c) => c.item)).toEqual([id]);
    expect((await call(`/items/${shortId}/work-log`, { headers })).status).toBe(200);
    expect(((await (await call(`/items/${shortId}/history`, { headers })).json()) as { entries: HistoryEntry[] }).entries).toHaveLength(2);
    expect((await call(`/items/${shortId}`, { method: "DELETE", headers })).status).toBe(204);
    expect(store.items.some((i) => i.id === id)).toBe(false);
  });

  it("does not take a prefix under 8 characters", async () => {
    const { id } = await create({ title: "T" });
    expect((await get(`/items/${id.slice(0, 7)}`)).status).toBe(404);
  });

  it("refuses a prefix more than one item starts with, naming them, and changes nothing", async () => {
    stored("abcdef01-0000-4000-8000-000000000001", "A");
    stored("abcdef01-2000-4000-8000-000000000002", "B");
    const refused = await get("/items/abcdef01");
    expect(refused.status).toBe(409);
    expect(refused.body.matches).toEqual(["abcdef01-0000-4000-8000-000000000001", "abcdef01-2000-4000-8000-000000000002"]);
    expect(refused.body.error).toContain("abcdef01-2000-4000-8000-000000000002");
    expect((await send("PATCH", "/items/abcdef01", { title: "x" })).status).toBe(409);
    expect((await call("/items/abcdef01", { method: "DELETE", headers })).status).toBe(409);
    expect((await call("/items/abcdef01/history", { headers })).status).toBe(409);
    expect(store.items).toHaveLength(2);
    expect((await get("/items/abcdef01-2")).body.title).toBe("B");
  });

  it("stores the full id for a parent or dependency given short, and filters by a short parent", async () => {
    const epic = await create({ title: "E", type: "epic" });
    const story = await create({ title: "S", type: "story", parent: epic.shortId });
    const other = await create({ title: "O", type: "story", parent: epic.id, dependsOn: [story.shortId] });
    expect(story.parent).toBe(epic.id);
    expect(other.dependsOn).toEqual([story.id]);
    const moved = (await (await send("PATCH", `/items/${other.id}`, { dependsOn: [], parent: epic.shortId })).json()) as WorkItemView;
    expect(moved).toMatchObject({ parent: epic.id, dependsOn: [] });
    expect((await list(`?parent=${epic.shortId}`)).map((i) => i.title).sort()).toEqual(["O", "S"]);
    expect((await send("POST", "/items", { title: "x", type: "story", parent: "zz" })).status).toBe(400);
  });

  it("draws a new id until its first 8 characters start no other item's", () => {
    const epic = (id: string) =>
      WorkItem.create({ type: "epic", title: id, body: "", acceptanceCriteria: [], status: "backlog", parent: null, dependsOn: [] }, null, undefined, id);
    const graph = new Graph([epic("abcdef01-0000-4000-8000-000000000001")]);
    const draws = ["abcdef01-9999-4000-8000-000000000002", "abcdef02-0000-4000-8000-000000000003"];
    expect(graph.freshId(() => draws.shift()!)).toBe("abcdef02-0000-4000-8000-000000000003");
  });
});

describe("pages", () => {
  it.each([
    ["/", "text/html", "<title>waypoint</title>"],
    ["/ui/app.js", "text/javascript", "function board"],
    ["/ui/style.css", "text/css", ".board"],
    ["/docs/api", "text/html", "createItem"],
    ["/docs/mcp", "text/html", "create_item"],
    ["/mcp.json", "application/json", "\"tools\""],
  ])("serves %s without a token", async (path, type, says) => {
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
    expect(await res.text()).toContain(says);
  });
});
