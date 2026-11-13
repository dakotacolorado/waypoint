import { OpenAPIHono } from "@hono/zod-openapi";
import { SUMMARY } from "./banner.ts";
import { ROUTES } from "./schema.ts";

/** The API's version, dated as AWS dates theirs: changed only when the contract is. */
export const API_VERSION = "2026-11-12";

/** The API's overview, at the top of its docs. Markdown. */
export const OVERVIEW = `${SUMMARY} A task depends on other tasks, and the service keeps it from being started while it is blocked by one still open, or finished before its acceptance criteria are met.

- \`status\` is one of \`backlog\`, \`in_progress\`, \`review\`, \`done\` or \`cancelled\`. \`done\` and \`cancelled\` are the closed statuses.
- A task **depends on** other tasks, and is **ready** when it is in \`backlog\` and every task it depends on is closed.
- A task can move to \`in_progress\`, \`review\` or \`done\` once every task it depends on is closed, and to \`done\` once every criterion is met and every subtask is closed.
- A task's **subtasks** are the steps of its work, with dependencies among themselves held to the same rule. Its **criteria** are what must be true for it to be done.
- Cancelled tasks count as closed and are left out of lists unless asked for.

Every request but \`GetHealth\` takes \`Authorization: Bearer <token>\`. A write is recorded as its \`x-actor\` header, else its token's name. Errors are \`{code, message}\`.`;

/** The OpenAPI document for every route, with or without handlers. */
export function contract(app = new OpenAPIHono()) {
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer" });
  for (const route of ROUTES) app.openAPIRegistry.registerPath(route);
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "waypoint", version: API_VERSION, description: OVERVIEW },
    tags: [{ name: "Tasks" }, { name: "Comments" }, { name: "Labels" }, { name: "Service" }],
  });
}
