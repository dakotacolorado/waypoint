import { singleToken } from "./auth.ts";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorkTrackerApi } from "./api.ts";
import { REFERENCE_FILE, readSkill, renderReference, SKILL_DIR, UI_URL_MARK } from "./skill.ts";
import { openApiDocument } from "./spec.ts";
import type { WorkItemStore } from "./store.ts";

const doc = async () => (await openApiDocument()) as Parameters<typeof renderReference>[0];

describe("the skill's reference", () => {
  it("is what openapi.json renders to, so it cannot drift from the API", async () => {
    expect(readFileSync(REFERENCE_FILE, "utf8")).toBe(renderReference(await doc()));
  });

  it("covers every operation a worker calls, and not the platform's", async () => {
    const reference = renderReference(await doc());
    expect(reference).toContain("## PATCH /items/{id}");
    expect(reference).not.toContain("/skill");
    expect(reference).not.toContain("/health");
  });
});

describe("GET /skill", () => {
  const api = new WorkTrackerApi(null as unknown as WorkItemStore, singleToken("t"), { skill: () => readSkill(SKILL_DIR, 7, "abc", "https://ui.example") });
  const get = (auth?: string) => api.fetch(new Request("http://local/skill", { headers: auth ? { authorization: auth } : {} }));

  it("needs the token", async () => {
    expect((await get()).status).toBe(401);
  });

  it("answers bin/ and reference/ under the skill's folder, with no guidance", async () => {
    const skill = (await (await get("Bearer t")).json()) as ReturnType<typeof readSkill>;
    expect(skill).toMatchObject({ key: "work-tracker", version: 7, commit: "abc" });
    expect(skill.files.map((f) => [f.path, f.executable])).toEqual([
      ["skills/work-tracker/bin/wt", true],
      ["skills/work-tracker/reference/api.md", false],
      ["skills/work-tracker/reference/statuses.md", false],
    ]);
  });

  it("points wt link at this deployment's UI", async () => {
    const skill = (await (await get("Bearer t")).json()) as ReturnType<typeof readSkill>;
    const wt = skill.files.find((f) => f.path.endsWith("bin/wt"))!.content;
    expect(wt).toContain("ui=${WT_UI_URL:-https://ui.example}");
    expect(wt).not.toContain(UI_URL_MARK);
  });
});

describe("wt link", () => {
  const title = "A worker can say [done] when it hands a ticket back, and the service stops it";
  const run = async (id: string) => {
    const server = createServer((req, res) => {
      const found = req.url === "/items/6ff632ff" && req.headers.authorization === "Bearer t";
      res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(found ? { id: "6ff632ff-0000-4000-8000-000000000000", shortId: "6ff632ff", title } : { error: "Not found." }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const env = { PATH: process.env.PATH, WT_URL: `http://127.0.0.1:${port}`, WT_TOKEN: "t", WT_UI_URL: "https://ui.example/" };
      return await promisify(execFile)(join(SKILL_DIR, "bin", "wt"), ["link", id], { env });
    } finally {
      server.close();
    }
  };

  it("prints a Markdown link reading as the short id and the title, cut at a word to fit", async () => {
    const { stdout } = await run("6ff632ff");
    expect(stdout).toBe("[6ff632ff A worker can say \\[done\\] when it hands a ticket back, and…](https://ui.example/items/6ff632ff)\n");
  });

  it("fails as the read does for an unknown item", async () => {
    await expect(run("00000000")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("HTTP 404") });
  });
});
