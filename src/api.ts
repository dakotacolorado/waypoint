import { readFileSync } from "node:fs";
import { OpenAPIHono } from "@hono/zod-openapi";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Auth, Caller } from "./auth.ts";
import { LETTERS_ONLY, MARK_ICON, MARK_PIXEL_SVG, MARK_SVG, SUMMARY, TAGLINE } from "./banner.ts";
import { contract } from "./contract.ts";
import { ConflictError, NotFoundError, ValidationError, type Status } from "./domain.ts";
import { mcpServer, type Call } from "./mcp.ts";
import * as routes from "./schema.ts";
import type { Store } from "./store.ts";

export const SPEC_PATH = "/openapi.json";

export interface ApiOptions {
  /** What `GetHealth` says this copy is. */
  about?: { version: string; commit: string };
  /** Where people reach it, as `https://host:8444`: what the served MCP docs give as its address. */
  publicUrl?: string;
}

type Env = { Variables: { caller: Caller } };

const DEFAULT_PAGE = 100;

/** One page of `items` from the offset `nextToken` encodes, and the token for the next. */
function page<T>(items: T[], maxResults: number | undefined, nextToken: string | undefined): { page: T[]; nextToken: string | null } {
  let from = 0;
  if (nextToken !== undefined) {
    from = Number(Buffer.from(nextToken, "base64url").toString("utf8"));
    if (!Number.isInteger(from) || from < 0) throw new ValidationError("nextToken is not one this service gave");
  }
  const size = maxResults ?? DEFAULT_PAGE;
  const end = from + size;
  return { page: items.slice(from, end), nextToken: end < items.length ? Buffer.from(String(end)).toString("base64url") : null };
}

/** Who a write is from: its `x-actor`, else its token's name; null for the environment's admin token naming no one. */
const actorOf = (c: Context<Env>): string | null => c.req.header("x-actor") ?? c.get("caller").name;

const fail = (c: Context, status: 400 | 401 | 404 | 409 | 500, code: string, message: string, details: Record<string, unknown> = {}) =>
  c.json({ code, message, ...details }, status);

export class WaypointApi {
  readonly hono: OpenAPIHono<Env>;

  private readonly store: Store;
  private readonly auth: Auth;
  private readonly about: { version: string; commit: string };
  private readonly publicUrl: string | undefined;

  constructor(store: Store, auth: Auth, options: ApiOptions = {}) {
    this.store = store;
    this.auth = auth;
    this.about = options.about ?? { version: "0.0.0", commit: "unknown" };
    this.publicUrl = options.publicUrl;
    this.hono = new OpenAPIHono<Env>({
      defaultHook: (result, c) => (result.success ? undefined : fail(c, 400, "ValidationException", issues(result.error as unknown as { issues: Issue[] }))),
    });
    this.guard();
    this.routes();
    this.hono.get(SPEC_PATH, (c) => c.json(contract()));
    this.mcp();
    this.pages();
  }

  get fetch() {
    return this.hono.fetch;
  }

  private guard(): void {
    const bearer: MiddlewareHandler<Env> = async (c, next) => {
      const header = c.req.header("authorization");
      const caller = header?.startsWith("Bearer ") ? this.auth.caller(header.slice("Bearer ".length)) : null;
      if (!caller) return fail(c, 401, "UnauthorizedException", "The Authorization header is missing, or its token isn't one this service issued.");
      c.set("caller", caller);
      await next();
    };
    for (const path of ["/tasks", "/tasks/*", "/labels", "/labels/*", "/mcp"]) this.hono.use(path, bearer);
  }

