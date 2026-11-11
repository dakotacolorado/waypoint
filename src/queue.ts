import type { z } from "@hono/zod-openapi";
import { requestedName, STALE_AFTER_MS, type Agent, type AgentRequest, type Agents } from "./assignment.ts";
import { DEFAULT_LIMIT, MAX_LIMIT, type Graph, type Status, type WorkItemView } from "./domain.ts";
import type { LastRunSchema, QueueItemSchema, QueueSchema, QueuedSchema, RunningSchema } from "./schema.ts";

/** The `claimed-by` of the queue's assignments, by which it knows the items it started. */
export const QUEUE = "work-tracker-queue";

export { DEFAULT_LIMIT, MAX_LIMIT };

/** A started item reading one of these has handed its work on, and frees its running place. */
const FREED: readonly Status[] = ["review", "done"];

export type Queue = z.infer<typeof QueueSchema>;
export type LastRun = z.infer<typeof LastRunSchema>;
export type Running = z.infer<typeof RunningSchema>;
export type Queued = z.infer<typeof QueuedSchema>;
type QueueItem = z.infer<typeof QueueItemSchema>;

export interface QueueSettings {
  limit: number;
  last: LastRun | null;
}

const ref = (item: WorkItemView): QueueItem => ({ id: item.id, shortId: item.shortId, title: item.title, status: item.status });

/** Whatever the queue started that may still hold a place: open, not yet in review or done, its assignment not ended. */
export const startedByQueue = (graph: Graph): WorkItemView[] =>
  graph
    .views()
    .filter((item) => item.assignment?.by === QUEUE && !item.assignment.ended && item.state === "open" && !FREED.includes(item.status))
    .sort((a, b) => a.assignment!.at.localeCompare(b.assignment!.at));

/** Where a started item stands: its agent running, its request still waiting, or holding nothing. */
export type Standing =
  | { running: Running }
  | { requested: Queued }
  | { free: true };

/**
 * `recover` finds a request whose id the item's assignment has not recorded yet;
 * without it such an assignment is taken as still being requested. A start
 * worker-service cannot be asked about holds its place, so a fault never runs more than the limit.
 */
export async function standing(
  item: WorkItemView,
  fleet: Pick<Agents, "get" | "requestOf">,
  now: number,
  recover?: (item: WorkItemView) => Promise<AgentRequest | null>,
): Promise<Standing> {
  const assignment = item.assignment!;
  const requested = (request: { id: string; name: string } | null, why: string): Standing => ({
    requested: { item: ref(item), position: null, state: "requested", blockedBy: [], request: request && { ...request, why } },
  });
  let agent = assignment.agent;
  let name = assignment.name;
  if (agent === null) {
    const found = recover ? await recover(item).catch(() => null) : null;
    if (!found) {
      if (recover && now - Date.parse(assignment.at) >= STALE_AFTER_MS) return { free: true };
      return requested(null, `${item.shortId} is being requested`);
    }
    agent = found.id;
    name = requestedName(found.id);
  }
  const running = (state: Agent["state"] | "unknown"): Standing => ({
    running: { item: ref(item), agent: { id: agent, name, state }, startedAt: assignment.at },
  });
  try {
    const worker = await fleet.get(agent);
    if (worker) return worker.state === "retired" ? { free: true } : running(worker.state);
    const request = await fleet.requestOf(agent);
    if (request?.state !== "waiting") return { free: true };
    return requested({ id: request.id, name }, request.why ?? "worker-service has not looked at it yet");
  } catch {
    return running("unknown");
  }
}

/** The queue as `GET /queue` serves it, and as the dispatcher counts its running places. */
export async function queueOf(
  graph: Graph,
  settings: QueueSettings,
  fleet: Pick<Agents, "get" | "requestOf">,
  now: number,
  recover?: (item: WorkItemView) => Promise<AgentRequest | null>,
): Promise<Queue> {
  const standings = await Promise.all(startedByQueue(graph).map((item) => standing(item, fleet, now, recover)));
  const running = standings.flatMap((each) => ("running" in each ? [each.running] : []));
  const requested = standings.flatMap((each) => ("requested" in each ? [each.requested] : []));
  const waiting = graph.queue().map((id): Queued => {
    const item = graph.view(graph.get(id)!);
    const blockedBy = item.blockedBy.map((each) => ref(graph.view(graph.get(each)!)));
    return { item: ref(item), position: item.queuePosition, state: blockedBy.length ? "blocked" : "next", blockedBy, request: null };
  });
  return { limit: settings.limit, running, queued: [...requested, ...waiting], last: settings.last };
}

/** Running places taken: by agents running, and by requests still waiting to start one. */
export const taken = (queue: Queue): number => queue.running.length + queue.queued.filter((each) => each.state === "requested").length;
