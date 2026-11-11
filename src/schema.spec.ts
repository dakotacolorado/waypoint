import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DraftSchema, PatchSchema } from "./schema.ts";
import { openApiDocument, SPEC_FILE } from "./spec.ts";

// Covers only what is ours, not Zod's. Rejections are tested through the routes.
describe("DraftSchema", () => {
  it("defaults everything but the title, and trims", () => {
    expect(DraftSchema.parse({ title: "  Ship it  ", acceptanceCriteria: [" a "] })).toEqual({
      type: "task",
      title: "Ship it",
      body: "",
      acceptanceCriteria: ["a"],
      status: "backlog",
      parent: null,
      dependsOn: [],
    });
  });
});

describe("PatchSchema", () => {
  it("keeps only the keys sent, and rejects an empty patch", () => {
    expect(PatchSchema.parse({ status: "review" })).toEqual({ status: "review" });
    expect(PatchSchema.safeParse({}).success).toBe(false);
  });
});

describe("openapi.json", () => {
  it("matches what the service serves", async () => {
    expect(JSON.parse(readFileSync(SPEC_FILE, "utf8"))).toEqual(await openApiDocument());
  });

  it("names every operation, since generators derive method names from it", async () => {
    const operations = await operationIds();
    expect(operations.filter((id) => !id)).toEqual([]);
  });
});

// Backstop for the pre-commit hook, which regenerates these.
describe.each(["docs/API.md", "docs/index.html"])("%s", (file) => {
  it("documents every operation", async () => {
    const rendered = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const undocumented = (await operationIds()).filter((id) => !rendered.includes(id!));
    expect(undocumented).toEqual([]);
  });
});

async function operationIds(): Promise<(string | undefined)[]> {
  const { paths } = (await openApiDocument()) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  return Object.values(paths).flatMap((methods) =>
    Object.values(methods).map((operation) => operation.operationId),
  );
}
