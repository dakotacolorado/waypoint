import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import type { Auth, Caller } from "./auth.ts";
import { HTTPException } from "hono/http-exception";
import { type Assignment, AmbiguousIdError, BlockedError, ForbiddenError, GraphError, note, type Note } from "./domain.ts";
import * as routes from "./schema.ts";
import { readSkill, SKILL_DIR, type Skill } from "./skill.ts";
import { AgentRefusedError, Assigner, type AgentOutcome, type Agents } from "./assignment.ts";
import { queueOf } from "./queue.ts";
import { AssignedError, ConflictError, type WorkItemStore } from "./store.ts";
import { TagTakenError } from "./tags.ts";

export const SPEC_PATH = "/openapi.json";

export interface ApiOptions {
  /** What `/health` says this copy is. */
  about?: { version: string; commit: string };
  /** What `GET /skill` serves. */
  skill?: () => Skill;
  /**
   * `assigner` and `fleet` are made on first use, so a server without worker-service's address still serves
   * everything else; there starting an agent answers 503, and the queue reads each agent's state as `unknown`.
   */
  assigner?: () => Assigner;
  fleet?: () => Pick<Agents, "get" | "requestOf">;
}

export class WorkTrackerApi {
  readonly hono: OpenAPIHono<{ Variables: { caller: Caller } }>;

  private readonly store: WorkItemStore;
  private readonly auth: Auth;
  private readonly about: { version: string; commit: string };
  private readonly skill: () => Skill;
  private readonly assigner: () => Assigner;
  private readonly fleet: Pick<Agents, "get" | "requestOf">;

  constructor(store: WorkItemStore, auth: Auth, options: ApiOptions = {}) {
    this.store = store;
    this.auth = auth;
    this.about = options.about ?? { version: "0.0.0", commit: "unknown" };
    this.skill = options.skill ?? (() => readSkill(SKILL_DIR, 0, "unknown", ""));
    const assigner = options.assigner ?? unconfigured;
    const fleet = options.fleet ?? unconfigured;
    let made: Assigner | undefined;
    this.assigner = () => (made ??= assigner());
    let agents: Pick<Agents, "get" | "requestOf"> | undefined;
    const reached = () => (agents ??= fleet());
    this.fleet = { get: async (id) => reached().get(id), requestOf: async (id) => reached().requestOf(id) };
    this.hono = new OpenAPIHono<{ Variables: { caller: Caller } }>({
      defaultHook: (result, c) =>
        result.success ? undefined : c.json({ error: issues(result.error) }, 400),
    });
    this.guard();
    this.routes();
    this.spec();
  }

  get fetch() {
    return this.hono.fetch;
  }

  /** As `Assigner.retire`, and refused in words where worker-service is not configured. */
  private async retireAgent(assignment: Assignment & { agent: string }): Promise<AgentOutcome> {
    try {
      return await this.assigner().retire(assignment);
    } catch (err) {
      return { id: assignment.agent, name: assignment.name, outcome: "refused", said: `${assignment.name} was not retired: ${(err as Error).message}` };
    }
  }

  private guard(): void {
    const bearer: MiddlewareHandler<{ Variables: { caller: Caller } }> = async (c, next) => {
      const header = c.req.header("authorization");
      const caller = header?.startsWith("Bearer ") ? this.auth.caller(header.slice("Bearer ".length)) : null;
      if (!caller) return c.json({ error: "Unauthorized." }, 401);
      c.set("caller", caller);
      await next();
    };
    this.hono.use("/items/*", bearer);
    this.hono.use("/skill", bearer);
    this.hono.use("/tags", bearer);
    this.hono.use("/tags/*", bearer);
    this.hono.use("/queue", bearer);
  }

