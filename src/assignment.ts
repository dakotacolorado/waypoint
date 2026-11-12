import { randomUUID } from "node:crypto";
import type { z } from "@hono/zod-openapi";
import { type Assignment, type WorkItemView } from "./domain.ts";
import type { AgentOutcomeSchema } from "./schema.ts";
import { AssignedError, type WorkItemStore } from "./store.ts";

/** What every agent started on an item gets beside `global`. */
export const TICKET_DOCUMENT = "tickets";

/** worker-service's role for an agent started on an item: the queue asks for one in it. */
export const IMPLEMENTER = "implementer";

/** What worker-service names the worker a request starts, by the request's id, which is also the worker's. */
export const requestedName = (request: string) => `${IMPLEMENTER}-${request.slice(0, 8)}`;

/**
 * How much earlier than its assignment, by this service's clock, worker-service
 * may date a request made for it: the two clocks are not the same.
 */
const CLOCK_SKEW_MS = 5_000;

/** worker-service's longest label. */
const LABEL_LIMIT = 40;

/**
 * Longer than a start waits on worker-service, so an assignment whose agent is
 * still unrecorded after this is from a request that died, not one still running.
 */
export const STALE_AFTER_MS = 60_000;

/** An agent as worker-service reads it. */
export interface Agent {
  id: string;
  name: string;
  state: "idle" | "working" | "waiting" | "interrupted" | "retired";
  status: "working" | "idle" | "waiting" | "review" | "done" | null;
}

export interface NewAgent {
  name: string;
  label: string;
  brief: string;
  /** The item's id, kept on the agent so what it used can be found by item. */
  item: string;
}

export interface NewRequest {
  label: string;
  brief: string;
  item: string;
}

/** A request for an agent, as worker-service reads it: its id becomes the agent's once admitted. */
export interface AgentRequest {
  id: string;
  state: "waiting" | "started" | "withdrawn";
  /** While waiting, why, as worker-service last found. */
  why: string | null;
  workerId: string | null;
  createdAt: string;
}

/** worker-service's refusal, in its words, with the status it answered. */
export class AgentRefusedError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** What an assignment reads of worker-service and asks of it. */
export interface Agents {
  /** Null when worker-service has none with that id. */
  get(id: string): Promise<Agent | null>;
  /** The agent not retired that this service made with `name`; null for none. */
  named(name: string): Promise<Agent | null>;
  /** Throws AgentRefusedError when none was made. */
  make(agent: NewAgent): Promise<Agent>;
  /** Throws AgentRefusedError when worker-service refuses. */
  retire(id: string): Promise<void>;
  /** Asks for an agent in `IMPLEMENTER`, started when worker-service admits it; throws AgentRefusedError when refused. */
  request(request: NewRequest): Promise<AgentRequest>;
  /** Null when worker-service has none with that id. */
  requestOf(id: string): Promise<AgentRequest | null>;
  /** Every request this service made for the item, withdrawn and started ones too. */
  requestsFor(item: string): Promise<AgentRequest[]>;
}

export type AgentOutcome = z.infer<typeof AgentOutcomeSchema>;

/** Holds its item until retired, or stopped after saying it is done; one stopped in `review` is started again by a send-back. */
export const live = (agent: Agent | null): agent is Agent =>
  agent !== null && agent.state !== "retired" && !(agent.status === "done" && agent.state === "idle");

export const label = (item: WorkItemView) => {
  const text = `ticket: ${item.title.trim()}`;
  return [...text].length <= LABEL_LIMIT ? text : `${[...text].slice(0, LABEL_LIMIT - 1).join("").trimEnd()}…`;
};

/** The agent's name: the item's, then the assignment's, so a retry of one assignment names the same agent. */
export const agentName = (item: WorkItemView, assignment: string) => `${item.shortId}-${assignment.slice(0, 8)}`;

