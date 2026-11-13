import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the page", () => {
  it("never inserts text as HTML: every element is made with h, which sets text", () => {
    const source = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|srcdoc/);
  });
});