  private routes(): void {
    const app = this.hono;
    const missing = { error: "Not found." } as const;

    app.openapi(routes.healthRoute, (c) => c.json({ ok: true as const, ...this.about }, 200));

    app.openapi(routes.skillRoute, (c) => c.json(this.skill(), 200));

    app.openapi(routes.listRoute, async (c) => {
      const { status, state, type, parent, heldBy, reviewedBy, queued, tag } = c.req.valid("query");
      const [graph, tags] = await Promise.all([this.store.graph(), tag === undefined ? undefined : this.store.tags()]);
      const of = parent === undefined ? undefined : graph.resolve(parent);
      const tagged = tag === undefined ? undefined : (tags!.find(tag)?.id ?? null);
      const items = graph
        .views()
        .filter((item) => status === undefined || item.status === status)
        .filter((item) => state === undefined || item.state === state)
        .filter((item) => type === undefined || item.type === type)
        .filter((item) => of === undefined || item.parent === of)
        .filter((item) => heldBy === undefined || item.heldBy === heldBy)
        .filter((item) => reviewedBy === undefined || item.reviewedBy === reviewedBy)
        .filter((item) => queued === undefined || (item.queuePosition !== null) === (queued === "true"))
        .filter((item) => tagged === undefined || (tagged !== null && item.tags.includes(tagged)));
      if (queued === "true") items.sort((a, b) => a.queuePosition! - b.queuePosition!);
      return c.json({ items }, 200);
    });

    app.openapi(routes.createItemRoute, async (c) => {
      const item = await this.store.create(c.req.valid("json"), claimed(c));
      return c.json((await this.store.graph()).view(item), 201);
    });

    app.openapi(routes.getRoute, async (c) => {
      const graph = await this.store.graph();
      const item = graph.get(graph.resolve(c.req.valid("param").id));
      return item ? c.json(graph.view(item), 200) : c.json(missing, 404);
    });

    app.openapi(routes.patchRoute, async (c) => {
      const { id } = c.req.valid("param");
      const by = claimed(c);
      const was = await this.store.graph().then((graph) => graph.get(graph.resolve(id)));
      const item = await this.store.update(id, c.req.valid("json"), by);
      if (!item) return c.json(missing, 404);
      const view = (await this.store.graph()).view(item);
      const signedOff = item.type === "epic" && was?.state === "open" && item.state === "closed" && item.closedReason === "completed";
      const assignment = item.assignment;
      if (!signedOff || !assignment?.agent) return c.json(view, 200);
      const agent = await this.retireAgent({ ...assignment, agent: assignment.agent });
      return c.json({ ...view, agent }, 200);
    });

    app.openapi(routes.historyRoute, async (c) => {
      const entries = await this.store.history(await this.store.resolve(c.req.valid("param").id));
      return entries ? c.json({ entries }, 200) : c.json(missing, 404);
    });

    app.openapi(routes.commentsRoute, async (c) => {
      const notes = await this.store.notes(await this.store.resolve(c.req.valid("param").id), "comment");
      return notes ? c.json({ comments: notes.map(comment) }, 200) : c.json(missing, 404);
    });

    app.openapi(routes.commentRoute, async (c) => {
      const id = await this.store.resolve(c.req.valid("param").id);
      const { body } = c.req.valid("json");
      const added = await this.store.addNote(note(id, "comment", body, [], claimed(c)));
      return added ? c.json(comment(added), 201) : c.json(missing, 404);
    });

    app.openapi(routes.workLogRoute, async (c) => {
      const notes = await this.store.notes(await this.store.resolve(c.req.valid("param").id), "work");
      return notes ? c.json({ entries: notes.map(logged) }, 200) : c.json(missing, 404);
    });

    app.openapi(routes.workLogEntryRoute, async (c) => {
      const id = await this.store.resolve(c.req.valid("param").id);
      const { body, links } = c.req.valid("json");
      const added = await this.store.addNote(note(id, "work", body, links, claimed(c)));
      return added ? c.json(logged(added), 201) : c.json(missing, 404);
    });

    app.openapi(routes.assignRoute, async (c) => {
      const item = await this.assigner().start(c.req.valid("param").id, claimed(c));
      return item ? c.json(item, 201) : c.json(missing, 404);
    });

    app.openapi(routes.tagItemRoute, async (c) => {
      const { id } = c.req.valid("param");
      const tagged = await this.store.tagItem(id, c.req.valid("json").tag, claimed(c));
      if (!tagged) return c.json(missing, 404);
      return c.json({ ...(await this.store.graph()).view(tagged.item), reached: tagged.reached }, 200);
    });

    app.openapi(routes.untagItemRoute, async (c) => {
      const { id, tag } = c.req.valid("param");
      const untagged = await this.store.untagItem(id, tag, claimed(c));
      if (!untagged) return c.json(missing, 404);
      return c.json({ ...(await this.store.graph()).view(untagged.item), reached: untagged.reached }, 200);
    });

    app.openapi(routes.tickRoute, async (c) => {
      const item = await this.store.tick(c.req.valid("param").id, c.req.valid("json").criterion, claimed(c));
      return item ? c.json((await this.store.graph()).view(item), 200) : c.json(missing, 404);
    });

    app.openapi(routes.untickRoute, async (c) => {
      const item = await this.store.untick(c.req.valid("param").id, c.req.valid("json").criterion, claimed(c));
      return item ? c.json((await this.store.graph()).view(item), 200) : c.json(missing, 404);
    });

    app.openapi(routes.deleteRoute, async (c) => {
      await this.store.remove(c.req.valid("param").id, claimed(c));
      return c.body(null, 204);
    });

    const queue = async () => queueOf(await this.store.graph(), await this.store.queueSettings(), this.fleet, Date.now());

    app.openapi(routes.queueRoute, async (c) => c.json(await queue(), 200));

    app.openapi(routes.patchQueueRoute, async (c) => {
      await this.store.setQueueLimit(c.req.valid("json").limit, claimed(c));
      return c.json(await queue(), 200);
    });

    const noTag = { error: "No tag with that id." } as const;

    app.openapi(routes.listTagsRoute, async (c) => c.json({ tags: (await this.store.tags()).all() }, 200));

    app.openapi(routes.createTagRoute, async (c) => c.json(await this.store.createTag(c.req.valid("json")), 201));

    app.openapi(routes.getTagRoute, async (c) => {
      const tag = (await this.store.tags()).get(c.req.valid("param").id);
      return tag ? c.json(tag, 200) : c.json(noTag, 404);
    });

    app.openapi(routes.patchTagRoute, async (c) => {
      const tag = await this.store.updateTag(c.req.valid("param").id, c.req.valid("json"));
      return tag ? c.json(tag, 200) : c.json(noTag, 404);
    });

    app.openapi(routes.deleteTagRoute, async (c) => {
      await this.store.removeTag(c.req.valid("param").id);
      return c.body(null, 204);
    });

    // Hono throws HTTPException for a malformed body before any handler runs;
    // collapsing this to 500 would report a bad request as our failure.
    app.onError((err, c) => {
      // A rejected relationship is the caller's error, not ours: 409 when an
      // item is still referenced or still waits on its dependencies, 400 for
      // anything else the graph refuses.
      if (err instanceof AmbiguousIdError) return c.json({ error: err.message, matches: err.matches }, 409);
      if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403);
      if (err instanceof BlockedError) return c.json({ error: err.message, blockedBy: err.blockedBy }, 409);
      if (err instanceof GraphError) {
        const conflict = err.message.startsWith("still referenced");
        return c.json({ error: err.message }, conflict ? 409 : 400);
      }
      if (err instanceof TagTakenError) return c.json({ error: err.message, tag: err.tag }, 409);
      if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
      if (err instanceof AssignedError) return c.json({ error: err.message, assignment: err.assignment }, 409);
      if (err instanceof AgentRefusedError) return c.json({ error: err.message }, 502);
      if (err instanceof UnconfiguredError) return c.json({ error: err.message }, 503);
      if (err instanceof HTTPException) {
        return c.json({ error: err.message || "Bad request." }, err.status);
      }
      console.error("Unhandled error:", err);
      return c.json({ error: "Internal error." }, 500);
    });
  }

  private spec(): void {
    this.hono.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
      type: "http",
      scheme: "bearer",
    });
    this.hono.doc(SPEC_PATH, {
      openapi: "3.1.0",
      info: {
        version: "0.1.0",
        title: "waypoint",
        description:
          "One entity, the work item, at exactly three levels: an epic has no parent, every " +
          "story has an epic, and every task has a story. `status` values are the board " +
          "columns. A parent's `status` is derived from its open children's, by the rule on " +
          "`WorkItemView.status`. `state` is separate: `open` until the item is closed, as " +
          "`completed` or `not_planned`, from any status. An item may depend on its siblings, items of its type with its parent, " +
          "and lists in `blockedBy` each dependency, its own or an item's above or below it, not yet " +
          "`done` or closed. The service refuses with 409 a move to `in_progress`, `review` " +
          "or `done` while `blockedBy` is not empty, and refuses a parent of the " +
          "wrong type, a dependency on a non-sibling, a cycle, or deleting an item still referenced. Every create, update " +
          "and delete is recorded in the item's `history`, which no operation edits. Beside " +
          "its fields an item keeps `comments`, what people and workers say about it, and a " +
          "`work-log`, what was done on it; neither changes the item or its history. A story " +
          "or task not yet started can be `queued` to start on its own, in the order queued, as many at once " +
          "as the queue's running limit: see `WorkItemView.queuePosition` and `/queue`. Acceptance criteria are ticked and " +
          "unticked one at a time at `/items/{id}/met`. Tags, at `/tags`, are a shared list " +
          "of labels, each a unique value, a colour and a description; an item carries some in " +
          "`tags`, added and removed one at a time at `/items/{id}/tags`, each on the item and " +
          "everything beneath it.",
      },
      tags: [{ name: "items" }, { name: "tags" }, { name: "queue" }, { name: "meta" }],
    });
  }
}

class UnconfiguredError extends Error {}

const unconfigured = (): never => {
  throw new UnconfiguredError("worker-service is not configured: no agent can be started");
};

/**
 * Who a write is from: its `claimed-by`, else its token's name. Null, the
 * person, only for an admin's write that names nobody.
 */
const claimed = (c: Context<{ Variables: { caller: Caller } }>): string | null => {
  const caller = c.get("caller");
  return c.req.header("claimed-by") ?? (caller.admin ? null : caller.name);
};
const comment = ({ id, item, author, at, body }: Note) => ({ id, item, author, at, body });
const logged = ({ kind: _kind, ...entry }: Note) => entry;

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}
