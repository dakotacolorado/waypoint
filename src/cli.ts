#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Tokens } from "./auth.ts";
import { banner } from "./banner.ts";
import { PACKAGE_VERSION } from "./build.ts";
import { start, type Running } from "./server.ts";
import { Store } from "./store.ts";

const USAGE = `waypoint v${PACKAGE_VERSION}: a task tracker for people and agents, over HTTP, on SQLite.

Usage:
  waypoint [serve] [options]              run the server
  waypoint token create <name> [--admin]  make a token; printed once, kept only as a hash
  waypoint token list
  waypoint token revoke <name>
  waypoint backup <file>                  copy the database, consistent while the server runs, to <file>

Options:
  --host <addr>     address to listen on (default 127.0.0.1, or WAYPOINT_HOST)
  --port <n>        port (default 4400, or WAYPOINT_PORT)
  --db <path>       the SQLite file (default ~/.waypoint/waypoint.db, or WAYPOINT_DB)
  --public-url <url>  its address behind a proxy, as https://host:8444: what the banner
                      and the served docs give (default this server's own, or WAYPOINT_PUBLIC_URL)
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
    "public-url": { type: "string" },
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
  const store = Store.open(path);
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

if (command === "backup") {
  if (!sub) fail("backup needs the file to write");
  const store = Store.open(path);
  try {
    const pages = await store.backup(resolve(sub!));
    process.stdout.write(`backed up ${path} to ${resolve(sub!)} (${pages} pages)\n`);
  } catch (err) {
    fail(`backup failed: ${(err as Error).message}`);
  }
  store.db.close();
  process.exit(0);
}

if (command !== "serve") fail(`unknown command "${command}"\n\n${USAGE}`);

const host = values.host ?? env.WAYPOINT_HOST ?? "127.0.0.1";
const port = Number(values.port ?? env.WAYPOINT_PORT ?? 4400);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, not ${values.port ?? env.WAYPOINT_PORT}`);
const shown = (at: number) => `http://${host.includes(":") ? `[${host}]` : host}:${at}`;

// Started once listening, so links default to the port it took, which `--port 0` leaves to the OS.
let running: Running | undefined;
const server = serve({ fetch: (request) => running!.api.fetch(request), hostname: host, port }, (info) => {
  const publicUrl = (values["public-url"] ?? env.WAYPOINT_PUBLIC_URL ?? shown(info.port)).replace(/\/+$/, "");
  running = start({ db: path, publicUrl, adminToken: env.WAYPOINT_ADMIN_TOKEN });
  const made = running.tokens.hasAdmin() ? null : running.tokens.create("admin", true);
  const color = Boolean(process.stdout.isTTY) && !env.NO_COLOR;
  process.stdout.write(banner({ version: PACKAGE_VERSION, url: shown(info.port), publicUrl, db: path, token: made, color }));
});

const stop = () => {
  server.close();
  running?.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
