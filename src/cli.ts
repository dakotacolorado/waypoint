#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Tokens } from "./auth.ts";
import { PACKAGE_VERSION, start } from "./server.ts";
import { WorkItemStore } from "./store.ts";

const USAGE = `waypoint v${PACKAGE_VERSION}: a task tracker for people and agents, over HTTP, on SQLite.

Usage:
  waypoint [serve] [options]              run the server
  waypoint token create <name> [--admin]  make a token; printed once, kept only as a hash
  waypoint token list
  waypoint token revoke <name>

Options:
  --host <addr>     address to listen on (default 127.0.0.1, or WAYPOINT_HOST)
  --port <n>        port (default 4400, or WAYPOINT_PORT)
  --db <path>       the SQLite file (default ~/.waypoint/waypoint.db, or WAYPOINT_DB)
  -h, --help        this

Environment:
  WAYPOINT_ADMIN_TOKEN       an admin token accepted beside the stored ones, never stored

Every request but /health and /openapi.json needs a bearer token. With no admin token
at all, serve makes one, named admin, and prints it once.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    port: { type: "string" },
    db: { type: "string" },
    admin: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const fail = (message: string): never => {
  process.stderr.write(`waypoint: ${message}\n`);
  process.exit(1);
};

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const env = process.env;
const db = values.db ?? env.WAYPOINT_DB ?? join(homedir(), ".waypoint", "waypoint.db");
const path = db === ":memory:" ? db : resolve(db);
if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
const [command = "serve", sub, name] = positionals;

if (command === "token") {
  const store = WorkItemStore.open(path);
  const tokens = new Tokens(store.db);
  if (sub === "create") {
    if (!name) fail("token create needs a name");
    try {
      process.stdout.write(`${tokens.create(name!, values.admin === true)}\n`);
    } catch (err) {
      fail((err as Error).message);
    }
  } else if (sub === "list") {
    for (const token of tokens.list()) process.stdout.write(`${token.name}\t${token.admin ? "admin" : "caller"}\t${token.createdAt}\n`);
  } else if (sub === "revoke") {
    if (!name) fail("token revoke needs a name");
    if (!tokens.revoke(name!)) fail(`no token named ${name}`);
  } else {
    fail(`unknown token command "${sub ?? ""}": create, list or revoke`);
  }
  store.db.close();
  process.exit(0);
}

if (command !== "serve") fail(`unknown command "${command}"\n\n${USAGE}`);

const host = values.host ?? env.WAYPOINT_HOST ?? "127.0.0.1";
const port = Number(values.port ?? env.WAYPOINT_PORT ?? 4400);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, not ${values.port ?? env.WAYPOINT_PORT}`);

const running = start({
  db: path,
  adminToken: env.WAYPOINT_ADMIN_TOKEN,
});
const made = running.tokens.hasAdmin() ? null : running.tokens.create("admin", true);

const server = serve({ fetch: running.api.fetch, hostname: host, port }, (info) => {
  process.stdout.write(`waypoint v${PACKAGE_VERSION} listening on http://${host.includes(":") ? `[${host}]` : host}:${info.port}, data in ${path}\n`);
  if (made) process.stdout.write(`admin token (shown once, kept only as a hash): ${made}\n`);
});

const stop = () => {
  server.close();
  running.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
