import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    expect(out).toContain("no worker-service configured");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const made = await fetch(`${url}/items`, { method: "POST", headers, body: JSON.stringify({ type: "epic", title: "kept" }) });
    expect(made.status).toBe(201);
    stops.splice(0).forEach((stop) => stop());

    const again = await serve(db, /no worker-service configured[^\n]*\n/);
    expect(again).not.toContain("admin token");
    const url2 = /listening on (\S+),/.exec(again)![1]!;
    const { items } = (await (await fetch(`${url2}/items`, { headers })).json()) as { items: { title: string }[] };
    expect(items.map((item) => item.title)).toEqual(["kept"]);
  });

  it("makes no token when the environment gives an admin one", { timeout: 20_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "waypoint-cli-"));
    const out = await serve(join(dir, "w.db"), /no worker-service configured[^\n]*\n/, { WAYPOINT_ADMIN_TOKEN: "env-admin" });
    expect(out).not.toContain("admin token");
    const url = /listening on (\S+),/.exec(out)![1]!;
    expect((await fetch(`${url}/items`, { headers: { authorization: "Bearer env-admin" } })).status).toBe(200);
  });

  it("serves at /skill a wt that works against it with only WT_URL and WT_TOKEN set", { timeout: 20_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "waypoint-cli-"));
    const out = await serve(join(dir, "w.db"), /admin token[^\n]*: (wp_\S+)\n/);
    const url = /listening on (\S+),/.exec(out)![1]!;
    const token = /admin token[^\n]*: (wp_\S+)/.exec(out)![1]!;
    const skill = (await (await fetch(`${url}/skill`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      files: { path: string; content: string; executable: boolean }[];
    };
    for (const file of skill.files) {
      const at = join(dir, file.path);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, file.content, { mode: file.executable ? 0o755 : 0o644 });
    }
    const wt = (...args: string[]) =>
      execFileSync(join(dir!, "skills/work-tracker/bin/wt"), args, { env: { PATH: process.env.PATH, WT_URL: url, WT_TOKEN: token }, encoding: "utf8" });
    const epic = JSON.parse(wt("POST", "/items", JSON.stringify({ type: "epic", title: "through wt" }))) as { id: string; shortId: string };
    expect((JSON.parse(wt("GET", `/items/${epic.shortId}`)) as { title: string }).title).toBe("through wt");
    expect(wt("link", epic.shortId)).toContain(`(${url}/items/${epic.shortId})`);
  });
});
