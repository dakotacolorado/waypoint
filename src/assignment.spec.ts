import { singleToken } from "./auth.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkTrackerApi } from "./api.ts";
import { AgentRefusedError, Assigner, STALE_AFTER_MS, type Agent, type AgentRequest, type Agents, type NewAgent } from "./assignment.ts";
import { FleetClient } from "./dispatch.ts";
import type { Draft, WorkItemView } from "./domain.ts";
import { FakeStore } from "./fake-store.ts";

const TOKEN = "t";
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

/** worker-service as a test sets it: what it holds, what it was asked to make, and how a make goes. */
class FakeAgents implements Agents {
  agents: Agent[] = [];
  made: NewAgent[] = [];
  /** Set to refuse the next make, or to lose its answer after making it. */
  next: "refuse" | "lose" | null = null;
  retired: string[] = [];
  refuseRetire: string | null = null;

  retire = async (id: string) => {
    if (this.refuseRetire) throw new AgentRefusedError(this.refuseRetire, 409);
    this.retired.push(id);
    this.agents.find((agent) => agent.id === id)!.state = "retired";
  };

  get = async (id: string) => this.agents.find((agent) => agent.id === id) ?? null;
  request = async (): Promise<AgentRequest> => {
    throw new Error("no request is made by a Start");
  };
  requestOf = async () => null;
  requestsFor = async () => [];
  named = async (name: string) => this.agents.find((agent) => agent.name === name && agent.state !== "retired") ?? null;
  make = async (agent: NewAgent) => {
    if (this.next === "refuse") throw new AgentRefusedError("worker-service answered 503 to POST /fleet/workers: no connected host has room", 503);
    if (this.agents.some((each) => each.name === agent.name && each.state !== "retired")) {
      throw new AgentRefusedError("worker-service answered 409 to POST /fleet/workers: name taken", 409);
    }
    this.made.push(agent);
    const made: Agent = { id: `agent-${this.made.length}`, name: agent.name, state: "working", status: "working" };
    this.agents.push(made);
    if (this.next === "lose") throw new TypeError("fetch failed");
    return made;
  };
}

let store: FakeStore;
let agents: FakeAgents;
let now: number;
let api: WorkTrackerApi;
let story: string;

beforeEach(async () => {
  store = new FakeStore();
  agents = new FakeAgents();
  now = Date.parse("2026-11-06T12:00:00Z");
  const assigner = new Assigner(store, agents, "https://ui.example", () => now);
  api = new WorkTrackerApi(store, singleToken(TOKEN), { assigner: () => assigner });
  const epic = await store.create(draft({ type: "epic", title: "E" }));
  story = (await store.create(draft({ type: "story", title: "S", parent: epic.id }))).id;
});

function draft(fields: Partial<Draft> & { title: string }): Draft {
  return { type: "task", body: "", acceptanceCriteria: [], status: "ready", parent: null, dependsOn: [], ...fields };
}

const task = async (fields: Partial<Draft> = {}) => (await store.create(draft({ title: "T", parent: story, ...fields }))).id;

const start = (id: string, by?: string) =>
  api.fetch(new Request(`http://local/items/${id}/assignment`, { method: "POST", headers: { ...headers, ...(by && { "claimed-by": by }) } }));

const read = async (id: string): Promise<WorkItemView> => {
  const graph = await store.graph();
  return graph.view(graph.get(id)!);
};

