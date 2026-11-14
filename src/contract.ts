import { OpenAPIHono } from "@hono/zod-openapi";
import { SUMMARY } from "./banner.ts";
import { ROUTES } from "./schema.ts";

/** The API's version, dated as AWS dates theirs: changed only when the contract is. */
export const API_VERSION = "2026-11-14";

/** Every path served without a token, as `OPEN_WORDS` names them; `/ui/` is a prefix. */
export const OPEN_PATHS = ["/health", "/openapi.json", "/mcp.json", "/docs/api", "/docs/mcp", "/", "/ui/"] as const;
export const OPEN_WORDS =
  "Every request takes `Authorization: Bearer <token>` but these, which hold no data: `GetHealth` (`/health`), the contracts (`/openapi.json`, `/mcp.json`), the docs (`/docs/api`, `/docs/mcp`) and the page (`/`, `/ui/…`).";

/** The API's overview, at the top of its docs. Markdown. */
export const OVERVIEW = `${SUMMARY} A task depends on other tasks, and the service keeps it from being started while it is blocked by one still open, or finished before its acceptance criteria are met.

- \`status\` is one of \`backlog\`, \`in_progress\`, \`review\`, \`done\` or \`cancelled\`. \`done\` and \`cancelled\` are the closed statuses.
- A task **depends on** other tasks, and is **ready** when it is in \`backlog\` and every task it depends on is closed.
- A task can move to \`in_progress\`, \`review\` or \`done\` once every task it depends on is closed, and to \`done\` once every criterion is met and every subtask is closed.
- A task's **subtasks** are the steps of its work, with dependencies among themselves held to the same rule. Its **criteria** are what must be true for it to be done.
- A task's **verification** says who checks that its work does what it should, \`agent\` or \`person\`, and when, \`before_release\` or \`after_release\`; null if no one has said.
- Cancelled tasks count as closed, and \`ListTasks\` leaves them out unless \`includeCancelled\` is \`true\` or \`status\` is \`cancelled\`.

${OPEN_WORDS} A write is recorded as its \`x-actor\` header, else its token's name; one by the environment's admin token (\`WAYPOINT_ADMIN_TOKEN\`), which has no name, as null.

The API's version, ${API_VERSION}, is the date its contract last changed, as AWS dates theirs; the package's version is apart, and \`GetHealth\` gives it. Errors are \`{code, message}\`.`;

/** The OpenAPI document for every route, with or without handlers. */
export function contract(app = new OpenAPIHono()) {
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer" });
  for (const route of ROUTES) app.openAPIRegistry.registerPath(route);
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "waypoint API", version: API_VERSION, description: OVERVIEW },
    tags: [{ name: "Tasks" }, { name: "Comments" }, { name: "Labels" }, { name: "Service" }],
  });
}
