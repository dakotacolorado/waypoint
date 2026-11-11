import { singleToken } from "./auth.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkTrackerApi } from "./api.ts";
import { Assigner } from "./assignment.ts";
import { Dispatcher } from "./dispatch.ts";
import type { Draft } from "./domain.ts";
import { FakeFleet, NOW } from "./fake-fleet.ts";
import { FakeStore } from "./fake-store.ts";
import type { Queue } from "./queue.ts";

const TOKEN = "test-token";
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const FIRST = "00000001-0000-4000-8000-000000000000";

let store: FakeStore;
let fleet: FakeFleet;
let api: WorkTrackerApi;
let dispatcher: Dispatcher;
let story: string;

beforeEach(async () => {
  store = new FakeStore();
  fleet = new FakeFleet();
  const assigner = new Assigner(store, fleet, "https://ui.example", () => NOW);
  api = new WorkTrackerApi(store, singleToken(TOKEN), { assigner: () => assigner, fleet: () => fleet });
  dispatcher = new Dispatcher(store, fleet, assigner, () => NOW);
  const epic = await store.create(draft({ type: "epic", title: "E" }));
  story = (await store.create(draft({ type: "story", title: "S", parent: epic.id }))).id;
});

function draft(fields: Partial<Draft> & { title: string }): Draft {
  return { type: "task", body: "", acceptanceCriteria: [], status: "ready", parent: null, dependsOn: [], ...fields };
}

const task = async (title: string, fields: Partial<Draft> = {}) => (await store.create(draft({ title, parent: story, ...fields }))).id;

const queued = async (title: string, fields: Partial<Draft> = {}) => {
  const id = await task(title, fields);
  await store.update(id, { queued: true });
  await new Promise((resolve) => setTimeout(resolve, 2));
  return id;
};

const get = async (): Promise<Queue> => {
  const res = await api.fetch(new Request("http://local/queue", { headers }));
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json() as Promise<Queue>;
};

const patch = (body: unknown, extra: Record<string, string> = {}) =>
  api.fetch(new Request("http://local/queue", { method: "PATCH", headers: { ...headers, ...extra }, body: JSON.stringify(body) }));

