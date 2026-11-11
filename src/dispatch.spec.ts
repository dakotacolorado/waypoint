import { beforeEach, describe, expect, it } from "vitest";
import { Assigner } from "./assignment.ts";
import { CREATED_BY, Dispatcher, FleetClient, QUEUE } from "./dispatch.ts";
import type { Draft } from "./domain.ts";
import { FakeFleet, NOW } from "./fake-fleet.ts";
import { FakeStore } from "./fake-store.ts";

let store: FakeStore;
let fleet: FakeFleet;
let dispatcher: Dispatcher;
let assigner: Assigner;
let story: string;

beforeEach(async () => {
  store = new FakeStore();
  fleet = new FakeFleet();
  assigner = new Assigner(store, fleet, "https://ui.example", () => NOW);
  dispatcher = new Dispatcher(store, fleet, assigner, () => NOW);
  const epic = await store.create(draft({ type: "epic", title: "E" }));
  story = (await store.create(draft({ type: "story", title: "S", parent: epic.id }))).id;
});

function draft(fields: Partial<Draft> & { title: string }): Draft {
  return { type: "task", body: "", acceptanceCriteria: [], status: "ready", parent: null, dependsOn: [], ...fields };
}

const task = async (title: string, fields: Partial<Draft> = {}) =>
  (await store.create(draft({ title, parent: story, ...fields }))).id;

const queued = async (title: string, fields: Partial<Draft> = {}) => {
  const id = await task(title, fields);
  await store.update(id, { queued: true });
  // The queue is ordered by `queuedAt`, to the millisecond.
  await new Promise((resolve) => setTimeout(resolve, 2));
  return id;
};

const read = async (id: string) => {
  const graph = await store.graph();
  return graph.view(graph.get(id)!);
};

const FIRST = "00000001-0000-4000-8000-000000000000";