/** The agent's first message: its item, that it is the only work this session is for, and how it ends. */
export const brief = (item: WorkItemView, link: string): string =>
  [
    `You are started on the work tracker's ${item.type} "${item.title}" (id ${item.id}): ${link}`,
    "This item is the only work this session is for: do not pick up anything else from the backlog or the queue.",
    "Read it with the work-tracker skill, with its parent and children, and see it through as the tracker's conventions say.",
    item.children.length
      ? "Its status follows its children: move them as the work moves. Everything beneath it is yours too: the queue does not start any of it on an agent of its own."
      : "It is yours: it reads in_progress, held by you.",
    "Once you hand it back for review (moved to review, its PR open), use the page skill to say review, with a one-line result: your session then ends, and a message (a send-back from approval-service, or the person) starts it again.",
    item.type === "epic"
      ? "The epic is closed by the person alone, from its review panel, never by you. Do not ask for its sign-off while anything beneath it is open and not done (finish it, or close it not_planned with the reason on its work log) or while any of its PRs is still with approval-service (page review then). Once every child reads done, use the page skill to say waiting, in one line naming the epic by its short id, that it is ready for sign-off."
      : "Once it is done, use the page skill to say done: your session then ends.",
  ].join("\n\n");

/** Starts an agent on an item: assigns it first, so no second start can, then has worker-service make the agent. */
export class Assigner {
  private readonly store: WorkItemStore;
  private readonly agents: Agents;
  private readonly ui: string;
  private readonly now: () => number;

  constructor(store: WorkItemStore, agents: Agents, ui: string, now: () => number = Date.now) {
    this.store = store;
    this.agents = agents;
    this.ui = ui;
    this.now = now;
  }

  /**
   * The item, its assignment naming the agent; null when no item has that id.
   * Throws AssignedError while a live agent holds it, BlockedError or GraphError
   * as the move would, and AgentRefusedError when worker-service makes none.
   */
  start(ref: string, by: string | null): Promise<WorkItemView | null> {
    return this.begin(ref, by, async (item, assignment) => {
      const agent = await this.makeAgent({ name: assignment.name, ...this.briefing(item) });
      return { agent: agent.id, name: assignment.name };
    });
  }

  /**
   * As `start`, but asks worker-service for an agent in `IMPLEMENTER`, which it
   * starts when its usage and hosts allow: the item is held at once by the
   * request's id and the name its agent will have.
   */
  async request(ref: string, by: string | null): Promise<{ item: WorkItemView; request: AgentRequest } | null> {
    let request: AgentRequest | undefined;
    const item = await this.begin(ref, by, async (item, assignment) => {
      request = await this.requestAgent(item, assignment);
      return { agent: request.id, name: requestedName(request.id) };
    });
    return item && { item, request: request! };
  }

  private async begin(
    ref: string,
    by: string | null,
    starter: (item: WorkItemView, assignment: Assignment) => Promise<{ agent: string; name: string }>,
  ): Promise<WorkItemView | null> {
    const graph = await this.store.graph();
    const found = graph.get(graph.resolve(ref));
    if (!found) return null;
    const item = graph.view(found);
    const replacing = await this.check(item);

    const id = randomUUID();
    const assignment: Assignment = { id, agent: null, name: agentName(item, id), by, at: new Date(this.now()).toISOString(), ended: null };
    const assigned = await this.store.assign(item.id, assignment, replacing);
    if (!assigned) return null;

    let started: { agent: string; name: string };
    try {
      started = await starter(item, assignment);
    } catch (err) {
      await this.store.unassign(assigned.before, assignment);
      throw err;
    }
    await this.store.recordAgent(item.id, id, started.agent, started.name);
    const after = await this.store.graph();
    return after.view(after.get(item.id)!);
  }

  private briefing(item: WorkItemView): { label: string; brief: string; item: string } {
    return { label: label(item), item: item.id, brief: brief(item, `${this.ui}/items/${item.shortId}`) };
  }

