import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderApiReference } from "./api-doc.ts";
import { ROUTES } from "./schema.ts";
import { API_DOC, openApiDocument, SPEC_FILE } from "./spec.ts";

describe("openapi.json and docs/API.md", () => {
  it("match what the service serves", async () => {
    const served = await openApiDocument();
    expect(JSON.parse(readFileSync(SPEC_FILE, "utf8"))).toEqual(served);
    expect(readFileSync(API_DOC, "utf8")).toBe(renderApiReference(served));
  });

  it("name every operation in AWS's VerbNoun form, with a summary that says the same in words", async () => {
    const { paths } = await openApiDocument();
    const operations = Object.values(paths).flatMap((methods) => Object.values(methods));
    expect(operations.map((op) => op.operationId).sort()).toEqual(ROUTES.map((route) => route.operationId).sort());
    for (const op of operations) {
      expect(op.operationId).toMatch(/^(List|Get|Create|Update|Delete)[A-Z][A-Za-z]+$/);
      expect(op.summary.split(" ")[0]!.toLowerCase()).toBe(op.operationId.match(/^[A-Z][a-z]+/)![0].toLowerCase());
    }
  });

  it("document every field of every data type", async () => {
    const { components } = await openApiDocument();
    const undocumented = Object.entries(components.schemas).flatMap(([name, schema]) =>
      Object.entries(schema.properties ?? {})
        .filter(([, field]) => !field.description && !field.$ref)
        .map(([field]) => `${name}.${field}`),
    );
    expect(undocumented).toEqual([]);
  });
});