describe("dispatcher", () => {
  it("asks for an implementer for a queued epic briefed for an epic, and takes what is queued beneath it off the queue", async () => {
    const epic = (await store.create(draft({ type: "epic", title: "big", status: "backlog" }))).id;
    await store.update(epic, { queued: true });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const inner = (await store.create(draft({ type: "story", title: "inner", parent: epic }))).id;
    const leaf = (await store.create(draft({ title: "leaf", parent: inner }))).id;
    await store.update(leaf, { queued: true });
    const elsewhere = await queued("elsewhere");

    expect(await dispatcher.run()).toMatchObject({ requested: [{ item: epic }] });
    const [asked] = fleet.requests;
    expect(asked!.brief).toContain("epic \"big\"");
    expect(asked!.brief).toContain("closed by the person alone");
    expect(asked!.brief).toContain("Everything beneath it is yours too");
    expect(await read(leaf)).toMatchObject({ queuedAt: null, status: "ready" });
    expect(await read(epic)).toMatchObject({ queuePosition: null });
    expect((await read(elsewhere)).queuePosition).toBe(1);
  });

  it("passes over a queued epic whose story waits on an unfinished item outside it, stored before the sibling rule", async () => {
    const outside = (await store.create(draft({ type: "epic", title: "outside", status: "backlog" }))).id;
    const epic = (await store.create(draft({ type: "epic", title: "held", status: "backlog" }))).id;
    store.depend((await store.create(draft({ type: "story", title: "waits", parent: epic }))).id, [outside]);
    await store.update(epic, { queued: true });
    expect(await dispatcher.run()).toMatchObject({ requested: [], why: [expect.stringMatching(/every queued item is blocked/)] });
    expect(fleet.requests).toHaveLength(0);

    await store.update(outside, { state: "closed", closedReason: "completed" });
    expect(await dispatcher.run()).toMatchObject({ requested: [{ item: epic }] });
  });

  it("starts a childless epic in_progress, held by the worker its request names", async () => {
    const epic = (await store.create(draft({ type: "epic", title: "empty" }))).id;
    await store.update(epic, { queued: true });
    await dispatcher.run();
    expect(await read(epic)).toMatchObject({ status: "in_progress", heldBy: "implementer-00000001", queuedAt: null, assignment: { by: QUEUE } });
  });

  it("makes one implementer request for the first queued item, which records the worker it starts and holds the item by its name", async () => {
    const first = await queued("first");
    const second = await queued("second");
    const run = await dispatcher.run();
    expect(fleet.requests).toHaveLength(1);
    expect(fleet.made).toHaveLength(0);
    const [asked] = fleet.requests;
    expect(run).toEqual({ requested: [{ item: first, shortId: first.slice(0, 8), request: FIRST, worker: "implementer-00000001", state: "started", why: null }], why: ["1 of 1 running places are taken"] });
    expect(asked!.brief).toContain(`(id ${first})`);
    expect(asked!.brief).toContain("only work this session is for");
    expect(asked).toMatchObject({ label: "ticket: first", item: first });
    expect(await read(first)).toMatchObject({
      status: "in_progress",
      heldBy: "implementer-00000001",
      queuePosition: null,
      assignment: { agent: FIRST, name: "implementer-00000001", by: QUEUE },
    });
    expect(fleet.workers.find((worker) => worker.id === FIRST)).toBeDefined();
    expect((await read(second)).queuePosition).toBe(1);
  });

  it("at limit 1, makes no request while its last waits to be admitted or its item is being worked on, and the next once it reads review", async () => {
    const first = await queued("first");
    const second = await queued("second");
    fleet.holdBack = "weekly usage is 95%";
    expect(await dispatcher.run()).toMatchObject({ requested: [{ item: first, state: "waiting", why: "weekly usage is 95%" }] });
    expect(await read(first)).toMatchObject({ status: "in_progress", heldBy: "implementer-00000001", assignment: { agent: FIRST, ended: null } });
    expect(await dispatcher.run()).toMatchObject({
      requested: [],
      why: ["1 of 1 running places are taken", expect.stringMatching(/request for .* \(implementer-00000001\) is waiting: weekly usage is 95%/)],
    });
    fleet.admit(FIRST);
    expect(await dispatcher.run()).toMatchObject({
      requested: [],
      why: ["1 of 1 running places are taken", expect.stringMatching(/implementer-00000001, which the queue started on .*, is working and .* reads in_progress/)],
    });
    for (const state of ["waiting", "idle", "interrupted"] as const) {
      fleet.workers[0]!.state = state;
      expect((await dispatcher.run()).requested, state).toEqual([]);
    }
    await store.update(first, { status: "review" });
    expect(await dispatcher.run()).toMatchObject({ requested: [{ item: second }] });
    expect(fleet.requests).toHaveLength(2);
  });

  it("finds the request whose answer was lost, recording it rather than asking again", async () => {
    const first = await queued("first");
    await queued("second");
    fleet.lose = true;
    expect(await dispatcher.run()).toMatchObject({ requested: [{ item: first, request: FIRST }] });
    fleet.lose = false;
    expect(await read(first)).toMatchObject({ assignment: { agent: FIRST, name: "implementer-00000001" } });
    expect((await dispatcher.run()).requested).toEqual([]);
    expect(fleet.requests).toHaveLength(1);
  });

  it("refuses the person's Start on an item whose queue request is still waiting, naming it", async () => {
    const first = await queued("first");
    fleet.holdBack = "no connected host has a free slot";
    await dispatcher.run();
    await expect(assigner.start(first, null)).rejects.toThrow(/held by implementer-00000001, which worker-service has not started yet: no connected host/);
    expect(fleet.made).toHaveLength(0);
  });

  it("is not held up by a live agent the person started", async () => {
    const mine = await task("mine");
    await assigner.start(mine, null);
    const first = await queued("first");
    expect(await dispatcher.run()).toMatchObject({ requested: [{ item: first }] });
    expect(await read(first)).toMatchObject({ assignment: { by: QUEUE, agent: FIRST } });
  });

  it("takes off the queue, without starting it again, an item the person started after it was queued", async () => {
    await queued("leaf");
    await store.update(story, { queued: true });
    await assigner.start(story, null);
    await store.update(story, { queued: true });
    const run = await dispatcher.run();
    expect(run).toMatchObject({ requested: [], why: [expect.stringMatching(/is held by .*; taken off the queue/)] });
    expect(fleet.made).toHaveLength(1);
    expect(fleet.requests).toHaveLength(0);
    expect((await read(story)).queuePosition).toBeNull();
  });

  it("skips a blocked queued item, which keeps its place", async () => {
    const blocker = await task("blocker", { status: "backlog" });
    const blocked = await queued("blocked", { dependsOn: [blocker] });
    const free = await queued("free");
    expect(await dispatcher.run()).toMatchObject({ requested: [{ item: free }] });
    expect((await read(blocked)).queuePosition).toBe(1);
    await store.update(free, { status: "review" });
    expect(await dispatcher.run()).toMatchObject({ requested: [], why: [expect.stringMatching(/every queued item is blocked/)] });
  });

  it("says so when the queue is empty, without asking worker-service anything", async () => {
    fleet.request = async () => {
      throw new Error("asked");
    };
    expect(await dispatcher.run()).toEqual({ requested: [], why: ["the queue is empty"] });
  });

  it("says worker-service's refusal and leaves the item queued as it was", async () => {
    const id = await queued("first");
    fleet.refuse = "the stage has no role implementer";
    expect(await dispatcher.run()).toEqual({ requested: [], why: ["the stage has no role implementer"] });
    expect(await read(id)).toMatchObject({ status: "ready", queuePosition: 1, assignment: null });
  });
});