describe("GET /queue", () => {
  it("reads limit 1, nothing running and no last run before anything is queued or set", async () => {
    expect(await get()).toEqual({ limit: 1, running: [], queued: [], last: null });
  });

  it("reads limit 1 from a stored limit it does not know", async () => {
    store.queueStored = { limit: 99, other: true };
    expect((await get()).limit).toBe(1);
  });

  it("needs the token", async () => {
    expect((await api.fetch(new Request("http://local/queue"))).status).toBe(401);
  });

  it("lists the queued items in order, each next or blocked, a blocked one naming what it waits on by short id, title and status", async () => {
    const blocker = await task("blocker", { status: "backlog" });
    const first = await queued("first");
    const held = await queued("held", { dependsOn: [blocker] });
    const { queued: items } = await get();
    expect(items).toEqual([
      { item: { id: first, shortId: first.slice(0, 8), title: "first", status: "ready" }, position: 1, state: "next", blockedBy: [], request: null },
      {
        item: { id: held, shortId: held.slice(0, 8), title: "held", status: "ready" },
        position: 2,
        state: "blocked",
        blockedBy: [{ id: blocker, shortId: blocker.slice(0, 8), title: "blocker", status: "backlog" }],
        request: null,
      },
    ]);
  });

  it("lists an item the queue started as running with its agent, and the dispatcher's last run", async () => {
    const first = await queued("first");
    const second = await queued("second");
    await dispatcher.run();
    const queue = await get();
    expect(queue.running).toEqual([
      {
        item: { id: first, shortId: first.slice(0, 8), title: "first", status: "in_progress" },
        agent: { id: FIRST, name: "implementer-00000001", state: "working" },
        startedAt: new Date(NOW).toISOString(),
      },
    ]);
    expect(queue.queued.map((each) => [each.item.id, each.state])).toEqual([[second, "next"]]);
    expect(queue.last).toEqual({
      at: new Date(NOW).toISOString(),
      requested: [{ item: first, shortId: first.slice(0, 8), request: FIRST, worker: "implementer-00000001", state: "started", why: null }],
      why: ["1 of 1 running places are taken"],
    });
  });

  it("lists a request still waiting to be admitted as requested, saying why, ahead of the queued items", async () => {
    const first = await queued("first");
    await queued("second");
    fleet.holdBack = "weekly usage is 95%";
    await dispatcher.run();
    const { running, queued: items } = await get();
    expect(running).toEqual([]);
    expect(items[0]).toMatchObject({
      item: { id: first },
      position: null,
      state: "requested",
      request: { id: FIRST, name: "implementer-00000001", why: "weekly usage is 95%" },
    });
    expect(items[1]).toMatchObject({ state: "next", position: 1 });
  });

  it("keeps a started item running while its agent waits on a question, and drops it once it reads review, done or closed", async () => {
    const first = await queued("first");
    await dispatcher.run();
    fleet.workers[0]!.state = "waiting";
    expect((await get()).running).toMatchObject([{ item: { id: first }, agent: { state: "waiting" } }]);
    await store.update(first, { status: "review" });
    expect((await get()).running).toEqual([]);
    await store.update(first, { status: "in_progress" });
    expect((await get()).running).toHaveLength(1);
    await store.update(first, { status: "done" });
    expect((await get()).running).toEqual([]);
    await store.update(first, { status: "in_progress" });
    await store.update(first, { state: "closed", closedReason: "not_planned" });
    expect((await get()).running).toEqual([]);
  });

  it("drops an epic the queue started once every child is done, while its agent waits for sign-off", async () => {
    const epic = (await store.create(draft({ type: "epic", title: "big", status: "backlog" }))).id;
    const inner = (await store.create(draft({ type: "story", title: "inner", parent: epic }))).id;
    await store.update(epic, { queued: true });
    await dispatcher.run();
    expect((await get()).running).toMatchObject([{ item: { id: epic } }]);
    await store.update(inner, { status: "in_progress" });
    await store.update(inner, { status: "done" });
    fleet.workers[0]!.state = "waiting";
    expect((await get()).running).toEqual([]);
  });

  it("does not count an item the person started", async () => {
    await new Assigner(store, fleet, "https://ui.example", () => NOW).start(await task("mine"), null);
    expect((await get()).running).toEqual([]);
  });

  it("holds a start worker-service cannot be asked about as running, its agent unknown", async () => {
    await queued("first");
    await dispatcher.run();
    fleet.get = async () => {
      throw new Error("unreachable");
    };
    expect((await get()).running).toMatchObject([{ agent: { id: FIRST, state: "unknown" } }]);
  });

  it("drops a start whose agent was retired", async () => {
    await queued("first");
    await dispatcher.run();
    fleet.workers[0]!.state = "retired";
    expect((await get()).running).toEqual([]);
  });
});

describe("PATCH /queue", () => {
  it("sets the limit from 1 to 10, as the person's write, and answers the queue at it", async () => {
    const res = await patch({ limit: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ limit: 3 });
    expect((await get()).limit).toBe(3);
    expect((await patch({ limit: 10 })).status).toBe(200);
    expect((await patch({ limit: 1 })).status).toBe(200);
    expect((await get()).limit).toBe(1);
  });

  it("refuses any other limit with 400", async () => {
    for (const limit of [0, 11, 2.5, "3", null]) expect((await patch({ limit })).status, String(limit)).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ limit: 2, other: 1 })).status).toBe(400);
    expect((await get()).limit).toBe(1);
  });

  it("refuses a write with claimed-by with 403", async () => {
    const res = await patch({ limit: 3 }, { "claimed-by": "a219a00f-18237bd5" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/only the person sets the queue's running limit/);
    expect((await get()).limit).toBe(1);
  });

  it("keeps the limit when the dispatcher records a run, and the run when the limit is set", async () => {
    await patch({ limit: 4 });
    await dispatcher.run();
    expect(await get()).toMatchObject({ limit: 4, last: { why: ["the queue is empty"] } });
    await patch({ limit: 2 });
    expect(await get()).toMatchObject({ limit: 2, last: { why: ["the queue is empty"] } });
  });
});
