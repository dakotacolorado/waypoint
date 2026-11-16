import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");

describe("the page", () => {
  it("never inserts text as HTML: every element is made with h, which sets text", () => {
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|srcdoc/);
  });

  it("opens the board with the small wordmark, tagline and summary, above its filters", () => {
    const board = source.slice(source.indexOf("async function board("));
    expect(board).toMatch(/main\.replaceChildren\(\s*landing\(true\),[\s\S]*?filters,/);
  });

  it("keeps the full-size wordmark on the sign-in screen", () => {
    expect(source).toMatch(/h\("div", \{ class: "signin" \}, landing\(\), form\)/);
  });
});