describe("dispatcher, with a running limit", () => {
  const limit = (n: number) => store.setQueueLimit(n, null);

  it("with limit 3 and five unblocked items queued, requests three in one run, in queue order", async () => {
    const ids = [];
    for (const title of ["a", "b", "c", "d", "e"]) ids.push(await queued(title));
    await limit(3);
    const run = await dispatcher.run();
    expect(run.requested.map((each) => each.item)).toEqual(ids.slice(0, 3));
    expect(run.why).toEqual(["3 of 3 running places are taken"]);
    expect(fleet.requests.map((each) => each.item)).toEqual(ids.slice(0, 3));
    expect(await dispatcher.run()).toMatchObject({ requested: [], why: ["3 of 3 running places are taken", expect.any(String), expect.any(String), expect.any(String)] });
  });

  it("counts requests still waiting to be admitted as taking places", async () => {
    for (const title of ["a", "b", "c"]) await queued(title);
    await limit(2);
    fleet.holdBack = "no connected host has a free slot";
    expect((await dispatcher.run()).requested).toHaveLength(2);
    expect((await dispatcher.run()).requested).toEqual([]);
  });

  it("skips a blocked item ahead in the queue, which keeps its place, and requests the next unblocked one", async () => {
    const blocker = await task("blocker", { status: "backlog" });
    const blocked = await queued("blocked", { dependsOn: [blocker] });
    const free = await queued("free");
    const after = await queued("after");
    await limit(2);
    expect((await dispatcher.run()).requested.map((each) => each.item)).toEqual([free, after]);
    expect((await read(blocked)).queuePosition).toBe(1);
  });

  it("starts a blocked item on its own once its dependency reads done, with nothing closed", async () => {
    const blocker = await task("blocker", { status: "in_progress" });
    const blocked = await queued("blocked", { dependsOn: [blocker] });
    expect(await dispatcher.run()).toMatchObject({ requested: [], why: [expect.stringMatching(/every queued item is blocked/)] });
    await store.update(blocker, { status: "done" });
    expect((await dispatcher.run()).requested.map((each) => each.item)).toEqual([blocked]);
  });

  it("requests the next once a running item reaches review, done, or is closed", async () => {
    const [a, b, c, d] = [await queued("a"), await queued("b"), await queued("c"), await queued("d")];
    expect((await dispatcher.run()).requested.map((each) => each.item)).toEqual([a]);
    await store.update(a, { status: "review" });
    expect((await dispatcher.run()).requested.map((each) => each.item)).toEqual([b]);
    await store.update(b, { status: "done" });
    expect((await dispatcher.run()).requested.map((each) => each.item)).toEqual([c]);
    await store.update(c, { state: "closed", closedReason: "not_planned" });
    expect((await dispatcher.run()).requested.map((each) => each.item)).toEqual([d]);
  });

  it("keeps the place of an item whose agent waits on a question, requesting nothing in its stead", async () => {
    await queued("a");
    await queued("b");
    await dispatcher.run();
    fleet.workers[0]!.state = "waiting";
    expect(await dispatcher.run()).toMatchObject({ requested: [], why: ["1 of 1 running places are taken", expect.stringMatching(/is waiting and .* reads in_progress/)] });
  });

  it("frees the place of an epic whose agent waits for sign-off with every child done", async () => {
    const epic = (await store.create(draft({ type: "epic", title: "big", status: "backlog" }))).id;
    const inner = (await store.create(draft({ type: "story", title: "inner", parent: epic }))).id;
    await store.update(epic, { queued: true });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const next = await queued("next");
    expect((await dispatcher.run()).requested.map((each) => each.item)).toEqual([epic]);
    expect((await dispatcher.run()).requested).toEqual([]);
    await store.update(inner, { status: "in_progress" });
    await store.update(inner, { status: "done" });
    fleet.workers[0]!.state = "waiting";
    expect((await read(epic)).status).toBe("done");
    expect((await dispatcher.run()).requested.map((each) => each.item)).toEqual([next]);
  });

  it("requests a queued epic once, at the epic level, taking its queued children off the queue, then the next item", async () => {
    const epic = (await store.create(draft({ type: "epic", title: "big", status: "backlog" }))).id;
    await store.update(epic, { queued: true });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const inner = (await store.create(draft({ type: "story", title: "inner", parent: epic }))).id;
    const leaf = (await store.create(draft({ title: "leaf", parent: inner }))).id;
    await store.update(leaf, { queued: true });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const other = await queued("other");
    await limit(5);
    const run = await dispatcher.run();
    expect(run.requested.map((each) => each.item)).toEqual([epic, other]);
    expect(fleet.requests.map((each) => each.item)).toEqual([epic, other]);
    expect(await read(leaf)).toMatchObject({ queuedAt: null, status: "ready", assignment: null });
  });

  it("starts nothing new after the limit is lowered until the running count is under it, and stops nothing", async () => {
    for (const title of ["a", "b", "c", "d"]) await queued(title);
    await limit(3);
    const started = (await dispatcher.run()).requested.map((each) => each.item);
    expect(started).toHaveLength(3);
    await limit(1);
    expect(await dispatcher.run()).toMatchObject({ requested: [], why: expect.arrayContaining(["3 of 1 running places are taken"]) });
    expect(fleet.workers.filter((each) => each.state === "working")).toHaveLength(3);
    await store.update(started[0]!, { status: "review" });
    await store.update(started[1]!, { status: "review" });
    expect((await dispatcher.run()).requested).toEqual([]);
    await store.update(started[2]!, { status: "review" });
    expect((await dispatcher.run()).requested).toHaveLength(1);
  });

  it("goes on to the next item past one the person started after it was queued", async () => {
    await task("leaf");
    await store.update(story, { queued: true });
    await assigner.start(story, null);
    await store.update(story, { queued: true });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const other = (await store.create(draft({ type: "story", title: "other", parent: (await read(story)).parent }))).id;
    await store.update(other, { queued: true });
    await limit(2);
    const run = await dispatcher.run();
    expect(run.requested.map((each) => each.item)).toEqual([other]);
    expect(run.why).toEqual([expect.stringMatching(/is held by .*; taken off the queue/)]);
  });
});