  /**
   * The request this service made for `assignment`, found by its item and its
   * date, and recorded on it; null for none. A request answered on the way
   * back, or by an attempt that died before it wrote the id, is found so.
   */
  async recover(item: WorkItemView, assignment: Assignment): Promise<AgentRequest | null> {
    const since = Date.parse(assignment.at) - CLOCK_SKEW_MS;
    const requests = await this.agents.requestsFor(item.id);
    const request = requests.find((each) => each.state !== "withdrawn" && Date.parse(each.createdAt) >= since) ?? null;
    if (request) await this.store.recordAgent(item.id, assignment.id, request.id, requestedName(request.id));
    return request;
  }

  /**
   * Retires the agent `assignment` names, as the person's sign-off of its epic
   * does; what was done, never a throw, since the close it follows stands.
   */
  async retire(assignment: Assignment & { agent: string }): Promise<AgentOutcome> {
    const { agent: id, name } = assignment;
    try {
      const agent = await this.agents.get(id);
      if (!agent || agent.state === "retired") {
        return { id, name, outcome: "already_retired", said: `${name} was already retired: nothing was retired.` };
      }
      await this.agents.retire(id);
      return { id, name, outcome: "retired", said: `Retired ${name}.` };
    } catch (err) {
      return { id, name, outcome: "refused", said: `${name} was not retired: ${(err as Error).message}` };
    }
  }

  /** The id of the item's assignment, once it is found to hold nothing; throws AssignedError while it does. */
  private async check(item: WorkItemView): Promise<string | null> {
    const there = item.assignment;
    if (!there) return null;
    if (there.ended) return there.id;
    if (there.agent !== null) {
      await this.holds(item, there, there.agent);
      return there.id;
    }
    // Unrecorded: being made by another request, or made by one that died before it wrote the id.
    const agent = await this.agents.named(there.name);
    if (agent) {
      const recorded = await this.store.recordAgent(item.id, there.id, agent.id);
      const assignment = recorded?.assignment ?? { ...there, agent: agent.id };
      if (live(agent)) throw new AssignedError(`${item.shortId} is held by ${there.name}, which is ${agent.state}: open its chat`, assignment);
      return there.id;
    }
    const request = await this.recover(item, there);
    if (request) {
      await this.holds(item, { ...there, agent: request.id, name: requestedName(request.id) }, request.id);
      return there.id;
    }
    if (this.now() - Date.parse(there.at) < STALE_AFTER_MS) {
      throw new AssignedError(`${item.shortId} is being started on ${there.name}: open its chat in a moment`, there);
    }
    return there.id;
  }

  /** Throws AssignedError while the agent `id`, or the request of that id still waiting to start it, holds the item. */
  private async holds(item: WorkItemView, there: Assignment, id: string): Promise<void> {
    const agent = await this.agents.get(id);
    if (live(agent)) throw new AssignedError(`${item.shortId} is held by ${there.name}, which is ${agent.state}: open its chat`, there);
    if (agent) return;
    const request = await this.agents.requestOf(id);
    if (request?.state === "waiting") {
      throw new AssignedError(`${item.shortId} is held by ${there.name}, which worker-service has not started yet: ${request.why ?? "it has not looked yet"}`, there);
    }
  }

  /**
   * After any failure the agent is looked for by name: worker-service's 409 for
   * a name taken, or an answer lost on the way, can follow an agent made.
   */
  private async makeAgent(agent: NewAgent): Promise<Agent> {
    try {
      return await this.agents.make(agent);
    } catch (err) {
      const made = await this.agents.named(agent.name).catch(() => null);
      if (made) return made;
      throw err instanceof AgentRefusedError ? err : new AgentRefusedError(`could not reach worker-service: ${(err as Error).message}`, 0);
    }
  }

  /** As `makeAgent`, the request looked for by its item after any failure. */
  private async requestAgent(item: WorkItemView, assignment: Assignment): Promise<AgentRequest> {
    try {
      return await this.agents.request(this.briefing(item));
    } catch (err) {
      const made = await this.recover(item, assignment).catch(() => null);
      if (made) return made;
      throw err instanceof AgentRefusedError ? err : new AgentRefusedError(`could not reach worker-service: ${(err as Error).message}`, 0);
    }
  }
}
