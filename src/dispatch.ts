import {
  AgentRefusedError,
  Assigner,
  IMPLEMENTER,
  TICKET_DOCUMENT,
  type Agent,
  type AgentRequest,
  type Agents,
  type NewAgent,
  type NewRequest,
} from "./assignment.ts";
import type { WorkItemView } from "./domain.ts";
import { QUEUE, queueOf, taken, type LastRun, type Queue } from "./queue.ts";
import { AssignedError, type WorkItemStore } from "./store.ts";

/** Recorded as `createdBy` on each worker, and `requester` on each request, this service makes, so it can list its own. */
export const CREATED_BY = "work-tracker";

export { QUEUE };

/** The first queued item nothing holds up; a blocked one keeps its place. */
export const nextQueued = (queue: WorkItemView[]): WorkItemView | undefined => queue.find((item) => !item.blockedBy.length);

export type Dispatched = Omit<LastRun, "at"> & {
  /** Items whose assignment this run ended, its agent being retired: present only when there were some. */
  released?: string[];
};

/**
 * Asks worker-service for an implementer for each unblocked queued item, up to
 * the queue's running limit: worker-service decides, by its usage and hosts, when each starts.
 */
export class Dispatcher {
  private readonly store: WorkItemStore;
  private readonly fleet: Pick<Agents, "get" | "requestOf">;
  private readonly assigner: Assigner;
  private readonly now: () => number;

  constructor(store: WorkItemStore, fleet: Pick<Agents, "get" | "requestOf">, assigner: Assigner, now: () => number = Date.now) {
    this.store = store;
    this.fleet = fleet;
    this.assigner = assigner;
    this.now = now;
  }

  /** Stores what it decided as the queue's `last`, so the person can see why the queue is or is not moving. */
  async run(): Promise<Dispatched> {
    const released = await this.release();
    const dispatched = await this.dispatch();
    await this.store.recordQueueRun({ at: new Date(this.now()).toISOString(), ...dispatched });
    return released.length ? { ...dispatched, released } : dispatched;
  }

  /**
   * Ends each standing assignment whose agent worker-service says is retired,
   * or has no record of, nor a request of that id still waiting; one it cannot
   * be asked about is left for the next run.
   */
  private async release(): Promise<string[]> {
    const graph = await this.store.graph();
    const standing = graph.views().filter((item) => item.assignment?.agent && !item.assignment.ended);
    const released: string[] = [];
    for (const item of standing) {
      const { id, agent, name } = item.assignment!;
      const why = await this.gone(agent!, name).catch(() => null);
      if (why === null) continue;
      await this.store.endAssignment(item.id, id, why, CREATED_BY);
      released.push(item.id);
    }
    return released;
  }

  /** Why the agent `id` no longer holds its item; null while it, or the request of that id, may. */
  private async gone(id: string, name: string): Promise<string | null> {
    const agent = await this.fleet.get(id);
    if (agent) return agent.state === "retired" ? `its agent ${name} was retired` : null;
    const request = await this.fleet.requestOf(id);
    if (request?.state === "waiting") return null;
    return request?.state === "withdrawn" ? `its request for ${name} was withdrawn` : `its agent ${name} is unknown to worker-service`;
  }

  /** Why each running place is taken, as `queueOf` counts them. */
  private static holding(queue: Queue): string[] {
    return [
      ...queue.running.map(({ item, agent }) => `${agent.name}, which the queue started on ${item.shortId}, is ${agent.state} and ${item.shortId} reads ${item.status}`),
      ...queue.queued
        .filter((each) => each.state === "requested")
        .map(({ item, request }) =>
          request
            ? `the queue's request for ${item.shortId} (${request.name}) is waiting: ${request.why}`
            : `${item.shortId} is being requested`,
        ),
    ];
  }