describe("POST /items/{id}/assignment", () => {
  it("assigns a leaf, makes its agent named from the assignment, and holds the item for it", async () => {
    const id = await task({ title: "Fix it" });
    await store.update(id, { queued: true });
    const res = await start(id.slice(0, 8), "lead");
    expect(res.status).toBe(201);
    const item = (await res.json()) as WorkItemView;
    const { assignment } = item;
    expect(assignment).toMatchObject({ agent: "agent-1", by: "lead", name: `${item.shortId}-${assignment!.id.slice(0, 8)}` });
    expect(item).toMatchObject({ status: "in_progress", heldBy: assignment!.name, queuePosition: null });
    expect(agents.made).toEqual([{ name: assignment!.name, label: "ticket: Fix it", item: item.id, brief: expect.stringContaining(`https://ui.example/items/${item.shortId}`) }]);
    expect(agents.made[0]!.brief).toContain("It is yours: it reads in_progress, held by you.");
    expect(await read(id)).toMatchObject({ assignment });
  });

  it("makes one agent for two starts at once, refusing the second with 409 naming it", async () => {
    const id = await task();
    const [a, b] = await Promise.all([start(id), start(id)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const refused = (await (a.status === 409 ? a : b).json()) as { error: string; assignment: { name: string } };
    expect(agents.made).toHaveLength(1);
    expect(refused.assignment.name).toBe(agents.made[0]!.name);
    expect(refused.error).toContain(agents.made[0]!.name);
  });

  it("refuses a start while the agent is live, even stopped in review, naming it", async () => {
    const id = await task();
    await start(id);
    for (const [state, status] of [["working", "working"], ["idle", "review"], ["interrupted", null]] as const) {
      Object.assign(agents.agents[0]!, { state, status });
      const res = await start(id);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ assignment: { agent: "agent-1", name: agents.made[0]!.name } });
    }
    expect(agents.made).toHaveLength(1);
  });

  it("starts again once the agent is stopped done or retired, with a new assignment", async () => {
    const id = await task();
    const first = ((await (await start(id)).json()) as WorkItemView).assignment!;
    Object.assign(agents.agents[0]!, { state: "idle", status: "done" });
    const second = ((await (await start(id)).json()) as WorkItemView).assignment!;
    expect(second.id).not.toBe(first.id);
    agents.agents[1]!.state = "retired";
    expect((await start(id)).status).toBe(201);
    expect(agents.made).toHaveLength(3);
  });

  it("assigns a parent, leaving its derived status and taking what is queued beneath it off the queue", async () => {
    const leaf = await task();
    await store.update(leaf, { queued: true });
    const res = await start(story);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: "ready", heldBy: null, assignment: { agent: "agent-1" } });
    expect(agents.made[0]!.brief).toContain("Everything beneath it is yours too");
    expect(await read(leaf)).toMatchObject({ status: "ready", queuedAt: null });
    const unqueued = (await store.history(leaf))!.at(-1)!;
    expect(unqueued).toMatchObject({ item: leaf, changes: [{ field: "queuedAt", to: null }] });
    expect((await store.history(story))!.filter((entry) => entry.item === leaf).at(-1)).toEqual(unqueued);
    expect((await start(story)).status).toBe(409);
    expect(agents.made).toHaveLength(1);
  });

  it("puts the item back as it was when worker-service makes no agent, in its words", async () => {
    const id = await task();
    const leaf = await task();
    await store.update(id, { queued: true });
    await store.update(leaf, { queued: true });
    const before = await read(id);
    agents.next = "refuse";
    const res = await start(id);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "worker-service answered 503 to POST /fleet/workers: no connected host has room" });
    const after = await read(id);
    expect({ ...after, updatedAt: before.updatedAt }).toEqual(before);
    expect((await read(leaf)).queuePosition).not.toBeNull();
  });

  it("puts a parent's queue back too when worker-service makes no agent", async () => {
    const leaf = await task();
    await store.update(leaf, { queued: true });
    agents.next = "refuse";
    expect((await start(story)).status).toBe(502);
    expect(await read(leaf)).toMatchObject({ queuePosition: 1 });
    expect((await read(story)).assignment).toBeNull();
  });

  it("finds the agent already made when its answer was lost, rather than making another", async () => {
    const id = await task();
    agents.next = "lose";
    const res = await start(id);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ assignment: { agent: "agent-1" } });
    expect(agents.made).toHaveLength(1);
  });

  it("finds by name the agent a request that died made, and refuses a retry naming it", async () => {
    const id = await task();
    const { item } = (await store.assign(id, { id: "0b1c2d3e-0000-4000-8000-000000000000", agent: null, name: "x-0b1c2d3e", by: null, at: new Date(now).toISOString(), ended: null }, null))!;
    agents.agents.push({ id: "agent-9", name: item.assignment!.name, state: "working", status: "working" });
    now += STALE_AFTER_MS * 2;
    const res = await start(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ assignment: { agent: "agent-9" } });
    expect((await read(id)).assignment!.agent).toBe("agent-9");
    expect(agents.made).toHaveLength(0);
  });

  it("refuses a start while another is still making its agent, and replaces it once that one is stale and made nothing", async () => {
    const id = await task();
    await store.assign(id, { id: "0b1c2d3e-0000-4000-8000-000000000000", agent: null, name: "x-0b1c2d3e", by: null, at: new Date(now).toISOString(), ended: null }, null);
    const res = await start(id);
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("being started on x-0b1c2d3e") });
    now += STALE_AFTER_MS;
    expect((await start(id)).status).toBe(201);
    expect(agents.made).toHaveLength(1);
  });

  it("refuses a blocked leaf with 409 and a closed item with 400, making nothing", async () => {
    const dependency = await task();
    const blocked = await task({ dependsOn: [dependency] });
    const res = await start(blocked);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ blockedBy: [dependency] });
    await store.update(dependency, { state: "closed", closedReason: "not_planned" });
    expect((await start(dependency)).status).toBe(400);
    expect(agents.made).toHaveLength(0);
    expect((await read(blocked)).assignment).toBeNull();
  });

  it("refuses a parent with 409 naming each blocking item, its own, an ancestor's or a child's, making nothing", async () => {
    const graph = await store.graph();
    const epic = graph.get(story)!.parent!;
    const own = (await store.create(draft({ type: "story", title: "Own", parent: epic }))).id;
    const above = (await store.create(draft({ type: "epic", title: "Other" }))).id;
    const below = (await store.create(draft({ type: "epic", title: "Elsewhere" }))).id;
    await store.update(story, { dependsOn: [own] });
    await store.update(epic, { dependsOn: [above] });
    // A child's dependency outside its parent is possible only as stored before the sibling rule.
    store.depend(await task(), [below]);
    const res = await start(story);
    expect(res.status).toBe(409);
    const refused = (await res.json()) as { error: string; blockedBy: string[] };
    expect(refused.blockedBy.sort()).toEqual([own, above, below].sort());
    expect(refused.error).toContain('"Other"');
    expect((await start(epic)).status).toBe(409);
    expect(agents.made).toHaveLength(0);
    expect((await read(story)).assignment).toBeNull();
    expect((await read(epic)).assignment).toBeNull();
  });

  it("assigns a parent already started though a dependency was added since", async () => {
    const leaf = await task();
    await store.update(leaf, { status: "in_progress" });
    const epic = (await store.graph()).get(story)!.parent!;
    const later = (await store.create(draft({ type: "story", title: "Later", parent: epic }))).id;
    await store.update(story, { dependsOn: [later] });
    expect((await start(story)).status).toBe(201);
    expect(agents.made).toHaveLength(1);
  });

  it("answers 404 for no such item and 503 where worker-service is not configured", async () => {
    expect((await start("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const bare = new WorkTrackerApi(store, singleToken(TOKEN));
    const res = await bare.fetch(new Request(`http://local/items/${await task()}/assignment`, { method: "POST", headers }));
    expect(res.status).toBe(503);
  });
});

describe("closing an assigned item", () => {
  const patch = (id: string, body: object, by?: string) =>
    api.fetch(
      new Request(`http://local/items/${id}`, {
        method: "PATCH",
        headers: { ...headers, ...(by && { "claimed-by": by }) },
        body: JSON.stringify(body),
      }),
    );
  const close = (id: string, closedReason = "completed", by?: string) => patch(id, { state: "closed", closedReason }, by);

  const signedOffEpic = async () => {
    const epic = (await store.create(draft({ type: "epic", title: "Big" }))).id;
    await store.create(draft({ type: "story", title: "Part", parent: epic }));
    await start(epic);
    return epic;
  };

  it("ends its assignment, recorded in its history, retiring nothing, and a new start makes a new one", async () => {
    const id = await task();
    const first = ((await (await start(id)).json()) as WorkItemView).assignment!;
    const res = await close(id, "not_planned", "agent-6");
    const closed = (await res.json()) as WorkItemView & { agent?: unknown };
    expect(closed.agent).toBeUndefined();
    expect(closed.assignment).toEqual({ ...first, ended: { at: closed.updatedAt, why: "the item was closed as not_planned" } });
    const change = (await store.history(id))!.at(-1)!.changes.find((each) => each.field === "assignment");
    expect(change).toMatchObject({ from: { ended: null }, to: { ended: { why: "the item was closed as not_planned" } } });
    expect(agents.retired).toEqual([]);

    await patch(id, { state: "open", status: "ready" });
    expect((await read(id)).assignment!.ended).not.toBeNull();
    const second = ((await (await start(id)).json()) as WorkItemView).assignment!;
    expect(second).toMatchObject({ ended: null, agent: "agent-2" });
  });

  it("ends the assignment of each item a parent's close closes", async () => {
    const id = await task();
    await start(id);
    await close(story, "not_planned", "agent-6");
    expect((await read(id)).assignment!.ended).toMatchObject({ why: expect.stringMatching(/above it was closed as not_planned/) });
  });

  it("retires the epic's agent, by the assignment's agent id, on the person's sign-off", async () => {
    const epic = await signedOffEpic();
    const res = await close(epic);
    expect(res.status).toBe(200);
    const { agent, state, assignment } = (await res.json()) as WorkItemView & { agent: unknown };
    expect(state).toBe("closed");
    expect(assignment!.ended).not.toBeNull();
    expect(agent).toEqual({ id: "agent-1", name: agents.made[0]!.name, outcome: "retired", said: `Retired ${agents.made[0]!.name}.` });
    expect(agents.retired).toEqual(["agent-1"]);
  });

  it("leaves the epic closed when worker-service refuses the retire, saying so in its words", async () => {
    const epic = await signedOffEpic();
    agents.refuseRetire = "worker-service answered 409 retiring agent-1: it is busy";
    const { agent, state } = (await (await close(epic)).json()) as WorkItemView & { agent: { outcome: string; said: string } };
    expect(state).toBe("closed");
    expect(agent).toMatchObject({ outcome: "refused", said: expect.stringContaining("it is busy") });
  });

  it("retires nothing, and says so, when the epic's agent is already retired or unknown", async () => {
    const epic = await signedOffEpic();
    agents.agents[0]!.state = "retired";
    const { agent } = (await (await close(epic)).json()) as WorkItemView & { agent: { outcome: string; said: string } };
    expect(agent).toMatchObject({ outcome: "already_retired", said: expect.stringContaining("already retired") });
    expect(agents.retired).toEqual([]);
  });
});

describe("FleetClient as Agents", () => {
  const client = (answer: (url: string, init: RequestInit) => Response) => {
    const calls: [string, RequestInit][] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return answer(url, init);
    }) as typeof globalThis.fetch;
    return { calls, agents: new FleetClient("https://ws.example/", "k", fetch) };
  };

  it("makes an agent stopped once done, with the tickets document", async () => {
    const { calls, agents } = client(() => Response.json({ id: "a", name: "n", state: "working", status: null }, { status: 201 }));
    await agents.make({ name: "n", label: "ticket: x", brief: "b", item: "i-1" });
    expect(calls[0]![0]).toBe("https://ws.example/fleet/workers");
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ name: "n", label: "ticket: x", brief: "b", item: "i-1", whenDone: "stop", documents: ["tickets"] });
  });

  it("says a refusal with worker-service's status and words", async () => {
    const { agents } = client(() => Response.json({ error: "Host h is full." }, { status: 409 }));
    await expect(agents.make({ name: "n", label: "l", brief: "b", item: "i-1" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Host h is full.") });
  });

  it("says a refused retire in worker-service's words", async () => {
    const { agents } = client(() => Response.json({ error: "Session is busy." }, { status: 409 }));
    await expect(agents.retire("a")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Session is busy.") });
  });

  it("reads null for an agent worker-service does not have, and finds one by name among those not retired", async () => {
    expect(await client(() => Response.json({ error: "Not found." }, { status: 404 })).agents.get("x")).toBeNull();
    const { agents, calls } = client(() =>
      Response.json({ workers: [{ id: "1", name: "n", state: "retired" }, { id: "2", name: "n", state: "idle" }] }),
    );
    expect(await agents.named("n")).toMatchObject({ id: "2" });
    expect(calls[0]![0]).toBe("https://ws.example/fleet/workers?createdBy=work-tracker");
  });

  it("asks for an implementer for the item, in the role's documents and whenDone", async () => {
    const { calls, agents } = client(() => Response.json({ id: "r", state: "waiting", why: null, workerId: null, createdAt: "x" }, { status: 201 }));
    expect(await agents.request({ label: "ticket: x", brief: "b", item: "i-1" })).toMatchObject({ id: "r", state: "waiting" });
    expect(calls[0]![0]).toBe("https://ws.example/fleet/requests");
    expect(calls[0]![1]).toMatchObject({ method: "POST", headers: { "claimed-by": "work-tracker" } });
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ role: "implementer", label: "ticket: x", brief: "b", item: "i-1" });
  });

  it("reads null for a request worker-service does not have, and lists every one it made for an item", async () => {
    expect(await client(() => Response.json({ error: "Not found." }, { status: 404 })).agents.requestOf("x")).toBeNull();
    const { agents, calls } = client(() => Response.json({ requests: [{ id: "r" }] }));
    expect(await agents.requestsFor("i-1")).toEqual([{ id: "r" }]);
    expect(calls[0]![0]).toBe("https://ws.example/fleet/requests?all=true&item=i-1&requester=work-tracker");
  });
});
