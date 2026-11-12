import { readFileSync } from "node:fs";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import type { Auth, Caller } from "./auth.ts";
import { HTTPException } from "hono/http-exception";
import { type Assignment, AmbiguousIdError, BlockedError, ForbiddenError, GraphError, note, type Note } from "./domain.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { mcpServer, type Call } from "./mcp.ts";
import { EMOJI, LETTERS_ONLY, PIN_SVG, SUMMARY, TAGLINE } from "./banner.ts";
import * as routes from "./schema.ts";
import { readSkill, SKILL_DIR, type Skill } from "./skill.ts";
import { AgentRefusedError, Assigner, type AgentOutcome, type Agents } from "./assignment.ts";
import { queueOf } from "./queue.ts";
import { AssignedError, ConflictError, type WorkItemStore } from "./store.ts";
import { TagTakenError } from "./tags.ts";

export const SPEC_PATH = "/openapi.json";

/** The API's overview, at the top of its docs. Markdown. */
const OVERVIEW = `A task tracker for people and their agents. Every request takes a bearer token, but the liveness check.

## Items

One kind of record, the **item**, at three levels:

- an **epic** has no parent;
- every **story** has an epic;
- every **task** has a story.

## Status and state

- \`status\` is the board column: \`backlog\`, \`ready\`, \`in_progress\`, \`review\`, \`done\`.
- A parent's status is **derived** from its open children (the rule is on \`WorkItemView.status\`): move the children, not the parent.
- \`state\` is separate: \`open\`, or \`closed\` as \`completed\` or \`not_planned\`, from any status.

## Dependencies

- An item may depend only on its **siblings**: items of its own type with the same parent.
- \`blockedBy\` lists what it still waits on: its own dependencies, and those of the items above and below it, not yet done or closed.
- A move to \`in_progress\`, \`review\` or \`done\` is refused with **409** while \`blockedBy\` is not empty.
- Also refused: a parent of the wrong type, a dependency on a non-sibling, a cycle, and deleting an item another still names.

## Beside an item

- **History**: every create, update and delete, never edited. \`/items/{id}/history\`
- **Comments**: what people and agents say about it. \`/items/{id}/comments\`
- **Work log**: what was done on it, with links. \`/items/{id}/work-log\`
- **Acceptance criteria**: each with its own id (\`c1\`, \`c2\`, …), ticked and unticked one at a time. \`/items/{id}/met\`

None of comments, the work log or ticks changes the item's other fields.

## Tags

A shared list of labels at \`/tags\`, each a unique value, a colour and a description. One put on an item at \`/items/{id}/tags\` goes on everything beneath it too.

## The queue

A story or task not yet started can be \`queued\` to start on its own, in order, as many at once as the running limit. See \`WorkItemView.queuePosition\` and \`/queue\`. It starts agents only where a worker-service is configured.

## Who wrote it

A write is recorded under its \`claimed-by\` header, else its token's name. Only an admin token's write that names nobody is the person's: it alone may sign off an epic, force a move past its dependencies, or set the queue's limit.`;

export interface ApiOptions {
  /** What `/health` says this copy is. */
  about?: { version: string; commit: string };
  /** Where people and agents reach it, as `https://host/waypoint`: what the served docs give as its address. */
  publicUrl?: string;
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
  private readonly publicUrl: string | undefined;
  private readonly skill: () => Skill;
  private readonly assigner: () => Assigner;
  private readonly fleet: Pick<Agents, "get" | "requestOf">;

  constructor(store: WorkItemStore, auth: Auth, options: ApiOptions = {}) {
    this.store = store;
    this.auth = auth;
    this.about = options.about ?? { version: "0.0.0", commit: "unknown" };
    this.publicUrl = options.publicUrl;
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
    this.mcp();
    this.pages();
  }

  /** The page, and the API's and the MCP server's docs, read once: none needs a token, and none holds data. */
  private pages(): void {
    const file = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const page = (path: string, type: string) => {
      const content = file(path);
      return (c: Context) => c.body(content, 200, { "content-type": `${type}; charset=utf-8` });
    };
    this.hono.get("/", page("ui/index.html", "text/html"));
    this.hono.get("/ui/app.js", page("ui/app.js", "text/javascript"));
    this.hono.get("/ui/style.css", page("ui/style.css", "text/css"));
    const mark = Object.entries({ LETTERS: LETTERS_ONLY, PIN_SVG, EMOJI, TAGLINE, SUMMARY })
      .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};\n`)
      .join("");
    this.hono.get("/ui/banner.js", (c) => c.body(mark, 200, { "content-type": "text/javascript; charset=utf-8" }));
    this.hono.get("/docs/api", page("docs/index.html", "text/html"));
    // The docs' example address is a local one; served, they give this deployment's own.
    const local = "http://127.0.0.1:4400";
    const mcpDocs = file("docs/mcp.html").replaceAll(local, this.publicUrl ?? local);
    this.hono.get("/docs/mcp", (c) => c.body(mcpDocs, 200, { "content-type": "text/html; charset=utf-8" }));
    this.hono.get("/mcp.json", page("mcp.json", "application/json"));
  }

  /**
   * The MCP server, at `/mcp`, stateless: each request gets its own, whose
   * tools make their API requests in-process with the request's own
   * `authorization` and `claimed-by`.
   */
  private mcp(): void {
    this.hono.all("/mcp", async (c) => {
      const authorization = c.req.header("authorization")!;
      const claimedBy = c.req.header("claimed-by");
      const call: Call = async (method, path, body) => {
        const res = await this.hono.fetch(
          new Request(`http://local${path}`, {
            method,
            headers: { authorization, "content-type": "application/json", ...(claimedBy && { "claimed-by": claimedBy }) },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
        return { status: res.status, body: res.status === 204 ? null : await res.json() };
      };
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcpServer(this.about.version, call).connect(transport);
      return transport.handleRequest(c.req.raw);
    });
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
    this.hono.use("/mcp", bearer);
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
        description: OVERVIEW,
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
