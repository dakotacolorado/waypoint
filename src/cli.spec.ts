import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLI = new URL("./cli.ts", import.meta.url).pathname;
let dir: string | undefined;
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Starts the server on a port nobody holds, and resolves with what it printed once it said its admin token, or the first lines it said. */
const serve = (db: string, until: RegExp, env: NodeJS.ProcessEnv = {}) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "--port", "0", "--db", db], { env: { PATH: process.env.PATH, ...env } });
    stops.push(() => child.kill());
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (until.test(out)) resolve(out);
    });
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`said only: ${out}`)), 5000);
  });

describe("waypoint serve", () => {
  it("makes and prints an admin token on a fresh database, which the API takes, and keeps the data in that file", { timeout: 20_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "waypoint-cli-"));
    const db = join(dir, "w.db");
    const out = await serve(db, /admin token[^\n]*: (wp_\S+)\n/);
    const url = /listening on (\S+),/.exec(out)![1]!;
    const token = /admin token[^\n]*: (wp_\S+)/.exec(out)![1]!;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const made = await fetch(`${url}/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "kept" }) });
    expect(made.status).toBe(201);
    stops.splice(0).forEach((stop) => stop());

    const again = await serve(db, /listening on [^\n]*\n/);
    expect(again).not.toContain("admin token");
    const url2 = /listening on (\S+),/.exec(again)![1]!;
    const { tasks } = (await (await fetch(`${url2}/tasks`, { headers })).json()) as { tasks: { title: string }[] };
    expect(tasks.map((task) => task.title)).toEqual(["kept"]);
  });

  it("makes no token when the environment gives an admin one", { timeout: 20_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "waypoint-cli-"));
    const out = await serve(join(dir, "w.db"), /listening on [^\n]*\n/, { WAYPOINT_ADMIN_TOKEN: "env-admin" });
    expect(out).not.toContain("admin token");
    const url = /listening on (\S+),/.exec(out)![1]!;
    expect((await fetch(`${url}/tasks`, { headers: { authorization: "Bearer env-admin" } })).status).toBe(200);
  });

});
