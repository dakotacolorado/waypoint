import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Tokens } from "./auth.ts";

describe("Tokens", () => {
  it("keeps only a hash, and knows a token's caller by it", () => {
    const db = new DatabaseSync(":memory:");
    const tokens = new Tokens(db);
    const token = tokens.create("worker", false);
    expect(JSON.stringify(db.prepare("SELECT * FROM tokens").all())).not.toContain(token);
    expect(tokens.caller(token)).toEqual({ name: "worker", admin: false });
    expect(tokens.caller(`${token}x`)).toBeNull();
  });

  it("refuses a second token of one name, and forgets a revoked one", () => {
    const tokens = new Tokens(new DatabaseSync(":memory:"));
    const token = tokens.create("person", true);
    expect(() => tokens.create("person", false)).toThrow(/already exists/);
    expect(tokens.list()).toEqual([{ name: "person", admin: true, createdAt: expect.any(String) }]);
    expect(tokens.revoke("person")).toBe(true);
    expect(tokens.caller(token)).toBeNull();
    expect(tokens.revoke("person")).toBe(false);
  });

  it("takes the environment's admin token without storing it", () => {
    const db = new DatabaseSync(":memory:");
    const tokens = new Tokens(db, "from-env");
    expect(tokens.hasAdmin()).toBe(true);
    expect(tokens.caller("from-env")).toEqual({ name: null, admin: true });
    expect(tokens.list()).toEqual([]);
    expect(new Tokens(db).hasAdmin()).toBe(false);
  });
});