  /**
   * Requests an implementer for each queued item nothing holds up, in order,
   * while fewer than the limit's places are taken; a blocked one keeps its place.
   * The queue is read again after each request, since an epic's takes what is queued beneath it off the queue.
   */
  private async dispatch(): Promise<Dispatched> {
    let graph = await this.store.graph();
    if (!graph.queue().length) return { requested: [], why: ["the queue is empty"] };
    const queue = await queueOf(graph, await this.store.queueSettings(), this.fleet, this.now(), (item) =>
      this.assigner.recover(item, item.assignment!),
    );
    let free = queue.limit - taken(queue);
    const requested: Dispatched["requested"] = [];
    const why: string[] = [];
    const tried = new Set<string>();
    for (;;) {
      const left = graph.queue().filter((id) => !tried.has(id)).map((id) => graph.view(graph.get(id)!));
      if (!left.length) return { requested, why: requested.length || why.length ? why : ["the queue is empty"] };
      if (free <= 0) {
        return { requested, why: [...why, `${queue.limit - free} of ${queue.limit} running places are taken`, ...Dispatcher.holding(queue)] };
      }
      const item = nextQueued(left);
      if (!item) return { requested, why: [...why, `every queued item ${tried.size ? "left " : ""}is blocked: ${left.map((each) => each.shortId).join(", ")}`] };
      tried.add(item.id);
      try {
        const made = await this.assigner.request(item.id, QUEUE);
        if (made) {
          const { request } = made;
          requested.push({ item: item.id, shortId: item.shortId, request: request.id, worker: made.item.assignment!.name, state: request.state, why: request.why });
          free--;
        }
      } catch (err) {
        if (err instanceof AssignedError) {
          // Someone started it after it was queued: it is theirs, and leaves the queue.
          await this.store.update(item.id, { queued: false }, QUEUE);
          why.push(`${err.message}; taken off the queue`);
        } else if (err instanceof AgentRefusedError) {
          return { requested, why: [...why, err.message] };
        } else throw err;
      }
      graph = await this.store.graph();
    }
  }
}

/** Under `STALE_AFTER_MS`, so a start whose call hangs is given up before its assignment reads as dead. */
const CALL_TIMEOUT_MS = 30_000;

/** worker-service over HTTP, as `CREATED_BY`. */
export class FleetClient implements Agents {
  private readonly url: string;
  private readonly token: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(url: string, token: string, fetch: typeof globalThis.fetch = globalThis.fetch) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetch;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.token;
    const res = await this.fetch(`${this.url}${path}`, {
      ...init,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "claimed-by": CREATED_BY },
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || body === null) {
      throw new AgentRefusedError(`worker-service answered ${res.status} to ${init.method ?? "GET"} ${path}${body?.error ? `: ${body.error}` : ""}`, res.status);
    }
    return body;
  }

  async get(id: string): Promise<Agent | null> {
    try {
      return await this.call<Agent>(`/fleet/workers/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof AgentRefusedError && err.status === 404) return null;
      throw err;
    }
  }

  async named(name: string): Promise<Agent | null> {
    const { workers } = await this.call<{ workers: Agent[] }>(`/fleet/workers?createdBy=${CREATED_BY}`);
    return workers.find((worker) => worker.name === name && worker.state !== "retired") ?? null;
  }

  /** Stopped, not retired, once it says done: the person can still read it, and message it if more is needed. */
  make({ name, label, brief, item }: NewAgent): Promise<Agent> {
    return this.call<Agent>("/fleet/workers", {
      method: "POST",
      body: JSON.stringify({ name, label, brief, item, whenDone: "stop", documents: [TICKET_DOCUMENT] }),
    });
  }

  request({ label, brief, item }: NewRequest): Promise<AgentRequest> {
    return this.call<AgentRequest>("/fleet/requests", { method: "POST", body: JSON.stringify({ role: IMPLEMENTER, label, brief, item }) });
  }

  async requestOf(id: string): Promise<AgentRequest | null> {
    try {
      return await this.call<AgentRequest>(`/fleet/requests/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof AgentRefusedError && err.status === 404) return null;
      throw err;
    }
  }

  async requestsFor(item: string): Promise<AgentRequest[]> {
    const query = new URLSearchParams({ all: "true", item, requester: CREATED_BY });
    return (await this.call<{ requests: AgentRequest[] }>(`/fleet/requests?${query}`)).requests;
  }

  async retire(id: string): Promise<void> {
    const token = this.token;
    const res = await this.fetch(`${this.url}/fleet/workers/${id}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}`, "claimed-by": CREATED_BY },
    });
    if (res.ok || res.status === 404) return;
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new AgentRefusedError(`worker-service answered ${res.status} retiring ${id}${body?.error ? `: ${body.error}` : ""}`, res.status);
  }
}

/** worker-service's address and token: the dispatcher's, and the Start button's, only when both are given. */
export interface WorkersConfig {
  url: string;
  token: string;
}