  private routes(): void {
    const app = this.hono;
    /** The task as the set now stands, after the write that made it. */
    const view = async (id: string) => {
      const tasks = await this.store.tasks();
      return tasks.view(tasks.get(id)!);
    };

    app.openapi(routes.getHealth, (c) => c.json({ ok: true as const, ...this.about }, 200));

    app.openapi(routes.listTasks, async (c) => {
      const q = c.req.valid("query");
      const tasks = await this.store.tasks();
      // A label no task can have matches none, rather than refusing the list.
      const label = q.label === undefined ? null : ((await this.store.labels()).all().find((each) => each.id === q.label || each.name.toLowerCase() === q.label!.toLowerCase())?.id ?? "");
      const wanted = tasks
        .all()
        .map((task) => tasks.view(task))
        .filter((task) => (q.status ? task.status === q.status : task.status !== "cancelled" || q.includeCancelled === "true"))
        .filter((task) => q.ready === undefined || task.ready === (q.ready === "true"))
        .filter((task) => label === null || task.labels.includes(label))
        .filter((task) => q.assignee === undefined || task.assignee === (q.assignee === "none" ? null : q.assignee));
      const { page: result, nextToken } = page(wanted, q.maxResults, q.nextToken);
      return c.json({ tasks: result, nextToken }, 200);
    });

    app.openapi(routes.createTask, async (c) => {
      const { clientToken, ...input } = c.req.valid("json");
      const task = await this.store.createTask(input, actorOf(c), clientToken);
      return c.json({ task: await view(task.id) }, 201);
    });

    app.openapi(routes.getTask, async (c) => {
      const tasks = await this.store.tasks();
      return c.json({ task: tasks.view(tasks.find(c.req.valid("param").taskId)) }, 200);
    });

    app.openapi(routes.updateTask, async (c) => {
      const task = await this.store.updateTask(c.req.valid("param").taskId, c.req.valid("json"), actorOf(c));
      return c.json({ task: await view(task.id) }, 200);
    });

    app.openapi(routes.deleteTask, async (c) => {
      await this.store.deleteTask(c.req.valid("param").taskId, actorOf(c));
      return c.body(null, 204);
    });

    app.openapi(routes.listTaskHistory, async (c) => {
      const { maxResults, nextToken } = c.req.valid("query");
      const { page: entries, nextToken: next } = page(await this.store.history(c.req.valid("param").taskId), maxResults, nextToken);
      return c.json({ entries, nextToken: next }, 200);
    });

    app.openapi(routes.listComments, async (c) => {
      const { maxResults, nextToken } = c.req.valid("query");
      const { page: comments, nextToken: next } = page(await this.store.comments(c.req.valid("param").taskId), maxResults, nextToken);
      return c.json({ comments, nextToken: next }, 200);
    });

    app.openapi(routes.createComment, async (c) => {
      const { body, clientToken } = c.req.valid("json");
      return c.json({ comment: await this.store.createComment(c.req.valid("param").taskId, body, actorOf(c), clientToken) }, 201);
    });

    app.openapi(routes.listLabels, async (c) => {
      const { maxResults, nextToken } = c.req.valid("query");
      const { page: labels, nextToken: next } = page((await this.store.labels()).all(), maxResults, nextToken);
      return c.json({ labels, nextToken: next }, 200);
    });

    app.openapi(routes.createLabel, async (c) => {
      const { clientToken, ...input } = c.req.valid("json");
      return c.json({ label: await this.store.createLabel(input, clientToken) }, 201);
    });

    app.openapi(routes.getLabel, async (c) => c.json({ label: (await this.store.labels()).find(c.req.valid("param").labelId) }, 200));

    app.openapi(routes.updateLabel, async (c) => c.json({ label: await this.store.updateLabel(c.req.valid("param").labelId, c.req.valid("json")) }, 200));

    app.openapi(routes.deleteLabel, async (c) => {
      await this.store.deleteLabel(c.req.valid("param").labelId, actorOf(c));
      return c.body(null, 204);
    });

    app.onError((err, c) => {
      if (err instanceof ValidationError) return fail(c, 400, "ValidationException", err.message);
      if (err instanceof NotFoundError) return fail(c, 404, "ResourceNotFoundException", err.message);
      if (err instanceof ConflictError) return fail(c, 409, "ConflictException", err.message, err.details);
      // Hono throws HTTPException for a malformed body before any handler runs.
      if (err instanceof HTTPException) return fail(c, 400, "ValidationException", err.message || "The request is malformed.");
      console.error("Unhandled error:", err);
      return fail(c, 500, "InternalServerException", "Something went wrong on our side.");
    });
  }