describe("a run, of an assignment whose agent is retired", () => {
  it("ends it, leaving the item in_progress and unheld, recorded with the agent's name, and it can be started again at once", async () => {
    const id = await task("held");
    const first = (await assigner.start(id, null))!.assignment!;
    fleet.workers[0]!.state = "retired";
    const run = await dispatcher.run();
    expect(run).toEqual({ requested: [], why: ["the queue is empty"], released: [id] });
    const item = await read(id);
    expect(item).toMatchObject({ status: "in_progress", heldBy: null, assignment: { id: first.id, ended: { why: `its agent ${first.name} was retired` } } });
    const entry = (await store.history(id))!.at(-1)!;
    expect(entry).toMatchObject({ claimedBy: CREATED_BY, changes: expect.arrayContaining([expect.objectContaining({ field: "heldBy", to: null })]) });
    expect(JSON.stringify(entry.changes)).toContain(first.name);
    expect(await assigner.start(id, null)).toMatchObject({ status: "in_progress", heldBy: expect.any(String), assignment: { ended: null, agent: "w-2" } });
    expect((await dispatcher.run()).released).toBeUndefined();
  });

  it("ends one worker-service has no record of, and an epic's, so its Start makes a new agent", async () => {
    const epic = (await store.create(draft({ type: "epic", title: "big", status: "backlog" }))).id;
    await store.create(draft({ type: "story", title: "inner", parent: epic }));
    await assigner.start(epic, null);
    fleet.workers = [];
    expect((await dispatcher.run()).released).toEqual([epic]);
    expect((await read(epic)).assignment!.ended).toMatchObject({ why: expect.stringMatching(/unknown to worker-service/) });
    expect(await assigner.start(epic, null)).toMatchObject({ assignment: { ended: null } });
    expect(fleet.made).toHaveLength(2);
  });

  it("leaves it as it is while worker-service cannot be asked, and ends it on the next run that can", async () => {
    const id = await task("held");
    await assigner.start(id, null);
    fleet.workers[0]!.state = "retired";
    const get = fleet.get;
    fleet.get = async () => {
      throw new Error("unreachable");
    };
    expect((await dispatcher.run()).released).toBeUndefined();
    expect((await read(id)).assignment!.ended).toBeNull();
    fleet.get = get;
    expect((await dispatcher.run()).released).toEqual([id]);
  });

  it("leaves one whose request is still waiting, and ends one whose request was withdrawn", async () => {
    const id = await queued("first");
    fleet.holdBack = "weekly usage is 95%";
    await dispatcher.run();
    expect((await dispatcher.run()).released).toBeUndefined();
    fleet.requests[0]!.state = "withdrawn";
    expect((await dispatcher.run()).released).toEqual([id]);
    expect((await read(id)).assignment!.ended).toMatchObject({ why: "its request for implementer-00000001 was withdrawn" });
  });

  it("leaves a live agent's, and one stopped done, assigned", async () => {
    const id = await task("held");
    await assigner.start(id, null);
    Object.assign(fleet.workers[0]!, { state: "idle", status: "done" });
    expect((await dispatcher.run()).released).toBeUndefined();
    expect((await read(id)).heldBy).not.toBeNull();
  });
});

describe("FleetClient", () => {
  it("asks worker-service as work-tracker, with its token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "w-1", name: "x", state: "working", status: null }), { status: 201 });
    }) as typeof globalThis.fetch;
    const client = new FleetClient("https://ws.example/", "ws-token", fetch);
    await client.make({ name: "x", label: "ticket: x", brief: "b", item: "ca147da6-9a30-4d59-b508-e404d21b9dfd" });
    const [{ url, init }] = calls as [{ url: string; init: RequestInit }];
    expect(url).toBe("https://ws.example/fleet/workers");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "x", item: "ca147da6-9a30-4d59-b508-e404d21b9dfd" });
    expect(init.headers).toMatchObject({ authorization: "Bearer ws-token", "claimed-by": CREATED_BY });
  });

  it("throws worker-service's refusal in its words", async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: "no such role" }), { status: 400 })) as typeof globalThis.fetch;
    const client = new FleetClient("https://ws.example", "t", fetch);
    await expect(client.request({ label: "l", brief: "b", item: "i" })).rejects.toThrow("worker-service answered 400 to POST /fleet/requests: no such role");
  });
});