  /**
   * The MCP server, at `/mcp`, stateless: each request gets its own, whose
   * tools make their API requests in-process with the request's own
   * `authorization` and `x-actor`.
   */
  private mcp(): void {
    this.hono.all("/mcp", async (c) => {
      const authorization = c.req.header("authorization")!;
      const actor = c.req.header("x-actor");
      const call: Call = async (method, path, body) => {
        const res = await this.hono.fetch(
          new Request(`http://local${path}`, {
            method,
            headers: { authorization, "content-type": "application/json", ...(actor && { "x-actor": actor }) },
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

  /** The page, and the API's and the MCP server's docs, read once: none needs a token, and none holds data. */
  private pages(): void {
    const file = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const serve = (content: string, type: string) => (c: Context) => c.body(content, 200, { "content-type": `${type}; charset=utf-8` });
    this.hono.get("/", serve(file("ui/index.html"), "text/html"));
    this.hono.get("/ui/app.js", serve(file("ui/app.js"), "text/javascript"));
    this.hono.get("/ui/style.css", serve(file("ui/style.css"), "text/css"));
    const mark = Object.entries({ LETTERS: LETTERS_ONLY, MARK_PIXEL_SVG, MARK_SVG, TAGLINE, SUMMARY, STATUSES: routes.Status.options as readonly Status[] })
      .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};\n`)
      .join("");
    this.hono.get("/ui/banner.js", serve(mark, "text/javascript"));
    this.hono.get("/ui/mark.svg", serve(MARK_ICON, "image/svg+xml"));
    this.hono.get("/docs/api", serve(file("docs/index.html"), "text/html"));
    // The docs' example address is a local one; served, they give this deployment's own.
    const local = "http://127.0.0.1:4400";
    this.hono.get("/docs/mcp", serve(file("docs/mcp.html").replaceAll(local, this.publicUrl ?? local), "text/html"));
    this.hono.get("/mcp.json", serve(file("mcp.json"), "application/json"));
  }
}

type Issue = { code: string; path: PropertyKey[]; message: string; [key: string]: unknown };

const KINDS: Record<string, string> = { string: "text", number: "a number", int: "a whole number", boolean: "true or false", array: "a list", object: "an object" };

// zod reports what it received only in its own message, unless asked to keep the input.
const missing = (each: Issue) => each.expected === "nonoptional" || each.message.endsWith("received undefined");

/** A validation issue in plain words, naming the field it is about. */
function issue(each: Issue): string {
  const field = each.path.reduce<string>((at, key) => (typeof key === "number" ? `${at}[${key}]` : at ? `${at}.${String(key)}` : String(key)), "") || "the body";
  const size = (n: unknown, origin: unknown) => (origin === "string" ? `${n} characters` : origin === "array" ? `${n} items` : String(n));
  switch (each.code) {
    case "invalid_type":
      return missing(each) ? `${field} is required` : `${field} must be ${KINDS[String(each.expected)] ?? String(each.expected)}`;
    case "too_small":
      if (each.origin === "string" && each.minimum === 1) return `${field} can't be empty`;
      if (each.origin === "array" && each.minimum === 1) return `${field} needs at least one item`;
      return `${field} must be at least ${size(each.minimum, each.origin)}`;
    case "too_big":
      return `${field} can be at most ${size(each.maximum, each.origin)}`;
    case "invalid_value":
      return `${field} must be one of ${(each.values as unknown[]).map(String).join(", ")}`;
    case "unrecognized_keys":
      return `${field} has no field ${(each.keys as string[]).join(", ")}`;
    case "custom":
      return each.path.length ? `${field} ${each.message}` : each.message;
    case "invalid_format":
      return each.format === "regex" && !each.message.startsWith("Invalid") ? `${field} ${each.message}` : `${field} isn't a valid ${String(each.format)}`;
    default:
      return `${field} isn't valid`;
  }
}

/** Every issue, as one message. */
export function issues(error: { issues: Issue[] }): string {
  return error.issues.map(issue).join("; ");
}
